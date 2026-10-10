# patches/ 补丁分级清单

> **单一事实源是 [`scripts/patch-layers.mjs`](../scripts/patch-layers.mjs)**；本文件是它的说明与判据记录。
> 两者一致性由以下命令强制校验（`npm run gate -- patches`，也跑在 CI 的 test job 中）：
>
> ```bash
> npm run gate -- patches                                        # 逐个目标检查
> node scripts/patch-layers.mjs --list --dsh-target=alpha        # 看某目标的分级
> ```

---

## 0. 双通道：补丁按目标分目录（2026-09-15 起）

本仓同时维护**两条上游运行时通道**，各自持有一套补丁与 vendored 覆盖包：

| 目标 | 上游线 | 补丁目录 | vendored 覆盖包 | 对应桌面版本 |
|---|---|---|---|---|
| `next` | npm `next` dist-tag，**当前锚在上游 `next` 线的 `0.2.0-rc.2`**（2026-09-30 从 `0.1.5-rc.3` 跨两个 minor 推进，含上游重构；预检 clean 2 / conflict 12，经三路合并后 10 个补丁全部 clean） | `patches/next/`（条数不写死：`--list` 为准） | `packages/next/`（**已清空**，2026-09-24） | `<x.y.z>-rc.<n>[+<w>]`（**合成号**，ADR-061；`<n>` = 台账 `builds[]` 同组 max+1；具体值以 `package.json` 为准） |
| `alpha` | npm `alpha` dist-tag（当前 `0.2.1-alpha.1`）（2026-10-07 从 `0.1.7-alpha.2` 跨 minor 推进，含上游重构；预检 clean 4 / conflict 7，经行号重算 + 语义重做 3 个 + 退役 1 个后 10 个补丁全部 clean） | `patches/alpha/`（条数不写死：`--list` 为准） | `packages/alpha/`（已清空） | `<x.y.z>-alpha.<n>[+<w>]`（合成号；ADR-057 的**跨通道单调**要求继续有效——alpha 构建须排在最高 rc 构建之上，旧数值示例已作废） |

构建时用 `npm run prepare:harness -- --dsh-target=<name>` 选一条；发布时由 **tag 的预发布
通道名**自动推导（`release.yml` 的 preflight 调 `scripts/dsh-targets.mjs --channel-of`）。
未知通道（如 `beta`）**直接失败**而不是回退默认目标——回退会产出「版本号说 beta、
运行时却是 next 线」的包，而用户要装上才发现。

**分级表按包名索引，不按文件名**：同一个包在两个目标下的补丁做的是同一件事，
只是行号随上游版本变化。按包名登记意味着新增一条上游线**不需要**动
`patch-layers.mjs`——否则每加一条线都要复制一遍全部 `why` 文案，而复制品迟早漂移。

## 1. 为什么需要分级

`patches/<target>/*.patch` 是 `patch-package` 的**行级 diff**，锁定在该目标的
`DSH_VERSION`（唯一产地是 `scripts/dsh-targets.mjs`）。上游 DSH 处于灰度迭代期，
任一被补丁包改动一行，`patch-package` 就会冲突。此前 `prepare-harness.mjs` 对补丁
只有两种结果：**全成**或**中断构建**——于是一次纯视觉补丁的冲突就能阻断整条打包
链路，而品牌与 UI 增强类补丁本不该有这种权力。

> ⚠️ **移植补丁时必须重算行号**：`patch-package` 按 `@@ -N` 给出的行号定位，
> 偏移取 0、-1、+1 … **超过 ±20 行即放弃**（`dist/patch/apply.js` 的 `fuzzingOffset`）。
> 「把补丁从一条上游线复制过来、只改文件名」会让行号漂到 20 行以上——此时预检
> （按内容搜索，比它宽松）报 clean、真实组装报 failed，缺陷只在下载 300MB 组装
> 之后才暴露。2026-09-15 的 alpha 线移植就撞上了（`trajectory` 漂移 135 行、
> `llm-deepseek` 漂移 369 行）。修法与守卫：
> `node scripts/recount-patches.mjs --dsh-target=<target> --pristine=<未打补丁的包根>`，
> 以及 `check-patch-applicability` 里那条按 ±20 窗口判定的断言。

## 2. 三级失败策略

| layer | 含义 | 补丁失败时 | 典型成员 |
|---|---|---|---|
| `brand` | 品牌资源 / 身份（图标、名称、品牌位） | 记 Warn 并继续；产物退回原生品牌 | 当前**为空**，见下文 |
| `ui-behavior` | 视觉、文案与产品增强 | 记 Warn 并继续；该项增强缺失，应用仍可用 | 全部 `client-ui-*`、错误码文案、会话删除能力 |
| `functional` | 缺失会让补丁体系或桌面插件加载失效（**启动相关**） | **立即中断构建**（fail-fast） | 桌面插件包声明、插件 loader / 模块解析兜底 |

- **默认层是 `ui-behavior`**：未登记的补丁按可降级处理，并在报告中显式标为未登记，
  **不会**被静默当成 critical，也**不会**被静默放行而不报。
- `prepare-harness.mjs --strict`：所有层都按 `functional` 处理，恢复旧的「任一处失败即中断」行为。
- 逐补丁结果（`applied` / `skipped` / `failed` / 层名）写入 `resources/MANIFEST.json` 的
  `patches` 字段并打印成表，**不存在「未打补丁却无任何提示」的静默态**。

### `brand` 层为什么当前为空

品牌资源**不走** `patch-package`，而是由 [`scripts/install-brand-assets.mjs`](../scripts/install-brand-assets.mjs)
把 `build/logo-*.png`、`app-icon.png` 等直接注入 Harness web 前端产物（见 `prepare-harness.mjs` 第 4 步）。
该层保留在策略中是刻意的：一旦将来出现必须以补丁形式改品牌位的场景（例如官方把品牌位写进 JS 常量），
它已有明确的、比 `ui-behavior` 更宽松的策略位。**空层不是遗漏，而是事实陈述。**

---

## 3. 逐个补丁的分类判据（2026-09-10 人工确认；2026-09-15 alpha 线复核；2026-09-30 双线推进后复核；2026-10-07 alpha 线推进后复核）

分类原则：**只有当缺失会导致「补丁体系失效」或「桌面插件挂不上 / 起不来」时才归 `functional`**；
其余一律 `ui-behavior`（可降级）。产品功能增强（如会话永久删除）虽然影响功能，
但缺失时只是该操作报错、应用整体可用，因此归入可降级层，并通过 `retireWhen` 记录其长期归属。

下表按**包名**列（两个目标同名同判据）；实际文件名带各自目标的版本段，
如 `patches/next/@deepseek-ai+dsh+0.2.0-rc.2.patch` 与
`patches/alpha/@deepseek-ai+dsh+0.2.1-alpha.1.patch`。

### functional（条数不写死：`node scripts/patch-layers.mjs --list --dsh-target=<t>` 是权威）

| 补丁（包名） | 判据 | 退役条件 |
|---|---|---|
| `@deepseek-ai/dsh` | 把 `dsh-desktop-client-ui` / `dsh-desktop-hmr-fallback` / `dsh-desktop-market-installer` 三个桌面插件包声明为 dsh 依赖（第四个 `dsh-desktop-preset-transfer` 已于 2026-09-30 整链退役）。缺失则 `build/dsh-desktop.patch.yml` 的 `insert: name` 解析不到包，**profile 启动即失败** | 官方提供声明式扩展点（无需改 `package.json` 即可挂载外部插件） |
| `@deepseek-ai/cordis-plugin-loader` | 插件 loader 对裸 specifier 的 import 失败时，基于 `ctx.baseUrl` 用 `createRequire` 回退解析。桌面插件包位于 `node_modules`，缺失则**插件 import 失败**。<br>**2026-10-10（B4）同一补丁加了另一半**：入口 specifier 被交成**绝对 `file://` URL 而该文件并不存在**（典型形态：硬写的 `<pkgDir>/index.js`，而包的真实入口在 `main`/`exports` 里）时，那条 URL 是一条**死路**——`require.resolve` 不收 URL，URL 也从不走包解析 ⇒ 热挂载无声失败、回落重启（用户感知为「点了插件没反应」）。补丁在**任何下游解析之前**把失效的 `file://` URL 修成其 owning package 的裸名（按 `/node_modules/` 取**最内层**，覆盖作用域包与 pnpm 虚拟 store），并留 warn 让这次替换**可见**（AGENTS §7.1 禁无声降级）。<br>🔴 落点必须在 `composeError` 异步体的**顶部**：`this.ctx.loader.internal` 存在时第一路直接 `return`，写在 `else` 分支里的救援在真机上**永不可达**（本仓实测判据 C1） | 官方 loader 支持从 `baseUrl` 解析裸包名，**且**上游解析器不再把绝对入口 URL 交给 loader |
| `@deepseek-ai/dsh-client-modules` | `ClientModuleRegistry` 解析 `${expectedPackageName}/package.json` 定位插件模块，渲染侧装载的最后一段依赖 | 官方 registry 自带 `createRequire` 解析 |
| `@deepseek-ai/dsh-typert-loader` | 上游把**启动路径**上「任一 contributor 注册失败」升级成 `AggregateError` 并从 `apply()` 抛出，而 typert-loader 本身是 profile 的一个 loader entry ⇒ 一个插件的 typert 声明有问题就让**整棵插件树**加载失败（`dsh: plugin tree failed to load`）。同一份代码在**动态路径**（后挂载的 entry）上只 `logger.error` 不抛——启动路径缺的正是这个降级。补丁把启动路径的失败也降级为带 entry 名的 logged error（保留 `AggregateError` 作结构化载荷） | 官方把 contributor 注册失败降级为非致命（或按 entry 隔离、不再整树原子） |
| `@deepseek-ai/dsh-client-file-upload` | `registerAgentResolver` 在「已注册」时抛错，而 Cordis `Fiber._reload()` 是**先重跑 apply、后处置上一轮 effects** ⇒ 任何对该 entry 的重放（插件管理器 live-apply、热挂载 bundle 重列核心行）都会命中守卫抛错，让 session-controller 整个 fiber 回滚；回滚连带摘掉它注册的 `typert.lookups.configure("agent"/"session")` ⇒ 冷会话切模式报 `lookup provider "agent" did not resolve`。补丁把守卫改为**接管 + warn**（旧 disposer 的 `=== resolve` 比较保证不误伤新注册者） | 官方把该注册改为幂等（或 reload 前先处置旧注册） |

### ui-behavior（next 7 个 / alpha 7 个；**已退役项**在表内以删除线标明，半退役项在判据列内注明）

| 补丁（包名） | 判据 | 退役条件 |
|---|---|---|
| ~~`dsh-client-ui-layout`~~ | 🗄️ **已全线退役**：alpha 线 2026-09-16、next 线 2026-09-30（上游 0.2.0 的 `computeColumns(…, collapsedWidth)` + `data-platform` 推导覆盖本补丁全部意图，两线判据均已满足）。补丁文件两线均已删除 | 官方区分平台宽度 ← **已满足（两线）** |
| `dsh-client-ui-sidebar` | 注入壳层锚点属性（`data-dsh-sidebar-root` / `-wide` / `-settings`），供 Harness 页注入脚本挂载手机状态指示器。**自定义 padding 已于 2026-09-16 移除**（上游原生适配 macOS，叠加会成双份留白） | 官方侧栏暴露等效锚点（本仓注入脚本可挂到官方标记上）时 |
| ~~`dsh-client-ui-workspace`~~ | 🗄️ **两线退役（2026-09-30）**：上游原生 `completionUnread` → `SessionStatusDots`/`StateDot` 未读完成态 + 完整会话行样式。补丁文件两线均已删除 | 官方列表补齐未读与行样式 ← **已满足（两线）** |
| `dsh-client-ui-settings-models` | 模型设置页的**每模型推理等级**注入（`ModelReasoningEffortsField`，经上游 `ModelRow` 的插槽挂载）。（Provider 选择器 / 搜索自 2026-09-30 起随上游目录添加流退役；alpha 线于 2026-10-07 推进时同轮退役） | 官方提供 per-model 推理等级控件（上游源码明确注释「刻意不做」） |
| ~~`dsh-client-ui-model-selection`~~ | 🗄️ **已全线退役**：next 线 2026-09-30、alpha 线 2026-10-07（上游 `0.2.1-alpha.1` 实测自带模糊搜索 `search`×30 / `fuzzy` / 键盘导航 `moveFocus`，判据满足）。补丁文件两线均已删除 | 官方自带搜索 ← **已满足（两线）** |
| ~~`dsh-client-ui-agent-preset`~~ | 🗄️ **两线退役（2026-09-30）**：上游重写为卡片式预设管理 UI（`cardBroken`/`guideTitle` 键域），旧菜单/对话框锚点整体消失；**整条预设传递链路同轮退役**（`dsh-desktop-preset-transfer`）。补丁文件两线均已删除 | 官方提供预设包导入导出 ← **判据已转化为「上游重写」** |
| `dsh-client-ui-chat` | 会话内 `FORBIDDEN` 错误文案。（`QUOTA` / `ACCOUNT_*` 族上游已于 `0.2.1-alpha.1` 内置，自 2026-10-07 起本补丁只重放 `FORBIDDEN`） | 官方补齐 `FORBIDDEN` 文案 |
| `dsh-client-ui-trajectory` | 轨迹页 `QUOTA` / `FORBIDDEN` 错误文案 | 同上 |
| `dsh-client-ui-deliverables` | Codex 风格本地路径引用解析；`paths` 为 `null` 时的空数组兜底 | 官方支持本地路径引用解析 |
| `dsh-llm-deepseek` | 把 HTTP 403 从 `AUTH` 拆成独立 `FORBIDDEN` 码；缺失时 403 显示为鉴权错误（文案不准，不影响运行） | 官方错误码分类含 `FORBIDDEN` |
| `dsh-llm-pi-ai` | 同上：消息文本中的 403 归类为 `FORBIDDEN` | 同上 |

### next 线（0.1.5-rc.3）的移植裁定（2026-09-24）

上游 `latest` 从 `0.1.5-rc.2` 前进到 `0.1.5-rc.3`。预检 **clean 14 · conflict 0**——
14 个补丁（含 `cordis-plugin-loader`，它跟自己的版本号 `1.0.3`，不跟 DSH）**全部干净可用**，
**无需重算行号、无需重写语义**，机械改版本段即可。

**vendored 覆盖包全部退役：** `packages/next/` 原有的三个 tgz（`agent-preset` /
`settings-models` / `workspace`）已验证**不再需要**——逐个把 vendored tgz 与 registry 的
同版本 `0.1.5-rc.2` tarball 做 `diff -rq`，**三对全部逐字节一致**（vendoring 的前提是
「上游静默重发布过 tarball、同版本号不同字节」，此处不成立）。删除后 `packages/` 目录整体消失；
`prepare-harness` 以 `readdirSafe(vendoredDir)` + `existsSync(vendoredDir)` 双重容忍缺失，
无需额外改动。这与 alpha 线（2026-09-16）的退役判据完全一致。

> ⚠️ **本批次未推进到上游 `next`（`0.1.7-rc.1`）**——那是**跨两个 minor 的升级**：
> 预检为 clean 5 · conflict 9，**79 个 hunk 需重新撰写**（`workspace` 34 / `settings-models` 17 /
> `agent-preset` 15 / `model-selection` 6 / `deliverables` 2 / `llm-deepseek` 2 / `layout` 1 /
> `sidebar` 1 / `dsh` 1，其中 `dsh` 属 `functional` 层）。抽样 `dsh-llm-deepseek` 证实是
> **上游重构**而非行号漂移：rc.2 的 `function httpErrorCode`（2089 行文件、函数在 1526）在
> rc.1（2231 行）被整体删除，逻辑并入 `type`-based 判定。**另立批次处理。**
>
> 📌 **`dsh-client-ui-layout` 的退役判据只在 `0.1.7` 线满足**：该上游改进
> （`computeColumns(…, collapsedWidth)` + `data-platform` 推导）在 `0.1.6-alpha.2` 引入，
> **rc.3 尚未回灌**——预检显示同一个 `layout` 补丁在 rc.1 有 1/2 段未匹配、在 rc.3 判 clean。
> 故本批次 `layout` 补丁**必须保留**，不可照搬 alpha 线的退役结论。

### alpha 线（0.1.6-alpha.2）的移植裁定（2026-09-16）

上游 alpha 通道从 `0.1.6-alpha.1` 前进到 `alpha.2`。预检显示 **9 个补丁是纯行号漂移**
（`recount-patches.mjs` 重算即可）、**5 个有真实内容冲突**；按 `retireWhen` 逐条裁定后
**13 个补丁**（原 14 个，退役 1 个）。

**两处退役——上游补上了同类能力，我们的实现被取代：**

1. **`dsh-client-ui-layout`（整条补丁退役）**。我们做的是「折叠侧栏宽度按平台区分」
   （UA 嗅探 macOS → 80px）。上游把折叠宽度**参数化**了：
   `computeColumns(viewport, sidebar, rightbar, collapsedWidth = 56)`，由
   `documentElement.dataset.platform === "darwin" || hasAttribute("data-windows-titlebar")`
   推导，macOS 折叠时**直接收到 0**、其他平台 56，并处理了 Windows 标题栏。
   这正是该补丁 `retireWhen` 写明的条件（「官方区分平台侧边栏宽度时」），且上游实现
   比我们的 UA 嗅探更完整（后者还会在 Windows 上误判）。
2. **`dsh-client-ui-sidebar` 的自定义 padding（补丁保留，功能缩减）**。上游已原生适配
   macOS：`topStrip` 元素 + `[data-platform=darwin]` 规则 + `-webkit-app-region: drag`
   拖拽区 + `[data-sidebar-collapsed]` 下的交通灯留白。我们的 UA 嗅探 padding 会与之
   **叠加成双份留白**，因此移除。该补丁现在只做一件事：**注入壳层锚点属性**
   （`data-dsh-sidebar-root` / `data-dsh-sidebar-wide` / `data-dsh-sidebar-settings`）——
   注入脚本（`src-tauri/frontend/harness-ui-inject.js`）依赖它们，不能退役。

**一处上游反向采纳：** `dsh-client-ui-model-selection` 的键盘导航修复
（`active < 0` 时按 `moveFocus` 方向落到首/尾）上游已自行实现且语义一致——取上游写法。
同包的**搜索框增强上游仍没有**，保留。

**其余冲突按「上游新结构 + 保留我们的增强」合并：**

- **`settings-models`**：上游把模型行重构成 `ModelRow` 组件、以 `ModelInputTypes` 取代我们的
  `ModelImageInputToggle`（前者的 fieldset 支持「未覆写时显示继承值」，更完整；我们的
  `modelImageInput*` 三个文案键随之删除）。我们的**目录搜索**与**每模型推理等级**上游都没有
  （后者上游源码明确注释「刻意不做」——理由是 provider 级控件不合理，而每模型能力由 composer
  的模型选择器提供，正是我们做的形态）。接入方式：遍历源换成 `visibleModels`（保留搜索过滤，
  条目自带原始下标，`ModelRow` 正需要它），推理等级经 `ModelRow` 新增的 `advancedExtra` 插槽注入。
- **`workspace`**：上游把 `useSessionPendingInteraction` 重命名为 `useSessionStatus`、会话行加了
  标题裁剪（`titleRef` / `revealClippedTitle`）与 `padding-inline-start` 缩进，并把内联会话树
  重构成 `renderGroup` 闭包（支持嵌套工作区）。未读标记与右键菜单按新结构重新接入。
- **`agent-preset`**：上游给 `AgentPresetSeat` 加了 `sessionId` / `useSessionRetainInfo`，
  我们的搜索框状态（`query` / `recentIds`）按新签名保留。

**vendored 覆盖包全部退役：** `packages/alpha/` 原有的三个 tgz 已验证**不再需要**——逐个用
registry 内容做应用判定，13 个补丁全部干净可用（vendoring 的前提是「上游静默重发布过 tarball、
同版本号不同字节」，这次不成立）。删除后真实组装仍 13/13 applied。

### alpha 线（0.1.6-alpha.1）的移植裁定（2026-09-15）

14 个补丁全部移植到 alpha 线，做法是**在 alpha 纯净树上重建我们的改动**（而不是逐块解
三路合并的冲突）——上游把 `SessionTree` / `FlatList` 从 `useSessions` 改成了 `list` prop、
订单模型也换成了 `saveSessionOrder`，逐块解冲突会把旧结构带回来，反而更脆。

两处**有意的差异**，各自有明确理由：

1. **`dsh-client-ui-workspace` 不再移植「在 Finder 中打开」菜单项**。该菜单项的实现是
   `window.dshDesktop?.openInFinder(...)` 加一个 `typeof window.dshDesktop === 'function'`
   的存在性判断——而 `window.dshDesktop` 在全仓**从未被定义**（注入脚本只定义
   `__dshDesktopPhone`，见 `src-tauri/frontend/harness-ui-inject.js`）。也就是说这段代码
   在 rc.2 线上**永远不会显示那个菜单项**，是一段死代码。保留它等于把一个「看起来能点、
   点了没反应」的入口写进补丁，与本仓「不为远程 origin 开反向 IPC」的结论（INV-2）冲突。
   要让它在 alpha 线上真的可见，必须先按 INV-2 立项定义这个全局——那是一件独立的事，
   不该顺手夹带在版本升级里。
2. **`dsh-client-ui-deliverables` 的 `chatFileMentions` 取 alpha 的宿主实现**。我们的改动
   原本是「把 presented 文件路由到 `opener.open`，并在 `paths === null` 时不早退」；
   alpha 把同一段重写成了走 `owner.openFile` + `presented.previewButton`。保留我们那版会把
   上游新引入的 presented 预览入口覆盖掉，因此取上游实现，只保留**本仓的独立增强**——
   `localPathReference`（Codex 风格本地路径解析）。

> ### ⚠️「会话永久删除」特性已随 0.1.5-rc.1 升级移除（2026-09-12）
>
> 该特性此前由**四条补丁 + 一个跨进程契约**构成：`dsh-api-session-controller`（`session.delete`
> RPC 客户端）、`dsh-session-persistence`（删除原语）、`dsh-session-persistence-jsonl`（后端
> `deleteStored`）、`dsh-workspace`（`forgetSession`），外加 `dsh-client-ui-workspace` 里的会话
> 删除菜单与确认对话框。
>
> **移除原因**：0.1.5-rc.1 把会话持久化层整体重构——我们删除逻辑挂钩的 `PersistenceCoordinator`
> 类**已被删除**（`dsh-session-persistence/lib/index.js` 从 1594 行缩到 267 行），改为基于
> **handle** 的新模型（`JsonlSessionPersistence`，3361 行）。这四条补丁的目标代码已不存在，
> 无法机械移植，只能按新模型**重写**；而在无三平台运行证据前重写并交付，属于本仓宣称纪律
> 明令禁止的「无法验证却声称可用」。
>
> **当前状态**：四条后端补丁已删除；`dsh-client-ui-workspace` 里的会话删除 UI（菜单项、确认
> 对话框、`deleteSession` action、三处 locale 文案）已同步剥离，**未读标记等其余增强保留**。
> 这是 `ui-behavior` 层允许的降级：**缺失的只是一项本仓自加的功能，不是上游能力回退**——
> 0.1.5-rc.1 本身同样没有会话永久删除，alpha 线（0.1.6-alpha.1）同样没有。
>
> **恢复条件**：按 handle 模型重写删除链路，且**必须有三平台真实运行证据**
> （`smoke.yml -f scope=full`）才能合入。参见 `docs/roadmap.md` 的补丁退役机制。
>
> **本次升级的验证状态**：`0.1.5-rc.1` 的 14 个补丁已于 2026-09-13 通过完整验证并随
> **v0.3.0** 发布（三平台 CI + Smoke full 全绿）。两条通道于 2026-09-15 首次发布：
>
> | 版本 | 上游 | 补丁数 | 证据 |
> |---|---|---|---|
> | **v0.5.0-next.1** | DSH `0.1.5-rc.2` | 14 | 本机真实组装 14/14 + L1 5/5；三平台 CI + Smoke `scope=full` 全绿；release 8/8 job 绿、19 资产 |
> | **v0.6.0-alpha.1** | DSH `0.1.6-alpha.1` | 14 | 同上（alpha 线补丁为本次按语义重做，非机械移植） |
> | **v0.6.0-alpha.2** | DSH `0.1.6-alpha.2` | **13** | 本机真实组装 13/13 + L1 5/5（`layout` 退役、vendored 覆盖包退役）；三平台证据由 Release 流程产出 |
>
> `0.1.6-alpha.1 → alpha.2` 是首次出现**补丁净减少**的一次推进（14 → 13）：上游补齐了
> 平台化侧栏宽度，我们那条补丁按 `retireWhen` 退役。这正是补丁退役机制想要的方向——
> 补丁数随上游成熟而下降，而不是只增不减。
>
> 三者均为 `prerelease: true`，且实测确认 `releases/latest` 仍指向 `v0.4.0`——
> 预发布**不会**进入 stable 更新链路。

### alpha 线（0.2.1-alpha.1）的移植裁定（2026-10-07）

上游 `alpha` dist-tag 从 `0.1.7-alpha.2` 直跳到 `0.2.1-alpha.1`（跨 minor，含上游重构）。
本轮**没有本地组装基线**，全部裁定基于「上游 tgz 实测 + 纯净树按内容定位」，纯净树与
取证目录一律放仓库外（`%TEMP%`）——上游 npm 代码落入 `harness-deps/` 会被安全门扫出高危。

**预检基线**：clean 4 / conflict 7（11 个补丁）。与 2026-09-30 next 线那次落在同一个上游
重构窗口，语义裁定沿用先例。

**行号重算**：用 [`relocate-patch-hunks.mjs`](../scripts/relocate-patch-hunks.mjs)
（本机 `spawnSync git` 报 EBUSY，故走「只改 `@@` 行、无外部进程」这条路径）。
首轮 **8/10 个补丁、27 个 hunk 自动重算，6 个 hunk 定位不到**（`chat` 3 + `settings-models` 3）；
逐条重写后 **41 个 hunk 全部对齐（10/10 补丁）**。最终 `check:patch-applicability` =
**clean 10 / conflict 0**。

**退役 1 个（`retireWhen` 已实证满足）**：

| 补丁 | 判据的核实结果（对 `0.2.1-alpha.1` tgz 实测） | 结论 |
|------|--------------------------------------------|------|
| `dsh-client-ui-model-selection` | 上游自带模糊搜索与键盘导航：`search`×30 / `searchRow`×9 / `searchRef`×6 / `fuzzy`×1 / `moveFocus`×2（`lib/`） | **alpha 线退役**（next 线已于 2026-09-30 退役）——**两线归一** |

**语义重做 3 个**：

- **`dsh-client-ui-chat`**（3 个 hunk 全部重写）：上游已内置 `ACCOUNT_SIGNED_OUT` /
  `ACCOUNT_SIGN_IN_REQUIRED` / `QUOTA` / `ACCOUNT_QUOTA` 四个分支与对应 zh/en 文案
  （`failureMessage()` 现为 4 行 if 链），**仍无 `FORBIDDEN`**。补丁相应收窄：只重放
  `code === "FORBIDDEN"` 分支 + zh/en `message.failure.forbidden` 词条，
  **不再覆盖 `quota` 文案**（上游已接管——属「上游追上我们」，不是能力回退）。
- **`dsh-client-ui-settings-models`**：24 个 hunk 自动定位；3 个定位不到的根因是
  **上游把 `EditorFooter` 的 `onSubmit` 扩成两段**（新增 `props.onSubmitCredential?.()`）。
  裁定：`footerProps` 的 `onSubmit` 与 `1805` hunk 的 before 块**都补回该行**——
  这属于「上游新增行为能力不得因移植而丢失」，而本补丁的 Provider 编辑器 sticky footer
  改造正建立在此 `footerProps` 提取之上。另 2 个 hunk 的 `welcomeBody` 上下文文案
  随上游从 `0.1`→`0.2` 更新，**仅校正上下文，不动本仓新增的 onboarding 词条**。
  🔴 **注入点未变的前提已核实**：本线上游仍无 `reasoningEffort*` 控件（4 处注释明确
  「per-MODEL, deliberately none」），故每模型推理等级增强仍需保留。
- **`dsh-llm-deepseek` / `dsh-llm-pi-ai`**：纯行号重算（2 + 1 个 hunk），无语义变化。

**一个刻意不改的值**：`@deepseek-ai/cordis-plugin-loader` 的上游解析范围由 `~1.0.5`
变为 `~1.0.6-alpha.1`，本仓**保持补丁文件名 `1.0.3`**——`prepare-harness.mjs` 由文件名推导
override，把它反向钉到补丁所针对的 `1.0.3`；这与两线既有做法一致（`~1.0.5` 时同样钉 `1.0.3`），
且 1.0.x 段代码未变（`EntryTree` 的裸 specifier 回退逻辑逐字相同）。

**退役后的净结果**：alpha 11 → 10 条（**与 next 线补丁集在包名层面归一**）。

**体积（清单 Step 6，如实记录）**：本轮**无本地组装基线**（`src-tauri/resources/` 与
`harness-deps/` 均不存在），无法给出增量对比；按计划取代理基线并显式标注
「基线缺失，增量不可比」——不重蹈 2026-09-30 那次「跳过体积对比」的流程教训。

### next 线（0.2.0-rc.2）与 alpha 线（0.1.7-alpha.2）的移植裁定（2026-09-30）

本轮推进的**做法**是把升级清单 §2 的三路合并移植**工具化**：新增
[`scripts/merge-migrate-patches.mjs`](../scripts/merge-migrate-patches.mjs)（`merge` 模式产出
「新版纯净 ↔ 已解决」两棵树与冲突清单，`regen` 模式从两棵树 `git diff --no-index` 重生成补丁）。
它把「摆三棵树、跑 git merge-file、再重生成补丁」这段此前纯手工的工序变成可复跑的命令，
24 个 hunk 级冲突逐条可审。**语义裁定仍由人做**，工具只保证文本合并与行号正确。

**预检基线**（本轮开始时）：next 对 0.2.0-rc.2 clean 2 / conflict 12；alpha 对 0.1.7-alpha.2
clean 4 / conflict 9。经 merge 工具自动三路合并后，需要人工裁定的只剩 **5 个包 55 处冲突**
（workspace 29 / settings-models 13 / agent-preset 7 / chat 3 / deliverables 2 / llm-deepseek 1）。
裁定的最终结果：**四个包整体退役**（上游已完整覆盖我们的意图或锚点结构性失效），
三个包按语义重做，其余七个零冲突接受。

**四个整线退役（按 retireWhen 逐条核实上游实现后裁定）**：

| 补丁 | 退役判据的核实结果 | 结论 |
|------|--------------------|------|
| `dsh-client-ui-layout` | next 0.2.0-rc.2 与 alpha 0.1.7-alpha.2 均有 `computeColumns(…, collapsedWidth)` + `data-platform` 推导（`lib/client.js` 实测命中三关键词） | **两线退役**（next 线原「待跟进」的预言兑现） |
| `dsh-client-ui-workspace` | 两线上游均原生 `completionUnread` → `SessionStatusDots`/`StateDot` 未读完成态 + 完整会话行样式（含 hover 卡片） | **两线退役**；「手动标记未读」如需在新结构上恢复，另立批次 |
| `dsh-client-ui-model-selection` | next 上游自带模糊搜索 + 键盘选择（`search`/`fuzzy`/`moveFocus` 实测命中）；alpha 上游仅有 `moveFocus`，**无搜索** | **仅 next 退役**；alpha 保留（同包两通道不同命，正是分级表按包名登记的代价与价值） |
| `dsh-client-ui-agent-preset` | 上游重写为**卡片式**预设管理 UI（`cardBroken`/`guideTitle` 键域；2089 → 1702 行），旧菜单/对话框锚点整体消失——`copyTitle` 等 9 个 locale 键归零 | **两线退役**（「上游重构使补丁前提失效」）；**整条预设传递链路同轮退役**：插件 `dsh-desktop-preset-transfer` 依赖的 `@deepseek-ai/dsh-agent-presets`（roots/scanRoot 文件模型）被上游重命名并重铸为 `@deepseek-ai/dsh-agent-preset` + agentPresets 注册模型，四个导入符号（`COMPOSITION_FILE`/`SETTINGS_NAMESPACE`/`scanRoot`/`writableRoot`）整体消失，插件无法移植。vendor 源码已删，`@deepseek-ai/dsh` 补丁的依赖声明与 `build/dsh-desktop.patch.yml` 的 insert 行同步移除。**恢复前提**：上游重新暴露文件系统预设根，或有新 UI 消费方重建导入/导出 |

**三个包的语义重做（上游新结构 + 保留我们的增强）**：

- **`dsh-client-ui-chat`**：取上游新增的 `ACCOUNT_*` 错误码与「额度已用尽」文案，
  重放我们的 `FORBIDDEN` 分支（`code === "FORBIDDEN"` → zh/en 词条）——上游尚无此码。
- **`dsh-client-ui-deliverables`**：延续 alpha 线先例——取上游新路由
  （`owner.openFile` + `presented.previewButton`），**只保留本仓增强** `localPathReference`
  （Codex 风格本地路径解析；上游无等价物），并再次移除 `paths === null` 的提前返回
  （否则无产物回合里本地路径引用永不出现）。
- **`dsh-llm-deepseek`**：上游把 `httpErrorCode`（status if 链）重构为 type-based
  `providerError`，403 并入 AUTH。**在两处映射点**（`providerError` 主链 + FILES API
  上传链）重放「403 → FORBIDDEN」拆分——这是本补丁的全部意图，缺任一处的后果都是
  上传失败仍显示为鉴权错误。
- **`dsh-client-ui-settings-models`**：Provider 选择器/搜索**整体退役**（上游新增
  「目录 / 自定义」SegmentedControl 添加流，`addMode`/`addCatalog` + 候选搜索 `fetchSearch`，
  官方提供等价能力）；**每模型推理等级保留并重接**——上游源码两处明确注释
  「There is deliberately no reasoning-effort control… it is a per-MODEL capability」，
  而恰是我们的 `ModelReasoningEffortsField` 走的 per-model 层：经上游 `ModelRow` 的
  `advancedExtra` 插槽注入（alpha 线先例在新基线上的延续），locale 三键（en+zh）随之重放。

**顺带的正确性发现**：上游 `settings-models` 的 `providerError` 主链里 403 已并入
`AUTH`，但 FILES API 仍单列 403；两处不一致——我们的 FORBIDDEN 拆分**必须两边都改**，
只改主链会让上传类 403 走新码而消息报旧文案（这正是补丁预检「上下文对上 ≠ 语义成立」的实例）。

**退役后的净结果**：next 14 → 10 条、alpha 13 → 11 条。

**体积（清单 Step 6，如实记录）**：本轮推进的资源树实测 **464.1 MB**（`harness/` 377.8 MB +
内置 Node 85.5 MB，`npm run size:report` 口径三）。**开工时未采集 0.1.5-rc.3 的基线体积**
（本批次由用户指令在中途启动，Step 1 的基线四项只完成了 git 提交记录一项），因此无法给出
增量对比——0.2.0 线新增的文档预览依赖（libreoffice-kit 等）在 alpha.2 时期已引入过同类项，
但 next 线从 rc.3 到 0.2.0-rc.2 的具体增量未测。**后续升级仍应按 Step 1 先落体积基线。**

**组装期抓到的第五个退役（本批次唯一由门禁而非预检发现的）**：`dsh-desktop-preset-transfer`
插件无法在两条新线上解析导入——上游把它依赖的 `@deepseek-ai/dsh-agent-presets`
（preset roots / scanRoot 文件模型）**重命名并重铸**为 `@deepseek-ai/dsh-agent-preset`
+ `agentPresets` 服务（register/activate 注册模型，`acquireScope`/`mount`/`recompose` 一套
新方法），插件入口的四个符号整体消失。`check:patch-applicability` 只查补丁不查 vendor 插件，
因此它是**组装后的树健全性门禁（规则 2：桌面插件入口裸导入必须可解析）**抓到的——
这正是该门禁存在的理由（「装得上、起不来」）。裁定：整条预设传递链路退役
（UI 消费方已同轮退役，无第二个消费方；文件系统预设根模型在上游已不存在，
照旧 API「移植」= 在已消失的语义上造假）。三处联动移除 + vendor 源码删除。

### 桌面启动缺陷修复（B2，2026-10-10）：两线同批新增 2 个补丁

> 背景：用户报告 `0.2.0-rc.2.1` / `0.2.1-alpha.1.1` 上「启动报错进不去」「装完切不到其他模式」
> 「首次启动插件加载不了」。逐条取证后落到两处运行时契约缺陷，两线形态相同，故同批新增。

**新增补丁（按包名，两线各带自己的版本段）：**

- `@deepseek-ai/dsh-typert-loader`——把启动路径的 contributor 注册失败从 **fatal** 降级为
  **带 entry 名的 logged error**。上游在动态路径（`ctx.on("internal/plugin")` 的 microtask 分支）
  已经只 `logger.error` 不抛，启动路径却 `throw new AggregateError`；而 typert-loader 是 profile 的
  一个 loader entry ⇒ **一个插件的 typert 声明有问题，整棵插件树加载失败**。
- `@deepseek-ai/dsh-client-file-upload`——`registerAgentResolver` 从「已注册即抛」改为
  **接管 + warn**。Cordis `Fiber._reload()` 会**先重跑 apply、后处置上一轮 effects**，
  所以「已注册」在重放时序里是**正常**的，抛错会让 session-controller 整个 fiber 回滚，
  连带摘掉它注册的 `typert.lookups.configure("agent"/"session")`。

**两处与批次计划书不一致，在此记录（偏差必须可查）：**

| # | 计划书写的是 | 实际做的是 | 原因 |
|---|---|---|---|
| 1 | 改 `dsh-api-session-controller`（让**调用方**幂等） | 改 `dsh-client-file-upload`（让**服务**可重入） | 幂等性属**服务契约**。`registerAgentResolver` 全树只有一个调用点（`session-controller:2851`），但非幂等的根因在服务侧——「reload 先重跑后处置」是**运行时契约**，任何消费者都会踩，改调用方只能修一处；且调用方拿不到「别人的」disposer，先 dispose 会把另一个仍活着的 owner 打坏。服务侧改法（接管 + warn）由旧 disposer 的 `=== resolve` 比较保证不乱清 |
| 2 | ③（可选）`dsh-agent` resolver 兜底 | **不做** | 兜底要「冷会话也能解析出 Agent」＝接持久化层，本机**无法验证**（组装被 `koffi` 拦、无真实网关）。按「无法验证不得声称可用」放弃；真正缺的 lookup 已由补丁 2「不再丢失」覆盖 |

**验证（全部成对红→绿，本地可复跑）：**

| 判据 | 证据 |
|---|---|
| 补丁能否干净落盘 | 用**真实 `patch-package`**（不是本仓自写的匹配器）在仓库外临时 app 根上打：两线各 2 包全部 `✔`、退出码 0；LF 形态落盘**逐字节等于预期且零 CR** |
| 本机 CRLF 工作树的副作用 | 同补丁转 CRLF 后仍 applied 成功，差异**恰好**是新增行尾部 8 / 4 个 `\r`。显式断言而非忽略：`core.autocrlf=true` 只作用于**工作树**，blob 是 LF，所以 CI 无此差；本地组装产物与 CI 会有字节差，必须被看见 |
| typert 降级行为 | 桩 ctx 真跑 `apply()`：红=纯净模块抛 `AggregateError` 且指名坏 entry；绿=resolve、恰 1 次 `logger.error`、**好 entry 照常注册**（是「跳过坏的」而不是「整树放弃」） |
| file-upload 幂等行为 | 红=第二次注册抛 `already registered`；绿=接管 + 恰 1 条 warn；且**旧 disposer 在新注册之后才运行**（正是 `_reload()` 的顺序）不会清掉新 resolver |
| lockfile 是否需重生成 | 用本仓 `lockInputsMatch` 复算：两线 `ok=true`。原因：这两个包在快照 `overrides` 里**本就存在且同值**（`--update` 会把整个 `@deepseek-ai/dsh-*` 家族钉进快照），新增补丁只是把它们从「家族钉死」挪进「基础 override」，值不变 ⇒ 规则 2 仍满足。负控（值改错 / 注入快照外包名）均 `ok=false`，证明判据在工作 |
| 静态门禁 | `patches`、`harness-lockfile`、`harness-entry`、`harness-inject` 全绿 |

**未覆盖（诚实声明）**：组装态「12/12 applied」与「能启动」**本机验不了**（`prepare:harness --force`
被 `koffi` 拦，见 `docs/incidents/local-toolchain-limits.md`），须由 CI 的 build / portable job 在
`prepare:harness` 之后按名点名确认。

---

### market 热挂载入口 URL（B4，2026-10-10）：**扩展既有补丁，不新增文件**

> 背景：同一个用户报告里第 5 条是「装完首启点插件加载不了」。市场日志
> （`profiles/web/.dsh-market/log.ndjson`）原文给的失败是
> `failed to import loader entry mkt-furongjun1999-dsh-memory (file:///…/node_modules/@furongjun1999/dsh-memory/index.js): Cannot find module '…\@furongjun1999\dsh-memory\index.js' imported from …\.dsh-market\`。

**根因（实测，逐条可查）：**

1. **入口 specifier 是一条死路**：热挂载把裸包名解析成了**绝对 `file://` 入口 URL**，而该 URL 指向
   **不存在的文件**——`<pkgDir>/index.js`。该包的真实入口由 manifest 声明
   （`type: module`、`main: lib/index.js`、`exports["."].import: ./lib/index.js`），**没有** `index.js`。
2. **`~` 是日志产物，不是 specifier 的一部分**（报告原假设在此被**证伪**）：`…/dshmarket/lib/log.js`
   的 `sanitize()` 会把 `homedir()` 折叠成 `~`（隐私处理）。原始 message 里是
   `C:\Users\Administrator\AppData\…`，写成 `~\AppData\…` 只是落盘时的替换。按"畸形 specifier"去找
   构造点会找错方向。
3. **为什么 loader 救不了它**：`EntryTree.import()` 的兜底只处理**裸包名**（`require.resolve(name)`）。
   绝对 `file://` URL 既不是相对 specifier、`require.resolve` 也不接受 URL ⇒ 兜底整段失效。
4. **产者不在本仓可控面内**：`resolveProfileEntry()`（把裸名转成绝对入口 URL 的那个函数，失败时
   回退硬写 `join(packageDir,'index.js')`）只存在于 **`dshmarket@1.52.0`** 里；本仓 vendored
   `vendor/dshmarket` 是 **1.40.0**（`hot.js` 只写裸名，**不含**该函数），且 `origin/main` 同为
   1.40.0、`resolveProfileEntry` 在全仓**零命中**。即：缺陷的**产者**不在 `vendor/**` 里。

**方案级偏差（必须记）：施工面从 `vendor/dshmarket/**` 迁到 loader 补丁。**

| # | 计划书写的是 | 实际做的是 | 原因 |
|---|---|---|---|
| 1 | 改 `vendor/dshmarket/**` 的 hot-mount 路径构造 | 扩展 `@deepseek-ai/cordis-plugin-loader` 既有补丁 | 本仓 vendored 的 1.40.0 **根本没有那个构造点**（它写裸名）——照计划改会去修一个不存在的函数。把补丁加在 loader 这一侧，收益是**与市场版本无关**：任何版本的市场交来失效的绝对入口 URL，热挂载都不会再无声失败 |
| 2 | （报告未写）救援落在 import 的 `else` 分支 | 落在 `composeError` 异步体**顶部**（先修 specifier，再走原有三条路） | **行为夹具当场判红**：`this.ctx.loader.internal` 存在时第一路直接 `return`，`else` 分支在真机上**永不可达**——按原写法这条救援在发生缺陷的配置里等于没写（判据 C1） |

**验证（`.workbuddy/tmp/verify-b4-loader.mjs`，`node --expose-internals`，19/19 PASS）：**

| 判据 | 证据 |
|---|---|
| 缺陷本体（成对红→绿） | 同一夹具、同一 URL：未打补丁 ⇒ `ERR_MODULE_NOT_FOUND`；打补丁 ⇒ 解析成功且 token 命中（ESM-only 包，`exports` 只给 `import` 条件、**故意不放 index.js**） |
| 降级可见 | 替换触发时留下 warn，且 warn 里出现反解出的裸名（AGENTS §7.1 禁无声降级） |
| 负控 1：不得凭空造模块 | 包**本身**不存在时，修后仍必须失败 |
| 负控 2：不得误触发 | 裸名缺失仍按原样失败，且**零 warn**（证明救援没被走进） |
| 不回归 | 裸包名 / **存在**的绝对 `file://` URL / 缺失的相对 specifier —— 两种变体行为一致 |
| 反解正确性 | 作用域包 `@scope/pkg` 取两段；pnpm 虚拟 store `.pnpm/<n>@<v>/node_modules/<n>/…` 取**最内层**（夹具按 pnpm 真实形态补了顶层链接，否则测的是"没装"而不是"取错") |
| 已知边界（留档） | 宿主**无** `internal` 时，第二路（CJS `require.resolve`）救不了 ESM-only 包 ⇒ 仍失败。该配置不是缺陷发生的那种（真机 `internal` 必然可用，否则错误里的 base 不会是被 baseUrl 锚定的 `.dsh-market/`）；同一宿主下 CJS 包可成功，证明第二路本身有效 |
| 补丁能否干净落盘 | `git apply --check` 与 GNU `patch --dry-run` 均通过；真实 `patch -p1` 落盘结果与生成器产物**逐字节相同**；`node --check` 语法通过；LF 落盘零 CR（本机 `core.autocrlf=true` 只作用于工作树） |
| 对**真实发布包**的适用性 | `check-patch-applicability` 双线各 12/12 clean（`--target=0.2.0-rc.2` / `--target=0.2.1-alpha.1 --dsh-target=alpha`） |

**未覆盖（诚实声明）**：①组装态（`prepare:harness` 之后）与真机热挂载**本机验不了**——`koffi` 拦
`--force`、L1 让 `smoke:headless` 必红、捆绑 Node 24.9 在本机跑不了脚本（三条都先于 B4 存在）；
②夹具跑在托管 Node 22.22.2 上，**未**在捆绑的 24.9 上复跑（同上，本机跑不了）。

---

## 4. 维护规则

1. 新增补丁 → 在 `scripts/patch-layers.mjs` 的 `PATCH_LAYERS` 中登记（**包名** + layer + why +
   retireWhen），并在本文件对应小节补一行。未登记会被 `npm run gate -- patches` 报为问题。
   该表按包名索引，因此**加一条上游通道不需要动它**；只有新包才要补。
2. 删除补丁 → 同步删除分级表条目；`--self-test` 会检查「分级表引用了不存在的包」与
   「目录里有未登记的补丁」两侧。
3. 调整层 → 必须同时说明理由；`functional` 只收「缺失即起不来」的补丁。
4. 上游补齐某项能力后 → 按 `retireWhen` 退役该补丁，而不是让它继续漂移。
5. **移植补丁到另一条上游线**（新增目标、推进基线）→ 三步缺一不可：
   1. `npm run check:patch-applicability -- --dsh-target=<源> --target=<目标版本>`
      看哪些干净、哪些冲突（它现在也会报「内容匹配但行号漂移超窗」）；
   2. 冲突的按语义重做（见上文 alpha 线的做法），**改完必须重算行号**：
      `node scripts/recount-patches.mjs --dsh-target=<目标> --pristine=<未打补丁的包根>`；
   3. `npm run prepare:harness -- --dsh-target=<目标> --force` 真实组装并确认**本目标**全部 `applied`（条数以
     `node scripts/patch-layers.mjs --list --dsh-target=<目标>` 为准，不在此写死）
      ——**这一步不可省略**：预检与真实组装在行号口径上不同，只有它能证明补丁真的落盘。
