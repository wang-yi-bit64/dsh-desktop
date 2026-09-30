# 发布与 CI 事故档案

> 从 `AGENTS.md` §4 迁入，原样保留。

### 发布工作流的两个静默缺陷（已修复，勿回归）

`v0.1.0` 首次发布时，三个平台的 release job **全红**，但失败点各不相同，且本地门禁全绿——只有真跑发布才暴露。两处根因都已修正并加了守卫 `npm run verify:release-workflow`：

1. **tauri-action 会自己插入 `build` 与 `--`**。其 `Runner.execTauriCommand` 拼出的 argv 是
   `[...tauriScript] + ['build'] + (npm 且有参数 ? ['--'] : []) + [...args]`。
   本仓原来写成 `tauriScript: npm run tauri --` + `args: build --bundles …`，实际展开成
   `npm run tauri -- build -- build --bundles …`，tauri CLI 报 `unexpected argument 'build' found`。
   正确形状是 `tauriScript: npm run tauri`（不带 `build`、不带尾随 `--`）+ `args: --bundles …`（只放选项）。
   守卫会**模拟**该拼装逻辑，断言 `build` 恰好出现一次、且 `tauriScript` 自身不含 `build`/`--`。

2. **macOS 的 bash 3.2 不认全角标点作变量终止符**。生成发布说明的脚本里写了
   `**首次发布**（$TAG）`：macOS runner 的 bash 3.2 在没有 UTF-8 locale 时会把紧跟其后的
   全角 `）` 并进变量名，解析成变量 `TAG）`，报 `TAG）: unbound variable`（Linux/Windows 的
   bash 正确终止，所以只有 macOS 这一台红）。修法是变量一律写 `${VAR}` 花括号形式。守卫用正则
   扫 release.yml 里「未加花括号的 `$NAME` 紧邻非 ASCII 字符」的可执行行（注释与 `${{ … }}` 表达式除外）。

两条判据都带**可伪证性检查**：把上述旧写法当夹具，断言必须变红。

### 临时目录清理失败否决了主结论：一次通过的核验被判成发布失败（2026-09-23 实测，已修复勿回归）

`v0.7.0-alpha.5` 的发布在**最后一步** `publish CLI + portable artifacts` 失败。日志里最刺眼的是：
**前面三条都绿**，红的只是一句与核验无关的清理：

```
✅ 已发布产物核验通过：dsh-host-cli-…-aarch64-apple-darwin.tar.gz   sha256=6811d79b…
✅ 已发布产物核验通过：dsh-host-cli-…-x86_64-pc-windows-msvc.zip    sha256=8dd3a2ac…
✅ 已发布产物核验通过：dsh-host-cli-…-x86_64-unknown-linux-gnu.tar.gz sha256=b3a06859…
package-portable 失败：EACCES: permission denied, unlink '/tmp/dsh-portable-probe-dxo46J/resources/harness/node_modules'
```

根因不是核验判据，而是 `verifyDownloaded()` **`finally` 里的 `rmSync(probeDir, …)`**：

1. `--verify-download` 跑在 ubuntu 的 `cli-publish` 上，要解包的是 **Windows 产出的 `.zip`**；
   `unzip` 恢复出的目录权限位可能不可写（zip 不记录 Unix 权限），删到
   `resources/harness/node_modules` 这种深层目录时 `unlink` 报 EACCES。
   `rmSync` 的 `force: true` **只忽略「不存在」，不忽略 EACCES**。
2. `finally` 里抛出的异常会**覆盖** try 块的返回值 → 一次**通过**的核验被这句清理判成了
   发布失败；更糟的是 `problems` 数组**从未被打印**，没人知道核验到底过没过
   （诊断时只能从「三条 CLI 绿 + 没有其他 ERROR」反推它本来是过的）。

**修法**：新建 [`scripts/remove-tree.mjs`](scripts/remove-tree.mjs)，把「删临时目录」做成
**尽力而为**的纯逻辑，`package-cli.mjs` / `package-portable.mjs` 的**生产路径**清理点全部改用它：

- `removeTreeBestEffort(dir)` **永不抛**，返回 `{ ok, error, attempts }`；调用方最多打一条
  `console.warn`，**结论照常返回**；
- 三级降级：直接删 → 递归恢复写权限后再删（`grantWritePermissionRecursive`，**不跟随符号链接**——
  `chmod` 顺着链接会改到仓库里真实文件的权限）→ OS 兜底（`rm -rf` / `rmdir /s /q`）；
- `remover` / `osRemover` / `chmod` 均可注入，因此「三级顺序」与「不跟随链接」这两条契约
  能在纯函数测试里断言，不必依赖宿主的权限语义；
- `verifyDownloaded` 新增可注入的 `removeTree`，自测注入「永远失败」的清理器，
  断言**结论逐字不变**——这是本次事故的回归守卫（实现若再让异常冒泡，该自测当场判红）。

判据入口：`npm run verify:remove-tree`（自测 21 项），已接入 ci.yml 与 release.yml 的静态门禁；
`verify:portable-package` 52 → 54 项。**教训**：辅助动作（清理、日志、上报）**不得有能力否决主结论**；
把它们写进 `finally` 时要问一句「这里抛了会怎样」——答案是「会覆盖主结论」，那就必须吞掉并降级为告警。

> ⚠️ 这条与前面几条构成同一个序列：`v0.7.0-alpha.5` 一共暴露出**四处**「被前置失败掩盖的潜伏缺陷」
> （picker 位置 → FFI 单例 → sharp libc → 清理否决结论）。**修好一个红灯不要假定下一个也绿**，
> 尤其不要把「Release 已存在」当成「发布成功」——按**资产清单**数（见 §8.5）。
> 序列在 `v0.7.0-alpha.6` 的准备里继续了**第五处**，见下一节。

### 镜像目录的脚本清单写死：CI 在一片绿之后才红（2026-09-23，已修复勿回归）

> 🗄️ **2026-09-24 更新**：涉及的演练（`dry-run-cli-publish.mjs`）已随 CLI 发布通道退役
> 归档到 `docs/archive/`，因此**这条链路当前没有活的入口**。本节保留为**方法论记录**——
> 「手抄清单迟早与真实依赖脱节」这条教训与具体脚本无关，恢复通道或写同类演练时仍然适用。

`ci.yml` 的 `Build CLI and dry-run the publish steps`（`npm run verify:cli-publish`）**本机无法复现**——
它需要一个已构建的 release 二进制，而本机 node 连 git/tar 都 spawn 不了（`EBUSY`）。
于是 `12e7e49` 让 `package-cli.mjs` 开始导入 `./remove-tree.mjs` 之后，**没有任何本地检查会跑它**，
直到下一次 CI：

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/dsh-publish-dryrun-85OKdf/scripts/remove-tree.mjs'
imported from /tmp/dsh-publish-dryrun-85OKdf/scripts/package-cli.mjs
```

根因：演练在临时目录里搭「最小检出布局」，而**要复制哪些脚本是写死的**
（`['package-cli.mjs', 'package-portable.mjs']`，注释还写着「两个脚本都只依赖 Node 内置模块，
因此复制三个文件即可」）。这个前提被新的本地 import 打破，而写死的清单**没有任何机制**会因此报错——
`ERR_MODULE_NOT_FOUND` 只在子进程启动那一刻才出现，且被包装成「步骤退出码 1，
不是产物类缺失」这种指向不明的告警。**同一形态的第三例**（前两例：四处手抄的资源清单、
`needsWebView2LoaderDll` 的候选清单），结论不变：**手抄清单迟早与真实依赖脱节，要算不要抄。**

**修法（勿改回）**：

- `scriptMirrorClosure()` 按**本地导入闭包**算要复制的脚本——四种写法都抓（`import x from './y'`、
  `export … from './y'`、动态 `import('./y')`、副作用 `import './y'`），只认 `./` 前缀；
  引用了不存在的脚本时**响亮抛错**并点名文件，不静默少拷。
- 复制完再用 `unresolvedMirroredImports()` 复核一遍：把「子进程里的 `ERR_MODULE_NOT_FOUND`」
  提前成这里的一句人话（独立第二判据——闭包靠正则，正则可能漏写法）。
- `mirrorSelfCheck()` 是纯逻辑自检（`--self-test` 本机可跑，是这条链路唯一能本地验证的部分），
  其中**硬编码**「`remove-tree.mjs` 必须在闭包里」作为**独立事实**，不用闭包自己现算——
  否则判据错了期望值跟着错，又变成对称失效（与 §「按宿主环境分支的断言」同一教训）。
  另含可证伪性走查：合成三层树验证传递边被穿透、裸包名不被当成本地文件。

### 变更说明的默认基线必须相对 `--to` 求（已修复，勿回归）

`release.yml` 用 `changelog.mjs --notes --to "$TAG"` 生成 Release 正文。`--from` 省略时的默认基线**不能**写成「全仓库最近的 tag」：发布时 `$TAG` 这个 tag 必然已经存在（它就是刚 push 上来的那个），从 `HEAD` 去找会把它自己找回来，`--from` 与 `--to` 指向同一处，区间退化为 `v0.1.0..v0.1.0`，正文变成「区间内没有提交」——**首个版本的 Release 说明整篇空白，且不报错**。

正确做法是相对 `--to` 求上一个 tag：`latestTag({ rev: \`${to}^\` })`（推导已抽成 `conventional-commits.mjs` 的 `baselineRefFor()`）。另外 `--notes` 遇到空区间现在**直接失败**：空白正文会被 GitHub Release 原样展示，没人会注意到「这个版本没什么可说的」其实是一次自动化故障。

`changelog.mjs --self-test` 里有一条建临时 git 仓库实跑区间解析的断言钉着这点（渲染层纯逻辑断言抓不到它——错在「与 git 的交互」上）。实测：同一首次发布场景，旧实现读到 0 条提交、新实现读到全部历史（98 行 / 13063 字符 / 8 章节，对比修复前的 5 行 / 115 字符 / 0 章节）。

