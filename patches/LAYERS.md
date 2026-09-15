# patches/ 补丁分级清单

> **单一事实源是 [`scripts/patch-layers.mjs`](../scripts/patch-layers.mjs)**；本文件是它的说明与判据记录。
> 两者一致性由以下命令强制校验（`npm run verify:patches`，也跑在 CI 的 test job 中）：
>
> ```bash
> npm run verify:patches                                        # 逐个目标检查
> node scripts/patch-layers.mjs --list --dsh-target=alpha        # 看某目标的分级
> ```

---

## 0. 双通道：补丁按目标分目录（2026-09-15 起）

本仓同时维护**两条上游运行时通道**，各自持有一套补丁与 vendored 覆盖包：

| 目标 | 上游线 | 补丁目录 | vendored 覆盖包 | 对应桌面版本 |
|---|---|---|---|---|
| `next` | npm `next` dist-tag（当前 `0.1.5-rc.2`） | `patches/next/` | `packages/next/` | `0.5.0-next.1` |
| `alpha` | npm `alpha` dist-tag（当前 `0.1.6-alpha.1`） | `patches/alpha/` | `packages/alpha/` | `0.6.0-alpha.1` |

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

## 3. 逐个补丁的分类判据（2026-09-10 人工确认；2026-09-15 alpha 线复核）

分类原则：**只有当缺失会导致「补丁体系失效」或「桌面插件挂不上 / 起不来」时才归 `functional`**；
其余一律 `ui-behavior`（可降级）。产品功能增强（如会话永久删除）虽然影响功能，
但缺失时只是该操作报错、应用整体可用，因此归入可降级层，并通过 `retireWhen` 记录其长期归属。

下表按**包名**列（两个目标同名同判据）；实际文件名带各自目标的版本段，
如 `patches/next/@deepseek-ai+dsh+0.1.5-rc.2.patch` 与
`patches/alpha/@deepseek-ai+dsh+0.1.6-alpha.1.patch`。

### functional（3 个）

| 补丁（包名） | 判据 | 退役条件 |
|---|---|---|
| `@deepseek-ai/dsh` | 把 `dsh-desktop-client-ui` / `dsh-desktop-hmr-fallback` / `dsh-desktop-market-installer` / `dsh-desktop-preset-transfer` 声明为 dsh 依赖。缺失则 `build/dsh-desktop.patch.yml` 的 `insert: name` 解析不到包，**profile 启动即失败** | 官方提供声明式扩展点（无需改 `package.json` 即可挂载外部插件） |
| `@deepseek-ai/cordis-plugin-loader` | 插件 loader 对裸 specifier 的 import 失败时，基于 `ctx.baseUrl` 用 `createRequire` 回退解析。桌面插件包位于 `node_modules`，缺失则**插件 import 失败** | 官方 loader 支持从 `baseUrl` 解析裸包名 |
| `@deepseek-ai/dsh-client-modules` | `ClientModuleRegistry` 解析 `${expectedPackageName}/package.json` 定位插件模块，渲染侧装载的最后一段依赖 | 官方 registry 自带 `createRequire` 解析 |

### ui-behavior（11 个）

| 补丁（包名） | 判据 | 退役条件 |
|---|---|---|
| `dsh-client-ui-layout` | 折叠侧栏宽度按平台区分（macOS 80 / 其他 56），纯几何 | 官方区分平台宽度 |
| `dsh-client-ui-sidebar` | 侧栏 padding 与 `data-dsh-sidebar-*` 标记，纯样式 | 官方侧栏自带等效留白 |
| `dsh-client-ui-workspace` | 工作区/会话行样式、未读标记、搜索行渲染 | 官方列表补齐未读与行样式 |
| `dsh-client-ui-settings-models` | 模型设置页 Provider 选择器、模态切换、目录 UX | 官方设置页提供等价能力 |
| `dsh-client-ui-model-selection` | 模型选择弹层搜索框与样式 | 官方自带搜索 |
| `dsh-client-ui-agent-preset` | 预设导入/导出与 Awesome Preset 浏览界面 | 官方提供预设包导入导出（可同时撤掉 `dsh-desktop-preset-transfer` 插件） |
| `dsh-client-ui-chat` | 会话内 `QUOTA` / `FORBIDDEN` 错误文案 | 官方补齐这两种错误码文案 |
| `dsh-client-ui-trajectory` | 轨迹页 `QUOTA` / `FORBIDDEN` 错误文案 | 同上 |
| `dsh-client-ui-deliverables` | Codex 风格本地路径引用解析；`paths` 为 `null` 时的空数组兜底 | 官方支持本地路径引用解析 |
| `dsh-llm-deepseek` | 把 HTTP 403 从 `AUTH` 拆成独立 `FORBIDDEN` 码；缺失时 403 显示为鉴权错误（文案不准，不影响运行） | 官方错误码分类含 `FORBIDDEN` |
| `dsh-llm-pi-ai` | 同上：消息文本中的 403 归类为 `FORBIDDEN` | 同上 |

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
> **v0.3.0** 发布（三平台 CI + Smoke full 全绿）。`next`（0.1.5-rc.2）与 `alpha`
> （0.1.6-alpha.1）两套补丁均于 2026-09-15 完成本机真实组装 `14/14 applied` 与真实资源树
> L1 冒烟 5/5；三平台证据由各自的 Release 流程产出。

---

## 4. 维护规则

1. 新增补丁 → 在 `scripts/patch-layers.mjs` 的 `PATCH_LAYERS` 中登记（**包名** + layer + why +
   retireWhen），并在本文件对应小节补一行。未登记会被 `npm run verify:patches` 报为问题。
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
   3. `npm run prepare:harness -- --dsh-target=<目标> --force` 真实组装并确认 `14/14 applied`
      ——**这一步不可省略**：预检与真实组装在行号口径上不同，只有它能证明补丁真的落盘。
