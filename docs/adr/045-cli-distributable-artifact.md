# ADR-045 — CLI 可引用产物 Phase 1：归档 + sha256；产物不含 runtime

| | |
|---|---|
| 状态 | ⚠️ **部分取代（2026-09-24）**：发布通道已退役；归档 + 校验的**打包能力**保留。见文末「后续」 |
| 日期 | 2026-09-13（v0.4.0 首次验证）；2026-09-24（发布通道退役） |
| 唯一产地 | 现为 `scripts/package-cli.mjs`（打包）+ `release.yml` 的 `preflight`（`verify:cli-package`）。原 `cli` / `cli-publish` 两个 job 已删除 |

## 背景

`dsh-host-cli` 有真实价值（`start | status | stop | tail | probe | doctor`），
但没有可下载产物时，外部只能 clone 仓库自建。Phase 1 回答：**怎么让一个陌生人
拿到可验证的 CLI**。

## 决策

1. 三平台构建归档（+ `.sha256` 边车 + `manifest.json`），产物名由
   `package.json` 版本 + 目标三元组推导；`package-cli.mjs` 做**回读校验**
   （归档解包回读）与**产物执行自检**（真跑一次 `--help` 之类）。
2. `cli-publish` job 从公开 URL **下载回**刚上传的副本、核验与 manifest
   逐字节一致后再上传到同一 Release，并把产物表写进正文（`--clobber`，
   因为 `workflow_dispatch` 重跑会命中同名资产）。
3. **硬边界：产物不含 runtime。** 表述禁「下载即用」；用户需用 `--resource`
   指向已组装的 runtime（安装目录的 resources 或源码 checkout 的
   `src-tauri/resources/`）；归档自带 `README.txt` 与 Release 正文都写明这一点。
4. **Phase 2（runtime bundle 独立发布）🕓 计划中**，触发条件（写在
   `dev-plan-cli-distribution.md` §4）：出现第一个非本仓消费者，或开工
   H3-a 运行时更新事务 / H2-a 兼容矩阵时才做。**提前单独做就是为
   「可能有用的未来」建基础设施**——与批次 F 归档两个 crate 同一判据。
   ⚠️ H3 已被 ADR-047 删除，触发条件本身保留（第一个真实消费者出现时仍然成立）。

## 备选方案与取舍

- **发一个含 runtime 的完整 CLI 包**：否决。300MB+ 且与桌面安装包重复分发，
  更新节奏还不同（CLI 修 bug 不该逼用户重下 runtime）。
- **只挂 GitHub Actions artifact**：否决。artifact 会过期、不可公开引用，
  「可引用产物」名不副实。

## 后果

- v0.4.0 已验证全链路：8 个 job 全绿、9 个 CLI 资产上传完整、公开 URL 下载核验
  与 manifest 一致。
- CLI 与桌面安装包**互不牵连**：`cli` job 不依赖 300MB 资源树，与 `build` 并行，
  能在 build 失败时照常产出。

## 守卫与证据

- `npm run verify:cli-package`（含 self-test；CI 与 release preflight）。
- ~~`npm run verify:cli-publish`~~ —— 随发布通道退役一并归档到
  `docs/archive/dry-run-cli-publish.mjs`。
- `docs/dev-plan-cli-distribution.md` §3.5.1（核对记录）、§5（退役评估）。

## 后续 — 发布通道退役（2026-09-24）

**决定**：删除 `release.yml` 的 `cli` 与 `cli-publish` 两个 job（含 `gh release upload`
与 Release 正文渲染），停止把 CLI 二进制作为 Release 资产发布。
**保留**：`crates/dsh-host-cli` crate、`scripts/package-cli.mjs` 及其全部判据、
`preflight` 里的 `verify:cli-package`。

### 依据（逐条实测，不是印象）

| 判据 | 实测值 | 指向 |
|---|---|---|
| 本仓之外的外部消费者 | **0** | 取消 |
| 仓库内消费者用的哪一份 | 全部 `target/debug/`（`smoke-launch.mjs` / `fault-inject.mjs` / `cli_blackbox.rs`），与上传产物**零交集** | 取消 |
| 产物自足性 | **不自足**——不含 runtime，`start` 必然退出码 3（ADR-045 自己的硬边界） | 取消 |
| 定位对产物的依赖 | **不依赖**——INV-6 靠「存在一个能跑二进制的入口」，不靠「挂在 Release 上」 | 取消 |

**为什么不自足是核心论据**：本 ADR 的备选方案段已否决「含 runtime 的完整包」（重复
分发 300MB），因此产物的**唯一可能用户**是已装桌面的用户——而他们的 `resources/`
就在安装目录里，根本不需要从 GitHub 下这个 CLI。定位与产物形状错位，正是
「对外可引用性名不副实」的根源。

### 为什么保留打包能力（而非一并删除）

`package-cli.mjs` 的约 40 项判据（归档丢可执行位、边车必须是 `sha256sum -c` 读得动的
形状、篡改与截断能否判红）**与「要不要上传」无关**，属于 ADR-031 的可证伪守卫资产。
删掉它们等于削掉一批已经写好、本机跑得动的能力证据，与 ADR-047「保留全部本地验证
门禁」相抵触。取消的是**上传**这一动作，不是**打包与核验**这套能力。

### 与 ADR-047 的关系

ADR-047 把项目定位从「发布产品」改为「能力证明资产」，并删除了烧钱或纯运维的项。
本次退役是同一判据的延伸：**一个无人下载的产物 = 纯运维成本**。但两者不完全等同——
ADR-047 删除的是「发布工程」，本次删除的是「发布动作」，两者都不触碰能力证据本身。

### 成本与可逆性

- 维护面净减：`release.yml` 减 183 行（`cli` 三平台 job + `cli-publish`）、
  归档 813 行演练脚本、CI 减一个需 release 二进制的步骤。
- 可逆性高：恢复需四处一起做（归档脚本移回、`package.json` 恢复 `verify:cli-publish`、
  `ci.yml` 恢复演练步骤、`verify-release-workflow.mjs` 改回正向断言），清单写在
  `docs/archive/dry-run-cli-publish.mjs` 的文件头。
- **历史资产未删**：已发布 Release 上的 9 个 CLI 资产保留（可下载、链接有效）；
  GitHub 上删资产**不可逆**，删除反而破坏历史可追溯性。
  后续发布的期望资产数由 22 改为 **13**。
- **恢复触发条件不变**（本节第 4 条原文仍有效）：出现第一个非本仓消费者。

### 一处真实踩到的守卫缺陷（已修）

退役说明在 `release.yml` 里**逐字引用**了 `gh release upload` 来交代删掉了什么，
而「不得有上传动作」的判据扫全文 → **守卫被自己的文档命中，恒红**。
修法是新增 `stripYamlComments()`：所有「不得出现」类判据先剥掉整行注释再判，
并配两条互补夹具（注释里的引用必须放行、可执行位置的同一串必须判红）。
这已是本仓第二次踩「注释命中判据」的坑（前一次见 ADR-031 的相关记录）。
