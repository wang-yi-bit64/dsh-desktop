# ADR-020 — patch-package 必须「应用模式 + 相对 --patch-dir」+ 显式 --error-on-fail

| | |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-09（prepare-harness 定型；真实事故见 AGENTS.md §4） |
| 唯一产地 | `scripts/prepare-harness.mjs::applySinglePatch()` |

## 背景

两条约束各自都能**静默**做错事，本仓都实际踩过：

1. **不得用 `patch-package <包名>` 形式**。带包名会把 CLI 切到**生成**模式
   （安装一份干净的包并与 `node_modules` 做 diff 以便*写出*补丁文件）。刚装好的
   staging 树什么都没打过，于是它报 `There don't appear to be any changes` 并退出
   非零 → 18 个补丁全被判失败 → `functional` 层抛错 → 三平台 bundle 一起挂。
   报错信息指向「某个包没有改动」，与真实原因（调用形式用错）毫无关系。
2. **`--patch-dir` 必须传相对路径且位于 `staging/` 之内**。patch-package 只拒绝
   以 `/` 开头的值，**Windows 绝对路径（`C:\…`）能绕过这个守卫**：它被当成相对路径
   拼到 cwd 之下，变成 `harness-deps/C:/…` 这样不存在的目录，patch-package 打印
   `No patch files found` 却**以 0 退出**——绝对路径不会失败，它只是什么都不做，
   而调用方会把补丁记成 `applied`。

## 决策

1. `applySinglePatch()` **逐个应用**补丁（应用模式），命令行传 staging 内 scratch
   目录的**目录名**，并额外拦截 `No patch files found` 这一种已知静默形态。
2. **`--error-on-fail` 必须显式传**：patch-package 在非 CI 环境失败也返回 0
   （有意如此，以防 `package.json` 与 `node_modules` 失步），不传则本机跑出来的
   「已应用」是假绿。
3. 判定成功的依据是**补丁是否真的落到盘上**（文件字节数 / 内容形态变化），
   不是退出码。

## 备选方案与取舍

- **一次性 `npx patch-package`（应用全部）**：曾是正确的写法，被 `cea57b3` 换掉。
  「应用全部」粒度下无法逐条记录 applied/skipped/failed，与 ADR-007 的
  「禁止无声降级」冲突（MANIFEST 要逐条记录）。
- **把 `--patch-dir` 做成绝对路径并在调用前自校验存在性**：也能防静默，
  但依赖调用方自觉；在 staging 内建 scratch + 传目录名是结构上不可能传错。

## 后果

- 补丁状态逐条落 `MANIFEST.json`，构建失败时能直接指出是哪一条、哪一层。
- 新补丁必须同时登记进 `patches/LAYERS.md` 与 `scripts/patch-layers.mjs`，
  否则 `prepare-harness.mjs` 以「未登记」告警并回退默认层。

## 守卫与证据

- `npm run verify:patches`（逐目标检查登记表一致性）。
- `MANIFEST.json` 的 `patches[]` 逐条 applied/skipped/failed（ADR-007 规则 3）。
