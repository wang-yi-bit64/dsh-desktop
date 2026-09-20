# ADR-021 — 补丁移植后必须重算行号（±20 窗口判据）

| | |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-09-15（alpha 线移植实测） |
| 唯一产地 | `scripts/recount-patches.mjs`、`check-patch-applicability` 的断言 |

## 背景

`patch-package` 按补丁里的 `@@ -N` 行号定位，偏移取 0、-1、+1…**超过 ±20 行即放弃**。
把补丁从一条上游线复制到另一条、只改文件名，会让行号漂到 20 行以上——此时
**只按内容搜索的预检报 clean，真实组装报 failed**，缺陷只在下载 300MB 之后才暴露。
2026-09-15 alpha 线移植实测：`trajectory` 漂 135 行、`llm-deepseek` 漂 369 行。

## 决策

移植补丁必须重算行号：

```bash
node scripts/recount-patches.mjs --dsh-target=<next|alpha> --pristine=<未打补丁的包根>
```

并配套两条纪律：

- 预检（`check:patch-applicability`）除内容搜索外，加一条按 ±20 窗口判定的断言
  （含可证伪自检）。
- `recount-patches.mjs` **拒绝任何未知参数**——位置参数曾被静默忽略，
  会让「重算 alpha」实际跑在默认目标上。

## 备选方案与取舍

- **只靠内容搜索预检**：否决，正是它漏报了 135 行的漂移。
- **移植时人工数行号**：否决。两条线版本不同、文件频繁变化，人肉不可维护。

## 后果

- 「补丁能否应用」在下载资源树之前就有确定答案。
- 代价：每次上游推进/移植多一步工序（已写进 `docs/dsh-upgrade-checklist.md`）。

## 守卫与证据

- `npm run check:patch-applicability`（±20 窗口断言 + 自检）。
- `npm run verify:targets`（目标表自检：未知通道必须失败不得回退）。
