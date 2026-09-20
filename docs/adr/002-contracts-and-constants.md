# ADR-002 — 契约与常量集中于 dsh-contracts

| | |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-09-10（随 crate 分离定型） |
| 唯一产地 | `crates/dsh-contracts/src/constants.rs`、`errors.rs`、`rpc.rs` |

## 背景

早期各 crate 自持常量与协议类型，出过两类事故：同名异型的 JSON-RPC 消息模型在多个
crate 各定义一份（2026-09 修复）；超时、路径、URL 硬编码散落在业务逻辑里，改一处
契约要全文搜索。同时错误码只有自然语言描述，前端无法按类别分派。

## 决策

1. 所有硬编码字符串、超时、退避间隔、缓冲区大小、正则与探测常量统一定义在
   `dsh-contracts`，每条带 `CX-` 契约编号注释。
2. 标准错误码总表 `E1xxx`~`E7xxx` 落 `errors.rs` 的 `codes` 模块，**族号 ↔ 类别
   （环境/网络/进程/鉴权/插件/模型网关/内部）的对应关系有测试守着**。
3. JSON-RPC 2.0 消息模型的唯一定义点是 `rpc.rs`；`dsh-host` 仅 re-export，
   ️ 严禁任何 crate 重复定义协议类型。

## 备选方案与取舍

- **各 crate 自持常量 + 文档约定**：否决，已实测导致同名异型冲突，且没有编译错误
  （`Serialize` 照常成功，只有消费方读不到字段时才暴露）。
- **错误码用纯数字无族号语义**：否决。前端要按类别分派（重试/引导用户/上报），
  无结构编号等于每条都要 if 字符串。

## 后果

- 改契约有单一编辑点；族号与类别漂移会被 `every_code_family_maps_to_its_category`
  测试当场拦下。
- ⚠️ RPC 类型当前**没有运行时消费者**（批次 F 删除了唯一的 Node 侧实现）。
  契约在、基础设施不在——不得把它当作「本仓有可用 RPC 基础设施」的证据，
  这与 ADR-007 宣称纪律联动。

## 守卫与证据

- `crates/dsh-contracts/src/errors.rs::every_code_family_maps_to_its_category`（CI）。
- `crates/dsh-contracts/src/ipc.rs` 的跨语言字段形状测试。
