# ADR-023 — tauri 的 beforeBuild/Dev 钩子只校验（--check），不组装

| | |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-09-15（alpha 线 Smoke 实测） |
| 唯一产地 | `src-tauri/tauri.conf.json` 两个钩子、`prepare-harness.mjs --check` |

## 背景

alpha 线的 Smoke 日志里，**同一个 job 出现了第二次组装**——tauri build 跑到一半，
`beforeBuildCommand`（当时是 `npm run prepare:harness`）又执行了一次组装。那一步在
tauri 内部触发，**拿不到 workflow 里显式选的目标**，于是按默认目标（next）重新
组装 `resources/`，把上一步刚组好的 alpha 树覆盖掉。

后果是「**版本号说 alpha、运行时是 next**」：安装包与 L2 GUI 冒烟实际测的是 next 线
的运行时，而**所有步骤都是绿的**——每一步单独看都没问题。这是跨层契约问题的
第三种形态：同一个位置被写了两遍，后写的赢了，且没人知道。

## 决策

组装与打包是两个动作：**组装**由人在 workflow 里显式选目标（`env: DSH_TARGET` +
`npm run prepare:harness`）；**打包**只该**校验**「树还是那棵树」。两个钩子都改成：

```jsonc
"beforeDevCommand": "npm run prepare:harness -- --check",
"beforeBuildCommand": "npm run prepare:harness -- --check"
```

`--check` **绝不组装**：断言 `resources/` 的指纹与 `MANIFEST.target` 都等于本次
目标；不一致时打印「实际装载 vs 本次目标」并给出正确的组装命令，退出码 1。

## 备选方案与取舍

- **在钩子里也支持 env 传目标**：否决。钩子跑在 tauri 内部，看不见 workflow 的 env，
  传不进去；能传进去也只是多一条路径，仍然可能静默回退默认目标。
- **删掉钩子，靠人自觉先组装**：否决。`cargo build` 的 glob 校验需要资源树在位，
  删钩子会把「忘组装」变成编译期谜语。

## 后果

- 通道错配从「静默全绿」变成「打包前退出码 1」。
- ⚠️ 改动这两个钩子前先想清楚：它们跑在 tauri 内部，任何在那里「重新组装」的写法
  都必然按默认目标覆盖当前树。

## 守卫与证据

- `verify:release-workflow` 的 `checkTauriHooksAreCheckOnly`：读 `tauri.conf.json`，
  断言凡调用 `prepare:harness` 的钩子必须带 `--check`；可伪证夹具就是被打回
  旧写法的同一份配置。
