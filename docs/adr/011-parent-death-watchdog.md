# ADR-011 — macOS 父死看门狗装在被替换后的入口上，定时器不许 unref

| | |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-09-12 |
| 唯一产地 | `build/parent-death-watchdog.mjs`、`build/harness-node-entry.mjs`、`scripts/mock-harness.mjs` |

## 背景

风险 R-7：macOS 没有 `PR_SET_PDEATHSIG` 等价物，宿主被杀后 Harness 成为孤儿。
补看门狗时撞上两个坑，各花掉一轮 CI，**都写进了该模块文件头**：

1. **定时器不能 `unref()`**。unref 的定时器在事件循环闲置时不触发，而 Harness
   大部分时间正是闲置的。第一版 unref 之后看门狗在 macOS 上**从未运行**——日志里
   连一行痕迹都没有，极易误判成「探测逻辑写错」。
2. **必须装在实际执行的那个进程上**。故障注入的 mock 模式会把 `node_entry` /
   `dsh_entry` **双双替换成 `mock-harness.mjs`**，`harness-node-entry.mjs` 根本不在
   该路径上；只装在入口上，对故障注入零作用。

## 决策

看门狗模块由**入口与 mock 共同引用**（`import` 后显式安装），且轮询定时器保持
ref。另给一个可本地实测的开关：`DSH_PARENT_DEATH_WATCHDOG=1` 在非 darwin 平台
强制启用——本机没有 macOS，这个开关让行为能被隔离验证（宿主被杀后 mock 进程数
2 → 0），而不是每轮靠三平台 CI 试错。

## 备选方案与取舍

- **只装在 `harness-node-entry.mjs`**：否决，见背景 2。真实运行形态（尤其 mock）
  不经过它。
- **定时器 `unref()` 以「不拖住事件循环退出」**：否决。看门狗的职责就是拖住退出；
  合理退出由宿主侧显式停机路径负责（ADR-014 的 `shutdown` 必经点）。

## 后果

- macOS 孤儿防护从「等下次冷启动清扫」变成「宿主死亡即回收」。
- 该模块的安装点从一处变两处（入口 + mock），修改其行为要同时想清楚两条路径。

## 守卫与证据

- `npm run verify:harness-entry` 的 **E4a/E4b/E4c**：入口装了看门狗 / 模块可用
  且未 unref / mock 也装了。三条各有可证伪夹具（含以修复前写法为夹具的回退检查）。
