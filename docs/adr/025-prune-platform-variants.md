# ADR-025 — 剪枝外来平台原生变体（linuxdeploy 杀手）

| | |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-09-12（含 rc.1 引入新布局后的复发修订） |
| 修订 | 2026-09-23（sharp 的「包名即 libc 选择器」）、2026-10-07（napi-rs 的「后缀 token `-musl`」） |
| 唯一产地 | `scripts/prune-platform-variants.mjs` |

## 背景

Linux 的 `build` job 曾**连续多轮**以 `failed to run linuxdeploy` 收场，而
tauri-bundler 在默认日志级别下**吞掉 linuxdeploy 的 stderr**，CI 上只留下一句
无信息量的错误（deb 正常，Windows/macOS 不经 linuxdeploy——红灯只出现在一个平台）。
用 `-v` 拿到真实报错才定位：

```
ERROR: Could not find dependency: libc.musl-x86_64.so.1
```

根因：linuxdeploy 会遍历 AppDir 内**每一个** ELF 并解析其动态依赖。
`@koromix/koffi-linux-x64` 在同一包里并列 glibc 与 musl 两份构建，`node-pty` 的
`prebuilds/` 也带齐所有平台架构；其中 musl 变体在 glibc 的 ubuntu runner 上
**必然**解析失败，于是整个 AppImage 打包被拖垮。

## 决策

在瘦身之后、打包之前调用 `prune-platform-variants.mjs` 剪掉外来变体。判据**有界**，
只对「目录名本身充当平台选择器」的两种布局动手：`prebuilds/`（prebuildify 约定）
与 libc 前缀目录（`musl_*` / 裸 `glibc`/`musl`）。包**名**里带平台后缀的
（`@img/sharp-linux-x64`）不碰——npm 已按 `os`/`cpu` 过滤。另有一道保险：
`prebuilds/` 目录之外只对**有同平台邻居**的目录按名删，永远不会删掉
「最后一个能用的」。剪掉它们不影响运行时：发布的 node 是 glibc 链接的，
koffi 按运行时 libc 选构建。

**复发（2026-09-12，rc.1 升级）**：新依赖
`@deepseek-ai/node-addon-system-linux-x64` 的布局是**裸 libc 名**
（`bin/glibc/system.node` 与 `bin/musl/system.node` 并列），而安全丝只认
`linux-x64` / `linux_x64`，不认裸名 `glibc` → `bin/musl` 逃过剪枝，linuxdeploy 又在
它上面 `Failed to run ldd`。修法：Linux 目标的保留名补上 `glibc`。

**复发（2026-09-23，next 线）——上面决策段里「包名带平台后缀的不碰」就此作废**：
`@img/sharp-linuxmusl-x64@0.35.4` 用**包名**区分 libc，而它在 lockfile 里只声明
`os`/`cpu`、**没有 `libc` 字段**，npm 遂把 glibc 与 musl 两份都装进树。修法：新增
**第 4 类判据**「包名里的 libc 选择器」，只在 `platform === 'linux'` 时生效，
安全丝是「同层必须存在 glibc 对应物才删」。判据因此从「两种布局」扩为**四类**。

**复发（2026-10-07，alpha `0.2.1-alpha.1`）——第 4 类判据换了一种书写方式**：
`node-addon-require-builtin@0.1.7` 用**后缀 token** 区分 libc
（`…-linux-x64-gnu` 与 `…-linux-x64-musl`），且该版本在 lockfile 里**连 `libc` 字段都不再声明**
（对照 next 线：`…-linux-x64-gnu` 曾声明 `libc:["glibc"]`，且当时没有 musl 变体）。
旧判据只认**连写**的 `linuxmusl`，故完全没命中。修法：把第 4 类由「一个映射」放宽为
**「一组候选」**（`glibcSiblingCandidates()`），同时给出连写与后缀 token 两种映射，
命中任一候选且该名确实存在于同层才删——安全丝语义不变，但上游再换命名约定时多半无需再改。
详见 `docs/incidents/packaging-size-and-platforms.md` 的对应小节。

## 备选方案与取舍

- **遇到再删（不建通用判据）**：否决。每轮升级都可能引入新布局（已经复发一次），
  逐个案处理等于把打包可靠性挂在运气上。
- **扩大判据到所有含平台后缀的目录名**：否决。npm 已按 `os`/`cpu` 过滤的场景
  多此一举，且误删风险随判据半径上升。有界是刻意的。

## 后果

- AppImage 打包从「连续多轮红」变为可预期。
- 升级 DSH 时请复核：新版可能再带来新的「平台选择器目录名」写法；若再报
  `failed to run linuxdeploy`，先 `-v` 看是哪个 ELF，再核对这里的判据。

## 守卫与证据

- `npm run verify:variants`（**38 项**断言；2026-09-12 时为 19 项，经 09-23 与 10-07 两次
  复发各追加一组。含反向断言：**没有 glibc 邻居的孤独 `bin/musl` 必须保留**——证明删除是
  「有邻居」驱动的，不是见到 musl 就删；同构的安全丝还有「没有 glibc 对应物的孤独 musl 包
  必须保留」，对连写与后缀 token 两种形态各有一条）。
- 可伪证性：把**现有**瘦身门禁 `pruneNodeModules()` 作用于同一棵树，必须复现出
  「`musl_x64/koffi.node` 原样幸存」——证明该缺陷逃得过当时全部门禁。2026-10-07 追加同构断言
  （现有 prune 对该后缀式布局同样完全无感）。
