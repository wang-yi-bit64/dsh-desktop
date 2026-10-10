# DSH 官方版本升级清单

> **适用对象**：把内置的 `@deepseek-ai/dsh` 从当前版本升到上游新版本的人。
> **双通道前提（2026-09-15 起）**：本仓同时维护两条上游运行时通道——`next`（默认，追 npm `next` dist-tag）与 `alpha`（追 npm `alpha` dist-tag）。每条通道各有独立的目标定义（`scripts/dsh-targets.mjs` 的 `DSH_TARGETS`）、补丁目录（`patches/<target>/`）与 vendored 覆盖包（`packages/<target>/`）。**升级按目标逐个进行**：涉及组装与补丁的命令都接受 `--dsh-target=<next|alpha>` 指定目标（`prepare:harness` 缺省 `next`；`verify:patches` 缺省检查**全部**目标），动手前先明确你要升的是哪条线。
> ⚠️ **通道名 ≠ 当前锚定的上游版本**：`upstreamDistTag` 字段是**上游 npm dist-tag 名**（通道定义；2026-10-09 由 `channel` 改名，旧名会被读成「本仓发布通道」），而 `dshVersion` 是**组装锚点**——答「用哪套补丁目录」。「**本仓钉的是哪个上游版本**」的 SSOT 是**台账** `harness-locks/dsh-releases.json` 的**在役键**（每个目标恰好一条；`docs/version-policy.md` §4），目标表的 `dshVersion` 与它必须**同批一致**（`npm run gate -- plan-facts` 的 C1 直接断言这一条）。二者**历史上**可以不一致。2026-09-30 `next` 线与 2026-10-07 `alpha` 线各自推进后，`next` 锚 `0.2.0-rc.2`、`alpha` 锚 `0.2.1-alpha.1`，两条线已各自对齐上游对应 dist-tag（2026-10-08 实测一致，`npm run gate -- drift` 不告警）。升级前先读台账与目标表的**实际值**，不要按通道名推断版本。
> **核心风险**：`patches/<target>/` 下的补丁是**行级 diff**，锁定在 `scripts/dsh-targets.mjs` 的 `DSH_TARGETS[<target>].dshVersion`（当前：next 线 `0.2.0-rc.2`、alpha 线 `0.2.1-alpha.1`）。上游任一被补丁包改动一行，对应补丁即冲突；文件名里的版本号也必须同步重命名，否则 `patch-package` 在全新组装时根本找不到目标包。
> **原则**：升级是**一次完整流程**，不是改一个常量。中断在任一步都必须回滚到已知良好状态，不允许「先合上、后面再补」。

---

## 0. 版本锚点总表

升级前先确认下列锚点的当前值，升级后必须**全部**同步。任何一处遗漏都会让产物处于「半新半旧」状态，且通常不会立刻报错。

| # | 锚点 | 位置 | 说明 |
|---|------|------|------|
| 1 | `DSH_TARGETS[<target>].dshVersion` | `scripts/dsh-targets.mjs`（目标总表） | 该目标的**组装锚点**（上游精确版本）；`scripts/prepare-harness.mjs` 不再写死版本，而是按 `--dsh-target` 经 `resolveTarget()` 从这里读取。决定 `dependencies` 里所有 `@deepseek-ai/*` 的取值（每个目标一条）。⚠️ **「本仓钉的是哪个上游版本」的 SSOT 是台账在役键**（`harness-locks/dsh-releases.json`，见 `docs/version-policy.md` §4）——同一事实两处产地，改锚点时必须与本字段同批，`plan-facts` 的 C1 会断言两者一致 |
| 2 | `NODE_VERSION` | `scripts/prepare-harness.mjs` | 内置 Node 运行时版本；与 DSH 无关，除非上游提升 Node 要求 |
| 3 | `PNPM_VERSION` | `scripts/prepare-harness.mjs` | 仅用于组装期工具链，通常不动 |
| 4 | `patches/<target>/*.patch` **文件名** | `patches/<target>/` | 形如 `@deepseek-ai+dsh-client-ui-chat+<版本>.patch`，版本段必须跟**该目标**的 `dshVersion` 一致（仅 DSH 家族包跟随；`cordis-plugin-loader` 这类独立版本号的包不跟）。两个目标各持一套，`npm run gate -- patches` 逐目标校验 |
| 5 | `PATCH_LAYERS` 表 | `scripts/patch-layers.mjs` | 每条补丁的 `layer` / `why` / `retireWhen`；补丁增删必须同步。表**按包名索引**——新增一条上游通道**不需要**动它，只有引入新包才要补 |
| 6 | `patches/LAYERS.md` | `patches/LAYERS.md` | 分级判据说明文档，需与 #5 保持一致（同样按包名列：同一个包在两条通道下做的是同一件事） |
| 7 | vendored 覆盖包 | `packages/<target>/*.tgz` | 被打补丁包的 tgz 覆盖，**按目标分目录**；版本号在文件名里，须对应该目标的 DSH 版本。⚠️ **两条线当前均为空**（alpha 于 2026-09-16、next 于 2026-09-24 退役——退役判据是与 registry 同版本 tarball 逐字节一致 ⇒ vendoring 前提不成立）。空目录**不报错**：`prepare-harness.mjs` 以 `readdirSafe` + `existsSync` 容忍该目录整体缺失 |
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
      自动化判据：`npm run gate -- profile-names`（P1/P2/P3；改动 `SAFE_MODE_PROFILE` /
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

- [ ] 跑 `npm run gate -- drift`：把**两条通道各自**钉住的版本与**上游最新 GitHub Release** 比一次。
      🔄 **基准已于 2026-10-09 由 npm dist-tag 换成上游 Release**（计划 2f；理由与实测见
      `scripts/verify-upstream-drift.mjs` 文件头：dist-tag 滞后可见，且上游出现过「tag 已动、
      依赖树未齐」的波次）。判定分档：
      - **阻断**：落后 ≥1 个 minor / 上游进入更晚的预发布阶段（如 alpha → rc）/
        上游在**新补丁线**上重新起预发布（patch 前进 **且** 阶段回退 ⇒ `patch-line-behind`）；
      - **仅提示**：同一 major.minor 且同一阶段，只落后补丁位或阶段内序号；
      - npm dist-tag 仍会打印，但**只作参考、不参与判定**（两者的差值＝「上游已宣布、npm 还没跟上」）；
      - 取不到上游 Release ⇒ 打印 SKIP（**不等于「已核对」**）；
        ⚠️ 例外：仓库 slug 404 属**配置缺陷**（slug 是本仓写死的常量），那种情形**判红**。

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

- [ ] `scripts/dsh-targets.mjs`：更新 `DSH_TARGETS[<target>].dshVersion`——**组装锚点**；`scripts/prepare-harness.mjs` 不再写死版本，而是按 `--dsh-target` 经 `resolveTarget()` 从这里读取（补丁目录 / vendored 目录 / staging 目录也一并由它推导）。只改你正在升的那条线。⚠️ 同批还要更新 `harness-locks/dsh-releases.json` 的在役键（那是「本仓钉的是哪个上游版本」的 SSOT，两者不一致会被 `npm run gate -- plan-facts` 判红）
- [ ] **`overrides` 已无手工维护段**：它由该目标的 `patches/<target>/*.patch` 文件名与 `packages/<target>/*.tgz` 自动推导（`prepare-harness.mjs`），所以没有「要改的 overrides 段」。要检查的是**钉住是否仍然必要**——上游若已修复相关问题，按 Step 5 退役对应补丁，override 会随文件名一起消失
- [ ] `packages/<target>/*.tgz` 与 `vendor/*` 中声明依赖 DSH 版本的地方
- [ ] **重新生成提交式 lockfile（2026-09-23 起，必做）**：版本锚点、补丁集、vendored 包任何一个变了，`harness-locks/<target>/` 的 lockfile 就与输入失配，CI 的组装会**硬失败**（`lockInputsMatch` 四条规则，其中第 4 条校验快照自证的 `target` + `dshVersion`）。重新生成：
  ```bash
  npm run harness:lockfile -- --dsh-target=<target>   # 需联网；next 解析约 15-40 分钟，alpha 数分钟
  git add harness-locks/<target>/package-lock.json harness-locks/<target>/inputs.json
  ```
  生成模式先算出**家族传递闭包**：从 `@deepseek-ai/dsh` 出发，沿 `dependencies` +
  `optionalDependencies` + `peerDependencies` 三字段 BFS，只收集 `@deepseek-ai/dsh-*`
  前缀，把闭包内**在该版本上已发布**的包全钉到该版本（**不钉解析不收敛**——实测 >1h 无解，
  堆 >4GB；漏掉 peer 边则会在运行期以「单例包多份拷贝 → FFI 重复类型注册」爆出来），
  然后 `npm install --package-lock-only` 只解析不安装。详见 `scripts/harness-lockfile.mjs`
  模块文档与 `AGENTS.md`「依赖解析的堆爆炸」一节。

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

> ### ✅ alpha 通道推进：`0.1.7-alpha.2` → `0.2.1-alpha.1`（2026-10-07；**跨 minor，补丁 11 → 10**）
>
> 本仓首次**跨 minor**推进（`0.1.7` → `0.2.1`）。补丁数由 11 降为 10：
>
> - **`dsh-client-ui-model-selection` 整条退役**：上游把型号选择器的搜索增强做进原生实现，
>   命中该补丁 `retireWhen` 写明的判据——属「上游追上我们」，**不是能力回退**。
>   ⚠️ 退役的是**补丁**，不是包：组装树内 `@deepseek-ai/dsh-client-ui-model-selection@0.2.1-alpha.1`
>   仍然存在（它是上游正常依赖），判断退役是否生效要看 `patches/alpha/` 下的补丁文件数，**不是看目录在不在**。
> - **`ui-chat` / `ui-settings-models` 语义重做**：`ui-chat` 收窄为只重放 `code === "FORBIDDEN"` 分支
>   （额度文案交还上游）；`ui-settings-models` 的注入点随上游重排（`advancedExtra` 消失 →
>   改挂 `renderSlot` / `ModelsChildSlots`），并补回上游新增的 `props.onSubmitCredential?.();`。
> - **`llm-deepseek` / `llm-pi-ai` 纯行号重算**（无语义改动）。
> - `cordis-plugin-loader` 保持 `1.0.3`（本补丁版本段与 DSH 版本解耦）。
>
> | 判据 | 结果 |
> |---|---|
> | 适用性预检 | `clean 10 / conflict 0` |
> | 真实组装（唯一能证明补丁落盘） | ✅ **10/10 applied**，`MANIFEST.target = alpha` |
> | 补丁后语法自检（`node --check`） | ✅ 10 个补丁包共 23 个 `.js/.cjs/.mjs`，`SyntaxError = 0` |
> | 门禁编排器 `--tier=fast` | ✅ **45 步全绿**（含 `cargo test --tests`） |
> | **L1 无头烟雾** | ✅ **5/5 PASS**，日志自证 `dsh=0.2.1-alpha.1 node=24.9.0 patches=10/10`，无 `[dsh-plugin-fault]` |
>
> **体积**：资源树口径三 **496.3 MB**（`harness/` 410.1 MB / `node/` 85.5 MB，199 个顶层包）。
> 最大子项 `@deepseek-ai/libreoffice-kit-win32-x64` **184 MB**——该大件自 `0.1.6-alpha.2` 起就在资源树内，
> **不是本轮新增**，故本轮**不构成需要解释的异常增量**。
> ⚠️ 本机**无体积基线**（`.workbuddy/size-baseline.json` 不存在），因此**没有做增量对比**；
> 代理基线见计划 §1.5，若需后续可比，首次可跑 `npm run size:report -- --write-baseline`。
>
> ⚠️ **本批次抓到两个「只看退出码看不见」的坑**（都已补守卫认知）：
> ① **hunk `@@` 计数失配**：给 hunk 补行却未同步 `+new,M` 计数 ⇒ `patch-package` 解析错位 ⇒
>    该补丁 `failed`。但 `check-patch-applicability`（按内容搜索）与 `relocate-patch-hunks`（只重算起点）
>    **都不校验计数**，且 `ui-behavior` 层失败**只打印一行、进程退 0** ⇒ **静默降级出缺功能的构建**。
>    **判绿必须逐行读补丁表，不能只看退出码。**
> ② **`spawnSync … EBUSY` 的真根因**：不是安全软件、不是残留目录，而是**本机无法为子进程建立 stdin 管道**。
>    它伪装成 `koffi` 的 `CMake does not seem to be available`（真因是 `cnoke` 的预编译探针子进程没起来）。
>    详见 `docs/incidents/local-toolchain-limits.md` 末条与计划 §7.5。
>
> 另如实记录两项**例外放行**（与 2026-09-30 那次同性质）：
> ① 本轮推进**早于**现役计划（`docs/dev-plan-0.8-convergence.md` §6）的四项切线条件中的三项
>    （发布时长、相关讨论关闭、fixtures 全绿），仅「预检通过」一项满足；理由与已知代价须记入 ADR-060，
>    **不得修改放行条件本身**。
> ② `runtime-locks/primary-runtime.json` 是**不按通道分目录的共享载荷**，两线共用一份，
>    其 `officeSkills.version` 无法同时匹配 next 与 alpha 两条线。**本轮由用户显式裁定「向 alpha 线对齐」**：
>    该字段由 `0.2.0-rc.2` 改为 `0.2.1-alpha.1`（依据 `@deepseek-ai/dsh@0.2.1-alpha.1` 直接依赖
>    `dsh-skill-office@0.2.1-alpha.1`），代价（next 线下一次载荷准备会取同一版本）与边界
>    （`runtime-locks/` 不拆目录）记入 **ADR-060 决策 4**。
>    ⚠️ 该字段**没有任何门禁交叉校验**——改它不会让门禁变红，也不会被门禁发现问题，只能靠 ADR 记。

> ### ✅ 双通道同步推进：next → 0.2.0-rc.2、alpha → 0.1.7-alpha.2（2026-09-30；ADR-057）
>
> **做法上的新增**：把 0.1.2-alpha.4 → rc.1 的先例（三路合并移植）工具化为
> `scripts/merge-migrate-patches.mjs`（merge 产出两棵树 + 冲突清单、regen 从两棵树重生成补丁）。
> 预检 next clean 2 / conflict 12、alpha clean 4 / conflict 9；三路合并自动消解 7/10 与 9/11 后，
> 只剩 5 个包 55 处冲突需人工裁定——**但工具只保证文本与行号，语义裁定仍逐条人判**。
>
> **四个整线退役 + 一条插件链退役**（概观见 `patches/LAYERS.md` 的 2026-09-30 裁定记录）：
> `ui-layout` / `ui-workspace` / `ui-agent-preset` 双线退役、`ui-model-selection` 仅 next；
> `dsh-desktop-preset-transfer` 插件随 UI 退役整链退役（上游 preset roots 文件模型被重铸为
> agentPresets 注册模型，四个导入符号消失）。
>
> ⚠️ **本批次抓到的两个「只在真跑时现形」的缺陷，都新增了对应守卫认知**：
> ① 组装后的**树健全性门禁**（`prepare-harness.mjs` 规则 2）抓到 preset-transfer 插件 import
> 不进新包——此前预检只覆盖 `patches/`，不覆盖 `vendor/` 插件，这正是该门禁的存在理由；
> ② **L1 冒烟**抓到 next 线启动即 `SyntaxError`——我自己的迁移脚本 splice 把冲突块里 theirs
> 侧的类声明两行误删（`await import(loader entry)` 编译期炸）。事后用
> `node --check` 全量过了一遍组装树 982 个依赖 `.js` 文件（仅此一处），并重跑双线 L1 5/5。
> **教训**：regen 出的补丁必须做「应用后语法自检」，不能只看预检 clean——
> `check:patch-applicability` 明确不判语义，而这正是它注释里写的那类缺口。
>
> 另如实记录：本轮推进**早于**现役计划（`docs/dev-plan-0.8-convergence.md` §6）的四项放行
> 条件中的前两项（上游 0.2.0-rc.2 仅发布 1 天；六个相关讨论未关闭，其中 #8166 peer gate
> 静默禁用 storage 与 #8140 工作区被清属数据丢失类）。推进由用户明确指令驱动，例外放行的
> 理由记录在 ADR-057「已知代价」段；发布前已用干净 profile 验证工作区/会话列表非空
> （即 #8166 判据的组装期检查），冒烟覆盖启动/停止/会话可见性。

> ### ✅ alpha 通道推进：0.1.6-alpha.1 → alpha.2（2026-09-16；**补丁净减少 14 → 13**）
>
> 首次出现**补丁数下降**的一次推进，也是首次出现「上游追上我们」：
>
> - **`dsh-client-ui-layout` 整条退役**：上游把折叠侧栏宽度参数化（`computeColumns(…, collapsedWidth)`
>   并由 `data-platform` 推导），比我们的 UA 嗅探更完整（macOS 折叠收到 0、含 Windows 标题栏）。
>   这正是该补丁 `retireWhen`（「官方区分平台侧边栏宽度时」）写明的条件——**按判据退役，不是丢功能**。
> - **`dsh-client-ui-sidebar` 缩减为纯锚点注入**：上游已原生适配 macOS（`topStrip` + `-webkit-app-region`），
>   我们的自定义 padding 会叠加成双份留白；而锚点属性（`data-dsh-sidebar-*`）是注入脚本的挂载点，必须保留。
> - **键盘导航修复被上游反向采纳**（`model-selection` 的 `moveFocus`），取上游写法。
> - **vendored 覆盖包三个 tgz 全部退役**：逐个用 registry 内容做应用判定，13 个补丁全部干净可用
>   （vendoring 的前提「上游静默重发布过 tarball」不成立）。删除后真实组装仍 13/13。
>
> 其余冲突按「上游新结构 + 保留我们的增强」合并：`settings-models` 上游把模型行重构成 `ModelRow`、
> 以 `ModelInputTypes` 取代我们的图像输入控件（我们的**搜索**与**每模型推理等级**上游都没有，
> 分别经 `visibleModels` 遍历与新增的 `advancedExtra` 插槽接入）；`workspace` 上游把
> `useSessionPendingInteraction` 重命名为 `useSessionStatus` 并把内联会话树重构成 `renderGroup`，
> 未读标记按新结构重新接入。
>
> **两个可复用的流程经验**：
> 1. **先跑 `recount-patches.mjs` 处理纯行号漂移**——14 个「冲突」里 9 个其实只是漂移，
>    自动重算后只剩 5 个真冲突，人工量大幅下降。
> 2. **「退役 vs 保留」要看上游是否真的覆盖了同一行为**：`layout` 被完整覆盖 → 退役；
>    `sidebar` 的锚点是注入脚本的**契约**（`data-dsh-sidebar-*`），上游没有等价物 → 只缩减、不退役。
>
> **⚠️ 体积：安装包翻倍，原因是上游新增文档预览能力（本次流程漏记，事后补）**
>
> | 平台 | alpha.1 | alpha.2 | 变化 |
> |---|---|---|---|
> | Windows exe | 53.6 MB | 126.3 MB | ×2.36 |
> | macOS dmg | 81.3 MB | 170.1 MB | ×2.09 |
> | Linux deb | 90.6 MB | 143.8 MB | ×1.59 |
> | Linux AppImage | 161.7 MB | 208.5 MB | ×1.29 |
>
> 资源树 `harness/` 从 **153.4 MB → 478.2 MB（+324.8 MB）**，主项是上游 alpha.2 新增的
> `@deepseek-ai/libreoffice-kit-win32-x64`（**325.1 MB**，内含整套 LibreOffice；
> darwin-arm64 那份 255.1 MB）。依赖链：`dsh-office-to-pdf` →（普通 `dependencies`）
> `libreoffice-kit` →（`optionalDependencies`）`libreoffice-kit-<platform>`，
> **npm 按平台只装一个，是上游的有意设计**。
>
> **取舍已裁定：接受**。文档预览是上游新增的用户可见能力，剪掉它等于本仓单方面删功能，
> 与「不删上游能力」的一贯口径冲突；真要减重应推动上游把它改成真正可选的组件。
>
> **流程教训**：Step 6 早已要求「增量 > 30MB 时确认原因」，但这次升级**跳过了体积对比**，
> 体积翻倍直到用户发现才被注意到。已在 Step 6 补上具体的定位方法与「必须写明原因」的要求。

> ### ✅ 双通道首发：next → 0.1.5-rc.2、alpha → 0.1.6-alpha.1（2026-09-15 全流程闭环）
>
> 本次不再「推进唯一基线」，而是**新增一条并行的上游通道**（见 `AGENTS.md` §8.6）：
> `next` 由 rc.1 前进到 rc.2，`alpha` 为新建目标。两条线各有 14 个补丁，分别随
> **v0.5.0-next.1** 与 **v0.6.0-alpha.1** 发布（各 8/8 release job 绿、19 资产、
> `prerelease: true`；三平台 CI 与 Smoke `scope=full` 在 tag 的同一提交上全绿）。
>
> **两条线的移植成本差得很远，这个差值本身是经验**：
> - `0.1.5-rc.1 → rc.2`：预检 **14 个全 clean**，机械改名即可。
> - 新建 `alpha`（0.1.6-alpha.1）：预检 **10 clean / 4 conflict**，其中一条是 `functional` 层
>   （`@deepseek-ai/dsh` 本体的依赖声明）。alpha 把 workspace 的 `SessionTree` / `FlatList` 从
>   `useSessions` 改成了 `list` prop、订单模型换成 `saveSessionOrder`，**逐块解三路合并会把旧结构
>   带回来**——因此改成「在 alpha 纯净树上重建我们的改动」。两处有意差异（不再移植依赖未定义
>   `window.dshDesktop` 的「在 Finder 中打开」；deliverables 取上游实现只留本仓增强）记在
>   [`patches/LAYERS.md`](../patches/LAYERS.md)。
>
> **⚠️ 本次踩到一个只在真实组装时才炸的坑，已加守卫**：`patch-package` 按 hunk **行号**定位，
> 偏移超 **±20 行**即放弃；只改文件名的复制会让行号漂到 20 行以上（`trajectory` 漂 135 行、
> `llm-deepseek` 漂 369 行），此时按内容搜索的预检仍判 clean。修法是 Step 2.2 的
> `recount-patches.mjs`；预检也已补上 ±20 窗口判据（含可证伪自检）。
>
> **⚠️ 同批还修复了两个只在三平台真跑时暴露的缺陷**（详见 `AGENTS.md` §8 后续两节）：
> `run:` 字符串里插 `${{ … }}` 传目标名在 Windows runner（PowerShell）上丢值（只有 Windows 红）；
> `tauri.conf.json` 的 `beforeBuildCommand` 会重新组装、**覆盖另一条通道刚组好的资源树**
> （alpha 的包装的却是 next 运行时，而所有步骤都绿）。两者各带可证伪守卫。

重生成补丁的逐个处理流程：

对 `patches/<target>/` 下每个补丁，逐个处理：

- [ ] **2.1 重命名文件名**：把版本段改为该目标的新版本（`DSH_TARGETS[<target>].dshVersion`；仅 DSH 家族包跟随，`cordis-plugin-loader` 这类独立版本号的包不改）。
      > 漏改的后果是 `patch-package` 在全新 `npm install` 后找不到目标包，该补丁静默不生效——而它的 `status` 会显示什么取决于失败模式，恰好是最难发现的一类事故。`npm run gate -- patches` 会逐目标校验版本段是否与该目标的 `dshVersion` 一致。
- [ ] **2.2 重算行号**（移植补丁的必需步骤，从另一条上游线复制补丁时尤其关键）：
      ```bash
      node scripts/recount-patches.mjs --dsh-target=<target> --pristine=<未打补丁的包根>
      ```
      > **为什么必须做**：`patch-package` 定位 hunk 的方式**不是**按内容搜索，而是从补丁声明的 `@@ -N` 行号开始试探，偏移取 0、-1、+1 … **超过 ±20 行即放弃**（`dist/patch/apply.js` 的 `fuzzingOffset`）。「复制补丁、只改文件名」会让行号漂移：上下文仍能匹配（**预检按内容搜索，会报 clean**），但真实组装定位不到，**只在下载完 300MB 组装时**才报 `cannot apply the patch file`。2026-09-15 的 alpha 线移植就撞上了（`trajectory` 漂移 135 行）。
      >
      > `--pristine` 必须指向**未打补丁**的上游包（布局 `<root>/<包名>/…`；默认 `harness-deps/<target>-pristine`，不存在时脚本直接报错）。**不能**用组装后的 `harness-deps/<target>/node_modules`——它已经打过补丁，行号无从重算。重算完成后按脚本提示重跑真实组装复核（2.3）。
      >
      > ⚠️ **默认路径是目标键、不带版本，因此它证明不了里面是哪一版**。同一目录在通道内被复用（`next/` 从 rc.2 一路用到 rc.3）：2026-09-25 实测 `harness-deps/next-pristine/` 里装的是 `0.1.7-rc.1`，而当时目标是 `0.1.5-rc.3`。换锚点时**把版本写进目录名**（`harness-deps/next-pristine-0.1.7-rc.1`）并显式传 `--pristine=<dir>`；`recount-patches.mjs` **不校验**纯净树版本（`existsSync` 过了就用），只有 `relocate-patch-hunks.mjs` 有该判据——所以这条纪律靠人守。
      >
      > ⚠️ **目录位置：版本进名字，目录出仓库（2026-09-29 补）。** 上一条的版本化目录若放在 `harness-deps/` 内，专项取消后忘记清理的基线会被当**项目源码**扫：2026-09-29 实测 `next-pristine-0.1.7-rc.1/` 里的上游 npm 代码被安全门（Mimosa git gate）扫出 3 条高危，把之后所有 agent 的 `git commit/push` 一路拦到残渣清理为止——而该目录本就 gitignored，永远进不了任何提交。`--pristine=` 是**显式路径参数**，基线一律放仓库外（如 `%TEMP%\dsh-pristine-<版本>`）；专项结束或升级取消时，连同基线一起清理（纯 registry 产物，随时可按本节流程重建）。
      >
      > **替代路径**（当 `spawnSync` 外部进程不可用、或只处理纯行号漂移时）：
      > ```bash
      > node scripts/relocate-patch-hunks.mjs --dsh-target=<target> --pristine=<未打补丁的包根>          # 只报告
      > node scripts/relocate-patch-hunks.mjs --dsh-target=<target> --pristine=<未打补丁的包根> --write  # 写回
      > ```
      > 与 `recount-patches.mjs` **互补而非替代**：前者在纯净树上按内容应用后与纯净文件 `git diff --no-index` **重生成**补丁（依赖 `git`，产出规范化补丁）；`relocate-patch-hunks.mjs` **只改写 `@@` 行**、其余原文**逐字节保真**、**无任何外部进程**（本机 `spawnSync git` 报 EBUSY 时唯一的路径）。行号必然一致，但上下文与计数**不保证逐字相同** ⇒ **同一份补丁只用其中一条路径**，混用会让补丁在两次操作间来回变动。退出码 `1` = 存在定位不到的 hunk（原样保留并列出，需人工判定是「上游真的删掉了那几行」还是「纯净树取错」）。
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
      npm run gate -- patches        # 逐目标（next / alpha）检查：包名可推导、已登记、文件名版本段与目标版本一致
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
- [ ] **体积有显著变化时，把「为什么变大」写进本次升级记录**（本清单的完成记录段 +
      `AGENTS.md`）。⚠️ 2026-09-18 的 alpha.2 升级漏了这一步：上游新增文档预览能力、
      把一整套 LibreOffice 打进运行时，资源树 +324.8 MB、安装包翻倍，**直到用户发现才被注意到**。
      补丁验证与体积对比同等重要——前者让应用能起来，后者决定用户是否愿意下载。

**怎么快速定位体积主项**：

```bash
# 1. 全平台都涨 → 资源树内容变化；只有某平台涨 → 该平台的打包问题
# 2. 找出体积主项（新建的外部程序包会立刻显形）
du -sm src-tauri/resources/harness/node_modules/@deepseek-ai/* | sort -rn | head
# 3. 查它的依赖声明位置：dependencies = 必装；optionalDependencies = 按平台/可选装
grep -n '"dependencies"\|"optionalDependencies"' -A 10 <该包>/package.json
```

判据参考：`dependencies` 里的是**必装**（要减重只能剪枝并接受功能缺失，或推动上游改成可选）；
`optionalDependencies` 里的通常带 `os`/`cpu`/平台后缀，**npm 已按平台过滤**，不该手删。

### Step 7 — 文档与状态口径同步

- [ ] 更新 `docs/system_design.md` 中的版本引用
- [ ] 若升级导致能力状态变化（例如某个 `⚠️ 未接线` 项被接线、或某个补丁退役使某能力消失），**必须**同步 `AGENTS.md` §7 的对照表与 `README.md` / `README.zh-CN.md` 的功能列表
- [ ] 在 `docs/` 记录本次升级的冲突处理结论（哪个补丁退役、为什么）

### Step 8 — 换代桥接版（**仅版本号模型换代时**，[ADR-063](adr/063-bridge-release-for-version-model-cutover.md)）

> 只在「新版号模型的号**必然低于**线上已有号」时适用（本仓 2026-10-09 的首次适用：合成号
> `0.2.x` 低于旧模型 `0.7.x`）。**不适用就不要做这一步**——放宽比较器是有代价的（决策 7）。

按序执行，**顺序不可颠倒**（桥接版没送达 ⇒ 合成号零投递）：

- [ ] 1. 选定该通道的桥接版号：**高于该通道当时最高 tag**（rc 线 `v0.7.3-rc.1` > `v0.7.2-rc.1`；
      alpha 线 `v0.7.4-alpha.1` > `v0.7.3-alpha.1`）
- [ ] 2. 登记：`node scripts/release-ledger.mjs --add-bridge <版本>`（先只读核对，再加 `--apply`）；
      登记后 `node scripts/release-ledger.mjs --validate` 必须自洽
- [ ] 3. 发布桥接版（走 §2 的既有链路；`updater-manifest.mjs --write-config` 会自动把
      `plugins.updater.allowDowngrades: true` 写进覆盖配置，**日志里会打印该行警告**）
- [ ] 4. **核实桥接版 tag 真的发出去了**（本地 `git tag` + `gh api repos/.../tags` 双侧一致）——
      台账登记只是**意图**，豁免判据要求该 tag 已发布，此刻之前合成号会被正确拦住
- [ ] 5. 再发合成号；`version.mjs check` 应打印**豁免依据 note**（而不是报红），
      `updater-manifest.mjs --verify --tag <tag>` 亦同

⚠️ 常见失败形态（判据都会报红，不会静默）：**只登记未发布**（`reason=bridge-not-delivered`）；
**跨通道借用别线的桥接版**（各通道有自己的端点）；**桥接版号低于本通道最高 tag**（它当年没送达）。

---

## 3. 升级后：允许合并的判据

全部满足才合并：

- [ ] `MANIFEST.json` 的 `patches[]` 逐条 `applied`，或 `skipped` 项均为 `ui-behavior` / `brand` 层且有明确记录
- [ ] `npm run gate -- patches` 通过
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
| `patch-package` 行级 diff（2026-10-03 实测 next 10 个 / alpha 11 个；曾 18 → 14 → 13） | 上游未开放的能力扩展点（品牌、UI 行为、插件加载） | 分层降级（`ui-behavior` 失败不阻构建）+ `retireWhen` 记录退役判据 + **移植后重算行号**（Step 2.2，`recount-patches.mjs`——±20 行窗口外必失败）；长期方案见 [`harness-packaging-and-compatibility.md`](harness-packaging-and-compatibility.md) |
| 补丁文件名内嵌版本号 | `patch-package` 的命名约定 | 本文 Step 2.1 强制项；`npm run gate -- patches` **逐目标**校验包名可推导性与版本段一致 |
| 无头门禁覆盖不到 Harness 行为变更 | 壳把 Harness 当黑盒派生 | Step 5 的 L1/L2 烟雾是**唯一**能发现此类回归的门禁 |
| 体积随上游增长 | 内置完整依赖树以换取宿主机零依赖 | Step 6 的体积对比 + [`harness-packaging-and-compatibility.md`](harness-packaging-and-compatibility.md) 的瘦身方案 |

---

## 6. 等上游：条件化条目登记（**上游到位后才动手**）

> 本节条目**不是待办**，是**条件化等待项**：本仓做不了，必须等上游先交付某个东西。
> 每条写死四件事：**在等什么**、**触发条件**（可证伪）、**核验方式**（可复现命令）、
> **上游到位后做什么**（含谁来发布）。
>
> ⚠️ **纪律**（继承 [ADR-042](adr/042-recovery-non-destructive-actions.md) 后果段）：
> ① 核验日期到期要**重走**，条目不许永远挂着；② 触发条件必须是**能跑出结论的命令**，
> 不写「留意上游动态」这类没有执行者的句子；③ 每条的落点都包含**由维护者发布一版**——
> 上游到位只是解除阻塞，交付仍要走 §5 的九步流程。
>
> 🔗 与漂移哨兵的分工：`verify-upstream-drift.mjs` 负责**自动叫号**（上游前进了就红），
> 本节记「叫号之后做什么」。哨兵在检测到**非预发布 Release** 时会直接点名 §6 第 1 条。

| # | 在等什么 | 触发条件（可证伪） | 核验方式（可复现） | 上次核验 | 上游到位后做什么 |
|---|---|---|---|---|---|
| 1 | **上游发布非预发布版本**（`stable` 线的存在前提） | `@deepseek-ai/dsh` 的 dist-tag 指向一个**无预发布段**的版本；或上游出现无 `-` 段的 Release tag `dsh-v<x.y.z>` | `npm view @deepseek-ai/dsh dist-tags --json`<br>`node scripts/upstream-release.mjs`（列出全部 Release 及其 `prerelease` 标记） | **2026-10-09**：❌ 未到位——25 条 Release **全部** `prerelease: true`；`dist-tags` 三条（`latest`/`next`/`alpha`）全为预发布 | ①**先定 stable 线的序号载体**（ADR-061 决策 7 的开口：`0.2.1-<n>` 会让合成号首个预发布标识符变成纯数字）——注意 `release-ledger.mjs::composeDesktopVersion()` 对无预发布段的上游**当前直接抛错**，这是**硬阻塞**；②新增/修订 ADR（计划无权改 ADR，**先决策再写代码**）；③接线 `stable` 目标（`DSH_TARGETS` + 目录 + 补丁集）；④**由维护者发布一版**（该上游版本 `n=1`，`w` 标批次） |
| 2 | **上游提供「停用插件而不卸载」的可逆语义** | 上游 market / profile 加载体系出现 disable / quarantine 入口，且**不靠改名、不摘 `desired.json` 条目、不被 `sweepRegistry()` 真删** | 按 [`dev-plan-0.2-hardening.md`](dev-plan-0.2-hardening.md) **§B4** 的三步重走证据链（产物是**核验记录**，不是代码） | **2026-09-10** 结论「不可逆」（批次 C 裁决）；**2026-10-09 本轮未重走**（§B4 仍标 ❌ 未开工） | 立项 `recovery_action: "disable"` + 恢复页按钮（`dev-plan-0.2-hardening.md` 0.2-决策点 3）→ **由维护者发布一版**（`fix` / `feat`，`n+1`）。⚠️ 按钮必须**有可见反馈**：判据见 `npm run gate -- shell-pages`（恢复页曾因按钮无监听「点了没反应」） |
| 3 | **上游公开发布官方桌面版**（`apps/desktop` 目前 `private: true`） | `@deepseek-ai/dsh-desktop` 在 npm 上可取；或上游出现 desktop 命名的 Release | `npm view @deepseek-ai/dsh-desktop version`<br>`gh api repos/deepseek-ai/deepseek-harness/contents/apps/desktop/package.json`（看 `private`）<br>`gh api "repos/deepseek-ai/deepseek-harness/releases?per_page=100" --jq '[.[]\|select(.tag_name\|test("desktop"))]\|length'` | **2026-10-09**：❌ 未发布——`@deepseek-ai/dsh-desktop@0.2.1-alpha.1` 且 **`private: true`**；desktop 命名 Release 数 = **0**（`apps/` 下已有 `cli` / `desktop-host` / `desktop` / `web`） | 立刻复核 §0.1 的**约束一**（`desktop` 是保留 profile 名，含大小写变体）与**约束二**（官方桌面版采用更深的宿主协议，不要逼近它）是否被违反 → 违反则改本仓命名 / 协议姿态 → **由维护者发布一版**（`n+1`，`w` 标该批次） |
| 4 | **上游依赖树里的已知漏洞被上游修掉**（Dependabot：`@modelcontextprotocol/client` ×2 **high**、`http-cache-semantics` **high**——三条都在 `harness-locks/**` 里，由上游传递依赖引入）。**2026-10-09 维护者裁决：跟随上游，不自行 pin** | 这 3 条告警从 open 集合里消失（变 `fixed`），**或**上游锚点推进到含修复版的树上 | `gh api -H "Accept: application/vnd.github+json" "repos/wang-yi-bit64/dsh-desktop/dependabot/alerts?state=open&per_page=20" --jq '.[] \| "\(.number) \| \(.security_advisory.severity) \| \(.dependency.package.name) \| fixed=\(.security_vulnerability.first_patched_version.identifier // "none")"'` | **2026-10-09**：❌ 未到位——`#9`/`#8` `@modelcontextprotocol/client`（`harness-locks/{next,alpha}/package-lock.json`，**fixed=2.2.0**）、`#5` `http-cache-semantics`（`harness-locks/next/…`，**fixed=none** ⇒ 此刻上游也修不了） | 随**上游锚点推进**自然消失（`sync-upstream-release` 会重新生成 `harness-locks/**` 的 lockfile）→ 复跑 `npm run gate -- drift` + `harness-lockfile`（lockfile 与 `inputs.json` 必须成对提交）→ **由维护者发布一版** |

> ⚠️ **同批告警里有一条不属于本节（不在「等上游」范围）**：`rustls`（**medium**，
> 清单路径 `src-tauri/Cargo.lock`，**fixed=0.23.45**）。**2026-10-09 复核已订正本条此前的结论**——
> 原文写作「在**本仓自己的** Cargo 依赖链里（Tauri 侧）」，并给出修法
> `cargo update -p rustls --precise 0.23.45`。**两句都不成立，实测证据如下**：
>
> | 原结论 | 实测 | 命令 |
> |---|---|---|
> | rustls 在本仓 Cargo 依赖链里 | ❌ 根 `Cargo.lock` **不含 `rustls`**（只有 `rustls-pki-types`，那是纯类型 crate）。updater 显式 `default-features = false, features = ["native-tls", …]` ⇒ Windows 走 schannel；`cargo tree -i rustls` 在 **4 个目标平台全部** 报 `did not match any packages` | `cargo tree --manifest-path src-tauri/Cargo.toml -i rustls` |
> | 修法是 `cargo update -p rustls --precise 0.23.45` | ❌ 该命令直接报错 | `cargo update -p rustls --precise 0.23.45` → `package ID specification 'rustls' did not match any packages` |
>
> **根因**：这条告警落在**孤儿 lock** 上。`src-tauri` 是根 Cargo workspace 的成员
> （`cargo metadata` 的 `workspace_root` 即仓库根），**cargo 只用根 `Cargo.lock`**；
> `src-tauri/Cargo.lock` 提交于 2026-09-04 的初版单 crate 布局（`2d91067`），此后
> **一次未动**（根 lock 已有 29 次提交），cargo 既不读它、删掉后也不重建它。
> 而 GitHub 依赖图**两个 lock 都收**（SBOM 实测：孤儿特有的
> `hyper-rustls`/`tokio-rustls`/`rustls-platform-verifier` 与根 lock 特有的
> `hyper-tls`/`tokio-native-tls`/`schannel` 并存）⇒ 一条**构建产物里根本不存在的依赖**
> 拿到了告警，并把上面那次人工分析带偏。
>
> **处置（2026-10-09，已完成）**：`git rm src-tauri/Cargo.lock`。收益不止消掉这一条——
> 它同时消掉了那份 lock 里全部 538 个陈旧包的幽灵告警面。**影响范围：无**——
> 构建产物零 `rustls` 代码，`cargo tree` 解析结果与删除前逐字一致（根 lock 的
> sha256 未变）。防复发守卫：`npm run gate -- cargo-lock-scope`（fast/ci/release，
> 判据是「根 lock 必须在位 **且** 成员目录下不得有独立 lock」这一**成对**条件）。
> **这是独立的一次判断**，别混进第 4 条。
