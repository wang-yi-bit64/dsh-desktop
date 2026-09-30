# 补丁与上游事故档案

> 从 `AGENTS.md` §4 迁入，原样保留。含上游 CLI 自执行方式变更、patch-package 应用模式、依赖树瘦身判据与依赖解析堆爆炸的根治方案。

### 上游改 CLI 自执行方式：壳入口静默退出（2026-09-12 升级实测，已修复勿回归）

`build/harness-node-entry.mjs` 是**包装器**：它必须先 import 上游 `@deepseek-ai/dsh/lib/bin.js`
之前装好 windowsHide 补丁、plugin safety guard 与 cold-start 投影，所以走 **`import`** 而非
派生 `node bin.js`。

alpha.4 的 `bin.js` 是**顶层自执行**，import 即运行。**0.1.5-rc.1 把它重构成**：

```js
async function runCli() { … }
if (import.meta.main) await runCli();   // ← 只有「作为直接入口」才执行
export { runCli };
```

import 该模块时 `import.meta.main` 恒为 **false**，于是 **CLI 从不运行**，进程随即以
退出码 **0** 静默结束。表现极具误导性——资源组装报 `14/14 applied`、入口 import 无任何异常、
harness.log 只到 `[harness-node] DSH entry loaded` 就断，而 `smoke-launch` 报的是
「Harness 就绪超时（退出码 8）」。**所有静态检查全绿**，因为它们看不见「进程起来了但 CLI 没跑」。

**修法（勿改回）**：入口接住 import 的返回值，并在导出了 `runCli` 时显式调用——

```js
const entry = await import(pathToFileURL(dshEntryPath).href)
if (typeof entry?.runCli === 'function') await entry.runCli()   // 新版显式调用
// 旧版（≤0.1.2-alpha.4）没有该导出，顶层自执行，不重复调用
```

**守卫**：`npm run verify:harness-entry`（E1~E4，含以修复前写法为夹具的可证伪性检查），
已进 CI 与 release preflight。**这类「上游改了自执行方式」属于升级时的隐形炸弹**：
升级 DSH 版本后若 L1 报「就绪超时但日志无报错」，先查这里。

### 补丁应用：`patch-package` 必须用「应用模式 + 相对 `--patch-dir`」（已修复，勿回归）

`scripts/prepare-harness.mjs` 的 `applySinglePatch()` 逐个应用 `patches/` 下的补丁。两条约束都是硬性的，各自都能**静默**做错事：

1. **不得用 `patch-package <包名>` 形式。** 带包名会把 CLI 切到**生成**模式：它安装一份干净的包并与 `node_modules` 做 diff，以便*写出*补丁文件。刚装好的 staging 树什么都没打过，于是它报 `There don't appear to be any changes` 并退出非零 → 18 个补丁全被判失败 → `functional` 层抛错 → 三平台 `bundle` 作业一起挂。报错信息指向「某个包没有改动」，与真实原因（调用形式用错）毫无关系。`cea57b3` 就是这样把原来正确的 `npx patch-package`（应用全部）换掉的；由于当时 `test` 作业本身是红的，`bundle` 从未执行，这个缺陷被掩盖了两天。
2. **`--patch-dir` 必须传相对路径，且目录要位于 `staging/` 之内。** patch-package 只拒绝以 `/` 开头的值（`--patch-dir must be a relative path`），**Windows 绝对路径（`C:\…`）能绕过这个守卫**：它被当成相对路径拼到 cwd 之下，变成 `harness-deps/C:/…` 这样不存在的目录，patch-package 打印 `No patch files found` 却**以 0 退出**。也就是说绝对路径不会失败，它只是什么都不做，而调用方会把补丁记成 `applied`。`applySinglePatch()` 因此在 staging 内建 scratch 目录、命令行传目录名，并额外拦截 `No patch files found` 这一种已知静默形态。

配套：**`--error-on-fail` 必须显式传**。patch-package 在非 CI 环境失败也返回 0（它有意如此，以防 `package.json` 与 `node_modules` 失步），不传的话本机跑出来的「已应用」是假绿，而这份报告正是「哪些补丁真的打上了」的证据。

判定这类改动是否成功，看的是**补丁是否真的落到盘上**（文件字节数 / 内容形态变化），不是退出码。

### 依赖树瘦身：删目录的判据是「内容」不是「名字」（已修复，勿回归）

`prepare:harness` 会把组装好的 `node_modules` 里「名字像开发产物」的目录（`test` / `docs` / `doc` / `example` …）**整目录删除**，用来缩小安装包。这条规则按名字判定是错的：`doc` 在某些包里恰好是**运行时路径**。

2026-09-11 定位的真实事故：`yaml/dist/doc/` 被整个删掉，而那里装的是 `directives.js` / `Document.js` 等运行时模块，于是 Harness 一启动就崩：

```
Harness 出现未处理的 Promise 拒绝：Error: Cannot find module '../doc/directives.js'
```

这个缺陷**没有任何静态检查能发现**——打包、签名、安装、`tauri build` 全部成功，只有真正启动才报错，也就是「装得上、起不来」。它能存活这么久，是因为 CI 直到 2026-09-10 才加「真实资源树 L1 烟雾」，而那条烟雾当时又被更早的红灯连续挡住。

规则已抽到 [`scripts/prune-harness-deps.mjs`](scripts/prune-harness-deps.mjs)，判据改为**目录内是否含运行时模块**（`.js`/`.cjs`/`.mjs`/`.node`/`.wasm`/`.json`）：命中名字只是必要条件，含运行时模块时**只递归进去删文件，绝不整目录删除**。`npm run verify:prune` 的自测带**可伪证性检查**——把旧判据作用于同一棵树必须复现出「`dist/doc` 被删」，否则自测本身失效。

实测（真实 `yaml` 包，203 → 153 个文件）：`dist/doc/directives.js`、`Document.js` 存活，同目录 5 个 `.d.ts` 仍被删除；整个 staging 内有 **42 个**这类「名字像开发产物但含运行时模块」的目录，旧判据会全部误删。取舍明确：**误删只会得到一个起不来的包，少删只是少省一点体积**，所以判据一律偏向「宁可不删」。

### 依赖解析的堆爆炸：浮动范围 + 上游发新版 = CI 三平台全灭（2026-09-23 实测，已根治勿回归）

`prepare:harness` 的 `npm install` 靠 arborist **在线解析** 600+ 包的依赖树。上游子包用
`^0.1.5-rc.2` 这类**浮动范围**互相引用——上游 2026-09-22 发布 `0.1.5-rc.3` 后，62 个未钉的
子包漂到 rc.3 而 14 个补丁包留在 rc.2，混血树让解析堆占用涨到 **>4GB 且 30 分钟不收敛**。
Node 默认老生代上限随宿主内存缩放（7GB runner ≈ 2GB），于是 smoke `35814756095` /
`35824813835` **三平台全灭**于 `Ineffective mark-compacts near heap limit`（SIGABRT 134），
且都在 `Prepare harness resources` 步骤跑 16 分钟才死。给子进程抬堆（`ecde5e0`，4096MB）
只是续命——实测堆爬到 4089MB 依旧死。**probe 实验还证伪了「把家族钉死搬进组装」的方案**：
钉死 dependencies 家族后解析仍要 41 分钟，且 peer/传递通道照样渗入 rc.3（189 个）。

**根治（已落地）**：提交式 lockfile + `npm ci`，跳过解析：

- `harness-locks/<target>/` 下成对提交 `package-lock.json` + `inputs.json`（输入快照；
  lockfile **不记录** overrides，没有快照就无法判断「这份 lockfile 是不是当前输入生成的」）。
- 组装时 `lockInputsMatch` 校验（dependencies 逐键一致 / 当前 overrides 逐条在快照中 /
  快照多余条目不得撞当前补丁名 / **快照自证的 `target` + `dshVersion` 与本次组装一致**），
  命中则复制 lockfile 进 staging 后 `npm ci`——**零解析、零漂移、可复现**。
- **CI 上 lockfile 是硬要求**：`CI`/`GITHUB_ACTIONS` 环境下缺失或失配直接 `process.exit(1)`，
  绝不静默回退在线解析；本地回退时打 ⚠️ 并提示再生成命令。
- 生成走 `npm run harness:lockfile -- --dsh-target=<t>`：先算出**家族传递闭包**（从
  `@deepseek-ai/dsh` 出发，沿 `dependencies` + `optionalDependencies` + `peerDependencies`
  三字段 BFS，只收集 `@deepseek-ai/dsh-*` 前缀），把闭包内每个在**该版本上已发布**的包
  钉死到主包版本（**不钉解析不收敛**），再 `npm install --package-lock-only`（8GB 堆、
  不跑 postinstall）只解析不安装。查 registry 用**直连 + 并发 8**（`npm view` 每个都要起
  一个进程，230 个名字要 ~12 分钟；直连只要几十秒），直连不可用时逐个回退 `npm view`。
- **版本锚点 / 补丁集 / vendored 包任何一项变更后必须重新生成**（升级清单 Step 1）；
  纯逻辑判据在 `scripts/harness-lockfile.mjs`（`verify:harness-lockfile` 自测 34 项）。

**lockfile 语义的注意事项**：提交式 lockfile 冻结的是「生成那一刻的完整解析结果」，
包括上游浮动范围当时解析到的版本（如 rc.3 混血）——这与任何用户当天 fresh install 得到的
树**一致**，只是从此**可复现**。上游升级（换 `dshVersion`）必须重生成，否则 inputs 失配
门禁会拦下。

**修好安装后暴露的下一处潜伏缺陷（同一轮，2026-09-23）**：`npm ci` 一通过，
`assertPickerSurfaceIsHostBacked()` 立刻红了——它写死 `node_modules/<pkg>`，而冻结树把
`@deepseek-ai/dsh-client-ui-directory-picker-native` **嵌在消费方之下**
（`node_modules/@deepseek-ai/dsh-web-app/node_modules/…`，且版本是 rc.3：它不在主包
dependencies 名单里，故未进家族钉死）。判据本身没错（该副本同样满足「无 `window.dshDesktop*`
全局桥 + 走 `ctx.uiWorkspace.pickDirectory()`」），错的是**位置假设**。修法是
`packageInstallDirs()`（从 lockfile 键取全部安装位置，顶层与嵌套一视同仁），并对**每一份
拷贝**做检查。**教训**：hoisting 是解析结果的一部分，会随依赖图变化——凡断言「某个包里的
某个文件」时，位置必须从 lockfile 推导，不能写死。

**再下一处：家族钉死漏了 peer 边 → FFI 单例出现两份拷贝 → 启动即崩（同一轮，2026-09-23）**。
位置断言修好、tree-precheck 全绿、`npm ci` 14/14 补丁全绿之后，smoke `35850241442` 三平台倒在
`Smoke L1 (assembled resource tree)`：

```
Error: Duplicate type name 'DSH_STARTUPINFOW'
    at …/dsh-sandbox-local/node_modules/@deepseek-ai/dsh-win32-process/lib/index.js
```

`@deepseek-ai/dsh-win32-process` 用 koffi 注册**进程级全局** FFI 类型名，树里出现两份拷贝就会
把 `DSH_STARTUPINFOW` 注册两次 → Harness 一启动就抛错。根因是第一版闭包**只沿
`dependencies` 走**：上游若干 rc.2 包以 `peer … ^0.1.5-rc.2` 引用 `dsh-settings` / `dsh-fs` /
`dsh-session-*` 等 23 个包，这些名字**不在任何包的 `dependencies` 里**，于是没被钉死，解析时
漂到 rc.3 → 与 rc.2 冲突 → npm 无法共享同一份拷贝，把包**嵌套**进消费方之下（lockfile 里
`嵌套条目 33 条`）。这正是「钉死 dependencies 家族后 peer/传递通道照样渗入」那句话的落地形态。

修法：闭包改为沿**三字段** BFS（`referencedPackageNames`，npm 7+ 会实际安装 peer），
实测遍历 250 个名字 → 钉死 238 个（dependencies-only 版是 208 / 195）。**教训**：
「传递闭包」不能只取 runtime 依赖边；**peer 也是会被物化的边**，漏掉它不会报错，
只会在运行期以「单例包出现两份」的形式爆出来——**解析期的绿色不代表树是自洽的**。
自测把这条判据钉住：`referencedPackageNames({ peerDependencies: {…} })` 必须抽出该名字
（只读 `dependencies` 的实现返回 `[]`，即第二处事故的形态）。

