# DSH 官方版本升级清单

> **适用对象**：把内置的 `@deepseek-ai/dsh` 从当前版本升到上游新版本的人。
> **双通道前提（2026-09-15 起）**：本仓同时维护两条上游运行时通道——`next`（默认，追 npm `next` dist-tag）与 `alpha`（追 npm `alpha` dist-tag）。每条通道各有独立的目标定义（`scripts/dsh-targets.mjs` 的 `DSH_TARGETS`）、补丁目录（`patches/<target>/`）与 vendored 覆盖包（`packages/<target>/`）。**升级按目标逐个进行**：涉及组装与补丁的命令都接受 `--dsh-target=<next|alpha>` 指定目标（`prepare:harness` 缺省 `next`；`verify:patches` 缺省检查**全部**目标），动手前先明确你要升的是哪条线。
> **核心风险**：`patches/<target>/` 下的补丁是**行级 diff**，锁定在 `scripts/dsh-targets.mjs` 的 `DSH_TARGETS[<target>].dshVersion`（当前：next 线 `0.1.5-rc.2`、alpha 线 `0.1.6-alpha.1`）。上游任一被补丁包改动一行，对应补丁即冲突；文件名里的版本号也必须同步重命名，否则 `patch-package` 在全新组装时根本找不到目标包。
> **原则**：升级是**一次完整流程**，不是改一个常量。中断在任一步都必须回滚到已知良好状态，不允许「先合上、后面再补」。

---

## 0. 版本锚点总表

升级前先确认下列锚点的当前值，升级后必须**全部**同步。任何一处遗漏都会让产物处于「半新半旧」状态，且通常不会立刻报错。

| # | 锚点 | 位置 | 说明 |
|---|------|------|------|
| 1 | `DSH_TARGETS[<target>].dshVersion` | `scripts/dsh-targets.mjs`（目标总表） | 该目标钉住的 Harness 版本，**唯一产地**；`scripts/prepare-harness.mjs` 不再写死版本，而是按 `--dsh-target` 经 `resolveTarget()` 从这里读取。决定 `dependencies` 里所有 `@deepseek-ai/*` 的取值（每个目标一条） |
| 2 | `NODE_VERSION` | `scripts/prepare-harness.mjs` | 内置 Node 运行时版本；与 DSH 无关，除非上游提升 Node 要求 |
| 3 | `PNPM_VERSION` | `scripts/prepare-harness.mjs` | 仅用于组装期工具链，通常不动 |
| 4 | `patches/<target>/*.patch` **文件名** | `patches/<target>/` | 形如 `@deepseek-ai+dsh-client-ui-chat+<版本>.patch`，版本段必须跟**该目标**的 `dshVersion` 一致（仅 DSH 家族包跟随；`cordis-plugin-loader` 这类独立版本号的包不跟）。两个目标各持一套，`npm run verify:patches` 逐目标校验 |
| 5 | `PATCH_LAYERS` 表 | `scripts/patch-layers.mjs` | 每条补丁的 `layer` / `why` / `retireWhen`；补丁增删必须同步。表**按包名索引**——新增一条上游通道**不需要**动它，只有引入新包才要补 |
| 6 | `patches/LAYERS.md` | `patches/LAYERS.md` | 分级判据说明文档，需与 #5 保持一致（同样按包名列：同一个包在两条通道下做的是同一件事） |
| 7 | vendored 覆盖包 | `packages/<target>/*.tgz` | 被打补丁包的 tgz 覆盖，**按目标分目录**；版本号在文件名里，须对应该目标的 DSH 版本 |
| 8 | 本地定制包 | `vendor/*` | `dsh-desktop-*` 与 `dshmarket`；若声明了 `dsh.bundle` 或 `dsh.client`，受上游 profile 加载规则约束 |
| 9 | 断言脚本 | `scripts/prepare-harness.mjs` 的 `assertPickerSurfaceIsHostBacked()` | 校验目录选择器仍走 Host seam；上游若重构该实现，断言必须**更新而不是删除** |
| 10 | 文档中的版本引用 | `docs/system_design.md`、`README*.md`、`AGENTS.md` | 版本号与能力状态口径 |

> **查询当前两条通道各自钉住的版本与目录**（即锚点 #1 / #4 / #7 的当前值）：
> ```bash
> node scripts/dsh-targets.mjs                             # 目标表：每条通道的版本 / 补丁目录 / vendored / staging
> node scripts/patch-layers.mjs --list --dsh-target=next   # 某目标的补丁分级（锚点 #5；换 alpha 同理）
> ```
>
> **查询某个 DSH 版本字符串在仓库内的所有出现处**（定位改名遗漏，排除生成物）：
> ```bash
> grep -rn "<旧版本号>" --exclude-dir=node_modules --exclude-dir=target \
>   --exclude-dir=resources --exclude-dir=.git .
> ```

---

## 0.1 官方桌面版约束（升级前必须核对）

> 官方 DSH 仓库（`deepseek-ai/deepseek-harness`）内含一个桌面应用（`apps/desktop`，Electron），
> 截至 2026-09-12 **已实现但尚未公开发布**（上游设计笔记原文 "Desktop has not been released"）。
> 它对本仓构成两条**硬约束**，每次升级都必须复核——它们不会因为「还没发布」而不生效，
> 恰恰相反：一旦官方发布，违反约束的产物会直接撞车。

### 约束一：`desktop` 是保留 profile 名（含所有大小写变体）

官方桌面版**独占** `$DSH_HOME/profiles/desktop`，并拒绝 CLI 对该 profile 执行
boot / config-dump / 插件管理。

- [ ] 确认本仓**没有**任何 profile 字面量等于 `desktop`（大小写不敏感）。
      自动化判据：`npm run verify:profile-names`（P1/P2/P3；改动 `SAFE_MODE_PROFILE` /
      `HARNESS_CLI` 会让它变红）。
- [ ] 本仓当前使用 `desktop-safe-mode`（安全模式）与裸子命令 `web`（默认）——**不要**改成 `desktop`。

> 为什么本仓会被影响：本仓用 `--profile <name>` 启动 Harness（见
> `crates/dsh-host/src/args.rs::profile_arguments`）。profile 名一旦撞上官方保留名，
> `dsh` CLI 会按官方桌面版的规则接管它。

### 约束二：官方桌面版采用更深的宿主协议，不要逼近它

官方桌面**不是** `Desktop → localhost → dsh web` 这一层，而是：内置 Node + pnpm、
私有 `@deepseek-ai/dsh-desktop-host` 子进程、`dsh-app://` 自定义 scheme、**不监听端口**、
版本与 `@deepseek-ai/dsh` 锁死、独立预载（**没有** `window.dshDesktop` 这类全局）。

- [ ] 不要为逼近官方形状而改写本仓的启动链路（本仓走 loopback HTTP，这是有意的、
      也是本仓与官方桌面**并存**的基础）。
- [ ] 若某个补丁或定制包引入 `window.dshDesktop*` 之类的 renderer 全局，视为回归——
     该形状曾导致目录选择器必然失败（见 `AGENTS.md`「目录选择器必须走 Host seam」）。
     自动化判据：`prepare-harness.mjs::assertPickerSurfaceIsHostBacked()`。
- [ ] 官方桌面**不支持 Linux**（仅 mac-arm64/x64 + win-x64）。本仓的 Linux 出包是
     与官方互补的发行战术（见 `docs/roadmap.md` §6 贯穿轨道 P1），升级后需复核 Linux 链路仍绿。

### 约束三：上游版本漂移要主动监测，不要等升级时才发现

- [ ] 跑 `npm run verify:drift`：把**两条通道各自**钉住的版本与它对应的 npm dist-tag 比一次
      （`next` 对 `next` tag、`alpha` 对 `alpha` tag；上游没有对应 tag 时退回 `latest`）。
      落后 ≥1 个 minor 或出现更晚的预发布阶段（如 alpha → rc）即非零退出；
      网络不可用时打印 SKIP（**不等于「已核对」**）。

---

## 1. 升级前：建立基线（不可跳过）

没有基线就无法判断「升级后变差了」。四项都要留档。

1. **记录当前版本与提交**
   ```bash
   git rev-parse HEAD
   git status --porcelain          # 必须为空，否则先提交或 stash
   ```
2. **记录当前补丁应用结果**：`src-tauri/resources/MANIFEST.json` 的 `patches[]`，逐条应有 `status: "applied"` 与所属 `layer`；同时记下 `target` 字段——`resources/` 是两条通道共用的，MANIFEST 记录的是**最近一次组装**的目标，动手前先确认它就是你要升的那条线。
   > 若此处已有 `skipped` / `failed`，**先解决它再升级**——否则升级后无法区分「新冲突」与「旧问题」。
3. **记录当前体积**：
   ```bash
   npm run size:report             # 壳二进制 / 安装包 / 资源树 三口径
   ```
4. **跑通三平台烟雾基线**：
   ```bash
   npm run smoke:headless          # L1，本机可跑
   npm run smoke                   # L1 + L2（L2 需要显示器或 xvfb）
   ```

---

## 2. 升级中：改动与验证顺序

顺序刻意设计为「先让组装能跑通，再看应用能不能起来」——反过来的话，启动失败会被误判成代码问题。

### Step 1 — 改版本锚点

- [ ] `scripts/dsh-targets.mjs`：更新 `DSH_TARGETS[<target>].dshVersion`——**唯一产地**；`scripts/prepare-harness.mjs` 不再写死版本，而是按 `--dsh-target` 经 `resolveTarget()` 从这里读取（补丁目录 / vendored 目录 / staging 目录也一并由它推导）。只改你正在升的那条线
- [ ] **`overrides` 已无手工维护段**：它由该目标的 `patches/<target>/*.patch` 文件名与 `packages/<target>/*.tgz` 自动推导（`prepare-harness.mjs`），所以没有「要改的 overrides 段」。要检查的是**钉住是否仍然必要**——上游若已修复相关问题，按 Step 5 退役对应补丁，override 会随文件名一起消失
- [ ] `packages/<target>/*.tgz` 与 `vendor/*` 中声明依赖 DSH 版本的地方

### Step 2 — 先跑适用性预检，再重生成补丁

> **零成本入口**：`npm run check:patch-applicability -- --dsh-target=<源目标> --target=<待检版本>`
> 只下载被补丁触及的十几个包（~4MB）到内存做干跑匹配，几秒内给出「干净 / 冲突（第几段 hunk）」清单，
> **不必先组装 300MB**。两个参数是两件事：`--dsh-target` 选**哪一套补丁**（连同它的当前基线版本），
> `--target` 是**待检的上游版本**。
> 它现在还会报「**内容匹配但行号漂移超过 20 行**」：`patch-package` 按 hunk 行号定位，
> 漂移超窗的补丁即使上下文完全一致也一定打不上（重算方法见 2.2）。除此之外它只判「上下文能否对上」，
> 不判语义是否仍成立——但正是升级时最耗时的第一问。
>
> ### ✅ 0.1.2-alpha.4 → 0.1.5-rc.1 已完成（2026-09-13 全流程闭环）
>
> **做法**：不靠 `patch-package` 重新生成，而是**三路合并移植**——以 pristine alpha.4 为共同祖先，
> 把 rc.1 上游的变化叠到「alpha.4 + 补丁」的意图状态上（`git merge-file ours base theirs`），
> 冲突处逐条按语义裁定（CSS 类名 hash 改名取上游、类名映射并集、函数签名参数并集）。
>
> **结果**：14 个补丁（18 − 4，见下）在 `0.1.5-rc.1` 上**全部干净可用**
> （`check:patch-applicability --target=0.1.5-rc.1` → clean 14 / conflict 0），
> 并已走完升级清单全流程：真实组装 `14/14 applied` → 三平台 CI + Smoke `scope=full` 全绿
> → **随 v0.3.0 发布**（2026-09-13）。
>
> **⚠️ 本次升级移除了「会话永久删除」特性**（4 个后端补丁 + `client-ui-workspace` 里的删除 UI）：
> rc.1 删除了承载该逻辑的 `PersistenceCoordinator` 类（该文件 1594 → 267 行），改为 handle 模型，
> 补丁无法机械移植。详见 [`patches/LAYERS.md`](../patches/LAYERS.md) 的专门说明。
> **这是本仓自加功能的降级，不是上游能力回退**——0.1.5-rc.1 本身同样没有会话永久删除。
>
> **⚠️ 本次升级还暴露并修复了三个与升级无直接关系、但只在真跑时才现形的缺陷**：
> Windows L2 找错壳二进制路径（Cargo workspace 的 target 在仓库根）、Linux 的 musl 变体
> 逃过剪枝（rc.1 新原生依赖用裸 libc 目录名 `bin/glibc` + `bin/musl`）、macOS 孤儿防护缺口
> （R-7，无 `PR_SET_PDEATHSIG` 等价物，补了父死看门狗）。三者各带守卫，见 `AGENTS.md`。
> **这是「升级必须走三平台烟雾」的最好证据**：静态门禁与旧软门禁全都看不见它们。
>
> 历史记录（仅供参考）：对中间版本 `0.1.2-rc.1` 的预检结果是 15 干净 / 3 冲突
> （`agent-preset` / `settings-models` / `workspace`，均为 UI 层的上下文漂移）。

重生成补丁的逐个处理流程：

重生成补丁的逐个处理流程：

对 `patches/<target>/` 下每个补丁，逐个处理：

- [ ] **2.1 重命名文件名**：把版本段改为该目标的新版本（`DSH_TARGETS[<target>].dshVersion`；仅 DSH 家族包跟随，`cordis-plugin-loader` 这类独立版本号的包不改）。
      > 漏改的后果是 `patch-package` 在全新 `npm install` 后找不到目标包，该补丁静默不生效——而它的 `status` 会显示什么取决于失败模式，恰好是最难发现的一类事故。`npm run verify:patches` 会逐目标校验版本段是否与该目标的 `dshVersion` 一致。
- [ ] **2.2 重算行号**（移植补丁的必需步骤，从另一条上游线复制补丁时尤其关键）：
      ```bash
      node scripts/recount-patches.mjs --dsh-target=<target> --pristine=<未打补丁的包根>
      ```
      > **为什么必须做**：`patch-package` 定位 hunk 的方式**不是**按内容搜索，而是从补丁声明的 `@@ -N` 行号开始试探，偏移取 0、-1、+1 … **超过 ±20 行即放弃**（`dist/patch/apply.js` 的 `fuzzingOffset`）。「复制补丁、只改文件名」会让行号漂移：上下文仍能匹配（**预检按内容搜索，会报 clean**），但真实组装定位不到，**只在下载完 300MB 组装时**才报 `cannot apply the patch file`。2026-09-15 的 alpha 线移植就撞上了（`trajectory` 漂移 135 行）。
      >
      > `--pristine` 必须指向**未打补丁**的上游包（布局 `<root>/<包名>/…`；默认 `harness-deps/<target>-pristine`，不存在时脚本直接报错）。**不能**用组装后的 `harness-deps/<target>/node_modules`——它已经打过补丁，行号无从重算。重算完成后按脚本提示重跑真实组装复核（2.3）。
- [ ] **2.3 试打补丁并解决冲突**：
      ```bash
      npm run prepare:harness -- --dsh-target=<target> --force
      ```
      `--force` 强制完整重组；分级策略下的失败汇总会打印每个补丁的 `applied / skipped / failed` 与层名。
- [ ] **2.4 对每个冲突判断归属**（三类结论必须显式选一个，不允许「先注释掉」）：
      | 情况 | 处理 |
      |------|------|
      | 上游已实现等效功能 | **退役该补丁**：删除文件 + 从 `PATCH_LAYERS` 移除 + 在 `LAYERS.md` 记退役原因与上游 PR/版本 |
      | 上游仅改动上下文行 | 重生成补丁（重新在该包上做改动后 `npx patch-package <pkg>`） |
      | 上游重构使补丁前提失效 | 补丁的**语义**需重做；此时若属 `functional` 层，必须评估是否阻塞发版 |
- [ ] **2.5 同步登记**：`scripts/patch-layers.mjs` 的 `PATCH_LAYERS` 与 `patches/LAYERS.md`——两者都**按包名**索引，所以新增/推进一条通道本身**不需要**动它们，只有新增或删除**包**才要改（同一包在两条通道下是同一件事，只是行号随上游版本变化）。
- [ ] **2.6 自检**：
      ```bash
      npm run verify:patches        # 逐目标（next / alpha）检查：包名可推导、已登记、文件名版本段与目标版本一致
      ```

> **补丁退役优先于补丁修复。** 每个 `ui-behavior` / `brand` 补丁都是长期的升级成本。若能推动需求进入上游，退役是净收益。`PATCH_LAYERS` 的 `retireWhen` 字段就是为此准备的判据记录。

### Step 3 — 校验断言仍然有效

- [ ] 确认 `assertPickerSurfaceIsHostBacked()` **仍然在断言正确的东西**：它要求补丁后的客户端文件不引用 `window.dshDesktop*` 且仍调用 `ctx.uiWorkspace.pickDirectory()`。
- [ ] 若上游改了目录选择器的 API 形状，**更新断言使其对应新形状**，不得因「断言失败」而删除断言——该断言的存在理由见 `AGENTS.md`（曾有一个补丁引入从未定义的 renderer 全局，导致导入项目必然报错）。

### Step 4 — 无头门禁（快、必过）

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test -p dsh-contracts -p dsh-host -p dsh-host-cli
cargo test --workspace          # 见下方平台说明
```

- [ ] 四项全绿。`dsh-host` 集成测试会真实派生 `scripts/mock-harness.mjs`，因此需要 `PATH` 上有 Node（或用 `DSH_TEST_NODE` 指定）。
- [ ] 注意：**无头门禁不覆盖 Harness 版本变更**——它测的是壳的行为，而 Harness 是当作黑盒被派生的。
- [ ] **平台说明（GNU 工具链宿主机）**：`cargo test --workspace` 在 `x86_64-pc-windows-gnu` 上会因 `src-tauri` 的测试二进制加载失败而报错（缺 `api-ms-win-core-winrt-error-l1-1-0.dll`，来自 Tauri 链接的 `webview2-com-sys`）。这是环境限制而非代码问题，详见 `AGENTS.md` §2「已知环境限制」。此时：
  - 本地以第 3 条的无头门禁为准（不含 `src-tauri`）；
  - `src-tauri` 的行为改由 Step 5 的 L1/L2 烟雾覆盖；
  - `src-tauri` 单测的执行者是 CI（MSVC runner），**不得因为本地跑不动就删掉这些测试**。

### Step 5 — 三平台烟雾（真正会发现 DSH 升级问题的门禁）

```bash
npm run smoke:headless            # L1：组装产物可派生、能就绪、退出干净、无孤儿
npm run smoke                     # L2：GUI 真实启动（Linux 下走 xvfb）
```

- [ ] L1 全绿（硬门禁）
- [ ] L2 三平台结果记录（Linux 无显示环境为已知限制，不作为硬门禁，但**结果必须留档**）
- [ ] 检查启动日志无 `[dsh-plugin-fault]` 归因（插件注册冲突 / 加载失败）
      ——注：`ISOLATION_NOT_WIRED` 自 2026-09-10 起不会再出现，产生它的插件隔离模块已归档删除

> **烟雾验收的是 `src-tauri/resources/` 里当前那棵树**：它由最近一次
> `npm run prepare:harness -- --dsh-target=<目标>` 产出。两条通道共用这一个资源目录，
> 切换 `--dsh-target` 时幂等判定会因 MANIFEST 的 `target` 不同而自动重组——但冒烟前
> 仍应先确认这棵树确实属于本次升级的那条线（`MANIFEST.json` 的 `target` 字段）。
> 远端 smoke 工作流用 `dsh_target` 输入选通道（`gh workflow run smoke.yml -f scope=full -f dsh_target=alpha`）。

### Step 6 — 体积与包体对比

```bash
npm run size:report
```

- [ ] 与 Step 1 的基线对比，记录资源树增量。依赖树增长是 DSH 升级最常见的隐性代价。
- [ ] 增量异常（例如 > 30MB）时，先确认不是新增了重复依赖或误把 devDependencies 打进资源树。

### Step 7 — 文档与状态口径同步

- [ ] 更新 `docs/system_design.md` 中的版本引用
- [ ] 若升级导致能力状态变化（例如某个 `⚠️ 未接线` 项被接线、或某个补丁退役使某能力消失），**必须**同步 `AGENTS.md` §7 的对照表与 `README.md` / `README.zh-CN.md` 的功能列表
- [ ] 在 `docs/` 记录本次升级的冲突处理结论（哪个补丁退役、为什么）

---

## 3. 升级后：允许合并的判据

全部满足才合并：

- [ ] `MANIFEST.json` 的 `patches[]` 逐条 `applied`，或 `skipped` 项均为 `ui-behavior` / `brand` 层且有明确记录
- [ ] `npm run verify:patches` 通过
- [ ] Step 4 四项全绿
- [ ] L1 烟雾全绿
- [ ] 体积变化已记录，无未解释的异常增量
- [ ] `AGENTS.md` §7 / README 状态口径与实际一致（`grep -rn "⚠️ 未接线" AGENTS.md README.md` 的命中项确实未接线）

---

## 4. 回滚

升级过程任一步不可解决时，回滚到 Step 1 记录的提交：

```bash
git checkout <baseline-commit> -- patches scripts/dsh-targets.mjs scripts/prepare-harness.mjs packages vendor
rm -rf src-tauri/resources harness-deps      # 组装产物，必须重建
npm install
npm run prepare:harness -- --dsh-target=<target> --force
npm run smoke:headless
```

- 回滚后**必须**重新跑一次 L1 烟雾：`resources/` 是生成物，删掉后不重建会让下一次构建悄悄用错版本。
- 不允许把「升级分支」与「回滚状态」长期并存——补丁文件名带版本号，同一 `patches/<target>/` 目录里放不下同一通道的两个版本。（两条**通道**各自的补丁集并存是有意的，见开头的双通道前提；受限的是同一条线。）

---

## 5. 已知的长期脆弱点

| 脆弱点 | 为什么存在 | 缓解 |
|--------|-----------|------|
| `patch-package` 行级 diff（当前每条通道 14 个，曾 18 个） | 上游未开放的能力扩展点（品牌、UI 行为、插件加载） | 分层降级（`ui-behavior` 失败不阻构建）+ `retireWhen` 记录退役判据 + **移植后重算行号**（Step 2.2，`recount-patches.mjs`——±20 行窗口外必失败）；长期方案见 [`harness-packaging-and-compatibility.md`](harness-packaging-and-compatibility.md) |
| 补丁文件名内嵌版本号 | `patch-package` 的命名约定 | 本文 Step 2.1 强制项；`verify:patches` **逐目标**校验包名可推导性与版本段一致 |
| 无头门禁覆盖不到 Harness 行为变更 | 壳把 Harness 当黑盒派生 | Step 5 的 L1/L2 烟雾是**唯一**能发现此类回归的门禁 |
| 体积随上游增长 | 内置完整依赖树以换取宿主机零依赖 | Step 6 的体积对比 + [`harness-packaging-and-compatibility.md`](harness-packaging-and-compatibility.md) 的瘦身方案 |
