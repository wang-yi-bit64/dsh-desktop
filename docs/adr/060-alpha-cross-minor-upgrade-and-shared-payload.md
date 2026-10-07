# ADR-060 — alpha 通道跨 minor 推进至 DSH `0.2.1-alpha.1`：退役判据、注入点迁移，与 primary runtime 共享载荷的显式对齐

|  |  |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-10-07 |
| 唯一产地 | `scripts/dsh-targets.mjs` 的 `DSH_TARGETS.alpha.dshVersion`（DSH 版本）；`runtime-locks/primary-runtime.json` 的 `officeSkills.version`（载荷来源版本） |
| 关联 | ADR-057（alpha 复役与双通道晋升/单调守卫）；`docs/dev-plan-alpha-0.2.1-upgrade.md`（本轮计划与执行台账，含 §7.5）；`docs/dev-plan-0.8-convergence.md` §6（切线放行条件）；`patches/LAYERS.md` §「alpha 线（0.2.1-alpha.1）的移植裁定（2026-10-07）」 |

## 背景

alpha 线的 DSH 版本由 `0.1.7-alpha.2` 推进到 `0.2.1-alpha.1`。这与既往几次推进有三点不同，
且三点都**不能靠既有规则自动推出结论**，故单独立 ADR：

1. **本仓首次「跨 minor」推进**（`0.1.7` → `0.2.1`）。此前 alpha 线只在同一 minor 内小步走
   （`0.1.2-alpha.4` → `0.1.6-alpha.1` → `0.1.7-alpha.2`），上游结构没有整体重排；这次有。
   补丁集由 **11 条降为 10 条**。
2. **退役与「上游追上我们」同时发生**：一条补丁按写明的 `retireWhen` 判据退役，
   另有两类补丁因上游自带能力而必须**收窄/迁移**而不是照旧重放。这三条各自对应一个决策。
3. **桌面版本必须跳到 `0.7.3-alpha.x`**：ADR-057 的跨通道单调守卫要求 alpha 桌面版本**严格大于**
   当时最高 rc tag。`0.7.2-alpha.x` 与 `0.7.2-rc.1` 同核心版本、预发布段按字母序比，
   `alpha` < `rc` ⇒ 不能发 `0.7.2-alpha.x`。本轮取 `0.7.3-alpha.1`。

此外，本轮在推进**时机**上不满足现役计划的放行条件（见决策 5），属**例外放行**，必须显式登记而不是沉默推进。

## 决策

### 1. `dsh-client-ui-model-selection` 整条退役（两线归一）

**判据已在补丁登记表中写明**（`retireWhen`：官方自带型号选择器搜索/键盘导航），本轮实测满足：
`0.2.1-alpha.1` 的 `lib/` 内自带模糊搜索与键盘导航（`search`×30 / `searchRow`×9 / `searchRef`×6 /
`fuzzy`×1 / `moveFocus`×2）。next 线已于 2026-09-30 先行退役，本轮 alpha 线跟进后**两线归一**。

- **性质**：这是「上游追上我们」，**不是能力回退**。按 `patches/LAYERS.md` §4 维护规则第 4 条执行。
- ⚠️ **判据的观测面必须说清**：退役的是**补丁**，不是包。
  `@deepseek-ai/dsh-client-ui-model-selection@0.2.1-alpha.1` 仍会出现在组装树里（它仍是上游正常依赖）。
  **判断退役是否生效，要看 `patches/<target>/` 下含该包名的补丁文件数，不能看目录在不在。**

### 2. `dsh-client-ui-chat` 收窄为「只重放 `FORBIDDEN`」

上游在 `0.2.1-alpha.1` 内置了 `QUOTA` / `ACCOUNT_*` 族的错误文案，本补丁继续重放它们会与上游叠加成双份处理。
故收窄为只保留 `FORBIDDEN` 分支（`lib/client.js` 内 `if (code === "FORBIDDEN")`），额度族文案**交还上游**。
`retireWhen`：官方补齐 `FORBIDDEN` 文案（**尚未满足**，故保留）。

### 3. `dsh-client-ui-settings-models` 的注入点迁移（语义重做，不是行号重算）

上游重构后，本补丁原先依赖的 `advancedExtra` 注入点**消失**。迁移目标是上游的槽位声明
`renderSlot` / `ModelsChildSlots`（即 `ModelRow` 的插槽体系），能力本身不变
（每模型**推理等级**控件 `ModelReasoningEffortsField`；官方源码明确注释「刻意不做」）。
（Provider 选择器与搜索增强自 2026-09-30 起已随上游目录添加流退役，不属本轮。）

- 迁移同时**补回**上游新增的 `props.onSubmitCredential?.();` 调用——不补会让上游新增的凭据提交流程失效。
- ⚠️ 该补丁是本轮唯一因**人工增删 hunk 内行**而踩坑的补丁，见「后果 · 已加固的判绿口径」。

### 4. `primary runtime` 的 `officeSkills.version` 由 `0.2.0-rc.2` 改为 `0.2.1-alpha.1`

**唯一产地**：`runtime-locks/primary-runtime.json` 的 `officeSkills.version`；
消费者是 `scripts/fetch-primary-runtime.mjs`（`npm pack <package>@<version>` 后取
`package/assets/` 下的三份 `SKILL.md` 与 `scripts/check_office.py`）。

**为什么改**：`@deepseek-ai/dsh@0.2.1-alpha.1` **直接依赖**
`@deepseek-ai/dsh-skill-office@0.2.1-alpha.1`。让载荷来源版本与在役 DSH 线对齐，
避免「桌面壳跑的是 0.2.1-alpha.1 的 Harness，而 office skills 正文取自 rc 线」这种跨线混装。
目标版本经 registry 实测**确实已发布**（`npm view @deepseek-ai/dsh-skill-office@0.2.1-alpha.1 version` 返回该版本）。

**为什么本轮之前的倾向是「不动」**：该文件**不按通道分目录**——`runtime-locks/` 根下单一文件，
两线共用同一份载荷。因此它的 `officeSkills.version` **在结构上无法同时匹配 next 与 alpha 两条线**。
本轮由用户显式裁定：**向 alpha 线对齐**（本轮发布的是 alpha 线）。这一取舍的代价见「后果」。

**边界（明确不做的事）**：
- 不改文件的目录结构（把 `runtime-locks/` 拆成按通道分目录**不在本轮范围**，且会牵动
  `fetch-primary-runtime` / `prepare-primary-runtime` / `prepare-runtime` 三处调用链与归档对账）。
- 该字段**没有任何门禁交叉校验**它与通道的一致性（实测：`scripts/verify-*.mjs` 与 `scripts/gates.mjs`
  均无 `officeSkills` 引用），因此**改它不会让任何门禁变红——也不会让任何门禁替你发现问题**。
  这正是必须写进 ADR 的原因：它靠人记，不靠工具守。

### 5. 例外放行：本轮推进**早于**现役计划的切线条件

`docs/dev-plan-0.8-convergence.md` §6 的四项放行条件是：①上游版本已发布 ≥7~14 天；
②相关讨论已关闭；③适用性预检通过；④fixtures 全绿。**本轮仅第 ③ 项满足**。

- **理由**：推进由用户明确指令驱动，目标是在 alpha 通道交付 `0.2.1-alpha.1` 的桌面预发布；
  alpha 通道的定位本就是「快速验证、不承诺稳定」，其风险由「不与 next 线互相阻塞」隔离。
- **已知代价（如实登记）**：本轮继承的是**未被观察期过滤过的上游**——若上游在发布后 7~14 天内回滚或
  热修，本仓会先于观察期吃到。缓解手段只有通道自身的隔离性与可回滚性（见 `docs/dev-plan-0.2.1` §6 与
  `docs/dsh-upgrade-checklist.md` §4）。
- 🔴 **本 ADR 只登记这次例外，不修改放行条件本身**（符合 `AGENTS.md` 关于「计划文档无权改写 ADR / 文档
  不得只增不减」的纪律）。

### 6. 判绿口径硬化：`ui-behavior` 层失败**不阻构建**，故**必须逐行读补丁表**

`prepare-harness.mjs` 按 `patches/LAYERS.md` 分级施加补丁：只有 `functional` 层失败会中断构建，
`ui-behavior` 层失败**只打印一行 `✘ … failed` 后进程退 0**。因此：

- **`prepare:harness` 退出码 0 ≠ 补丁全部落盘**。判绿必须看 `MANIFEST.json` 的 `patches[]` 是否逐条 `applied`
  （或 `skipped` 且属 `ui-behavior` 层且有记录）。
- 本轮实测正是这条口径救了一次：settings-models 补丁 failed 但进程退 0（详见「后果」）。

## 后果

### 已加固的判绿口径（本轮抓到、且**现有工具链看不见**的一类缺陷）

给 hunk 内**人工增删行**后若忘记同步 `@@ -old,N +new,M @@` 的计数，会发生：

| 环节 | 表现 |
|---|---|
| `check:patch-applicability`（按**内容搜索**定位 hunk） | ✅ 仍报 clean —— 它不校验 `@@` 计数 |
| `relocate-patch-hunks.mjs`（只重算 hunk **起点**） | ✅ 仍报全对齐 —— 同样不校验计数 |
| `patch-package` 实际施加（按 `@@ -N` **行号**定位） | ❌ 整文件解析错位 → 该补丁 `failed` |
| `prepare:harness` 退出码 | ⚠️ **0**（`ui-behavior` 层按分级策略降级继续） |

⇒ **结论**：「预检 clean + 退出码 0」在本仓**不足以**证明补丁落盘。
可执行的判绿路径只有两条，且必须都走：
①`MANIFEST.json` 逐条 `applied`；②组装后对补丁目标包做 `node --check` 语法自检（防 regen/splice 误删行）。

> 📌 **未实施、待裁定的改进**：给 `relocate-patch-hunks.mjs` 或预检链补一条**离线 hunk 计数自洽校验**。
> 该缺陷在现有工具链下完全不可见，且其后果是「发出一个少了功能的包」——最坏的一类结果。
> 本 ADR 只登记问题与判据，**不代替实现**。

### 已知代价

1. **决策 4 的跨线代价**：`officeSkills.version` 是两线共用字段。改为 `0.2.1-alpha.1` 后，
   **next 线（`0.2.0-rc.2`）的下一次载荷准备也会从 `0.2.1-alpha.1` 的 office skills 包取 `assets/`**。
   评估：该包在两版本间提供的是同一组四份文件（三份 `SKILL.md` + `check_office.py`），
   且载荷准备期有归档档位对账（`prepare-runtime.mjs`，不符即硬失败），因此**风险可控但有方向性偏差**：
   从「壳版本与载荷版本严格同线」退化为「载荷向 alpha 线倾斜」。
   若 next 线随后也要发布，应重新裁定（把 `runtime-locks/` 拆分为按通道分目录，或让 next 线回退该字段）。
2. **决策 5 的观察期代价**：见决策 5「已知代价」。
3. **本轮的本地验证覆盖不完整**（环境限制，非本轮引入）：本机**无法为子进程建立 stdin 管道**，
   故 `cargo clippy --workspace --all-targets` 与 rustdoc doctest **在本机不可用**，
   这两项的权威判据只能由 CI（Linux runner）提供。完整根因与规避见
   `docs/incidents/local-toolchain-limits.md` 末条与 `docs/dev-plan-alpha-0.2.1-upgrade.md` §7.5。
   ⚠️ **不得因为本地 `--tier=fast` 全绿就顺手宣布 full 档也绿**——fast 档的 cargo 步骤只覆盖
   `-p dsh-contracts -p dsh-host -p dsh-host-cli`，其依赖图不含 `indexmap`/`schemars`。

### 明确**不变**的部分

- `runner` 双通道隔离结构本身（`patches/<target>/`、`packages/<target>/`、`harness-locks/<target>/` 零结构改动）。
- `patches/LAYERS.md` §4 的维护规则（本 ADR 的全部退役/收窄动作都是**按其现有规则**执行的，没有新增特例）。
- `runtime-locks/primary-runtime.json` 的**目录结构**（只改一个版本字符串）。
- 放行条件本身（只登记例外，不改条件）。

## 判据（可证伪，本轮实测值）

| 判据 | 期望 | 本轮实测 |
|---|---|---|
| 适用性预检 | 全部干净 | `clean 10 / conflict 0` |
| **真实组装（唯一能证明落盘）** | 逐条 `applied` | ✅ **10/10 applied**，`MANIFEST.target = "alpha"`，非 applied/skipped = 0 |
| 补丁后语法自检 | 零 `SyntaxError` | ✅ 10 个补丁包共 23 个 `.js/.cjs/.mjs`，**0** |
| 门禁编排器 `--tier=fast` | 45 步全绿 | ✅ **45 步 / 383.5s / EXIT=0** |
| `runtime-locks` 的 `officeSkills.version` | `0.2.1-alpha.1` | 见「决策 4」；消费者 `fetch-primary-runtime.mjs` 用 `npm pack` 取该版本 |
| **L1 无头烟雾（唯一能发现 Harness 回归）** | 5/5 PASS | ✅ **5/5**，日志自证 `dsh=0.2.1-alpha.1 node=24.9.0 patches=10/10`，无 `[dsh-plugin-fault]` |
| 桌面版本单调性 | 严格大于最高 rc tag | `0.7.3-alpha.1` > `v0.7.2-rc.1` |
| 权威判据 | CI + 双线 Smoke（`dsh_target=alpha` / `next`） | 由 `release.yml` 前置的 workflow 提供（见计划 §C4） |
