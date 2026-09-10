# patches/ 补丁分级清单

> **单一事实源是 [`scripts/patch-layers.mjs`](../scripts/patch-layers.mjs)**；本文件是它的说明与判据记录。
> 两者一致性由以下命令强制校验（`npm run verify:patches`，也跑在 CI 的 test job 中）：
>
> ```bash
> node scripts/patch-layers.mjs --self-test
> node scripts/patch-layers.mjs --list
> ```

---

## 1. 为什么需要分级

`patches/*.patch` 是 `patch-package` 的**行级 diff**，全部锁定在 `scripts/prepare-harness.mjs`
的 `DSH_VERSION`（当前 `0.1.2-alpha.4`）。上游 DSH 处于灰度迭代期，任一被补丁包改动一行，
`patch-package` 就会冲突。此前 `prepare-harness.mjs` 对补丁只有两种结果：**全成**或**中断构建**——
于是一次纯视觉补丁的冲突就能阻断整条打包链路，而品牌与 UI 增强类补丁本不该有这种权力。

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

## 3. 逐个补丁的分类判据（2026-09-10 人工确认）

分类原则：**只有当缺失会导致「补丁体系失效」或「桌面插件挂不上 / 起不来」时才归 `functional`**；
其余一律 `ui-behavior`（可降级）。产品功能增强（如会话永久删除）虽然影响功能，
但缺失时只是该操作报错、应用整体可用，因此归入可降级层，并通过 `retireWhen` 记录其长期归属。

### functional（3 个）

| 补丁 | 判据 | 退役条件 |
|---|---|---|
| `@deepseek-ai+dsh+0.1.2-alpha.4.patch` | 把 `dsh-desktop-client-ui` / `dsh-desktop-hmr-fallback` / `dsh-desktop-market-installer` / `dsh-desktop-preset-transfer` 声明为 dsh 依赖。缺失则 `build/dsh-desktop.patch.yml` 的 `insert: name` 解析不到包，**profile 启动即失败** | 官方提供声明式扩展点（无需改 `package.json` 即可挂载外部插件） |
| `@deepseek-ai+cordis-plugin-loader+1.0.3.patch` | 插件 loader 对裸 specifier 的 import 失败时，基于 `ctx.baseUrl` 用 `createRequire` 回退解析。桌面插件包位于 `node_modules`，缺失则**插件 import 失败** | 官方 loader 支持从 `baseUrl` 解析裸包名 |
| `@deepseek-ai+dsh-client-modules+0.1.2-alpha.4.patch` | `ClientModuleRegistry` 解析 `${expectedPackageName}/package.json` 定位插件模块，渲染侧装载的最后一段依赖 | 官方 registry 自带 `createRequire` 解析 |

### ui-behavior（15 个）

| 补丁 | 判据 | 退役条件 |
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
| `dsh-api-session-controller` | 会话**永久删除**的客户端半边（`session.delete` RPC + `SessionDeleteError`）；缺失时删除会话报错，其余会话功能正常 | 官方提供会话永久删除 |
| `dsh-session-persistence` | 删除原语（`assertDeletable` / `delete` / `deleteStored`） | 同上 |
| `dsh-session-persistence-jsonl` | JSONL 后端的 `deleteStored`（删单个日志文件，保留共享项目目录） | 同上 |
| `dsh-workspace` | `forgetSession`：删除后从 Workspace 与归档状态摘除 | 同上 |

> 会话永久删除是**四条补丁 + 一个跨进程契约**的完整特性。它们被归入可降级层，
> 但四者应当**同进同退**：若其中一条冲突而其余仍在，产物会出现「UI 有删除入口但后端不支持」
> 的半成品状态。升级 DSH 版本时必须把这四条作为一个整体复核，见
> [`docs/dsh-upgrade-checklist.md`](../docs/dsh-upgrade-checklist.md)。

---

## 4. 维护规则

1. 新增补丁 → 在 `scripts/patch-layers.mjs` 的 `PATCH_LAYERS` 中登记（文件名 + layer + why + retireWhen），
   并在本文件对应小节补一行。未登记会被 `--self-test` 报为问题。
2. 删除补丁 → 同步删除分级表条目；`--self-test` 会检查「分级表引用了不存在的补丁」。
3. 调整层 → 必须同时说明理由；`functional` 只收「缺失即起不来」的补丁。
4. 上游补齐某项能力后 → 按 `retireWhen` 退役该补丁，而不是让它继续漂移。
