# ADR-004 — HarnessSnapshot.phase 必须 #[serde(flatten)] 平铺

| | |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-09-10 |
| 唯一产地 | `src-tauri/src/state.rs`（`HarnessSnapshot` 定义） |

## 背景

`harness_status` 命令与 `harness://status` 事件共用载荷 `HarnessSnapshot`。契约要求
`phase` 的 tag 与 `message` / `logs` **平铺**（与上游 `RuntimeStatus` 一致）：

```json
{ "phase": "failed", "cause_kind": "plugin_fault", "message": "…", "logs": ["…"] }
```

`state.rs` 的文档**写了这句话、漏了属性**，实际序列化出
`{"phase":{"phase":"failed",…}}`。编译器不报错——`Serialize` 照常成功，只是形状变了。
唯一消费方 `frontend/error.html` 判 `snapshot.phase === 'failed'`，于是**恒为 false**：
「疑似插件故障 → 建议进入安全模式」分支与安全模式按钮**从未生效过**。2026-09-10 用
serde 探针打印真实 JSON 才定位到。

## 决策

`HarnessSnapshot` 的 `phase` 必须带 `#[serde(flatten)]`，tag 与其余字段平铺；
这是**跨语言契约**，两侧各自都没错、错在中间形状，因此用测试把形状钉死，
而不是靠注释或文档约束后人。

## 备选方案与取舍

- **在消费方做兼容（两种形状都判）**：否决。等于把契约缺陷固化下来，下一个消费方
  还要再兼容一遍；且「静默不工作」的形态会被保留。
- **只补文档**：否决。这个问题正是「文档写了、代码没做」本身。

## 后果

- 契约由探针测试执行，改字段形状必须同步改测试。
- 建立了本仓对跨层形状问题的一般处置：**打印真实序列化结果**，不要读代码猜形状。

## 守卫与证据

- `state.rs::snapshot_json_keeps_the_phase_tag_flat`（CI 运行；本机 GNU 工具链
  跑不了 `src-tauri` 单测，原因见 ADR-001 的后果段）。
