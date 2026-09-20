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

- `verify:claims`（README 不得宣称「已签名 / 已公证」）。
- `tauri.conf.json` 的 `bundle.createUpdaterArtifacts` 与 updater 端点保持现状
  （minisign 侧不受影响）。
