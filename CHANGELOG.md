# 变更日志

> 本文件**自动生成**，请勿手工编辑——手工改动会在下次生成时被覆盖。
> 数据来源：git 提交历史（[Conventional Commits](https://www.conventionalcommits.org/)）。
> 重新生成：`npm run changelog:write -- --version <x.y.z>`
> 分类规则与版本推进规则见 [AGENTS.md](AGENTS.md) 的「版本与发布」一节。

<!-- changelog-entries -->

## [0.2.0-rc.2.1] - 2026-10-09

### 🐛 修复

- **release**: 前门时点判据只作用于目标行——next 线 --apply 首跑被 alpha 历史行误判红 ([8fa84f2](https://github.com/wang-yi-bit64/dsh-desktop/commit/8fa84f2c08d504e7a20af72fff759c17907f2598))
- **release**: 前门步骤⑧补传 --target/--dsh-target——--apply 首次端到端即失败 ([d5a5865](https://github.com/wang-yi-bit64/dsh-desktop/commit/d5a58659c9818c6f1f734ebb19f3f52ad3499611))

### 🧹 其他

- **release**: 0.2.1-alpha.1.1 ([7e452d4](https://github.com/wang-yi-bit64/dsh-desktop/commit/7e452d4fec17dea9f3bda28020ea52ce1a30ea0b))
- **release**: 0.7.4-alpha.1 ([c2296a0](https://github.com/wang-yi-bit64/dsh-desktop/commit/c2296a0b18262e8db0d42f41dd719adca0c99399))

## [0.2.1-alpha.1.1] - 2026-10-09

### ✨ 新功能

- **release**: ADR-063 桥接版机制 + Release Plan 可校验化（登记/豁免/注入/门禁） ([7946100](https://github.com/wang-yi-bit64/dsh-desktop/commit/7946100c3dc67e02fdd289af413be5793f1eae46))
- **gates**: 恢复 Dependabot 哨兵 —— 症状面零 secret 自动跑，前提面改由 PAT 驱动 ([fb95226](https://github.com/wang-yi-bit64/dsh-desktop/commit/fb95226a833aca9cee24334da9903dcaadce6105))
- **release**: MANIFEST v3 与 C1 改指台账 SSOT（2g + 2h 同批） ([7ef96db](https://github.com/wang-yi-bit64/dsh-desktop/commit/7ef96dbad9391ca37a88b292f92a43d16bc91a53))
- **release**: 2f 漂移哨兵换基准（npm dist-tag → 上游 GitHub Release）+ 修复前门步骤①② ([a1605d3](https://github.com/wang-yi-bit64/dsh-desktop/commit/a1605d3d9d9c06c9f82e1f452d4932e9736ad125))
- **release**: 2d version.mjs 子命令 + 修复步骤⑦ 恒判失败（writeVersion 契约不一致） ([0251178](https://github.com/wang-yi-bit64/dsh-desktop/commit/0251178014aa1f914b668d1a0c4136f4216d2528))
- **version**: 2c 落地 sync-upstream-release.mjs（--plan 默认只读 / --apply 显式写） ([51caac8](https://github.com/wang-yi-bit64/dsh-desktop/commit/51caac8ce4a1ee7894b9db4df6cee25b5fc0ca2a))
- **version**: 落地合成版本号模型（ADR-061）—— 2b 台账 + 2i 缺口修复 + 两条门禁 ([60d703f](https://github.com/wang-yi-bit64/dsh-desktop/commit/60d703fab269499a93961238808d4d81646b7472))

### 🐛 修复

- **release**: 前门步骤⑧补传 --target/--dsh-target——--apply 首次端到端即失败 ([d5a5865](https://github.com/wang-yi-bit64/dsh-desktop/commit/d5a58659c9818c6f1f734ebb19f3f52ad3499611))
- **gates**: github-config 分隔符归一改字面替换——posix 上反斜杠路径夹具恒红 ([268c36c](https://github.com/wang-yi-bit64/dsh-desktop/commit/268c36cb4172df072f1fde5513950a4db2a4ba17))
- **deps**: 删除孤儿 src-tauri/Cargo.lock —— 消幽灵 Dependabot 告警，补 cargo-lock-scope 守卫 ([eabbb7f](https://github.com/wang-yi-bit64/dsh-desktop/commit/eabbb7fe53739fe2e80246368f7b93c7eec50bb3))
- **gates**: 令牌纪律收口 —— 提供了令牌时 skip 不成立（D13 前提面残余漏洞） ([1b19b62](https://github.com/wang-yi-bit64/dsh-desktop/commit/1b19b62b1093334271929774b6d4d62f006ee141))
- **gates**: 哨兵成功时也回显输出（echoOutput）+ M6 字段白名单 ([853d78f](https://github.com/wang-yi-bit64/dsh-desktop/commit/853d78f222735995c15e9a31e58e2f3430b7f5d0))
- **deps**: Dependabot 安全更新不读 dependabot.yml 的 directory（D13）—— 关闭开关 + 两条守卫 ([b318252](https://github.com/wang-yi-bit64/dsh-desktop/commit/b3182529c15e2b21010200f7b097eadf971e48b3))

### ♻️ 重构

- **gates**: 撤回 dependabot-setting 的 CI job —— 实测 CI 核不了，不做变相背书 ([a7ce8ed](https://github.com/wang-yi-bit64/dsh-desktop/commit/a7ce8ed6e8d35b95a0fec2d53041896244573882))
- **targets**: 2e 拆分 dsh-targets 职责（目标表 / 台账 / 写入面三产地互斥） ([856876f](https://github.com/wang-yi-bit64/dsh-desktop/commit/856876ffa4227978a86b3375b73f8f523bec7517))

### 📝 文档

- **upgrade-checklist**: §6 登记上游依赖漏洞等待项（第 4 条）+ 区分本仓 rustls ([e1e9210](https://github.com/wang-yi-bit64/dsh-desktop/commit/e1e92103738d42238b47a67928e0b3206cf4a268))
- **github**: CODEOWNERS 头部状态同步——ruleset 已接通 code owners review ([8f4421b](https://github.com/wang-yi-bit64/dsh-desktop/commit/8f4421b59da421b1f2d92234c35bcdfc33e72dea))

### 🧹 其他

- **release**: 0.7.4-alpha.1 ([c2296a0](https://github.com/wang-yi-bit64/dsh-desktop/commit/c2296a0b18262e8db0d42f41dd719adca0c99399))
- **release**: 0.7.3-rc.1 ([a511e2a](https://github.com/wang-yi-bit64/dsh-desktop/commit/a511e2aeb9a0f049b08c6928075fa89062873d6d))
- **drift**: 探测 GITHUB_TOKEN 能否读到 security_and_analysis ([915c07d](https://github.com/wang-yi-bit64/dsh-desktop/commit/915c07dec659757a3135adff53bfdafbe824172e))
- **workflows**: 永久移除 pullfrog.yml（ADR-062 关闭 ADR-058 决策 1 的恢复路径） ([cacc9b9](https://github.com/wang-yi-bit64/dsh-desktop/commit/cacc9b9c8e92b843ddef7732318fb36f4dd6f682))
- **github**: 新增 CODEOWNERS 并为其补可证伪守卫 ([1e0ea04](https://github.com/wang-yi-bit64/dsh-desktop/commit/1e0ea04188c2af338707bb0ba69d03a5d4de6819))

## [0.7.3-rc.1] - 2026-10-09

### ✨ 新功能

- **release**: ADR-063 桥接版机制 + Release Plan 可校验化（登记/豁免/注入/门禁） ([7946100](https://github.com/wang-yi-bit64/dsh-desktop/commit/7946100c3dc67e02fdd289af413be5793f1eae46))
- **gates**: 恢复 Dependabot 哨兵 —— 症状面零 secret 自动跑，前提面改由 PAT 驱动 ([fb95226](https://github.com/wang-yi-bit64/dsh-desktop/commit/fb95226a833aca9cee24334da9903dcaadce6105))
- **release**: MANIFEST v3 与 C1 改指台账 SSOT（2g + 2h 同批） ([7ef96db](https://github.com/wang-yi-bit64/dsh-desktop/commit/7ef96dbad9391ca37a88b292f92a43d16bc91a53))
- **release**: 2f 漂移哨兵换基准（npm dist-tag → 上游 GitHub Release）+ 修复前门步骤①② ([a1605d3](https://github.com/wang-yi-bit64/dsh-desktop/commit/a1605d3d9d9c06c9f82e1f452d4932e9736ad125))
- **release**: 2d version.mjs 子命令 + 修复步骤⑦ 恒判失败（writeVersion 契约不一致） ([0251178](https://github.com/wang-yi-bit64/dsh-desktop/commit/0251178014aa1f914b668d1a0c4136f4216d2528))
- **version**: 2c 落地 sync-upstream-release.mjs（--plan 默认只读 / --apply 显式写） ([51caac8](https://github.com/wang-yi-bit64/dsh-desktop/commit/51caac8ce4a1ee7894b9db4df6cee25b5fc0ca2a))
- **version**: 落地合成版本号模型（ADR-061）—— 2b 台账 + 2i 缺口修复 + 两条门禁 ([60d703f](https://github.com/wang-yi-bit64/dsh-desktop/commit/60d703fab269499a93961238808d4d81646b7472))

### 🐛 修复

- **gates**: github-config 分隔符归一改字面替换——posix 上反斜杠路径夹具恒红 ([268c36c](https://github.com/wang-yi-bit64/dsh-desktop/commit/268c36cb4172df072f1fde5513950a4db2a4ba17))
- **deps**: 删除孤儿 src-tauri/Cargo.lock —— 消幽灵 Dependabot 告警，补 cargo-lock-scope 守卫 ([eabbb7f](https://github.com/wang-yi-bit64/dsh-desktop/commit/eabbb7fe53739fe2e80246368f7b93c7eec50bb3))
- **gates**: 令牌纪律收口 —— 提供了令牌时 skip 不成立（D13 前提面残余漏洞） ([1b19b62](https://github.com/wang-yi-bit64/dsh-desktop/commit/1b19b62b1093334271929774b6d4d62f006ee141))
- **gates**: 哨兵成功时也回显输出（echoOutput）+ M6 字段白名单 ([853d78f](https://github.com/wang-yi-bit64/dsh-desktop/commit/853d78f222735995c15e9a31e58e2f3430b7f5d0))
- **deps**: Dependabot 安全更新不读 dependabot.yml 的 directory（D13）—— 关闭开关 + 两条守卫 ([b318252](https://github.com/wang-yi-bit64/dsh-desktop/commit/b3182529c15e2b21010200f7b097eadf971e48b3))

### ♻️ 重构

- **gates**: 撤回 dependabot-setting 的 CI job —— 实测 CI 核不了，不做变相背书 ([a7ce8ed](https://github.com/wang-yi-bit64/dsh-desktop/commit/a7ce8ed6e8d35b95a0fec2d53041896244573882))
- **targets**: 2e 拆分 dsh-targets 职责（目标表 / 台账 / 写入面三产地互斥） ([856876f](https://github.com/wang-yi-bit64/dsh-desktop/commit/856876ffa4227978a86b3375b73f8f523bec7517))

### 📝 文档

- **upgrade-checklist**: §6 登记上游依赖漏洞等待项（第 4 条）+ 区分本仓 rustls ([e1e9210](https://github.com/wang-yi-bit64/dsh-desktop/commit/e1e92103738d42238b47a67928e0b3206cf4a268))
- **github**: CODEOWNERS 头部状态同步——ruleset 已接通 code owners review ([8f4421b](https://github.com/wang-yi-bit64/dsh-desktop/commit/8f4421b59da421b1f2d92234c35bcdfc33e72dea))

### 🧹 其他

- **drift**: 探测 GITHUB_TOKEN 能否读到 security_and_analysis ([915c07d](https://github.com/wang-yi-bit64/dsh-desktop/commit/915c07dec659757a3135adff53bfdafbe824172e))
- **workflows**: 永久移除 pullfrog.yml（ADR-062 关闭 ADR-058 决策 1 的恢复路径） ([cacc9b9](https://github.com/wang-yi-bit64/dsh-desktop/commit/cacc9b9c8e92b843ddef7732318fb36f4dd6f682))
- **github**: 新增 CODEOWNERS 并为其补可证伪守卫 ([1e0ea04](https://github.com/wang-yi-bit64/dsh-desktop/commit/1e0ea04188c2af338707bb0ba69d03a5d4de6819))



## [0.7.3-alpha.1] - 2026-10-07

### ✨ 新功能

- **runtime**: alpha 线推进至 DSH 0.2.1-alpha.1（锚点+补丁集+lockfile 原子提交） ([29093a7](https://github.com/wang-yi-bit64/dsh-desktop/commit/29093a7d0df818358569266bcecc06adbd7289ea))
- **runtime**: 默认构建带上 primary runtime 载荷，并补齐壳层观测/退出/快捷键 ([115161b](https://github.com/wang-yi-bit64/dsh-desktop/commit/115161b466a869b08f2d29ef18c006d17fb9186f))

### 🐛 修复

- **test**: manifest 平台用例不得硬编码 darwin——在 macOS 上等于没改 ([1ee03eb](https://github.com/wang-yi-bit64/dsh-desktop/commit/1ee03eb683efe22fd0523da6abe1423e3bfdff47))
- **test**: quit_probe 桩读到请求头结束再回包，消除吃字节竞态 ([05c1a83](https://github.com/wang-yi-bit64/dsh-desktop/commit/05c1a83b74c04e226f51982d38c9a3821b8809f0))
- **test**: 临时目录名含 ISO 时间戳的冒号，Windows 上 create_dir_all 失败 ([2660287](https://github.com/wang-yi-bit64/dsh-desktop/commit/266028743ecaeec0050555866f3b8d8a7252927f))
- **workflows**: 给含「冒号+空格」的步骤名加引号，否则 workflow_dispatch 失效 ([78c3ab8](https://github.com/wang-yi-bit64/dsh-desktop/commit/78c3ab80669b2e768b2e9b64b987a7124a82e7dd))
- **docs**: 收敛文档与代码事实矛盾，并同步门禁收敛（G1/G2） ([ad3b2a4](https://github.com/wang-yi-bit64/dsh-desktop/commit/ad3b2a44e30c3ec22e5dc3d47442835cbe34eac0))
- **state**: 收敛生产 unwrap，锁中毒改恢复 guard（D10/S4-4 销账） ([15b9169](https://github.com/wang-yi-bit64/dsh-desktop/commit/15b91698836e020608533f0b45fbc85cdcef4120))
- **workflows**: gate PR Agent on real /commands after a floating-image failure ([45d7327](https://github.com/wang-yi-bit64/dsh-desktop/commit/45d7327faf73aa777ee09316a9132b94a9e9cd58))

### ♻️ 重构

- **runtime**: 拆除档2（8 库 wheel 交叉安装），只保留档1.5 载荷形态 ([a6e4ba9](https://github.com/wang-yi-bit64/dsh-desktop/commit/a6e4ba9a810d307bc15a5d773a19baaf28e7e8e1))

### 📝 文档

- **alpha**: C1 新增 ADR-060，并将 primary-runtime 载荷向 alpha 线对齐 ([9138545](https://github.com/wang-yi-bit64/dsh-desktop/commit/9138545e0015a34efafd5d1e51d535432ea68705))
- **alpha**: 记录 B4 组装成功 / B5 烟雾全绿，并锁定 spawnSync EBUSY 根因 ([8f53982](https://github.com/wang-yi-bit64/dsh-desktop/commit/8f539823d4a6aaa33528ace0c7aa7058959ab01e))

### ✅ 测试

- **primary-runtime**: self-test 的 manifest 规则改用独立夹具，并输出完整 problems ([b55e497](https://github.com/wang-yi-bit64/dsh-desktop/commit/b55e4974d190a4dc72be4aa6c0c85864af28d4e0))
- **update-journal**: 轮转断言因写入量不足三平台全红——按上限反推行数 ([2dfb24c](https://github.com/wang-yi-bit64/dsh-desktop/commit/2dfb24cd36db73fb4a1abd64f49b7f329aeddd9e))

### 🧹 其他

- Merge origin/main into workbuddy/main-f8784a51（发布前并入 master 最新变更） ([f09c761](https://github.com/wang-yi-bit64/dsh-desktop/commit/f09c761a47f48edbf04e7843b72bedf3d2f0df84))
- Merge origin/main into workbuddy/main-f8784a51（alpha 推进前并入 master 最新变更） ([1a9a14f](https://github.com/wang-yi-bit64/dsh-desktop/commit/1a9a14fb30de90a360364cbbbf7a7ae66f1d2ff0))
- **rust**: cargo fmt 对齐 rustfmt 规范（CI 的 cargo fmt 步骤用） ([cc2cad0](https://github.com/wang-yi-bit64/dsh-desktop/commit/cc2cad0a403b50b030e87a404e0e6ac59bb99491))
- **scripts**: add verify:sentinels / verify:all and document the script map ([5112173](https://github.com/wang-yi-bit64/dsh-desktop/commit/51121734334748e12f5134c8080ea476470de2e9))
- **workflows**: pin Linux runners to ubuntu-24.04, drop node20 action ([d6c8809](https://github.com/wang-yi-bit64/dsh-desktop/commit/d6c880986a8adfc66bd38ae5b35dd7e3b2b48f8b))
- **workflows**: retire pullfrog, converge AI review on PR Agent (ADR-058) ([9f7ec0e](https://github.com/wang-yi-bit64/dsh-desktop/commit/9f7ec0ef1b5b6d58347b7a9082baec03d6645246))
- **git**: ignore merge-migrate-patches temp workdir ([ec56914](https://github.com/wang-yi-bit64/dsh-desktop/commit/ec569148a6bc3e6ba7dbd1b9134f2d640aa0a540))




## [0.7.2-rc.1] - 2026-09-30

### ✨ 新功能

- **runtime**: promote both channels — next 0.2.0-rc.2, alpha 0.1.7-alpha.2 (ADR-057) ([056a636](https://github.com/wang-yi-bit64/dsh-desktop/commit/056a63629591438d204c9246d1ec74ac144fa1ef))
- **frontend**: align shell UI with the official harness visual language ([6cf769b](https://github.com/wang-yi-bit64/dsh-desktop/commit/6cf769b1ce8c38b1c5c30c52a11f7c2d9bc63fae))
- **supply-chain**: cargo scanning, SHA pinning and gate tiering evidence (S3-1..S3-4) ([0add8e7](https://github.com/wang-yi-bit64/dsh-desktop/commit/0add8e751e7eb284fe131bf85217dfe472d3caab))
- **gates**: tier the verification into verify:fast and verify:full (S4-1/S4-2) ([e4cdbe1](https://github.com/wang-yi-bit64/dsh-desktop/commit/e4cdbe15e1473cf77eaf347215e78cc6dfc17acb))
- **guards**: add verify:doc-facts — reconcile doc claims against constants (S2-3) ([3bb18d3](https://github.com/wang-yi-bit64/dsh-desktop/commit/3bb18d3731ec565823b8f359d469e782623173dd))
- **channels**: declare the alpha line dormant (C7, ADR-056) ([ee67fcc](https://github.com/wang-yi-bit64/dsh-desktop/commit/ee67fcce6de9e66fa4ada3160031db30d39aa5b9))

### 🐛 修复

- **ci**: quote a step name containing a colon so the workflow parses ([a2cf031](https://github.com/wang-yi-bit64/dsh-desktop/commit/a2cf03189f1dfd4d324c397d0c29beca2cf56b77))
- **drift**: run the updater channel sentinel as its own job ([003652d](https://github.com/wang-yi-bit64/dsh-desktop/commit/003652db3ed0b570abf1894748f94e501350e8cc))
- **release**: scope the release-time updater check to the published channel ([8205a17](https://github.com/wang-yi-bit64/dsh-desktop/commit/8205a176787d392a63db16d790bc20523bcde1ed))

### ⚡ 性能

- **readiness**: replace 500ms soak window with dual-confirmation ready semantics ([070cc9d](https://github.com/wang-yi-bit64/dsh-desktop/commit/070cc9d5bf69bf7bfccf03826c1954eb5bb7a97f))

### 📝 文档

- sync channel tables, upgrade record and migration-tool usage ([dc8a7e2](https://github.com/wang-yi-bit64/dsh-desktop/commit/dc8a7e2acc9c327465526ea0f585edae3cc6808c))
- **archive**: shelve superseded 0.8 plan v1.0, fix stale roadmap claim (S2-2) ([ef3b523](https://github.com/wang-yi-bit64/dsh-desktop/commit/ef3b523b686ab6b29edd0bb23202686f0322ba72))
- **drift**: refresh the upstream drift note and cite the sentinel split ([85927b2](https://github.com/wang-yi-bit64/dsh-desktop/commit/85927b2ac5204eb9d8f0bde7f22909f189df4e82))
- **release**: record the v0.7.1-rc.1 channelized first release and close D1 for rc ([cec2c9c](https://github.com/wang-yi-bit64/dsh-desktop/commit/cec2c9c26ace38686713be71dbda4a461575268d))

### 🧹 其他

- **scripts**: drop dead npm aliases and wire the orphan fault-patterns guard ([6026025](https://github.com/wang-yi-bit64/dsh-desktop/commit/602602517ec9cd728cae40ece1323b088594b91f))
- **docs**: archive the three release-channels planning docs (S2-4) ([a5e3728](https://github.com/wang-yi-bit64/dsh-desktop/commit/a5e37280df6fde976323654d243c28f226b06026))
- **repo**: add LICENSE and SECURITY.md, fix authors (S0-1/S0-2/S0-5, S2-2) ([48e89cb](https://github.com/wang-yi-bit64/dsh-desktop/commit/48e89cb84b15ee37f166e2c456175b8bc4f0b7c6))



## [0.7.1-rc.1] - 2026-09-30

### ✨ 新功能

- **guards**: add verify:github-config and verify:update-channel ([1b9a323](https://github.com/wang-yi-bit64/dsh-desktop/commit/1b9a323624955a22cf32386cbe2a5083b7a8d206))
- **harness**: make the updater endpoint per-channel via a rolling manifest ([d215624](https://github.com/wang-yi-bit64/dsh-desktop/commit/d215624b4fa8c7af75c7bb06805908b2bcff78e5))

### 🐛 修复

- **workflows**: move pr-agent.yml into .github/workflows and pin actions ([a67574e](https://github.com/wang-yi-bit64/dsh-desktop/commit/a67574eadd81eaa70c967f0926631889de010d26))
- **build**: pin windows.staticVCRuntime=false for tauri 2.12 ([3107a45](https://github.com/wang-yi-bit64/dsh-desktop/commit/3107a4587818f40d2abf5b3d5f258af6f5fd7b92))

### 📝 文档

- **plan**: add the defect-remediation plan and close the 0.8 plan ADR-048 gap ([b0ec178](https://github.com/wang-yi-bit64/dsh-desktop/commit/b0ec17844dddcc43df2f5f4b02edcdc250faa7e0))
- **agents**: return AGENTS.md to a rules-and-index manual (160KB -> 33KB) ([e13708a](https://github.com/wang-yi-bit64/dsh-desktop/commit/e13708a0e266e34988a14b7a7bce12c3acd243f7))
- **adr**: add ADR-052..055 and revise 022/044/047/048 ([f9b0e37](https://github.com/wang-yi-bit64/dsh-desktop/commit/f9b0e374b886d074173344368f1a71f95aba3e12))
- **checklist**: pristine 基线放仓库外——版本进名字，目录出仓库 ([2113d85](https://github.com/wang-yi-bit64/dsh-desktop/commit/2113d859ce9e0d910e69325d0d3da66ac71d3360))
- **plan**: add the 0.8 development plan and its v1.1 convergence revision ([acc5a38](https://github.com/wang-yi-bit64/dsh-desktop/commit/acc5a38b5c1f0cc703e29efe8fa95615858567b6))

### 📦 构建与打包

- **deps**: upgrade tauri 2.11.5 -> 2.12.0 and raise MSRV to 1.90 ([b21da2c](https://github.com/wang-yi-bit64/dsh-desktop/commit/b21da2c4016cd2004fdb3fc506fcbe16f61084ad))

### 🧹 其他

- Add Qodo AI PR Agent workflow ([e9f8dc5](https://github.com/wang-yi-bit64/dsh-desktop/commit/e9f8dc59ebb37f528713292d64ef9ba5e76793a4))
- Merge pull request #1 from wang-yi-bit64/upgrade/tauri-2.12 ([ce4fe6e](https://github.com/wang-yi-bit64/dsh-desktop/commit/ce4fe6e3f879b770726b1d3e46b84545a76ce157))
- **gitignore**: ignore the .qoder/ better-harness run and scratch dirs ([b4fe335](https://github.com/wang-yi-bit64/dsh-desktop/commit/b4fe3356941e336189504f8ac19d19f9341a354a))



## [0.7.0-alpha.8] - 2026-09-25

### 🐛 修复

- **release-assets**: share one process runner so the L2 check works on this host ([2699297](https://github.com/wang-yi-bit64/dsh-desktop/commit/2699297e0fad6bc5cd6e3c8bd9f310814906ed18))
- **release**: checkout before verifying the portable assets ([4991828](https://github.com/wang-yi-bit64/dsh-desktop/commit/4991828fa0ab859942dd3e9db551391bf9dbaf1f))



## [0.7.0-rc.1] - 2026-09-25

### ✨ 新功能

- **harness**: promote the patch-hunk relocator and close two silent-pass paths ([e278353](https://github.com/wang-yi-bit64/dsh-desktop/commit/e278353358d925cbaedcaee6343e73cd365aa90c))
- **harness**: re-anchor the next target to 0.1.5-rc.3 and self-attest lock inputs ([f12e153](https://github.com/wang-yi-bit64/dsh-desktop/commit/f12e15392e7bddbbad8ae1eda78aa2ae512ff5ed))

### 🐛 修复

- **scripts**: give the release-path spawns an explicit stdio so they survive this host ([51e7e40](https://github.com/wang-yi-bit64/dsh-desktop/commit/51e7e409e4882f67e2a577b1c87a99d5d3a4d0c4))
- **release**: attach portable assets to the release (F13) ([1a329ec](https://github.com/wang-yi-bit64/dsh-desktop/commit/1a329ec06643b5a6be8a216848a287f0c4f67095))

### ♻️ 重构

- **targets**: decouple the upstream dist-tag name from the desktop tag suffix ([0fb6d0f](https://github.com/wang-yi-bit64/dsh-desktop/commit/0fb6d0fb38d70e4a45c0c09d5d1c7dc437e1f4a5))
- **release**: retire CLI publish channel, keep crate and packaging capability ([64cdd7b](https://github.com/wang-yi-bit64/dsh-desktop/commit/64cdd7be61861678919473665ff1768bf3012325))

### 📝 文档

- **plan**: re-audit the release-channel plan and guard its version claims ([6fec20a](https://github.com/wang-yi-bit64/dsh-desktop/commit/6fec20ae2355a452c5a4d98efe1183026db2deab))
- **smoke**: note the desktop suffix next to the upstream line in the dsh_target hint ([636252f](https://github.com/wang-yi-bit64/dsh-desktop/commit/636252fd8a959636cf710c2a94d91fd446d28de5))
- **release**: plan the three-channel release refactor, with risk review and optimizations ([c230244](https://github.com/wang-yi-bit64/dsh-desktop/commit/c2302441c3b10ea55c0252ed82c64b5ae9f8a000))
- **agents**: finish the cleanup — no drafts left ([011ebff](https://github.com/wang-yi-bit64/dsh-desktop/commit/011ebffd1eb0d7c195e550f32bcff67eb8f172da))
- **agents**: reconcile the cleanup record with the draft that was deleted ([0309520](https://github.com/wang-yi-bit64/dsh-desktop/commit/0309520fd8f0c2c239b2057395a4a67e2211463a))
- **agents**: correct the tag-cleanup record against what actually happened ([fdef0cb](https://github.com/wang-yi-bit64/dsh-desktop/commit/fdef0cb87e53dcff55f268f034c04eb0e8716c26))
- **agents**: record the failed-release tag cleanup and its rules ([67a9678](https://github.com/wang-yi-bit64/dsh-desktop/commit/67a9678e74db8d7a3537a8e6357751008268a8eb))
- **agents**: make the stale-tag record state-independent ([d78447f](https://github.com/wang-yi-bit64/dsh-desktop/commit/d78447fc65269e559df917c3ef32f975950337f2))
- **agents**: record the alpha.7 release and the tag-resurrection hazard ([2e96619](https://github.com/wang-yi-bit64/dsh-desktop/commit/2e9661919ac3f1a3eee3d3087000fc7e2c12e435))

### 🧹 其他

- **harness**: regenerate the next lockfile for rc.3 and sync the current-state docs ([bc60e97](https://github.com/wang-yi-bit64/dsh-desktop/commit/bc60e97b7add665e7c72d6947f14e07804afa232))



## [0.7.0-alpha.7] - 2026-09-23

### 🐛 修复

- **portable**: normalize zip entry separators before publishing ([59bd75c](https://github.com/wang-yi-bit64/dsh-desktop/commit/59bd75c07ea921c6b994db9ede88d2aafe9f7eae))



## [0.7.0-alpha.6] - 2026-09-23

### 🐛 修复

- **ci**: derive the dry-run mirror from the import closure ([4ab3e2b](https://github.com/wang-yi-bit64/dsh-desktop/commit/4ab3e2bce52b57648b2bacfb24e4d55aa6a9dbd7))
- **changelog**: keep one blank line between version sections ([bd776fd](https://github.com/wang-yi-bit64/dsh-desktop/commit/bd776fde10771817a5bb6db03716b0f3e3cbb47d))
- **release**: never let temp-dir cleanup veto a passing verification ([12e7e49](https://github.com/wang-yi-bit64/dsh-desktop/commit/12e7e49b492ddc81041dfec02f1411cb918cc644))

### 🧹 其他

- **release**: record the alpha.6 CI fix in the changelog ([a7b1b2b](https://github.com/wang-yi-bit64/dsh-desktop/commit/a7b1b2b8a0ba302a47e5f752d0ddc86f65656bfa))
- **release**: 0.7.0-alpha.6 ([9e112e2](https://github.com/wang-yi-bit64/dsh-desktop/commit/9e112e275b562027a4546233ea606f87854d8943))



## [0.7.0-alpha.5] - 2026-09-23

### 🐛 修复

- **harness**: prune package-name libc variants (sharp) so linuxdeploy stops dying ([992aa75](https://github.com/wang-yi-bit64/dsh-desktop/commit/992aa754e85695aebb2d31d69adbce78d4b1f1c1))
- **harness**: pin the full @deepseek-ai/dsh family closure, including peer edges ([8ed0a9e](https://github.com/wang-yi-bit64/dsh-desktop/commit/8ed0a9e34697b84fbcaa74154d2c5205803d9ddb))
- **harness**: resolve picker package location from lockfile, not a fixed path ([eca0612](https://github.com/wang-yi-bit64/dsh-desktop/commit/eca0612ee8110623b8497922a79ac492e1060903))
- **harness**: install Harness deps from committed lockfiles via npm ci ([3f3c46c](https://github.com/wang-yi-bit64/dsh-desktop/commit/3f3c46ccf871a23897275ca8ad23800803734e84))
- **harness**: raise npm install heap ceiling in prepare-harness ([ecde5e0](https://github.com/wang-yi-bit64/dsh-desktop/commit/ecde5e04b9417ba2aa05d5cfd5387298093a274e))
- **portable**: require WebView2Loader.dll only for non-msvc targets ([6c70c6d](https://github.com/wang-yi-bit64/dsh-desktop/commit/6c70c6d73f071923f2e50bfb5cb29c819655b7db))
- **release**: declare shell: bash on the portable packaging step ([b71e83e](https://github.com/wang-yi-bit64/dsh-desktop/commit/b71e83e588efdd29498401286644efc50a515f48))

### 🧹 其他

- **release**: 0.7.0-alpha.5 ([6f3742e](https://github.com/wang-yi-bit64/dsh-desktop/commit/6f3742e44863c98fb088334baae65730e72dd98f))



## [0.7.0-alpha.4] - 2026-09-22

### 🐛 修复

- **release**: stop the publish guards depending on wording and unreachable classes ([aac22ca](https://github.com/wang-yi-bit64/dsh-desktop/commit/aac22cab52abf4115053d780b424d15362859183))
- **ci**: unblock the fmt/clippy gates and the portable job's signing key ([a53419b](https://github.com/wang-yi-bit64/dsh-desktop/commit/a53419bdf1299d1f1e73804de4718e9fafa9813b))
- **portable**: stop incomplete bundles from passing the release gate ([f5d1d28](https://github.com/wang-yi-bit64/dsh-desktop/commit/f5d1d288ea57c092a93a420152aaca2bb87c7ecb))
- **plugin-safety-guard**: attribute boot-summary and entry-state faults ([883da3d](https://github.com/wang-yi-bit64/dsh-desktop/commit/883da3d120d11bc8cb46b5812ac7f0468a3bf3aa))
- **verify**: stop E5 from passing while scanning zero modules ([28cdc86](https://github.com/wang-yi-bit64/dsh-desktop/commit/28cdc8659f4cd7b2fd0a4bf6e9a9156846fadcfc))
- **harness-entry**: keep the entry alive when a sibling module is missing ([d015ed1](https://github.com/wang-yi-bit64/dsh-desktop/commit/d015ed1ec0966ad1e3ccf511294cbeff535e2314))
- **safe-mode**: persist the choice so it survives a cold start ([00c7d81](https://github.com/wang-yi-bit64/dsh-desktop/commit/00c7d81751c121938c47e5b06954cd22f716a04d))

### 📝 文档

- **adr**: register the archived plugin isolation gap as ADR-051 ([b6015a7](https://github.com/wang-yi-bit64/dsh-desktop/commit/b6015a76bcb49ae9e34dfdca75e919946ac4a573))

### 🧹 其他

- **portable**: drop the orphaned tauri.portable.conf.json ([14f0ae4](https://github.com/wang-yi-bit64/dsh-desktop/commit/14f0ae435379a4f029ecc62d8248f706fc55b12a))
- fix safe mode persistence, plugin fault attribution, and register the plugin isolation gap ([89d12f8](https://github.com/wang-yi-bit64/dsh-desktop/commit/89d12f8472ec7b0b187cf21f06051fbd8bcc2b3e))



## [0.7.0-alpha.3] - 2026-09-22

### ✨ 新功能

- **portable**: add Windows portable zip packaging and portable mode detection ([7b9e6d1](https://github.com/wang-yi-bit64/dsh-desktop/commit/7b9e6d193e8d87db545c0717276cc1f8f613b873))

### 🐛 修复

- **ci**: ensure DSH_TARGET inherited by tauri build and update release-workflow self-test ([e27490d](https://github.com/wang-yi-bit64/dsh-desktop/commit/e27490d5fe420701b244dcea08ab378e0770dea8))

### 📝 文档

- ADR 篇数补到 36 篇（ADR-049/050 已入库） ([334ff4f](https://github.com/wang-yi-bit64/dsh-desktop/commit/334ff4f8c50fbc0c41ea950e6fe3cc204776f79c))
- 记录 GNU 工具链本地安装包缺 WebView2Loader.dll 的限制 ([596e91e](https://github.com/wang-yi-bit64/dsh-desktop/commit/596e91eedc3a2ea834b5a0c6b9afdc210bf117f9))

### 🧹 其他

- **release**: 0.7.0-alpha.3 ([48320c7](https://github.com/wang-yi-bit64/dsh-desktop/commit/48320c7eb8f0b119d1952ffe20de5bf1a425ff1e))



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
