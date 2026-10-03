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
| `next` | npm `next` dist-tag，**当前锚在上游 `next` 线的 `0.2.0-rc.2`**（2026-09-30 从 `0.1.5-rc.3` 跨两个 minor 推进，含上游重构；预检 clean 2 / conflict 12，经三路合并后 10 个补丁全部 clean） | `patches/next/`（10 条） | `packages/next/`（**已清空**，2026-09-24） | `0.7.2-rc.1`（0.7.1 之后的下一个 rc；实际版本以 package.json 为准） |
| `alpha` | npm `alpha` dist-tag（当前 `0.1.7-alpha.2`） | `patches/alpha/`（11 条） | `packages/alpha/`（已清空） | `0.7.3-alpha.x` 起（必须**严格**大于最高 rc tag；`0.7.2-alpha.x` < `0.7.2-rc.1`，见 ADR-057） |

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

## 3. 逐个补丁的分类判据（2026-09-10 人工确认；2026-09-15 alpha 线复核；2026-09-30 双线推进后复核）

分类原则：**只有当缺失会导致「补丁体系失效」或「桌面插件挂不上 / 起不来」时才归 `functional`**；
其余一律 `ui-behavior`（可降级）。产品功能增强（如会话永久删除）虽然影响功能，
但缺失时只是该操作报错、应用整体可用，因此归入可降级层，并通过 `retireWhen` 记录其长期归属。

下表按**包名**列（两个目标同名同判据）；实际文件名带各自目标的版本段，
如 `patches/next/@deepseek-ai+dsh+0.2.0-rc.2.patch` 与
`patches/alpha/@deepseek-ai+dsh+0.1.7-alpha.2.patch`。

### functional（3 个）

| 补丁（包名） | 判据 | 退役条件 |
|---|---|---|
| `@deepseek-ai/dsh` | 把 `dsh-desktop-client-ui` / `dsh-desktop-hmr-fallback` / `dsh-desktop-market-installer` 三个桌面插件包声明为 dsh 依赖（第四个 `dsh-desktop-preset-transfer` 已于 2026-09-30 整链退役）。缺失则 `build/dsh-desktop.patch.yml` 的 `insert: name` 解析不到包，**profile 启动即失败** | 官方提供声明式扩展点（无需改 `package.json` 即可挂载外部插件） |
| `@deepseek-ai/cordis-plugin-loader` | 插件 loader 对裸 specifier 的 import 失败时，基于 `ctx.baseUrl` 用 `createRequire` 回退解析。桌面插件包位于 `node_modules`，缺失则**插件 import 失败** | 官方 loader 支持从 `baseUrl` 解析裸包名 |
| `@deepseek-ai/dsh-client-modules` | `ClientModuleRegistry` 解析 `${expectedPackageName}/package.json` 定位插件模块，渲染侧装载的最后一段依赖 | 官方 registry 自带 `createRequire` 解析 |

### ui-behavior（next 7 个 / alpha 8 个；**已退役项**在表内以删除线标明，半退役项在判据列内注明）

| 补丁（包名） | 判据 | 退役条件 |
|---|---|---|
| ~~`dsh-client-ui-layout`~~ | 🗄️ **已全线退役**：alpha 线 2026-09-16、next 线 2026-09-30（上游 0.2.0 的 `computeColumns(…, collapsedWidth)` + `data-platform` 推导覆盖本补丁全部意图，两线判据均已满足）。补丁文件两线均已删除 | 官方区分平台宽度 ← **已满足（两线）** |
| `dsh-client-ui-sidebar` | 注入壳层锚点属性（`data-dsh-sidebar-root` / `-wide` / `-settings`），供 Harness 页注入脚本挂载手机状态指示器。**自定义 padding 已于 2026-09-16 移除**（上游原生适配 macOS，叠加会成双份留白） | 官方侧栏暴露等效锚点（本仓注入脚本可挂到官方标记上）时 |
| ~~`dsh-client-ui-workspace`~~ | 🗄️ **两线退役（2026-09-30）**：上游原生 `completionUnread` → `SessionStatusDots`/`StateDot` 未读完成态 + 完整会话行样式。补丁文件两线均已删除 | 官方列表补齐未读与行样式 ← **已满足（两线）** |
| `dsh-client-ui-settings-models` | 模型设置页 Provider 选择器、模态切换、目录 UX | 官方设置页提供等价能力 |
| `dsh-client-ui-model-selection` | 模型选择弹层搜索框与样式。（**next 线已于 2026-09-30 随 0.2.0-rc.2 退役**：上游自带模糊搜索 + 键盘选择，判据满足；alpha 线上游尚无搜索，补丁保留） | 官方自带搜索 |
| ~~`dsh-client-ui-agent-preset`~~ | 🗄️ **两线退役（2026-09-30）**：上游重写为卡片式预设管理 UI（`cardBroken`/`guideTitle` 键域），旧菜单/对话框锚点整体消失；**整条预设传递链路同轮退役**（`dsh-desktop-preset-transfer`）。补丁文件两线均已删除 | 官方提供预设包导入导出 ← **判据已转化为「上游重写」** |
| `dsh-client-ui-chat` | 会话内 `QUOTA` / `FORBIDDEN` 错误文案 | 官方补齐这两种错误码文案 |
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
   3. `npm run prepare:harness -- --dsh-target=<目标> --force` 真实组装并确认**本目标**全部 `applied`（当前 next 10 / alpha 11）
      ——**这一步不可省略**：预检与真实组装在行号口径上不同，只有它能证明补丁真的落盘。
