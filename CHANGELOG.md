# 变更日志

> 本文件**自动生成**，请勿手工编辑——手工改动会在下次生成时被覆盖。
> 数据来源：git 提交历史（[Conventional Commits](https://www.conventionalcommits.org/)）。
> 重新生成：`npm run changelog:write -- --version <x.y.z>`
> 分类规则与版本推进规则见 [AGENTS.md](AGENTS.md) 的「版本与发布」一节。

<!-- changelog-entries -->

## [0.7.0-alpha.2] - 2026-09-21

### 🐛 修复

- **smoke**: 看门狗清理预算与门禁窗口对账，断言改为「预算内干净」 ([4e909bb](https://github.com/wang-yi-bit64/dsh-desktop/commit/4e909bb11982364d3d2f500e34989e13ab9140d9))
- **packaging**: 安装包补上 parent-death-watchdog.mjs，并把资源清单改成推导校验 ([9cd6690](https://github.com/wang-yi-bit64/dsh-desktop/commit/9cd669031a45395f529c6808b79e6de4d6ab104e))

### 📝 文档

- 既有决策 ADR 化（docs/adr/ 34 篇 + 索引） ([6aad22d](https://github.com/wang-yi-bit64/dsh-desktop/commit/6aad22dba54909fcb16f93f3536e632e51d7ecb6))

## [0.7.0-alpha.1] - 2026-09-19

### ✨ 新功能

- **shell**: 系统托盘与关窗驻留 + 应用内反馈入口（批次 0.2-B1 / 0.2-D2） ([2535823](https://github.com/wang-yi-bit64/dsh-desktop/commit/25358237f8142fce9cf1f46238b1823366f1a73f))

### 📝 文档

- 记录 alpha.2 安装包体积翻倍的原因与判据 ([ac89570](https://github.com/wang-yi-bit64/dsh-desktop/commit/ac89570cb3bdb98d3f5587853b79b48aff28cdff))

## [0.6.0-alpha.2] - 2026-09-18

### ✨ 新功能

- **harness**: alpha 线推进到 DSH 0.1.6-alpha.2（13 个补丁，两处退役） ([4b15129](https://github.com/wang-yi-bit64/dsh-desktop/commit/4b151299e8ffc7dbec035c46729cc0dc674b0f08))

### 📝 文档

- 回写 alpha.2 推进（补丁 14 → 13，两处退役） ([6140f7f](https://github.com/wang-yi-bit64/dsh-desktop/commit/6140f7fbbfff892f8e6e0629f181894330639633))
- 回写双通道首发结果（v0.5.0-next.1 / v0.6.0-alpha.1） ([ed693dd](https://github.com/wang-yi-bit64/dsh-desktop/commit/ed693dd6a4cc3ef527d12b8be8daf977525af764))

### 🔧 CI

- 固定 Node 版本并启用 npm 缓存 ([4f4bdc3](https://github.com/wang-yi-bit64/dsh-desktop/commit/4f4bdc3d7e22c207a3457d4a94e177aef5b01ed3))
- 使用 .nvmrc 统一 Node 版本 ([baa8cd5](https://github.com/wang-yi-bit64/dsh-desktop/commit/baa8cd55a3be719fb5a838f12b8402f74e0e12d0))
- 升级 GitHub Actions 依赖与 Node 版本 ([13c9003](https://github.com/wang-yi-bit64/dsh-desktop/commit/13c90035adb593538e7022a4d115bf0a71194305))

## [0.5.0-next.1] - 2026-09-15

### ✨ 新功能

- **harness**: 双上游运行时通道（next = DSH 0.1.5-rc.2 / alpha = DSH 0.1.6-alpha.1） ([2ae5e1a](https://github.com/wang-yi-bit64/dsh-desktop/commit/2ae5e1acd8dd5dc5f67d8631b38a566bb3126824))

### 🐛 修复

- **harness**: 构建钩子改为只校验——beforeBuildCommand 会覆盖另一条通道的资源树 ([84cb94f](https://github.com/wang-yi-bit64/dsh-desktop/commit/84cb94fe949a18691e2e3cf53d399c25c8c79397))
- **ci**: 构建目标改用 env 传值——shell 插值在 Windows runner 上会被丢掉 ([1d3a831](https://github.com/wang-yi-bit64/dsh-desktop/commit/1d3a831089b6a78043e92e7f8640eb8181219c99))

### 📝 文档

- **agents**: 记录 beforeBuildCommand 覆盖资源树的事故（第三种契约形态） ([c467da5](https://github.com/wang-yi-bit64/dsh-desktop/commit/c467da5de38af36b8cbaa9034616da5066783ace))
- **agents**: 记录「构建目标插进 run: 字符串 → 只有 Windows 红」的真实事故 ([75dacf8](https://github.com/wang-yi-bit64/dsh-desktop/commit/75dacf89e24b540ad152ee576685fe5ca91ac4e6))
- 回写 v0.4.0 首次真实发布结果（CLI 产物链路已跑通） ([be5fcf5](https://github.com/wang-yi-bit64/dsh-desktop/commit/be5fcf519b37235a9d3aa5ec4945039c7ce22a98))

### 🧹 其他

- Add `pullfrog.yml` workflow ([574f61e](https://github.com/wang-yi-bit64/dsh-desktop/commit/574f61ee7a71b9e2e5a6c44d777dd4d6a20c4d90))

## [0.4.0] - 2026-09-13

### ✨ 新功能

- **release**: CLI 归档作为 Release 资产发布（cli + cli-publish 两个 job） ([15cb85d](https://github.com/wang-yi-bit64/dsh-desktop/commit/15cb85df09e6afc1b93ba909194e28f775fce6da))
- **cli**: CLI 打包装箱脚本——命名/边车/manifest/回读校验/产物执行自检 ([57b4c1f](https://github.com/wang-yi-bit64/dsh-desktop/commit/57b4c1fa2e21f9bbd887b58bf09eeee32ddfdf55))

### 📝 文档

- 登记 CLI 可引用产物能力与分期计划 ([ca53f80](https://github.com/wang-yi-bit64/dsh-desktop/commit/ca53f80036ca49f5f0806a1343d6f6a1c69dd274))
- 同步 0.3.0 发布结果与三平台验证结论 ([6b16ac4](https://github.com/wang-yi-bit64/dsh-desktop/commit/6b16ac4794987b48d8bd7022419c25f3e2fe7757))

### ✅ 测试

- **release-workflow**: 守卫覆盖 CLI 产物形状（按 job 切片 + CRLF 无关） ([7f3b32a](https://github.com/wang-yi-bit64/dsh-desktop/commit/7f3b32a56fe16454ef73e28e874dd4090e40debb))

### 🔧 CI

- 接入 CLI 打包与发布步骤原文演练门禁 ([920d211](https://github.com/wang-yi-bit64/dsh-desktop/commit/920d211466fac64336ff536c84b120b4f8229340))

## [0.3.0] - 2026-09-13

### ✨ 新功能

- **harness**: 升级内置 DSH 运行时 0.1.2-alpha.4 → 0.1.5-rc.1 ([7a1d5ef](https://github.com/wang-yi-bit64/dsh-desktop/commit/7a1d5efad1a7e6c198e99e2713bf74a1c03e8e7a))

### 🐛 修复

- **macos**: 看门狗抽成共用模块并装到 mock 上——故障注入不经真实入口 ([4dc4f12](https://github.com/wang-yi-bit64/dsh-desktop/commit/4dc4f128722fc0da6da9811ba7306518ca62c4eb))
- **macos**: 看门狗去掉 unref——闲置时定时器不触发，真机上等于没有 ([d94e672](https://github.com/wang-yi-bit64/dsh-desktop/commit/d94e67282620096f4b0eb42bc71f998e1efc1cff))
- **macos**: 父死看门狗改为主动探测父进程存活 ([bb977fe](https://github.com/wang-yi-bit64/dsh-desktop/commit/bb977fef42568f1890f8fca42145cbfc3eee0c0c))
- **ci**: 修复三平台冒烟暴露的三个真实缺陷 ([b8c18f1](https://github.com/wang-yi-bit64/dsh-desktop/commit/b8c18f17043c9729fe458e19366659e78f7da3c5))

### 🧹 其他

- **github**: 新增 Issue 模板与 Discussions 入口（0.2-D1） ([f9c8513](https://github.com/wang-yi-bit64/dsh-desktop/commit/f9c8513ff030c3959e50b9a7719896e89c343840))

## [0.2.0] - 2026-09-12

### ✨ 新功能

- **guards**: 新增风险哨兵、宣称纪律守卫与上游预检工具 ([949c0dd](https://github.com/wang-yi-bit64/dsh-desktop/commit/949c0dd97735206d827d6eb6e6111a1ec145f75c))

### 🐛 修复

- **version**: 修正 --commit 下 CHANGELOG 静默不生成 ([ee136e4](https://github.com/wang-yi-bit64/dsh-desktop/commit/ee136e4a73274c3c5dc9fd04c943bc976e4ca2e5))

### 📝 文档

- **plan**: 新增长期路线图与加固差异化计划 ([ec3e65a](https://github.com/wang-yi-bit64/dsh-desktop/commit/ec3e65a515dde8ccf6c8a827db08e301842461cc))
- **changelog**: 重新生成 0.1.0 段落，纳入 v0.1.0 发布前的修复提交 ([96ad2ca](https://github.com/wang-yi-bit64/dsh-desktop/commit/96ad2cae25ee44e8c278687e0d4cf8c5db74e2f9))

### 🔧 CI

- **workflows**: 冒烟测试改为手动触发，日常提交不再跑 CI ([9f8e0f4](https://github.com/wang-yi-bit64/dsh-desktop/commit/9f8e0f462e87cccb90419a9ee535eef7e1ea8681))

### 🧹 其他

- **skills**: 安装项目级 agent skills（10 项）并入库技能实体 ([d7e12ed](https://github.com/wang-yi-bit64/dsh-desktop/commit/d7e12ed7d9890500c63e12382b3bc66eacc545b2))
## [0.1.0] - 2026-09-11

### ✨ 新功能

- **release**: 修复 CI 红灯 + 打通 tag 发布链路 + 版本管理与变更日志自动生成 ([2878589](https://github.com/wang-yi-bit64/dsh-desktop/commit/287858941de181fc51d2d2dd6cfacdac463684e1))
- **shell**: 闭合恢复/诊断/封套三条链路并冻结归档插件隔离与模型网关 ([b0a3e46](https://github.com/wang-yi-bit64/dsh-desktop/commit/b0a3e46e6d95b0431198924dd10be49d8abc31b8))
- **shell**: Harness 页注入机制 + 页内手机状态指示器 ([18e26f5](https://github.com/wang-yi-bit64/dsh-desktop/commit/18e26f5b91c4dce8bf2c794af382e683daca416f))
- **shell**: 接线应用内更新 UI（updates.html + harness_open） ([7a3ca73](https://github.com/wang-yi-bit64/dsh-desktop/commit/7a3ca73177995942ab8458bd63070339f8d873e0))
- **mobile**: 配对状态变化驱动原生菜单刷新（复刻上游 onConnectedChange） ([38eb983](https://github.com/wang-yi-bit64/dsh-desktop/commit/38eb9833ac45c0d9388b529bff691f13be28bd52))
- **shell**: Phone 子菜单显示手机桥实时状态（off / listening / paired） ([5edbd2f](https://github.com/wang-yi-bit64/dsh-desktop/commit/5edbd2ff012fb8f33c15fbaff0de269a3627d522))
- **mobile**: wire the LAN bridge and complete the cookie handshake ([02b6b01](https://github.com/wang-yi-bit64/dsh-desktop/commit/02b6b01064032b11dad7c842609ae50b3848f6cb))
- complete redesign architecture, dsh-contracts extraction, plugin isolation 2.0 and benchmarks ([2a0429d](https://github.com/wang-yi-bit64/dsh-desktop/commit/2a0429dcc8a2ac61e888f8a24b7937a2feaaea0d))
- **architecture**: implement Model Gateway, Plugin Worker Isolation, unified transport and update docs ([f373f5f](https://github.com/wang-yi-bit64/dsh-desktop/commit/f373f5f64cd9509b266f5e07681a129ce3280162))
- add model gateway crate, plugin worker isolation, supervisor, and diagnostics ([c1c32b5](https://github.com/wang-yi-bit64/dsh-desktop/commit/c1c32b5b4b2334446747f21b3078157d4195b341))
- **host**: support Node SEA sidecar binary mode and move frontend into src-tauri ([92a122c](https://github.com/wang-yi-bit64/dsh-desktop/commit/92a122c5f254eb58b4b9b3286b56c3d99fbd1d7d))
- **host,cli**: 重写/增强 dsh-host 与 dsh-host-cli（阶段 1 任务 T01-T04） ([6efc7eb](https://github.com/wang-yi-bit64/dsh-desktop/commit/6efc7eb90922993ae6d44b2c11602c487ff717f3))
- **cli**: 新增 dsh-host-cli 调试命令行（阶段 1 任务 1.2） ([1734417](https://github.com/wang-yi-bit64/dsh-desktop/commit/1734417a91b115377059a10a48d4e8753ca16cb7))
- **host**: 新增 GUI 无关的 dsh-host 库（阶段 1 任务 1.1） ([86e0209](https://github.com/wang-yi-bit64/dsh-desktop/commit/86e0209e7abf93f0016106fde56a7275f319dde9))
- Rust + Tauri 2.0 desktop shell for DeepSeek Harness ([2d91067](https://github.com/wang-yi-bit64/dsh-desktop/commit/2d910673cf21145b352dae7de37b22c95da103d8))

### 🐛 修复

- **release**: 修正 tauri-action 参数重复与 macOS 变量终止，打通发布链路 ([917ddc0](https://github.com/wang-yi-bit64/dsh-desktop/commit/917ddc050a035efa760f3b2747431c7104a2edd8))
- **build**: 剪掉外来平台原生变体，修复 Linux AppImage 打包失败 ([5230cd9](https://github.com/wang-yi-bit64/dsh-desktop/commit/5230cd9162eb0da81a4b0f95be2f7803269a19c7))
- **ci**: pin 新版 linuxdeploy + verbose 构建输出 ([30624bb](https://github.com/wang-yi-bit64/dsh-desktop/commit/30624bbab625ac28cce2bc730eb6eb57eaa82fe3))
- **ci**: gdk-pixbuf-query-loaders 在 noble 不在 PATH——改 multiarch 绝对路径 ([7b7f3ed](https://github.com/wang-yi-bit64/dsh-desktop/commit/7b7f3ed8a298b19aecb74eaf04190586666551f5))
- **ci**: Linux AppImage 打包环境修复——NO_STRIP + pixbuf loaders ([09ed742](https://github.com/wang-yi-bit64/dsh-desktop/commit/09ed742b063cfc901de368f4cb2674e1631c7552))
- **smoke**: 对齐契约 C5 两步兑换——undici fetch 无 cookie jar 致 303 二跳 401 ([5364f54](https://github.com/wang-yi-bit64/dsh-desktop/commit/5364f5422f831af63a79cdd7ffe02a4ed8965d25))
- **build**: 实体化 file: 依赖，修复桌面插件裸导入解析失败 ([b71bc92](https://github.com/wang-yi-bit64/dsh-desktop/commit/b71bc92834a5faf00659bca8b556dc67fe99843c))
- **build**: 修正依赖树瘦身误删运行时模块（yaml/dist/doc） ([be47830](https://github.com/wang-yi-bit64/dsh-desktop/commit/be478305fbe631faf3ff31f1218b65f4a4cd276f))
- **build**: 修正补丁应用与变更说明基线的两处静默失效 ([5a2f030](https://github.com/wang-yi-bit64/dsh-desktop/commit/5a2f030404661ddcd2b887d8f3a6d626f459f8f4))
- **shell**: 修正快照契约——phase 平铺（此前恒为 false 的插件故障分支根因） ([476a056](https://github.com/wang-yi-bit64/dsh-desktop/commit/476a05697d601c506a441fee6fc472469fc8ab78))
- **shell**: 更新源改指本仓库并接通自有签名密钥 ([60682ac](https://github.com/wang-yi-bit64/dsh-desktop/commit/60682ac2d4e3134cec3c3b7df2e4c26c7f9b88b8))
- **shell**: 安全模式真正以 desktop-safe-mode profile 启动 ([baa0cbe](https://github.com/wang-yi-bit64/dsh-desktop/commit/baa0cbe7f6bab463d71d89076610f26f6063f1fd))
- **shell**: 修复错误页安全模式按钮静默失效，并加接口面一致性门禁 ([c99a401](https://github.com/wang-yi-bit64/dsh-desktop/commit/c99a4013f1fd603705afbecd8472bc1ff3c2d543))
- **plugin-isolation**: stop reporting unwired plugin tools as executed ([957a5e8](https://github.com/wang-yi-bit64/dsh-desktop/commit/957a5e818c271d6146b900a0fd4ad75b7bdf39c7))
- **market**: 修复 generation 插件安装后无法挂载生效 ([8641966](https://github.com/wang-yi-bit64/dsh-desktop/commit/8641966a900b653f92520694b6c92224a952f2cc))
- **picker**: restore host-backed directory picker ([b91757a](https://github.com/wang-yi-bit64/dsh-desktop/commit/b91757aca7f8c7d80551d28b9aa72038355e9fcd))
- **windows**: repair packaged startup failures and sync docs ([e858080](https://github.com/wang-yi-bit64/dsh-desktop/commit/e858080feac9b7c9cf0c8670d60c32553a544065))
- **shell**: resolve packaged app startup failures (deadlock, resource mapping, missing bundles) ([d99b3bc](https://github.com/wang-yi-bit64/dsh-desktop/commit/d99b3bc1d90ea8052ef20f900a97024fcd2678b9))
- **build**: tauri 脚本改用 @tauri-apps/cli 二进制而非 cargo 子命令 ([f5fc573](https://github.com/wang-yi-bit64/dsh-desktop/commit/f5fc5736aaada85bad988fc82c649ee67c671831))
- 修 navigation doctest 引用私有模块 + macOS process_belongs_to 无 /proc ([f32e924](https://github.com/wang-yi-bit64/dsh-desktop/commit/f32e92459b7aa01ac837a3c52c409c799eb1dcaf))
- **host**: 跨平台门控 merge_path 用例 + stop 退出竞态；ci 增加 workspace test 诊断捕获 ([b131eb3](https://github.com/wang-yi-bit64/dsh-desktop/commit/b131eb33b87fad038ee73a1d168456a65597855d))
- **ci,host**: 修复 workspace 全量编译 + CI test job 缺 src-tauri 资源 ([29f98a9](https://github.com/wang-yi-bit64/dsh-desktop/commit/29f98a9bf9476fdc49a1703b10e24ad6bda19d56))
- **src-tauri**: 修复 GUI 壳编译/告警问题，使全 workspace 通过 clippy -D warnings ([e0722fd](https://github.com/wang-yi-bit64/dsh-desktop/commit/e0722fd96975a31b700b68a10de7d2c26acf896a))
- **ci**: 给 T05 headless gate step 的 name 加引号修复 YAML 解析 ([dc07b7b](https://github.com/wang-yi-bit64/dsh-desktop/commit/dc07b7bfa8e6117c3dc549071b59bf8fde5c0bc9))
- **host**: 规范化路径去掉 Windows \?\ verbatim 前缀，修复 node 入口 EISDIR ([b75700d](https://github.com/wang-yi-bit64/dsh-desktop/commit/b75700d90112bbbc2cbb0a87816e59a98ff4a5aa))

### ♻️ 重构

- **shell**: 删死 IPC 命令与死代码，摘除随之孤立的 dialog 插件 ([c8c6eae](https://github.com/wang-yi-bit64/dsh-desktop/commit/c8c6eae08af001f1fbdded53df5c107836a842a8))
- **rpc**: converge JSON-RPC model into dsh-contracts as single source ([f44cfb3](https://github.com/wang-yi-bit64/dsh-desktop/commit/f44cfb3ad7f6ca1822467515f8a3c0535927d944))
- **desktop**: 移动前端静态资源至 src-tauri/frontend 并完善文档与配置 ([506295c](https://github.com/wang-yi-bit64/dsh-desktop/commit/506295c052ff6d57718d6446ce3f73ea115eacdc))
- **shell**: src-tauri 接入 Harness 状态机并迁移宿主逻辑至 dsh-host（阶段 1 任务 1.4/1.5） ([b236712](https://github.com/wang-yi-bit64/dsh-desktop/commit/b236712e2d11e5b02293602b770673b55f5bc56c))

### 📝 文档

- **agents**: 补两条「勿回归」——补丁应用形式与变更说明基线 ([79b0d9a](https://github.com/wang-yi-bit64/dsh-desktop/commit/79b0d9a5876e21760fbaf8ae71855002bb9fa143))
- 同步批次 C~G 的真实能力口径与新增门禁 ([3ce658a](https://github.com/wang-yi-bit64/dsh-desktop/commit/3ce658a578b4b6cbea784110e47919689ed26579))
- 把断线点主计划移入 docs/ 入库并补 AGENTS.md 索引 ([3b7e570](https://github.com/wang-yi-bit64/dsh-desktop/commit/3b7e570d0f4728b393b402e24e2ee4c436e2e88e))
- 更正「无初始化脚本」的误判并登记页内指示器 ([d6b7fb0](https://github.com/wang-yi-bit64/dsh-desktop/commit/d6b7fb009efa57866c675fd5ec0c8fcc4abcb1e1))
- 把安全模式界面指示器登记为「计划中」并同步中英文 README ([58ce571](https://github.com/wang-yi-bit64/dsh-desktop/commit/58ce5711f4c85838600a48f4576ca5dd4f858647))
- 修正更新链路与签名密钥的过期宣称 ([8694eb0](https://github.com/wang-yi-bit64/dsh-desktop/commit/8694eb049cc55e06f4700436f2f98b940f5914f0))
- 同步安全模式与手机桥状态的真实宣称 ([5bdbdb4](https://github.com/wang-yi-bit64/dsh-desktop/commit/5bdbdb4798f7e5226bfe2a09a7ab4a2526f78b5b))
- 同步宣称真相——IpcEnvelope 未接线、无系统托盘、命令面 13 个 ([45611f9](https://github.com/wang-yi-bit64/dsh-desktop/commit/45611f91b6ffd37ba5ee22b893fa2eae7ad20838))
- calibrate capability claims and add the DSH upgrade checklist ([cf4137e](https://github.com/wang-yi-bit64/dsh-desktop/commit/cf4137e46905c0a9efa5c6a865945ff83e1b510e))
- 清理过期文档（旧版 GUI 计划、空模板与一次性归档） ([cb47591](https://github.com/wang-yi-bit64/dsh-desktop/commit/cb47591683ea5a6bc3ec9f42b9840bfa78bc1757))
- update README (en/zh) and AGENTS.md with redesign architecture, dsh-contracts, plugin isolation 2.0 and benchmarks ([4e9a49b](https://github.com/wang-yi-bit64/dsh-desktop/commit/4e9a49bba7f5be985a82b850eea1785c95c2294f))
- 归档文档记录 GUI 编译实测——windres/resources 已解决，残留环境级 os error 5（非代码阻塞） ([c7383ee](https://github.com/wang-yi-bit64/dsh-desktop/commit/c7383ee1ed7a1a5d0c3f65742019737d0cd5671e))
- 新增 GUI 打通与发布实施计划（P0-P5，依据 README 声明与代码现状核对） ([db84eea](https://github.com/wang-yi-bit64/dsh-desktop/commit/db84eea3aea295e3a61da1b1a2815e63a6a04727))
- 归档计划文档 T05 状态回填为已完成并记录推送阻塞 ([ab4ea70](https://github.com/wang-yi-bit64/dsh-desktop/commit/ab4ea707a822e9ae846904f28516e1aa75aef604))
- 系统设计文档与类图/时序图（T02 架构产物） ([763dae1](https://github.com/wang-yi-bit64/dsh-desktop/commit/763dae128486de7a7c78df08adbe91dc377c5037))
- 阶段 0/1 验证文档模板与任务归档记录 ([440d8b0](https://github.com/wang-yi-bit64/dsh-desktop/commit/440d8b03f876c87e92a8c736b2514b89e62f15b2))
- add Chinese README (README.zh-CN) ([5860c86](https://github.com/wang-yi-bit64/dsh-desktop/commit/5860c86aa16957056d3a5c31d9983c66d06bf476))
- record accepted-risk rationale for RUSTSEC-2024-0429 (glib) ([2b879e2](https://github.com/wang-yi-bit64/dsh-desktop/commit/2b879e2c34ba80224452a766725a2392e1163d36))
- add project README ([c707e4b](https://github.com/wang-yi-bit64/dsh-desktop/commit/c707e4bb7ea97eeeeae79ce45efc872add82935c))

### ✅ 测试

- **host**: 补回 port-in-use 重试计数断言 + 记录 stop_leaves_no_orphan 豁免 ([9e77ee2](https://github.com/wang-yi-bit64/dsh-desktop/commit/9e77ee2a0a5b2750db8cefe9151b384cc62b20f2))
- **host,cli**: T05 落地集成/黑盒测试、故障注入修正、验证文档与 CI 快门禁 ([e297e4f](https://github.com/wang-yi-bit64/dsh-desktop/commit/e297e4fe9bd13b59e7f8f31109360bbb5a1f3afc))

### 📦 构建与打包

- **gates**: tier patches by blast radius and add layered CI smoke ([cea57b3](https://github.com/wang-yi-bit64/dsh-desktop/commit/cea57b3c40cb9f1cd6541e076762abd459e2bc19))

### 🔧 CI

- 还原调试捕获为普通命令，bundle 用 cargo tauri build 直跑 ([2f2876f](https://github.com/wang-yi-bit64/dsh-desktop/commit/2f2876f067c8aae0fa8d948fef90d5c1f82843d7))

### 🧹 其他

- **smoke**: L1.3 失败时记录响应体与请求形态对照 ([14b63e3](https://github.com/wang-yi-bit64/dsh-desktop/commit/14b63e3a13d5550ea636fd93e053d8e986373891))
- **smoke**: 失败时保留 Harness 日志 + 新增瘦身引用审计工具 ([d91e30c](https://github.com/wang-yi-bit64/dsh-desktop/commit/d91e30c4c2f2cbca3344c8771c75c6aef3bb6498))
- **gates**: 新增壳内页面运行时冒烟，并修掉两处会误报的守卫 ([0d2ea84](https://github.com/wang-yi-bit64/dsh-desktop/commit/0d2ea84a17b6c7db90d12c049c13a859f66d61b5))
- **gates**: 注入脚本无头自测（含可证伪性检查）并进 CI ([6319994](https://github.com/wang-yi-bit64/dsh-desktop/commit/63199948529e6ce490cc4bbd688be94ffbdaa6de))
- **gates**: 登记 plugin-recovery.html 不可达，修复接口面门禁红灯 ([216f330](https://github.com/wang-yi-bit64/dsh-desktop/commit/216f3301cb8519494e560841eebbee6da0807b28))
- **ci**: 三个孤儿脚本接线，并把接口面检查与目标守卫加入门禁 ([9499a16](https://github.com/wang-yi-bit64/dsh-desktop/commit/9499a164d104afbd7967ffd662a96b2a5aeb5217))
- **shell**: drop unused model-gateway dep and log to app_data_dir ([d06c256](https://github.com/wang-yi-bit64/dsh-desktop/commit/d06c256cf12a57889870a17764b87ae5de25555b))
- .gitignore 忽略本地 mimosa 扫描工具工件 ([439200d](https://github.com/wang-yi-bit64/dsh-desktop/commit/439200d76efcd8f05dd0efff13c82c6477e59e56))
- **ci**: bundle job 改为直跑 npm run tauri build 并捕获诊断输出 ([13beeda](https://github.com/wang-yi-bit64/dsh-desktop/commit/13beedaf29c12c241ba57257c64398ac35a1896c))
- **ci**: 临时把 headless 单测失败输出打到 annotation 定位 unix 失败 ([4070eb4](https://github.com/wang-yi-bit64/dsh-desktop/commit/4070eb4532a3ab2d5dc9a55d9749be8daaecac04))
- **ci**: clippy 错误捕获改为只筛 error/warning 行 ([67d79d3](https://github.com/wang-yi-bit64/dsh-desktop/commit/67d79d30827e697c4f1ef700013eee61886b3b08))
- **ci**: 临时把 clippy 错误输出到 check annotation 以便定位跨平台失败 ([5fcd75e](https://github.com/wang-yi-bit64/dsh-desktop/commit/5fcd75eb37f43c09625e257e4f7cb890b1520b60))
- **env**: 切换 tauri-plugin-updater 至 native-tls/schannel 移除 ring 的 C 编译器依赖 ([0cdbff0](https://github.com/wang-yi-bit64/dsh-desktop/commit/0cdbff0731c9ce3629e3bc6a9276804850bb225d))
- **host,cli**: rustfmt 全量格式化并修复 clippy -D warnings 告警 ([ecf37de](https://github.com/wang-yi-bit64/dsh-desktop/commit/ecf37de3cc6f035cb82b1253090361542a90bf9a))
- **build**: 建立 Cargo workspace 并幂等化 Harness 组装（阶段 0） ([f03206b](https://github.com/wang-yi-bit64/dsh-desktop/commit/f03206b9d4b9a19e4faa99ad2daf308e01b9eb12))
