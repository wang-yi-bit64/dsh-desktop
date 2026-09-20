# ADR-028 — 版本号唯一真源 package.json；CHANGELOG 与 Release 正文同源

| | |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-09-11（首发链路修复后定型） |
| 唯一产地 | `scripts/version.mjs`、`scripts/changelog.mjs`、`scripts/conventional-commits.mjs` |

## 背景

版本号曾有三处重复（`package.json` / `tauri.conf.json` / `Cargo.toml`），
变更日志与 Release 正文各写各的。首发布时还暴露了一条静默缺陷：`release.yml` 用
`changelog.mjs --notes --to "$TAG"` 生成正文，`--from` 省略时的默认基线写成
「全仓库最近的 tag」——发布时 `$TAG` 必然已存在，从 `HEAD` 去找会把它自己找回来，
区间退化为 `v0.1.0..v0.1.0`，**首个版本的 Release 说明整篇空白，且不报错**。

## 决策

1. **`package.json` 是版本号唯一真源**；`tauri.conf.json` 写 `"../package.json"`
   （Tauri 官方 schema 允许 version 写成 package.json 路径）——**原生继承，
   不要改回硬编码字面量**；`Cargo.toml` 由 `version.mjs` 同步；`CHANGELOG.md` 是
   生成物，勿手工编辑。
2. **CHANGELOG 与 Release 正文同源同渲染**（同一份提交历史 + 同一渲染器），
   因此不会互相矛盾。两条硬规则：不静默丢弃任何提交（认不出的 type 归「其他」
   并保留原文）；破坏性变更同时出现在置顶章节与它的类型章节。
3. 变更说明的默认基线**相对 `--to` 求**：`latestTag({ rev: \`${to}^\` })`；
   `--notes` 遇到**空区间直接失败**——空白正文会被 GitHub Release 原样展示，
   没人会注意到「这个版本没什么可说的」其实是一次自动化故障。
4. 推进规则：`0.y.z` 阶段破坏性变更升 `minor`（API 本就未稳定）；任一 `feat` 升
   minor，`fix`/`perf` 升 patch，纯 docs/chore 不发版；预发布用 `-` 后缀；
   无历史 tag 时 `auto` **报错并要求显式指定**；先 `--dry-run` 再真改。
5. `--commit` 会一并重新生成 CHANGELOG 段落并纳入**同一个提交**——分成两个提交
   就会出现「tag 指向有版本号、没变更日志的那个提交」，CHANGELOG 从此永久滞后一版。
6. 不用 GitHub 内置 `--generate-notes`：它按已合并 PR 归纳，而本仓全程直推 main
   （2026-09-11 实测其产出一行 Full Changelog、零条目）。

## 备选方案与取舍

- **Release 正文手写**：否决。手写与 CHANGELOG 必然漂移，且发布是低频率动作，
  手写质量不可依赖。
- **三处各存版本号 + verify:version 校验**：否决（现状的来路）。校验是事后比对，
  原生继承让漂移不可能发生；保留 verify 是防 tag 与版本不匹配这一类问题。

## 后果

- 版本推进、变更日志、Release 正文、updater 的 `latest.json` 全部由同一版本号派生。
- `--to` 基线的推导藏在 git 交互里，渲染层纯逻辑断言抓不到——所以自测里有一条
  **建临时 git 仓库实跑区间解析**的断言。

## 守卫与证据

- `npm run verify:version`（package.json ↔ tauri.conf.json ↔ Cargo.toml；
  tag 构建时额外校验 tag 与版本号匹配）。
- `npm run verify:commits` / `verify:changelog`（含上述临时 git 仓断言）。
