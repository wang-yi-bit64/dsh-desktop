# CLI 与 Runtime 可引用产物 — 开发计划

> 状态：**Phase 1 已执行（2026-09-13）；Phase 2 未开工，带明确触发条件。**
> 上游依据：[`roadmap.md`](roadmap.md) H1（资产化 `dsh-host`，H1-c 发布为可引用产物、H1-d 用 CLI 自证）。
> 本文只覆盖**分发形态**；`dsh-host` 的代码架构边界见 [`AGENTS.md`](../AGENTS.md) §3 与 INV-6。

---

## 1. 问题陈述

`dsh-host-cli`（`start` / `stop` / `status` / `tail` / `probe` / `doctor`）与组装好的
runtime bundle（`src-tauri/resources/`，~267 MB）都**只作为源码 / 桌面安装包的内部零件存在**：

| | 现状 | 后果 |
|---|---|---|
| **CLI** | 只有两个仓库内脚本消费（`smoke-launch.mjs`、`fault-inject.mjs`），且**不在** `tauri.conf.json` 的 `bundle.resources` 里 | 第三方要用它必须 clone + 装 Rust 工具链 + 自己编译；装了桌面的用户机器上也没有它 |
| **Runtime bundle** | 由 `prepare-harness.mjs` 组装后整棵塞进 NSIS / dmg / deb，作为不透明载荷 | 没有独立版本号、没有可单独核对的哈希、不能单独下载；「运行时更新 / 回滚」无从做起 |

「可引用产物」= 有**独立版本号**、**可按平台指名引用**、**带校验和**、**不依赖本仓即可使用**的发行物。

## 2. 为什么先做 CLI（Phase 1），而不是先做 runtime（Phase 2）

CLI 侧几乎零成本且立刻有真实用途：它是「无 GUI 可靠层」这个定位第一次有**实物**——
`roadmap.md` H1-d 要的自证（用 CLI 在无头环境跑通启动→就绪→恢复）不需要 runtime 独立发布即可完成。
runtime 独立发布则要动 `Layout` 的资源解析语义与更新事务，**应当等第一个真实消费者出现再做**，
否则就是在为「可能有用的未来」建基础设施——那正是批次 F 归档 `dsh-model-gateway` 的同一类判断。

---

## 3. Phase 1 — CLI 作为可引用产物（已执行）

### 3.1 交付物形状

发布到与本版本同一个 GitHub Release 下，三平台各一份：

```
dsh-host-cli-v0.3.0-x86_64-pc-windows-msvc.zip        + .sha256
dsh-host-cli-v0.3.0-aarch64-apple-darwin.tar.gz       + .sha256
dsh-host-cli-v0.3.0-x86_64-unknown-linux-gnu.tar.gz   + .sha256
```

归档内含二进制、`README.txt`（自述用法与退出码）、以及在仓库根存在 `LICENSE` 时的授权副本。
另传一份 `<base>.manifest.json` 记录版本 / 三元组 / 文件大小 / sha256，供上传与核验步骤取用
（不靠文件名 glob 猜，三个平台的 manifest 各自带三元组、不会互相覆盖）。

### 3.2 三条硬判据（都在 [`scripts/package-cli.mjs`](../scripts/package-cli.mjs) 里，不在 workflow 的 bash 里）

1. **产物名由版本与目标三元组唯一决定**，版本读 `package.json`（唯一真源），不接受调用方手写——
   手写的那个版本号迟早与 tag 漂移，而产物名里的版本没有人会去核对。
2. **回读校验**：归档建好后解包回读，与源二进制逐字节比对哈希，并检查可执行位（Unix）。
   `tar` / `Compress-Archive` 退出码为 0 **不等于**「解开来还能用」：丢掉可执行位这类缺陷
   只有下载它的人才会发现。
3. **产物执行自检**（仅当目标三元组 == 本机时）：解包出来的那一份**真的执行**
   `--version`（必须回显本次版本）与一次 `status`（缺失资源树必须退出 `3` = `EXIT_MISSING_RESOURCE`）。
   架构不符 / 缺动态库 / 把 wrapper 当产物打进去，这几类都表现为「哈希完全正确、一执行就报错」。

外加一条**发布后核验**（`--verify-download`）：对**下载回来**的归档与边车比对 manifest。
上传链路（artifact 存储、Release 资产）改坏文件这件事，本地怎么验都验不出来。

### 3.3 接线点

| 位置 | 做了什么 |
|------|---------|
| `scripts/package-cli.mjs` | 打包 / 命名 / 边车 / manifest / 回读校验 / 产物执行自检 / 已发布核验 / 正文渲染（幂等）+ `--self-test`（38 项，含可伪证夹具） |
| `scripts/dry-run-cli-publish.mjs` | 把 `cli-publish` 的 `run:` 段落从 `release.yml` **原文抽出并逐字执行**（假 `gh` 截网、一次性检出布局、无副作用） |
| `package.json` | `package:cli`、`verify:cli-package`、`verify:cli-publish` |
| `release.yml` → `cli` job | 三平台 `cargo build --release -p dsh-host-cli` → `npm run package:cli` → `upload-artifact`。**不依赖 300MB 资源树**，故与 `build` 并行、各自失败互不牵连 |
| `release.yml` → `cli-publish` job | `needs: [preflight, build, cli]`（Release 对象由 build 的 tauri-action 创建，先传必失败）→ 下载 artifact → 逐平台核验 → 上传（`shopt -s nullglob` + 逐类断言 + `--clobber`）→ 把产物表写进 Release 正文 |
| `ci.yml` | `verify:cli-package`（三平台静态门禁）+ 构建 release 二进制后跑 `verify:cli-publish` |
| `release.yml` → preflight | `verify:cli-package`（秒级，在组装 300MB 之前失败） |

### 3.4 为什么这些判据要有守卫

`verify:release-workflow` 扩展了两类检查，都属于「只有真跑发布才炸」：

- **产物形状**：打包步骤缺席（产物根本没产出而工作流是绿的）、上传漏 `--clobber`
  （`workflow_dispatch` 兜底重跑会因资产已存在失败，而重跑正是发布失败后的补救通道）、
  漏传任一平台任一格式的边车 / manifest、`cli-publish` 漏 `needs: build` 或漏 `needs: cli`、
  缺平台、上传步骤没设 `shopt -s nullglob`（glob 未命中会把字面量路径传给 `gh`，
  报错指向不存在的文件而不是「这类产物没产出来」）、读 Release 正文时没做 `null` 归一。
  判据**按 job 切片**再断言：`needs` 这类形状只要文件里任何一处满足，全局匹配就会放行。
  各带可伪证夹具，并额外断言「CRLF 检出下判定一致」（判据不得依赖检出配置）。

`verify:cli-publish` 则把 `cli-publish` 的三个 `run:` 段落**逐字执行**。它存在的直接原因：
本任务的初版演练脚本**手抄**了工作流的上传循环，结果报出一个假缺陷（我抄件里给数组赋值
加了引号，引号阻止路径展开、`nullglob` 因此永不生效——工作流原文是对的）。
手抄一份实现去验收，验的是抄件而非真正发布的那段，因此改为从 YAML 原文抽取 `run:` 块执行。

⚠️ **这条演练的边界必须说清**：它用假 `gh`，只断言「文件存在、非空、带了 `--clobber`」，
不碰真实资产存储 / 权限 / tag 是否存在；且工作流的上传步骤要求**四类**产物齐全
（三平台矩阵整体产出的事实：Windows job 给 zip、Linux/macOS 给 tar.gz），单机上只能产出一种
归档格式，因此该步骤在本演练里**预期中止**并**显式声明跳过**上传相关断言（不是静默放行）。
它排除的是「脚本写错了」，不是「环境不允许」那一类。

### 3.5 本地已验证（2026-09-13）

打包 → 解包 → 对**真实 267 MB 资源树**执行，全绿：

```
sha256sum -c <archive>.sha256        → OK
dsh-host-cli status --resource <真树> → exit 0，resources: ok
dsh-host-cli doctor --resource <真树> → 6 checks, 0 fail, 0 warn
dsh-host-cli start  --resource <真树> → token acquired → ready http://127.0.0.1:4519 → 干净退出
```

另外：`verify:cli-publish` 逐字执行 `cli-publish` 的 `run:` 段落通过（核验步骤 + 正文渲染，
上传步骤受本机归档格式限制已显式跳过，见 §3.4）。

> 🔧 **2026-09-22 更新**：上面这条「上传步骤已显式跳过」**不再成立**。当时的跳过是
> 无条件成立的（单机只能造一种归档格式 → 必需清单里另一类必然缺席 → 每次都被放行），
> 于是「上传到底有没有真的执行」在任何平台都测不到，而 `dist/portable/*.tar.gz`
> 这个**永远不可能命中**的必需类也因此长期没人发现。现在：Windows 宿主同时造
> `.zip` 与 `.tar.gz` 并造出便携版，上传步骤能跑到底（文件数 / `--clobber` 是活断言）；
> 其余平台造不出的类逐条声明，判据锚在工作流的 `missing-artifact-class:` 标记与
> **产物类契约**（必需清单 == 夹具能造 ∪ 本机造不出）上。本机实测（Windows）：
> 三个 `run:` 段落全绿，上传 12 个文件。

### 3.5.1 首次真实发布已验证（v0.4.0，2026-09-13）

上面那份「尚未验证」清单已全部核对完毕，`release` 工作流 8 个 job 全绿：

| 待核对项 | 结果 |
|---|---|
| `cli` job 三平台是否都成功 | ✅ 三平台全绿；打包、回读校验（含可执行位）、产物执行自检、artifact 上传均通过 |
| runner 三元组名 | ✅ **`aarch64-apple-darwin`**（macOS runner 是 ARM）/ `x86_64-unknown-linux-gnu` / `x86_64-pc-windows-msvc`——与 §3.5 里担心的「本机无法预判」一致地由 runner 决定 |
| `cli-publish` 下载后核验 | ✅ 通过（这一步会暴露 artifact 传递中的任何改动，没有暴露问题） |
| 上传后资产完整性 | ✅ 9 个 CLI 文件（3 平台 × 归档 / `.sha256` / manifest）+ 4 类安装包 + `.sig` + `latest.json` |
| Release 正文与下载链接 | ✅ 表格 3 行、幂等标记恰好 1 次、3 个链接逐一命中真实资产 |
| 从公开 URL 下载并核对 | ✅ `sha256sum -c` OK；下载到的 sha256 与 manifest 逐字节一致；归档内可执行位为 `-rwxr-xr-x` |
| 自动更新链路未被影响 | ✅ `latest.json` 指向 0.4.0，7 个平台条目签名齐全 |

产物名（真实）：`dsh-host-cli-v0.4.0-{aarch64-apple-darwin.tar.gz,x86_64-pc-windows-msvc.zip,x86_64-unknown-linux-gnu.tar.gz}`

后续发布可直接沿用本节结论；只有改动 `cli` / `cli-publish` 的结构或归档逻辑时才需要重新核对。

### 3.6 已知边界（不得含糊）

- **CLI 不含 runtime**。归档里的 `README.txt` 与 Release 正文都显式写明这一点，并指向 `--resource`。
  产物自述与实际能力不一致，比缺失更糟。
- **macOS 二进制未公证**（Phase 3 才处理）；未签名，Gatekeeper 会给警告，`README.txt` 给出绕过步骤。
- **没有自动更新**：CLI 是手动下载的产物，不参与 updater 链路。

---

## 4. Phase 2 — Runtime bundle 独立发布（未开工）

### 4.1 要做的事

把 `prepare-harness.mjs` 的产物打成独立分发的归档，例如：

```
harness-runtime-<dsh-version>+<rev>-<platform>-<arch>.tar.zst   + MANIFEST.json + .sha256
```

版本轴定义为「上游 DSH 版本 + 构建修订」（补丁集跟随 DSH 版本走），与 app 版本解耦。

### 4.2 触发条件（满足其一才开工）

1. **出现第一个非本仓消费者**：第三方壳 / IDE host / CI 明确要用本仓 runtime 而不自己组装；
2. **开始做 `roadmap.md` H3-a 的运行时更新事务**——它必须以「runtime 可单独替换并校验」为前提；
3. **开始做 H2-a 的兼容性矩阵**——每个 bundle 自带 `MANIFEST.json` 时，矩阵从「文档声明」变成
   「发布了哪些 bundle、各自带什么 manifest」的可核对证据。

### 4.3 前置改造（真实工作量，别低估）

- `Layout` 需支持从**可写目录**加载 runtime（当前从 `resource_dir` 解析），才能做替换与回滚。
  [`paths.rs`](../crates/dsh-host/src/paths.rs) 已是所有派生路径的唯一产地，改动面可控。
- 需要更新事务与回滚（「当前版本 + 上一个版本」即可，不做多版本共存、不做 runtime 包管理器）。
- `constants.rs` 里的产品专属词汇（`dsh-desktop.patch.yml` / `[desktop]` / `desktop-safe-mode` /
  `desktop.log`）会成为**对外词汇表**，发布前要么收进 features 参数、要么在文档里说明。
- 分发通道与体积：单平台 ~267 MB，GitHub Release 资产上限 2 GB，需评估压缩率与是否分卷。

### 4.4 明确不做

- 不做 runtime 包管理器 / 多版本共存 / 依赖求解。
- 不把 `dsh-host` 发布到 crates.io 作为 Phase 2 的替代或前置：库只服务 Rust 消费者，
  而「可复用」的主要抓手是 CLI 与 runtime 这类**进程级**产物。库发布的边际收益是
  「有一页 registry 可引用」，触发条件同样是「出现第二个真实消费者」。
