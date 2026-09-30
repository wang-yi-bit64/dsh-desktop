# 命令速查

> 从 `AGENTS.md` 原 §2「常用命令速查」原样迁入（含 `### 开发与构建`、`### 快速测试与校验门禁` 与全部 npm script 名）。

## 2. 常用命令速查

### 开发与构建
```bash
# 组装资源并启动 Tauri 开发调试环境
npm run dev

# 构建安装包 / 二进制产物
npm run build
# 或直接调用
npm run tauri build
```

### 快速测试与校验门禁
```bash
# 1. 快速无头测试门禁（无需 GUI，无需组装资源包 - INV-6）
cargo test -p dsh-contracts -p dsh-host -p dsh-host-cli

# 2. 编译 src-tauri 前生成桩资源（全新 checkout 缺少 resources/ 时必跑）
node scripts/stub-tauri-resources.mjs

# 3. 格式化与 Clippy 静态检查
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings

# 4. 全 Workspace 编译检查
cargo check --workspace

# 5. 补丁分级自检（patches/ 与 patch-layers.mjs 登记表一致性）
npm run verify:patches

# 6. 壳接口面一致性（命令定义 ↔ 注册 ↔ 前端 invoke/listen ↔ 页面可达性）
#    这是唯一能捕获「写了但没人调用」类断线的门禁——见 §7.3
npm run verify:ipc-surface

# 7. 壳内页面运行时冒烟（DOM 桩执行内联脚本 + 点一遍所有按钮）
npm run verify:shell-pages

# 8. Harness 页注入脚本行为自测（19 项断言 + 可证伪性检查）
npm run verify:harness-inject

# 9. 打包目标守卫（构建主机 vs 目标平台；自动推断，亦可 `-- self-test` 自检）
npm run verify:target
npm run verify:target -- --self-test

# 10. 故障注入（孤儿进程清理 + 退出码归因，10 项断言）
#    前置：cargo build -p dsh-host-cli
npm run fault-inject

# 11. 分层烟雾（L1 无头硬门禁；L2 需已构建产物，缺失则 SKIP）
npm run smoke:headless
npm run smoke

# 12. 产物体积三口径（壳二进制 / 安装包 / 资源树）
npm run size:report

# 13. 版本号一致性（package.json 唯一真源 ↔ tauri.conf.json ↔ Cargo.toml；
#     tag 构建时额外校验 tag 与版本号匹配）——发布前的关键防线
npm run verify:version
# 本地查看各处版本、最近 tag、以及「上个 tag 以来的提交建议升哪一位」
npm run version:show

# 14. 变更日志/版本推进生成器自测（纯逻辑，无 git 依赖）
npm run verify:commits
npm run verify:changelog

# 15. 依赖树瘦身自测（删目录判据是「内容」不是「名字」，含可证伪性检查）
npm run verify:prune

# 16. 原生平台变体剪枝自测（删 musl / 非目标架构 prebuilds；
#     Linux AppImage 打包的必要前置——见「linuxdeploy 撞上外来变体」一节）
npm run verify:variants

# 17. 发布工作流守卫（tauri-action 参数拼装 + shell 变量终止；含自测）
#     守两类「只有真跑 release 才炸」的缺陷——见「发布工作流的两个静默缺陷」一节
npm run verify:release-workflow
npm run verify:release-workflow:self-test

# 17b. 发布资产清单守卫（期望 13 项，按名字逐一枚举；含自测）
#      F13 的真守卫：此前「13」只活在文档里，全仓零判据 ⇒ 实际产出 10 而门禁全绿。
#      另可核对真实 Release：npm run verify:release-assets -- --check-release <tag>
npm run verify:release-assets
npm run verify:release-assets:self-test

# 18. 官方 profile 保留名守卫（`desktop` 大小写变体）+ 契约锚点；含自测
npm run verify:profile-names
npm run verify:profile-names:self-test

# 19. 宣称纪律守卫（README ↔ AGENTS：禁止表述 / 状态词表 / §7.2 欠债登记）；含自测
npm run verify:claims
npm run verify:claims:self-test

# 19b. 计划事实守卫（文档里的「钉住的 DSH 版本」必须等于锚点；
#      计划文档的批次状态词在「头部摘要 / §5 标题 / §10.1 表行」三处必须自洽）；含自测
npm run verify:plan-facts
npm run verify:plan-facts:self-test

# 19c. 文档↔常量派生事实对账（S2-3）：rust-version / .nvmrc / license 三处 /
#      ADR 计数——文档是被测方，常量是产地；含真实漂移夹具的自测
npm run verify:doc-facts
npm run verify:doc-facts:self-test

# 20. 上游版本漂移哨兵（**逐通道**对照各自的 dist-tag；真检查会因上游领先而红，
#     跑在 nightly；CI 只跑自测）
npm run verify:drift
npm run verify:drift:self-test

# 20b. 双上游通道：目标表自检（目标名 ↔ 通道 ↔ 版本；未知通道必须失败不得回退）
npm run verify:targets

# 20c. 提交式 lockfile 纯逻辑自检（inputs 一致性三规则 + 家族钉死推导 +
#      闭包字段抽取 + 安装位置推导）
npm run verify:harness-lockfile

# 20d. 重新生成某目标的提交式 lockfile（版本锚点/补丁集/vendored 变更后必跑；
#      需联网——先直连 registry 并发算家族传递闭包，再 npm install --package-lock-only；
#      产出 harness-locks/<target>/ 下 package-lock.json + inputs.json，两者必须成对提交）
npm run harness:lockfile -- --dsh-target=<next|alpha>

# 20e. 临时目录清理判据自测（三级降级 / 永不抛错 / 不跟随符号链接）
npm run verify:remove-tree

# 20f. 更新通道（ADR-053）：纯逻辑自检（含可证伪夹具）+ 真检查
#      真检查核对「端点 version ≥ 该通道最新 tag」——它正是 2026-09-15~09-30 零投递的判据
npm run verify:update-channel:self-test
npm run verify:update-channel

# 20g. .github 配置准入（ADR-054）：工作流必须在 workflows/ 下；第三方 action 必须钉 40 位 SHA
npm run verify:github-config
npm run verify:github-config:self-test

# 21. 补丁健康度报告（层 / 退役条件 ↔ MANIFEST 实际结果；报告，非门禁）
#     默认按 MANIFEST 里记录的 target 取补丁表，也可 --dsh-target=<name> 指定
npm run report:patches

# 22. 上游升级预检：补丁在新版本上的适用性（~4MB，不必组装 300MB）
#     `--dsh-target` 选**哪一套补丁**，`--target` 是**待检的上游版本**，两者不同
npm run check:patch-applicability -- --dsh-target=next --target=0.1.6-alpha.2

# 22b. 移植补丁后**重算行号**（patch-package 按行号定位，偏移超 ±20 行即失败；
#      只按内容搜索的预检会漏报这类失败，真实组装才炸——见 §8.6）
#      ⚠️ 默认 --pristine 是 harness-deps/<target>-pristine，**目标键、不带版本**，
#      目录名证明不了里面是哪一版；换锚点后请显式指定带版本的目录，
#      或改用 relocate-patch-hunks.mjs（它有版本判据，本脚本没有）。
node scripts/recount-patches.mjs --dsh-target=<next|alpha> --pristine=<未打补丁的包根>

# 23. 壳入口 ↔ 上游 CLI 调用约定 + macOS 父死看门狗 + **打包资源清单推导**（含自测）
#     守三类静默失效：上游改自执行方式、看门狗装错进程/unref、
#     入口依赖的模块或 Rust 资源常量漏登记进 bundle.resources
#     （漏登记的后果只有安装包坏：本地目录齐全、门禁全绿——见 §4）
npm run verify:harness-entry
npm run verify:harness-entry:self-test

# 24. CLI 打包能力：打包 / 命名 / sha256 边车 / 回读校验 / 产物执行自检（含自测）
#     产物名由 package.json + 目标三元组推导；归档解包回读并真的执行一次
#     ⚠️ 2026-09-24 起这是**本地能力**，不再有 Release 上传通道（见 §8.4）
npm run verify:cli-package
#     便携版同一条链路（命名 / 边车 / 「解 zip 按平台选命令」）。真打包与可伪证
#     夹具依赖 PowerShell，故本步只在本机为 Windows 时有意义
npm run verify:portable-package
#     真打一份产物（先 cargo build --release -p dsh-host-cli）
npm run package:cli -- --bin target/release/dsh-host-cli --out dist/cli
#     核验下载回来的那份（manifest 由打包步骤落盘；上传通道退役后用于人工分发核对）
npm run package:cli -- --verify-download dist/cli --manifest dist/cli/<base>.manifest.json

# 25. 🗄️ 已归档（2026-09-24）：cli-publish 发布步骤的原文演练
#     scripts/dry-run-cli-publish.mjs → docs/archive/dry-run-cli-publish.mjs
#     归档理由：上传通道退役后它失去唯一标的（它 100% 服务于「上传步骤正确性」）。
#     文件头写明恢复清单（四处一起做）。**不要再从 scripts/ 里找它。**
#     注：它验证过的两条经验仍然有效，恢复时不必重踩：
#       · 手抄一份实现去验收，验的是抄件而非真正发布的那段；
#       · 豁免判据不得锚在散文上，必须锚在机器可读标记（missing-artifact-class:）上。

# 26. 推进版本号（dry-run 先看，再真改）
npm run version:bump -- auto --dry-run     # 依提交历史判定升 major/minor/patch
npm run version:set  -- 0.2.0              # 直接指定
npm run version:bump -- minor --commit --tag   # 改文件 + 提交 + 打本地 tag（不推送）

# 27. 变更日志（产物入库 / 供 Release 正文使用）
npm run changelog:write -- --version 0.2.0     # 写入 CHANGELOG.md
npm run changelog:notes                        # 打印上个 tag..HEAD 的 Release 正文
```

集成测试（`crates/dsh-host/tests/`）会真实派生 Node 进程运行 `scripts/mock-harness.mjs`，需要 `PATH` 上有 Node.js（可用 `DSH_TEST_NODE` 指定）；找不到时测试自行跳过而非失败。故障模式经 `mock-harness.mjs` 的 argv / 环境变量注入，不在 Rust 侧打桩。

