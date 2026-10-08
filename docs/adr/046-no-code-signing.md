# ADR-046 — 不买 OS 层代码签名证书；保留免费的 minisign 更新链校验

| | |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-09-20（零预算重裁的一部分） |
| 唯一产地 | `src-tauri/tauri.conf.json`（`plugins.updater` 保持开启）、`roadmap.md` 决策点 6 |

## 背景

自动更新链路的签名机制是 minisign：`tauri signer generate` 自己生成密钥对、
私钥放 CI Secret——**这部分零现金成本**，且已经跑通（v0.4.0 验证）。贵的是
**OS 信任层**：Apple Developer Program $99/年是 macOS 公证的硬前置；Windows 的
OV 证书 / Azure Trusted Signing 同样按年付费。原计划批次 0.2-A（A1 公证 /
A2 Windows 签名）因此长期挂在「0.2-决策点 1 — 签名证书预算」上未裁决。

## 决策

**不买 OS 层代码签名证书。** 保留 minisign 更新链校验（防篡改：updater 端点与
`latest.json` 的公钥验证不变），接受无 OS 签名的已知代价：macOS Gatekeeper
劝退级体验、Windows SmartScreen 首次运行拦截，README / Release 说明写明
对应的用户侧解法（macOS 右键打开 / 系统设置里允许；Windows「更多信息 → 仍要运行」）。

理由：证书解决的是「陌生用户敢不敢装」，而本项目没有获客预算——
**为一个不存在的安装基盘付年费，是用确定性支出买不确定收益**。
（roadmap 决策点 6 的双公钥过渡策略随之失去对象：单密钥 + 备份即可。）

## 备选方案与取舍

- **买 Apple Developer Program + Windows OV**：否决（本决定）。
  零预算约束下，年费是持续失血；且项目现在的目标读者是「看得懂 README 的人」
  （ADR-047），本来就会右键打开。
- **只改 endpoint 不开 `createUpdaterArtifacts`（决策点 1 的 B/C）**：否决。
  minisign 签名免费，没有理由放弃免费的那一层完整性保障；B 留下永远不工作的
  链路，C 把功能归零。
- **等第一个真实用户再买**：记录为可重开条件——若项目转向真实分发且出现
  稳定安装基盘，重新裁 A1/A2。

## 后果

- 安装体验有确定性的首次运行摩擦，需要在 README 正面处理而不是藏起来。
- 发布链路不依赖证书申请周期，随时可发（与 ADR-047 的单平台低成本发布呼应）。

## 守卫与证据

- `npm run verify:claims` 的规则 **`os-signing-claim`**（`scripts/verify-claims.mjs`）：两份 README
  **不得**出现「代码签名 / 公证 / Authenticode / notarize / code-sign / Developer ID / certificateThumbprint /
  signingIdentity」类**正面宣称**；如实声明（同一行写 `不做` / `not code-signed` 并引用 `ADR-046`）
  放行。自检含正反夹具 + 「否定只豁免同一行」的逐行夹具。
- `tauri.conf.json` 的 `bundle.createUpdaterArtifacts` 与 updater 端点保持现状
  （minisign 侧不受影响）。
- **不在任何地方接线**是判定的一部分，不是疏忽：`.github/workflows/`、`tauri.conf.json`、
  `scripts/` 内对 `APPLE_*` / `WINDOWS_CERTIFICATE*` / `certificateThumbprint` / `signingIdentity` /
  `codesign` **零命中即正确**。

## 记账（2026-10-08 补齐）

本 ADR 的结论此前只落在本文件与 `SECURITY.md` / `dev-plan-defect-remediation.md`，而
`dev-plan-0.2-hardening.md`（A1/A2）、`roadmap.md`（H3-b、决策点 6）仍把它写成
**待采购/待排期**的施工项。2026-10-08 已按本 ADR 全部改为「**已关闭——不实现、不接线**」，
并在 `AGENTS.md` §7.2 补一行 `🗄️ 刻意不做（能力边界）`。同期也把「一份输入提案里的
P2 OS code signing / notarization」**剔除**（不是降级到 P2）；该输入提案及其处置记录
已于 2026-10-08 从库中移除（备查 `.workbuddy/backup/2026-10-08-v3-docs-before-delete/`）。
「需要外部采购（Windows 证书 / Apple 会员）」这一门禁表述**已从仓库中清除**。
