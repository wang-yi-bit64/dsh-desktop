# ADR-045 — CLI 可引用产物 Phase 1：归档 + sha256；产物不含 runtime

| | |
|---|---|
| 状态 | 已接受（Phase 1 已上线；Phase 2 计划中） |
| 日期 | 2026-09-13（v0.4.0 首次验证） |
| 唯一产地 | `scripts/package-cli.mjs`、`release.yml` 的 `cli` / `cli-publish` job |

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
- `npm run verify:cli-publish`（发布步骤**原文**演练：从 release.yml 抽出 run 块
  逐字执行，假 gh 截网）。
- `docs/dev-plan-cli-distribution.md` §3.5.1（核对记录）。
