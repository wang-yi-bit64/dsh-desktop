# Windows 打包与启动事故档案

> 从 `AGENTS.md` §4（及 §2 的已知环境限制）迁入，原样保留。这些条目均为「已修复，勿回归」——不要删改判据。

### Windows 产物启动失败的三类根因（已修复，勿回归）

1. **`\\?\` verbatim 路径泄漏进子进程 argv**：Tauri 的 `resource_dir()` 来自 `current_exe().canonicalize()`，Windows 上带 `\\?\` 前缀。拼进 Node 入口脚本后 CJS loader 还原成裸盘符并抛 `EISDIR: lstat 'D:'`。修复点在 [`crates/dsh-host/src/paths.rs`](crates/dsh-host/src/paths.rs) 的 `Layout::resolve`——所有派生路径的唯一产地，禁止在别处再拼 `resource_dir` 原始值。
2. **`prepare:harness` 幂等检查漏项**：只校验 3 个文件时，缺 `bin/` / `plugin-safety-guard.mjs` 的资源树会被当作完整而跳过组装（前者是 `harness-node-entry.mjs` 的直接依赖，缺失则 Harness 起不来；缺 `bin/` 则 `cargo build` 的 glob 校验直接失败）。修改 `tauri.conf.json` → `bundle.resources` 时必须同步更新 `scripts/prepare-harness.mjs` 的 `REQUIRED_FILES` / `REQUIRED_DIRS`。
3. **契约环境变量未注入**：`Launcher::execute` 在 `shell == None` 时也必须经 `harness_env()`，否则 `DSH_HOME` 等变量缺失，Harness 回退 `~/.dsh`，把可变状态写到 `app_data_dir` 之外（违反 INV-1）。

另：`npm run tauri build` 首次打包需下载 NSIS 工具链；网络不可达 GitHub releases 时打包步骤报 `timeout: global`，但 `.exe` 与资源此时已成功产出。

### 打包资源清单是四处手抄的：漏一处只有安装包坏（2026-09-21 v0.7.0-alpha.1 实测，已修复勿回归）

看门狗模块（上一节）落地时，`build/parent-death-watchdog.mjs` **进了三份清单、漏了第四份**：

| 清单 | 是否登记 | 漏写后的表现 |
|------|---------|-------------|
| `prepare-harness.mjs` → `copyBuildFiles()` | ✅ | 文件不在 `resources/` |
| `prepare-harness.mjs` → `REQUIRED_FILES` | ✅ | 残缺资源树被当成完整复用 |
| `stub-tauri-resources.mjs` → `assets` | ✅ | CI 编译桩 glob 失配 |
| `tauri.conf.json` → `bundle.resources` | ❌ | **文件不进安装包** |

于是 v0.7.0-alpha.1 的 Windows 安装包装完一启动就：

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  'D:\Program Files\DSH Desktop\resources\parent-death-watchdog.mjs'
  imported from D:\Program Files\DSH Desktop\resources\harness-node-entry.mjs
```

**为什么所有门禁都是绿的**（这是本节最该记住的部分）：

1. **`tauri-build` 不会因缺条目而失败**。build.rs 只校验「每个 glob 至少匹配一个文件」——
   glob 清单对它来说是「取什么」，不是「必须有什么」。少一条目它没有任何意见。
2. **本地与 CI 走的都不是那份清单**。`npm run dev` / L1 / L2 读的是
   `src-tauri/resources/` 目录本身（由 `copyBuildFiles()` 铺好、齐全），`bundle.resources`
   只影响 `tauri build` 的出包内容。`git status` 也看不见——`resources/` 是 gitignore 的。
   所以**静态门禁、三平台 CI、单测、真实资源树 L1 全绿，只有装出来的那个包坏**。

**修法（勿改回）**：补上 `bundle.resources` 的条目，并**不要再靠手抄维持一致**——
`verify:harness-entry` 新增两条**推导**判据（不维护第五份文件名单）：

- **E5**：递归收集入口里所有相对 import（静态与动态同等对待），逐个要求在四份清单里
  出现。判定不绑定各清单的具体写法，也认 `resources/*.mjs` 这类 glob 覆盖。
- **E5d**：取 `crates/dsh-host/src/paths.rs` 的 `Layout::resolve` 里所有
  `resource_dir.join(常量)`，到 `crates/dsh-contracts/src/constants.rs` 查字面值，逐个要求
  被 `bundle.resources` 覆盖。硬编码文件名只能守住今天这几个；这条守的是**将来**新增的
  `resource_dir.join(NEW_FILE)`——同样没有编译错误。

两条都在**解析不到任何东西时报错而非通过**：一个静默放行的守卫会让下一次漏包看起来
「验过了」。`--self-test` 里最关键的夹具是**发出时那份真实的 `bundle.resources`**——
喂进去必须报 E5a，补上条目必须通过（否则它只是恒真的装饰）。判定理由与备选方案见
[`docs/adr/049`](docs/adr/049-bundle-resources-derived-guard.md)。

⚠️ 顺带记下**不要**做的两件事：(a) 别把 `bundle.resources` 改成 `resources/**/*` 一把梭
——那会把中间产物一并打进安装包，而体积是本仓明确关心的指标（§4 的 LibreOffice 一节）；
(b) 别为「清单和目录一致」把 `logo-light.png` / `logo-dark.png` 加进包——它们不由任何
运行时读取（品牌 logo 走 `install-brand-assets.mjs` 进 harness 前端树），加进去只是白增体积。

### 把构建目标插进 `run:` 字符串：只有 Windows 的 job 红（2026-09-15 实测，已修复勿回归）

首次双通道 Smoke 出现**三平台结论相反**的场面：Windows 的 job 红，macOS/Linux 正常。
日志指向 `node scripts/prepare-harness.mjs --dsh-target=`（**空值**），因为 workflow 里写的是

```yaml
run: npm run prepare:harness -- --dsh-target="${DSH_TARGET}"
```

Windows runner 的**默认 shell 是 PowerShell**（不是 bash），那行里的变量引用没有被展开成
期望的值，参数退化成 `--dsh-target=`，node 读到空串后按设计抛错。macOS/Linux 的 bash 正确展开，
于是同一份工作流在两个平台上给出相反的结论——而**根因只是 shell 不同**。

**修法（勿改回）**：目标名走**环境变量**，不要插进 `run:` 字符串。

```yaml
env:
  DSH_TARGET: ${{ needs.preflight.outputs.dsh_target }}
run: npm run prepare:harness
```

`resolveDshTargetArg()`（`scripts/dsh-targets.mjs`）因此支持三条来源，优先级为
**CLI 参数 > `DSH_TARGET` 环境变量 > 默认目标**。这样 workflow 里不再有任何 shell 引用，
任何 shell 都只是「启动进程、设一个变量」。与本仓给 `TAURI_SIGNING_PRIVATE_KEY` 用 env
而非内联插值是同一套理由（那次防密钥进日志，这次防 shell 改写语义）。

**守卫**：`verify:release-workflow` 的 `checkDualChannelShape` 判定组装步骤必须是
`env: DSH_TARGET` + `npm run prepare:harness` 的形状，并新增 `findInterpolatedTargetArg`
扫「`--dsh-target=` 与 `${{ … }}` 同行」的写法；可伪证夹具就是这次真实炸过的形状。
`dsh-targets.mjs --self-test` 另有四条断言钉住环境变量分支（含「环境变量里的未知目标
必须报错」——静默回退默认目标等于捆错运行时）。

> **同类风险提醒**：任何「把 `${{ … }}` 插进 `run:` 字符串当参数」的写法都有这个隐患。
> 本仓口径是**能用 env 就用 env**；确实需要插值时，先问「Windows 的 PowerShell 会不会
> 给出不同结果」。

### `beforeBuildCommand` 会把另一条通道的资源树整个覆盖（2026-09-15 实测，已修复勿回归）

比上一条更严重：alpha 线的 Smoke 日志里，**同一个 job 出现了第二次组装**——tauri build
跑到一半，`tauri.conf.json` 的 `beforeBuildCommand`（当时是 `npm run prepare:harness`）
又执行了一次组装。那一步在 tauri 内部触发，**拿不到 workflow 里显式选的目标**，于是按
默认目标（next）重新组装 `resources/`，把上一步刚组好的 alpha 树覆盖掉。

后果是「**版本号说 alpha、运行时是 next**」：alpha 的安装包与 L2 GUI 冒烟实际测的是
next 线的运行时，而**所有步骤都是绿的**——没有任何一步报错，因为每一步单独看都没问题。
这是本仓「跨语言/跨层契约问题」的第三种形态：不是形状变了，而是**同一个位置被写了两遍，
后写的赢了，且没人知道**。

**修法（勿改回）**：组装与打包是两个动作。组装由人在 workflow 里显式选目标
（`env: DSH_TARGET` + `npm run prepare:harness`）；打包只该**校验**「树还是那棵树」，
因此两个钩子都改成 `--check`：

```jsonc
"beforeDevCommand": "npm run prepare:harness -- --check",
"beforeBuildCommand": "npm run prepare:harness -- --check"
```

`prepare-harness.mjs --check` **绝不组装**：它断言 `resources/` 的指纹与 `MANIFEST.target`
都等于本次目标；不一致时打印「实际装载 vs 本次目标」并给出正确的组装命令，退出码 1。

**守卫**：`verify:release-workflow` 的 `checkTauriHooksAreCheckOnly` 读 `tauri.conf.json`，
断言这两个钩子（凡是调用 `prepare:harness` 的）必须带 `--check`；可伪证夹具就是被打回
旧写法的同一份配置。⚠️ 改动这两个钩子前先想清楚：**它们跑在 tauri 内部，看不见 workflow
的 env**——任何在那里「重新组装」的写法都必然会按默认目标覆盖当前树。

#### ⚠️ 已知环境限制：GNU 工具链下本地 `tauri build` 出的安装包缺 `WebView2Loader.dll`

本机（`x86_64-pc-windows-gnu`）执行 `npm run tauri build` **能**产出安装包，但装完启动即：

```text
dsh-desktop.exe: error while loading shared libraries:
WebView2Loader.dll: cannot open shared object file
```

- **根因**：GNU 构建下 `webview2-com-sys` 在运行时从 exe 同目录加载 `WebView2Loader.dll`；
  tauri-bundler 把该 DLL 放进 `target/release/`（所以**裸 exe 能跑**），却**没有**把它列进
  NSIS 安装包的文件清单——安装目录里没有它。
- **本地自测的绕法**：`cp target/release/WebView2Loader.dll "<安装目录>/"` 后再启动。
  2026-09-21 验证「装机缺 `parent-death-watchdog.mjs`」修复时实测有效（拷贝后安装版
  从安装目录的 resources 正常起到 Harness）。
- **结论**：本地 GNU 安装包**不是可发布形态**；正式产物一律走 CI 的 MSVC 三平台构建
  （`release.yml`）。本地 build 的定位是「验证打包清单与产物内容」，不是「出可发布的包」。

#### ⚠️ 该 DLL 的必需性**依目标工具链而定**，不可一概而论

同一件事在 MSVC 侧的表现完全相反，必须分清，否则会写出「只在一半环境成立」的判据：

| 目标三元组 | `webview2-com-sys` 链接方式 | 根目录是否需要 `WebView2Loader.dll` |
| --- | --- | --- |
| `x86_64-pc-windows-msvc`（CI / `windows-latest`） | **静态**（`WebView2LoaderStatic`） | **不需要**，也**不会**产出——缺它是正常形态 |
| `x86_64-pc-windows-gnu`（本机） | **动态**（`WebView2Loader.dll`） | **必需**，缺失即启动 `0xC0000135` |

判据来自上游源码的 `cfg_attr`，不是经验推测：

```rust
#[cfg_attr(target_env = "msvc",     link(name = "WebView2LoaderStatic", kind = "static"))]
#[cfg_attr(not(target_env = "msvc"), link(name = "WebView2Loader.dll"))]
```

- 代码侧的统一出口是 `package-portable.mjs` 的 `needsWebView2LoaderDll(triple)`；
  `REQUIRED_SIDECAR_FILES` 只是**候选**清单（staging 与 manifest 一律按**存在性**处理）。
- 🔴 **2026-09-23 事故**：便携打包的前置校验曾写成 `if (isWindows) { 要求 DLL }`，把
  GNU 才成立的事实当成通用前提，于是在 CI（MSVC）上把一份完全正确的产物判成「输入产物
  不完整」，`v0.7.0-alpha.4` 发布链被自家守卫卡死。**平台 ≠ 工具链**——判据要与「谁需要它」
  同源，而不是与「哪个平台」同源。
- 自测里对应的是**双 ABI 交叉覆盖**（`x86_64-pc-windows-msvc` 与 `-gnu` 两个 triple 都在
  同一台机器上跑一遍）。**不许**按宿主 triple 分支：宿主工具链是环境属性，按它分支会导致
  本机与 CI 各验一半、双双变绿——缺陷正是这样躲过全部自测的。

#### 🔴 归档条目名用反斜杠：Linux 侧核验必然红（2026-09-23 alpha.6 实测根因，已修复勿回归）

`Compress-Archive` 这个命令名在**不同 PowerShell 上产出的 zip 不一样**：

| 生产者 | 条目名 |
|---|---|
| Windows PowerShell **5.1**（runner 里的 `powershell`） | `resources\harness\a.json` ❌ |
| PowerShell **7.x**（`pwsh`） | `resources/harness/a.json` ✅ |

同一台机器、同一份源目录实测对照：5.1 产出 3/3 条含反斜杠，7.6.6 产出 0/3。

后果链条：Linux 的 Info-ZIP `unzip` 遇到反斜杠条目**判警并返回退出码 1**，而 `--verify-download`
把非 0 一律当失败 → 发布红在 `cli-publish` 的「核验便携版产物」这一步。即便它「成功」，也只
解出字面名 `resources\harness\a.json`，随后 `dirStats(probeDir/resources)` 数到 0 个文件。

**为什么潜伏这么久**：打包期的回读校验跑在 **Windows**（`Expand-Archive` 把 `\` 当分隔符，宽容），
发布期的核验跑在 **Linux**（`unzip` 严格）。两个平台各自只看自己那一半——与本小节开头
「平台 ≠ 工具链」「按宿主环境分支的断言 = 只验一半」是同一个病，只是这次病在**归档格式**上。

**修法（勿改回）**：

- 在**产出侧**规范化：`normalizeZipSeparators()` 把条目名的 `\` 原地**定长**替换成 `/`
  （定长 ⇒ 偏移、CRC、压缩流一概不动，只碰名字字段）。修在产出侧而非核验侧，Release 上的
  归档因此对任何标准工具可读，而不是要求每个消费方各自宽容。
- 规范化后**硬失败**：`remaining > 0` 抛错；`entries === 0`（中央目录读不出）也抛错。
  静默放过等于把缺陷推到 Linux 上才现形。
- 只读**中央目录**（EOCD → CD 记录），**不许**扫 `PK\x03\x04`：数据区里完全可能出现同样的
  字节序列，扫到就会改坏归档。
- `--verify-download` 的失败信息**必须带解包器的输出**：原先 `stdio: 'ignore'` 把唯一能解释
  失败的信息丢了，只剩一句「退出码 1」。现在捕获 stderr 并附进 problem。
  > 本机 sandbox 下「stdout 被管道接管」的外部 spawn 一律 `EBUSY`（`encoding: 'utf8'` 与默认
  > 都失败，`stdio: ['ignore','ignore','pipe']` 成功），故只接管 stderr——诊断信息本来就在 stderr。
- 自测（`verify:portable-package` 54 → **71 项**）：夹具用**纯 Node** 直写 zip 结构，
  **不拿 PowerShell 当输入**——被怀疑的生产者不能同时充当判据的输入，否则它一变测试就跟着变
  （对称失效）。断言覆盖：多级名字整体规范化、定长（只改 10 个字节且全为 `0x5C → 0x2F`）、
  幂等、正斜杠归档逐字节不变、EOCD 损坏时读不到条目且不动文件。
- 独立复核手段（本机没有 `unzip`，故用标准库）：规范化后的归档交给 **Python `zipfile`**
  读一遍——`namelist()` 无反斜杠、`testzip()` 返回 `None`（CRC 全通）、内容可读。这比拿自己写的
  读取器复核自己写的改写器可信。

