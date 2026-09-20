# ADR-012 — 壳入口接住 import 返回值，显式调用 runCli

| | |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-09-12（0.1.5-rc.1 升级实测） |
| 唯一产地 | `build/harness-node-entry.mjs` |

## 背景

`harness-node-entry.mjs` 是**包装器**：必须先 import 上游 `@deepseek-ai/dsh/lib/bin.js`
之前装好 windowsHide 补丁、plugin safety guard 与 cold-start 投影，所以走 `import`
而非派生 `node bin.js`。alpha.4 的 `bin.js` 是顶层自执行，import 即运行。
**0.1.5-rc.1 把它重构成**：

```js
if (import.meta.main) await runCli();   // 只有「作为直接入口」才执行
export { runCli };
```

import 该模块时 `import.meta.main` 恒为 false，于是 CLI 从不运行，进程随即以退出码
**0 静默结束**。表现极具误导性：资源组装报 `14/14 applied`、入口 import 无异常、
harness.log 只到 `[harness-node] DSH entry loaded` 就断，而 smoke 报的是
「Harness 就绪超时（退出码 8）」。**所有静态检查全绿**——它们看不见
「进程起来了但 CLI 没跑」。

## 决策

入口接住 import 的返回值，并在导出了 `runCli` 时显式调用：

```js
const entry = await import(pathToFileURL(dshEntryPath).href)
if (typeof entry?.runCli === 'function') await entry.runCli()   // 新版显式调用
// 旧版（≤0.1.2-alpha.4）没有该导出，顶层自执行，不重复调用
```

即**同时兼容新旧两种自执行方式**，升级时不需要改壳。

## 备选方案与取舍

- **固定为派生 `node bin.js`**：否决。派生就失去了「import 前打补丁」的时机，
  windowsHide / safety guard / cold-start 投影全部要另找落点。
- **只按新版写（无条件调 `runCli`）**：否决。旧版没有该导出会 TypeError，
  而两条上游通道当时版本不同（见 ADR-022）。

## 后果

- 这类「上游改了自执行方式」是升级时的**隐形炸弹**：现象是就绪超时但日志无报错。
- 该守卫的四个断言同时覆盖 E1~E4（含可证伪夹具），是 DSH 升级清单的必跑项。

## 守卫与证据

- `npm run verify:harness-entry`（E1~E4 + `--self-test`；CI 与 release preflight）。
- 判据口诀：升级 DSH 后若 L1 报「就绪超时但日志无报错」，先查这里。
