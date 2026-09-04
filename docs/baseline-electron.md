# Electron 基线采集（阶段 0 任务 0.5，§2.3）

> **状态：待执行**（模板已就位）。在一台干净 Windows 机器安装 Electron 版
> 0.1.1 后按本表记录；Tauri 侧目标值在采集后填入。

| 指标 | 采集方法 | Electron 基线 | Tauri 目标 |
|---|---|---|---|
| 安装包体积（字节数） | 三平台安装器 | _待填_ | ≤ 基线 − 80MB |
| 冷启动（双击 → splash 可交互） | 录屏逐帧 + 日志时间戳 | _待填_ | ≤ 基线 × 0.7 |
| 就绪总时长（双击 → harness UI 首屏） | 日志时间戳差 | _待填_ | ≤ 基线 × 0.9 |
| 稳态内存（就绪 5 分钟后工作集） | 任务管理器 | _待填_ | ≤ 基线 × 0.6 |
| 卸载重装后用户数据存活 | 手动验证 | 通过 | 通过 |

> 注：包体收益会被捆绑的 node + DSH 依赖树（约 300MB 展开后）吃掉大半，
> 这是「捆绑运行时」架构的固有成本（R-9）；卖点改为内存 / 启动 / 工程简洁性。

## 更新前置条件立项（关键路径，立即发起）

- [ ] `tauri signer generate -w ~/.tauri/dsh.key` 生成 minisign 密钥对；
      公钥入库、私钥入 CI secret
- [ ] Windows 代码签名证书（OV/EV）采购申请（SmartScreen 信誉需要）
- [ ] Apple Developer ID + 公证凭证
- [ ] 更新端点决策（ADR-6）：自建静态 `latest.json`（优先）/ GitHub Releases /
      协商复用 dshdesktop.com（需 DataElement 授权，**不可默认**）
