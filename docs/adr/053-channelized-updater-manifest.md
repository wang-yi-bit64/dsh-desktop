# ADR-053 — 更新链通道化：每通道一个滚动 Release manifest + 构建期注入端点

| | |
|---|---|
| 状态 | 已接受，执行中 |
| 日期 | 2026-09-30 |
| 唯一产地 | scripts/updater-manifest.mjs（端点的唯一产地）；src-tauri/tauri.conf.json 只保留默认值 |
| 关联 | ADR-052（双通道在役，本 ADR 是它的更新链配套）；docs/dev-plan-defect-remediation.md S1 |

## 背景

更新端点原为 releases/latest/download/latest.json。2026-09-30 实测：该 URL 返回的 version 是 0.5.0-next.1，而仓库已发布到 0.7.x。原因是 GitHub 的 releases/latest **排除预发布**，而自 v0.6.0-alpha.1 起每一次发布都是 prerelease（release.yml 按 semver 含连字符后缀自动判定，判定逻辑本身没错）。

后果：**自动更新自 2026-09-15 起零投递**——任何 0.6/0.7 用户检查更新，拿到的版本号低于已安装版本，于是永远不提示更新。README 已如实写明「预发布不进稳定更新路径」，但结论与它自己「Automatic Updates 已接线」的对外呈现冲突：链路确实接线了，却一次更新都没送出去。

双通道在役（ADR-052）之后问题更硬：一个 latest.json 无法表达两条线各自的更新来源。

## 决策

1. **每个 publishChannel 一个滚动 Release**：tag 形如 updater-rc / updater-alpha，标记为 prerelease（且 --latest=false，避免劫持仓库的 Latest 徽标），只承载一个资产 latest.json，每次发布以 --clobber 覆盖。
2. **端点 URL** = releases/download/updater-通道名/latest.json。
3. **端点由构建期注入**，不靠手改配置：release.yml 调 scripts/updater-manifest.mjs 生成一份覆盖 plugins.updater.endpoints 的配置，经 tauri build --config 生效。通道由 tag 推导（与运行时通道同源），因此「二进制里的更新源」与「它内置的运行时线」不能再各说各话。
4. **tauri.conf.json 的默认端点指向 rc**（默认目标 next 的 publishChannel），保证本地 npm run build 也产出合理默认；它不再是被依赖的运行时事实来源。
5. 发布后由 npm run verify:update-channel 断言「端点 version ≥ 该通道最新已发布 tag 的版本」。

## 备选方案与取舍

- **诚实降级为手动安装**：否决。自动更新是已对外宣称的能力，且本方案的改动量小于一次上游升级。
- **把两条通道都写进 endpoints 数组**：否决。tauri updater 取**首个能响应的**端点，不做跨端点版本比较——alpha 用户会被判给 rc 的包，等于顺带换掉运行时线。
- **把 manifest 放在固定分支上（raw.githubusercontent）**：否决。CDN 缓存会让发布后立刻做的自检读到旧 manifest，守卫的判据随之失真（而「发布后自检」正是本方案的可证伪手段）。
- **继续用 releases/latest 但把预发布改成非预发布**：否决。那会让仓库的 Latest 徽标与「哪些是预发布」的语义一起失真，且两条线仍然只能有一个来源。

## 后果

- **引入非 v 前缀的滚动 tag，这是本决定的真实风险**：任何用 git describe --tags 找「上一个发布 tag」的路径都会在下个发布周期起把 updater-rc 当成上一个发布，从而算出错误区间。缓解：所有 tag 发现路径必须限定 --match v*（release.yml 的 PREV 取值此前缺这一限定，本 ADR 落地时已修；conventional-commits.mjs 的 latestTag 本就有）。
- **已安装的 0.6/0.7 二进制无法被本改动救回**：更新端点固化在二进制里，旧版本仍指向 releases/latest。因此「能自动更新」从本改动之后的第一个版本开始生效，之前的用户需要手动装一次。这条必须如实写进 README，不得含糊。
- 仓库会多出两个长期存在的 prerelease 对象（updater-rc / updater-alpha），它们不是产品版本，首次看到的人容易误解——在 README 与 ADR 里点名它们是「更新通道载体，不是可安装版本」。

## 守卫与证据

- npm run verify:update-channel —— ① 端点可解析；② 端点 version ≥ 该通道最新 v* tag 的版本；③ 该 Release 含签名产物。**可证伪夹具**：以 2026-09-30 的真实状态（端点 0.5.0-next.1、最新 tag 0.7.0-rc.1）喂进判定必须报红，否则守卫是装饰。
- src-tauri/tauri.conf.json 的 endpoints 与 scripts/updater-manifest.mjs 的 URL 构造必须同源；断言由 verify:update-channel 的 --self-test 覆盖（URL 由通道推导，不允许手抄第二份）。
- tag 发现路径的 --match v* 断言并入 verify:release-workflow。
