# ADR-049 — 打包资源清单必须由推导校验，不能靠四处手抄保持一致

| | | |
|---|---|---|
| 状态 | 已接受 |
| 日期 | 2026-09-21 |
| 唯一产地 | `scripts/verify-harness-entry.mjs`（E5 / E5d）、`src-tauri/tauri.conf.json` → `bundle.resources` |

## 背景

「哪些文件要进安装包」这件事在本仓由**四份各自独立、手写的清单**共同描述：

| 位置 | 作用 | 漏写的后果 |
|------|------|-----------|
| `src-tauri/tauri.conf.json` → `bundle.resources` | tauri-build 真正打进安装包的 glob | 文件**不进安装包**（本 ADR 的事故） |
| `scripts/prepare-harness.mjs` → `copyBuildFiles()` | 把 `build/` 的产物拷进 `src-tauri/resources/` | 文件不在 `resources/`，后续打包拿不到 |
| `scripts/prepare-harness.mjs` → `REQUIRED_FILES` | 幂等快速路径的完整性判据 | 残缺的 `resources/` 被当成完整而复用 |
| `scripts/stub-tauri-resources.mjs` → `assets` | CI 编译桩（不组装 300MB 时用） | 编译期 glob 失配，CI 红 |

2026-09-21，v0.7.0-alpha.1 的 Windows 安装包实测暴露出这份「四处手抄」的真实代价：
入口（`build/harness-node-entry.mjs`）新增了对 `./parent-death-watchdog.mjs` 的**静态
import**（ADR-011 的 macOS 父死看门狗）之后，该文件**进了三份、漏了第四份**——
`copyBuildFiles()`、`REQUIRED_FILES`、`stub-tauri-resources.mjs` 都有，
`tauri.conf.json` 的 `bundle.resources` **没有**。安装后的应用一启动即：

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  'D:\Program Files\DSH Desktop\resources\parent-death-watchdog.mjs'
  imported from D:\Program Files\DSH Desktop\resources\harness-node-entry.mjs
```

这不是一次粗心，而是**这套结构的必然结果**，有三点值得写下来：

1. **`tauri-build` 不会因缺条目而失败。** 它的 build.rs 只校验「每个 glob 至少
   匹配一个文件」——**多一个文件没人要、少一个文件不是错误**。glob 清单对它的
   语义是「取什么」，不是「必须有什么」。
2. **唯一能早期发现它的路径恰好被绕过了。** 本地 `npm run dev` / L1 / L2 读的是
   `src-tauri/resources/` 目录本身（`copyBuildFiles()` 拷好、齐全），**不经过
   `bundle.resources` 这份清单**；`git status` 也看不见（`resources/` 是
   gitignore 的）。于是所有门禁、三平台 CI、`cargo test`、真实资源树 L1 全绿，
   而**只有装出来的那个包坏了**——与 ADR-024（`yaml/dist/doc` 被误删）同一个形态：
   「装得上、起不来」。
3. **它不是「忘了同步」而是「本来就没有单一产地」。** 同一个事实（入口依赖哪些
   兄弟模块）被抄了四遍，任一处漏抄都不会红——这类结构不能靠纪律维持。

## 决策

**把「入口依赖的文件必须入包」和「Rust 从资源目录读的文件必须入包」变成推导出来的
检查，而不是第五份手写清单。** 两条判据都读各自领域的唯一产地，不维护文件名单：

1. **E5 — 从入口源码推。** 递归收集 `build/harness-node-entry.mjs` 里所有相对
   import（静态 `from './x.mjs'` 与动态 `import('./x.mjs')` 同等对待），逐个要求
   在四份清单里出现。**新增一个兄弟模块而漏登记任何一处，这里就红。** 判定不绑定
   各清单的具体写法（`copyBuildFiles` 的数组 / `REQUIRED_FILES` / `assets` 都只按
   「文件名作为带引号字符串出现」认），也不绑定 `bundle.resources` 的形式
   （精确条目与 `resources/*.mjs` 这类 glob 都算覆盖）。
2. **E5d — 从 Rust 源码推。** 取 `crates/dsh-host/src/paths.rs` 的 `Layout::resolve`
   里所有 `resource_dir.join(常量)`，到 `crates/dsh-contracts/src/constants.rs` 查这些
   常量的字面值，逐个要求在 `bundle.resources` 里有覆盖。硬编码那五六个文件名只能
   守住**今天**这几个；这条判据守的是「将来有人加了一次 `resource_dir.join(NEW_FILE)`
   却没加进打包清单」——那种改动同样没有编译错误。

**判据自身失效必须自曝。** 两条检查都在解析不到任何东西时（paths.rs 改了写法、
入口改成别的加载方式）**报错而不是通过**：一个静默放行的守卫比没有守卫更糟，
它会让下一次漏包看起来「验过了」。

## 备选方案与取舍

- **改成 `resources/**/*` 一把梭，不再逐条列举**：否决。那会把 `resources/` 下的
  中间产物、临时文件、将来任何误放的东西一并打进安装包，而安装包体积已经是用户
  明确关心的指标（ADR-026）。逐条列举 + 推导校验，比放宽 glob 再加体积问题更可控。
- **加一个「打包后校验安装包内容」的测试**：方向对但代价高——要真跑
  `tauri build`（下载 300MB 资源、分钟级）才能测，进不了秒级静态门禁，等于把发现
  缺陷的时间从「提交时」推到「发布后」。E5/E5d 全部是纯静态、毫秒级。
- **把四份清单合成一份（生成自同一处）**：是更彻底的解法，但 `bundle.resources`
  必须是 `tauri.conf.json` 里的字面量（Tauri 配置不支持从外部文件 import），
  要做只能靠构建期生成配置——那会引入「配置是被生成的」这一层理解成本，
  且 `tauri.conf.json` 改坏时更难排查。当前体量下，推导校验已经覆盖了它的收益。
- **在 `prepare-harness.mjs` 里按 `bundle.resources` 反查并自动补拷**：否决。
  「自动补上」会把「有人忘了登记」这个事实藏起来，而资源清单的每一条都应该是
  有意加的——这与本仓「禁止无声降级」（§7.1 规则 3）一脉相承。

## 后果

- 新增/改名一个入口的兄弟模块，或新增一次 `resource_dir.join(...)`，漏登记任何
  一处都会在 `npm run verify:harness-entry` 处红，**不再依赖真装一次才暴露**。
- `verify:harness-entry` 从「入口与上游 CLI 的调用约定」扩展到同时覆盖「入口依赖
  的模块与 Rust 资源常量是否入包」——两者都属「入口这一层的契约」，放同一处。
- 代价：该守卫现在读 5 个文件（入口、四份清单 + paths.rs/constants.rs）。都是
  小文件，毫秒级；且它只在静态门禁里跑。
- 遗留（本次未处理，也**不该**顺手处理）：`resources/logo-light.png` 与
  `logo-dark.png` 被 `copyBuildFiles()` 拷进资源目录，但不在 `bundle.resources`
  里，也不被任何运行时读取（品牌 logo 走 `install-brand-assets.mjs` 进的是
  harness 前端树）。它们进不了安装包**不是缺陷**，只是 `resources/` 里一份无害的
  中间产物；不要为了「让清单和目录一致」而把它们加进包（那会白白增大体积）。

## 守卫与证据

- `npm run verify:harness-entry` 的 **E5a/E5b/E5c**（入口兄弟模块 ↔ 四份清单）与
  **E5d**（Rust 资源常量 ↔ `bundle.resources`），均已进 `ci.yml` 与 release preflight。
- **可证伪性**（`--self-test`，20 项断言）。E5 组里最关键的一条夹具是
  **v0.7.0-alpha.1 真实发出的那份 `bundle.resources`**——把清单原样喂进去必须报
  E5a；补上条目必须通过。少了这条，E5a 就只是一段恒真的装饰。E5d 组同理用
  **真实的 `paths.rs` / `constants.rs`** 当输入，并另配三条变体：常量值改成一个
  清单外的新文件名 → 报缺失；`paths.rs` 新增一次 `resource_dir.join(新常量)` →
  报缺失；清单补上该条目 → 通过（证明判定是「没覆盖才报」，不是「见到新常量就报」）。
- 端到端复现（2026-09-21 实测）：把修复后的 `tauri.conf.json` 改回发出时的清单，
  `node scripts/verify-harness-entry.mjs` 退出码 1 并指名
  `resources/parent-death-watchdog.mjs`；恢复后退出码 0。
