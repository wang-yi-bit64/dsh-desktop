# 契约形状与 IPC 事故档案

> 从 `AGENTS.md` §4 迁入，原样保留。跨语言契约问题的两种形态（形状变了消费方不报错）与三条纪律都在这里。

### 目录选择器必须走 Host seam，禁止引入 renderer 全局桥（已修复，勿回归）

Harness 页面运行在 Tauri webview 中。**此处曾有一处机制误判，已更正**：早期版本写「没有 preload / initialization script，任何 `window.*` 全局都无处定义」——**这句话是错的**。Tauri 的 `WebviewWindowBuilder::initialization_script` 会在每次顶层导航前执行脚本，正是 preload 的等价物；本仓已用它向 Harness 页注入手机状态指示器（见 §7.2 与 `src-tauri/src/harness_ui.rs`）。所以「定义不了全局」这个理由不成立。

**结论不变，但理由要换成成立的**：曾有一个 `patch-package` 补丁把原生目录选择器改成 `window.dshDesktopDirectoryPicker.pick()`，该全局在整个仓库中从未被定义（从没有任何注入脚本定义过它），导致工作区导入时必然弹出「无法打开文件夹 / DSH Desktop directory picker bridge is unavailable」。

即便今天有能力定义这样一个全局，**也不该走这条路**：页面若要回连宿主，就得为 Harness 这个**远程 origin** 开一个 IPC 入口，而本仓的命令面是收紧的（见 INV-2 与 §7）。注入机制只用于**壳层 → 页面**的单向下发。

正确路径是上游 stock 实现：客户端调用 `ctx.uiWorkspace.pickDirectory()` → Host `ctx.directoryPicker` seam → `@deepseek-ai/dsh-host-directory-picker-native` 在 Harness 进程内拉起 Win32 `IFileOpenDialog`。因为 Harness 绑定 `127.0.0.1`，`directory-picker-auto` 必定解析到 native 组合，无需任何 renderer IPC（这也与 INV-2 一致：harness 页没有 remote capability，本来也调不动宿主命令）。

`scripts/prepare-harness.mjs` 的 `assertPickerSurfaceIsHostBacked()` 会在应用补丁后校验该文件不再引用 `window.dshDesktop*` 且仍调用 `ctx.uiWorkspace.pickDirectory()`，违反即构建失败。

### 快照契约：`HarnessSnapshot.phase` 必须 `#[serde(flatten)]`（已修复，勿回归）

`harness_status` 命令与 `harness://status` 事件共用同一个载荷 `HarnessSnapshot`，契约为 `phase` 的 tag 与 `message` / `logs` **平铺**（与上游 `RuntimeStatus` 一致）：

```json
{ "phase": "failed", "cause_kind": "plugin_fault", "plugin_fault": true, "message": "…", "logs": ["…"] }
```

此前 `state.rs` 只**写了这句话**、漏了属性，实际发出 `{"phase":{"phase":"failed",…}}`。编译器不会报错——`Serialize` 照常成功，只是形状变了；而唯一的消费方 `frontend/error.html` 判的是 `snapshot.phase === 'failed'`，于是**恒为 false**：「疑似插件故障 → 建议进入安全模式」分支与安全模式按钮**从未生效过**。2026-09-10 用 serde 探针打印真实 JSON 才定位到。

这是跨语言契约问题的典型形态：**两侧各自都没错，错在中间的形状**。守护它的是 `state.rs` 的 `snapshot_json_keeps_the_phase_tag_flat`（CI 运行；本机 GNU 工具链跑不了 `src-tauri` 单测，原因见 §2）。

### 插件「已安装但未生效」的两类根因（已修复，勿回归）

市场对「安装成功却不在 `dsh.profile.bundles` 里」的包会给出结论，历史上此处出过两个独立缺陷，都会让一个**声明了 `dsh.bundle.patch` 的插件**永远挂载不上：

1. **`dsh.client` 单独作为「纯客户端插件」判据**：`vendor/dshmarket/src/verify.ts` 的 client-only 分支原本只测 `dsh.client !== undefined`。同时声明 `dsh.bundle` **和** `dsh.client` 的包（如 `dsh-better-sidebar`）因此被误判为「未声明 dsh.bundle」，提示用户「重启后由市场自动挂载生效」——而重启永远不会让它生效。判据必须成对：`dsh.client !== undefined && dsh.bundle === undefined`（`hasHostHalf` / `hot.ts` 的 shim 挂载早已如此）。
2. **cold-start 投影从未被调用**：`generations/projection.mjs` 的 `projectGenerations()` 是唯一会把 generation 插件写入 `dsh.profile.bundles` 并建立 `node_modules` 链接的函数，但整个仓库没有任何调用方——注释里说的「cold-start projector」并不存在。因此 generation 安装只 publish 了 manifest（`syncBundles: false` 是有意的：Harness 运行时不能替换 junction），却再也没有第二次机会把 bundle 层补上。修复在 [`build/harness-node-entry.mjs`](build/harness-node-entry.mjs)：在 import DSH 入口**之前**、且仅当 `$DSH_HOME/profiles/.generations/desired.json` 存在时执行 `projectGenerations()`，随后执行同样从未被调用的 `sweepRegistry()`。投影只收录**自己声明 `dsh.bundle.patch`** 的 generation：`loadProfile` 遇到列入 `bundles` 却没有 `dsh.bundle` 的包会直接抛错，整棵 profile 起不来，而纯客户端插件正是这种形状（它们由市场 shim 挂载）。已列入的条目除 generation 自有项外一律保留（部分 bundle 从 dsh 安装目录解析，重建列表会误删）。

配套：`scripts/prepare-harness.mjs` 的输入指纹此前不含 `build/`，而 `build/` 是原样拷进 `resources/` 的非依赖文件——改了 `harness-node-entry.mjs` 后指纹不变，快速路径复用旧副本，修改被静默丢弃。现在指纹包含 `build/` 摘要，且快速路径会调用 `copyBuildFiles()` 同步产物。（`vendor/` 无需摘要：这些条目以符号链接进入 `resources/`，打包时解引用，内容始终最新。）

### 统一 IPC 封套（`IpcEnvelope`）改造会**静默**打断页面（已修复，勿回归）

2026-09-10 批次 E 把 17 个命令从 `Result<T, String>` 改成 `IpcEnvelope<T>`。改动本身是正确的（前端因此能按错误类别分派），但它**当场打断了 `frontend/updates.html`**，而且没有任何编译错误、没有异常、没有日志：

```js
// 改前：拿到快照
invoke('updates_status').then(apply)
// apply 的第一行
if (!snapshot || !snapshot.phase) return
```

加上封套之后 `apply` 拿到的是**封套**而非快照，`snapshot.phase` 恒为 `undefined`，于是**每次调用都静默早退，整页永不渲染**。同一批里 `run()` 还漏判了 `success`，把「没有可用更新」这类业务失败当成了成功。

这是跨语言契约问题的第二种形态（第一种见上一节）：**形状变了，消费方不报错，只是安静地不工作**。三条纪律由此确立：

1. **命令不返回 `Err`**。外层 `Result` 恒为 `Ok`（只为满足 Tauri 对 `async` 命令的编译要求）；返回 `Err` 会让封套连同 `error.code` / `error.category` 一起丢掉，消费方退回读字符串。
2. **页面必须解包 `success`**，并把 `envelope.data` 当载荷用（`updates://status` 这类**事件**给的才是裸快照——同一页面两种载荷形态，别弄混）。
3. **改命令返回形态属于破坏性变更，必须过 `npm run verify:shell-pages`**。该守卫在 DOM 桩里真点每个页面的按钮并跑内联脚本，P6 专查「调用了命令却没解包封套」。上面两处缺陷就是它抓到的。

#### 后续回归：不要把 `IpcEnvelope` 放进 `Err` 位置（2026-09-11 修复）

批次 E 之后 CI 三平台 `cargo clippy` 全红，下游 smoke / bundle 被连带跳过。根因很单一：

```text
error: the `Err`-variant returned from this function is very large
  --> src-tauri/src/commands.rs:66
   |  fn ensure_local_origin(webview: &WebviewWindow) -> Result<(), IpcEnvelope<()>>
   |                                                    ^^^^^^^^^ the `Err`-variant is at least 128 bytes
note: `-D clippy::result-large-err` implied by `-D warnings`
```

`AppError` 里装着两个 `String`、一个可选 `String` 与一个 `serde_json::Value`，于是
`size_of::<IpcEnvelope<()>>()` = **128 字节**。它一旦出现在 `Err` 位置，clippy 就会把
「按值返回的 `Result` 每穿一层调用搬 128 字节」判为问题——在 `-D warnings` 下这是错误。

**修法（勿改回）**：`ensure_local_origin` 的 `Err` 改为 `Box<IpcEnvelope<()>>`
（`guard!` 宏相应 `failed(*error)`）。

**为什么不改共享契约**：`CommandResult<T> = Result<IpcEnvelope<T>, String>` 把封套放在
**`Ok`** 位置（`Err` 是 24 字节的 `String`），clippy 不管它；因此「给 `AppError` 拆箱」之类
的改法会让**所有**错误构造都多一次分配，却只修得掉上面这一处——成本与收益不成比例。

**为什么不 `#[allow(clippy::result_large_err)]`**：本仓库口径是能修根因就不压制，而
`Box` 正是 clippy 自己给的两条建议之一。若将来确有需要压制的场合，请连同理由一起写进本节，
不要就地挂一个裸 `allow`。

**这条 lint 本地能拦**（见 §2 关于 clippy 的实测复核）：改完跑
`cargo clippy --workspace --all-targets -- -D warnings`，不要等 CI 三平台跑一轮才发现。

