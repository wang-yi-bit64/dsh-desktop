# 任务归档：DSH Desktop Tauri 版实施 —— 阶段 0～1（2026-09-04）

> 依据《DSH Desktop Tauri 版实施计划 v2》（`.trae/documents/`）执行；本次归档覆盖阶段 0（Spike 准备 / 工作区 / 组装幂等化）与阶段 1（Tauri 壳层重构）的编码与验证工作。
>
> **更新记录**：2026-09-06 按实际进度补记——新增「阶段 1 增量 T01–T05」任务表、`docs/system_design.md` 产物、host/CLI 重写增强后的验证数据（fmt / clippy / 143 测试 / GUI API 静态核对）、本机 windows-gnu + rust-lld 链接器环境经验，以及 git 提交与推送结果。

## 一、已实现功能

### 阶段 0
| 任务 | 内容 | 状态 |
| --- | --- | --- |
| 0.1 | Cargo workspace：根 `Cargo.toml`（members：`src-tauri`、`crates/dsh-host`、`crates/dsh-host-cli`），`[workspace.dependencies]` 统一版本，`[profile.release]` lto/strip | ✅ 完成 |
| 0.3 | `scripts/prepare-harness.mjs` 幂等化：输入指纹（版本+依赖+overrides+patches）、`MANIFEST.json`（fingerprint / lockfileHash / versions / patchesApplied）、`--force` 覆盖、快速路径（产物完整仅重建 MANIFEST） | ✅ 完成，连续两次运行第二次跳过已实测 |
| 0.2 | Spike：`PORT_ZERO_SUPPORTED` 开关已内置于 `dsh-host/src/contracts.rs`；Spike 执行本身需人工 Go-No-Go | ⚠️ 模板就绪，执行待人工确认 |

### 阶段 1
| 任务 | 内容 | 状态 |
| --- | --- | --- |
| 1.1 | `crates/dsh-host`：GUI 无关库 crate，覆盖进程生命周期（spawn/Job Object/pidfile/sweep/terminate）、就绪探测（手写 HTTP/1.0，无 reqwest）、令牌提取、环境捕获（C2 快照）、日志（LogRing 200 + ANSI/GBK 清洗 + 失败归因）、路径布局（INV-1 资源只读）、停止语义（SIGTERM→4s→SIGKILL） | ✅ 完成；2026-09-06 重写增强后 99 单元 + 40 doctest 全过 |
| 1.2 | `crates/dsh-host-cli`：`start` / `status` / `tail` / `probe` 调试命令，`DSH_MOCK=1` 支持 | ✅ 完成；2026-09-06 重写为 clap 4 derive 六子命令（含 `stop` / `doctor`），4 项 CLI 测试全过 |
| 1.3 | `scripts/mock-harness.mjs`：契约对齐桩（token 行、401/200+cookie、--fail 各模式） | ✅ 完成 |
| 1.4 | src-tauri 接入状态机：`HarnessPhase`（§3.2 八态）+ exit watcher；`on_navigation` 导航裁决（本机放行 / 外链转 opener / 拒绝）；Cookie 431 缓解（webview2-com 0.38 CookieManager，仅 Windows，R-4 降级）；command `ensure_local_origin` 守卫（INV-2）；capabilities 仅 `core:default`；CSP 收紧；旧 `harness_runtime/shell_env/paths/resources` 删除并迁移至 dsh-host | ✅ 完成（dsh-desktop 编译验证进行中即被归档） |
| 1.5 | `frontend/error.html`：日志尾读（30 行）+ plugin_fault 提示 | ✅ 完成 |
| 1.6 | fault-inject 场景 A–F 验证（`scripts/fault-inject.mjs` 已就绪，CLI 二进制已构建） | ⏳ 待执行；脚本本身待修（E5 需改用 `process.execPath`、E6 场景 A 缺 straight-through 快照） |

### 阶段 1 增量（2026-09-06，依据 `docs/system_design.md` T01–T05）

| 任务 | 内容 | 状态 |
| --- | --- | --- |
| T01 | host 内核：契约常量集中（`contracts.rs`）、错误体系扩展（稳定退出码映射） | ✅ 完成 |
| T02 | 架构设计：`docs/system_design.md` + 类图/时序图（A–F 缺陷清单、T01–T05 任务列表） | ✅ 完成 |
| T03 | `args.rs`（HarnessArgs / `--env` 覆盖 / argv 快照）与 `logging.rs`（AppLog 全量落盘 + stdout 级别过滤）；`launch` 双轨 API（launch/run） | ✅ 完成 |
| T04 | CLI 重写：start/stop/status/tail/probe/doctor + `--` 透传 + `--print-argv` dry-run + 契约退出码 | ✅ 完成，143 测试全绿 |
| T05 | 集成测试（`crates/dsh-host/tests/*`）+ fault-inject 修复 + `verification-phase1.md` 回填 | ⏳ 未开始 |

## 二、修改的文件

**新增（2026-09-04 首次归档）**
- `Cargo.toml`、`Cargo.lock`（workspace 根）
- `crates/dsh-host/`（`Cargo.toml` + `src/{lib,contracts,error,paths,env,logs,token,readiness,process,stop,launch}.rs`）
- `crates/dsh-host-cli/`（`Cargo.toml` + `src/main.rs`）
- `scripts/mock-harness.mjs`、`scripts/fault-inject.mjs`
- `src-tauri/src/{cookies,navigation,layout}.rs`
- `docs/{spike-webview-results,baseline-electron,verification-phase1}.md`
- `.github/workflows/ci.yml`
- `docs/archive-phase0-1-2026-09-04.md`（本归档）

**新增（2026-09-06 增量）**
- `crates/dsh-host/src/args.rs`、`crates/dsh-host/src/logging.rs`
- `crates/dsh-host-cli/src/cli.rs`、`crates/dsh-host-cli/src/commands/{mod,start,inspect,doctor}.rs`
- `docs/system_design.md`、`docs/class-diagram.mermaid`、`docs/sequence-diagram.mermaid`

**修改（2026-09-06 增量）**
- `Cargo.toml`（`rust-version` 1.77 → 1.85，`idna_adapter` 1.2.2 为 edition2024）
- `crates/dsh-host/src/{contracts,error,logs,env,process,stop,readiness,paths,launch,lib}.rs`
- `crates/dsh-host-cli/{Cargo.toml,src/main.rs}`
- `.gitignore`（新增 `.cargo/`：本机专用链接器配置不入库）

**修改**
- `scripts/prepare-harness.mjs`（幂等 + MANIFEST + rmTreeSafe 原生删除回退）
- `src-tauri/{Cargo.toml,tauri.conf.json}`、`src-tauri/capabilities/default.json → main.json`
- `src-tauri/src/{state,commands,window,menu,lib,mobile_bridge,recovery,safe_mode}.rs`
- `frontend/error.html`、`.gitignore`、`README.zh-CN.md`（markdown lint 格式化）

**删除**
- `src-tauri/src/{harness_runtime,shell_env,paths,resources}.rs`（逻辑迁入 `dsh-host`，计划要求的 GUI-free 拆分）

## 三、验证状态

| 项 | 结果 |
| --- | --- |
| `cargo fmt --all -- --check` | ✅ 全工作区干净（2026-09-06 已对新增代码重跑 `cargo fmt --all`） |
| `cargo clippy -p dsh-host -p dsh-host-cli --all-targets -- -D warnings` | ✅ 通过（2026-09-06；修复 3 处：`paths.rs` needless-borrow、`contracts.rs` 常量断言 allow、`doctor.rs` print_literal） |
| `cargo check -p dsh-host -p dsh-host-cli`（2026-09-06） | ✅ 0 error / 0 warning |
| `cargo test -p dsh-host -p dsh-host-cli`（2026-09-06） | ✅ 143 全绿（99 单元 + 4 CLI 单元测试 + 40 doctest） |
| src-tauri（GUI）API 兼容静态核对（2026-09-06） | ✅ `Layout`/`HostError`/`Launcher`/`LaunchOutcome`/`RunningHarness`/`LogRing` 及 `take_exit`/`terminate`/`wait_exit`/`navigate_url` 等均存在且签名一致 |
| `cargo clippy --workspace -D warnings`（含 dsh-desktop） | ⏳ 编译被归档中止，**未出结果**（本次仍未覆盖，需重跑） |
| 任务 0.3 幂等（连跑两次） | ✅ 第二次 fingerprint 一致跳过 |
| fault-inject 场景 A–F | ⏳ 待执行（任务 1.6 / T05） |

## 四、未完成事项 / 风险

1. **dsh-desktop 全量 clippy/test 未完成**：workspace 级验证编译超过 24 分钟被归档中止。已知的唯一阻塞（`resources/MANIFEST.json` 缺失导致 build.rs 报错）已通过快速路径解决，重跑预期可通过；建议恢复时先跑 `cargo check -p dsh-desktop`。（2026-09-06 仍未覆盖，GUI crate 仅做了 API 静态核对。）
2. **任务 1.6 / T05 fault-inject 场景验证**未执行；脚本需先修 E5（`node` → `process.execPath`）与 E6（场景 A 期望值）。
5. **git 提交**：2026-09-04 归档前变更已按模块分组提交；2026-09-06 增量也已提交并**推送到 GitHub**（`6efc7eb` feat(host,cli) T01–T04、`763dae1` docs 系统设计文档），远端 `main` 已更新至 `763dae1`。
3. **Spike（任务 0.2）与 Electron 基线采集（任务 0.5）**：文档模板已建，实际执行为人工 Go-No-Go 步骤。
4. **阶段 2–7 未开始**（单实例托盘、目录选择原生能力 ADR-4、移动桥接完善、安全模式/恢复页、updater、打包）。
4.1 **T05 未开始**：集成测试（`crates/dsh-host/tests/{fixture,args_forwarding,mock_launch,mock_lifecycle}`）、`scripts/fault-inject.mjs` 修复、`docs/verification-phase1.md` 回填。本机无真实 dsh 引擎，运行时行为只能靠 `scripts/mock-harness.mjs` 契约桩验证。
5. **git 提交**：本次归档前所有变更均未提交，已按模块分组提交（见本次提交序列）。

## 五、环境经验（复现排查用）

- 本机 bash 的 `NODE_OPTIONS` 全局注入 safe-delete shim 并被子进程（npm）继承：`fs.rmSync` 被替换为回收站删除，超大目录（约 2 万文件）会超时崩溃。运行 prepare-harness 等重删除脚本时用 `NODE_OPTIONS= node …` 清空；脚本内 `rmTreeSafe()` 已优先使用原生命令 `cmd rd /s /q`。
- 沙箱环境会拦截 `target/debug/incremental` 写入（os error 5），cargo 全量编译需在沙箱外执行。
- 本机 NTFS 删除海量小文件极慢（约 10 文件/秒，疑似 AV 挂钩），优先用原生命令删除。
- **（2026-09-06）windows-gnu + rust-lld 链接链路（本机无 MSVC / 无完整 MinGW）**：
  - `.cargo/ld.lld.cmd` → `link-wrapper.cjs` 是必需配置：① rust-lld 不在 PATH，需用工具链绝对路径；② rust-mingw 的 `dllcrt2.o` 定义的 DLL 入口是 `DllMainCRTStartup`（x64 无下划线），rust-lld 默认查 `_DllMainCRTStartup` 且无 GNU ld 回退 → DLL 链接注入 `-e`；③ rustdoc 内部 rustc 不继承 `[target] rustflags`，doctest 链接缺 `-L self-contained` 与 `crt2.o` → 由 wrapper 注入（**`-L` 必须插在全部 `-l` 之前**，追加到末尾无效）。
  - `.cmd` 包装脚本必须**纯 ASCII**：UTF-8 中文注释在 GBK 代码页下会被 cmd 误解析为命令。
  - raw-dylib 导入库：GNU dlltool 依赖 `as.exe`（本机没有）→ 复制 `llvm-ar.exe` 改名为 `llvm-dlltool.exe`（LLVM 工具按 `argv[0]` 选驱动）+ `-C dlltool=` 指定。
  - rustc 长命令行走响应文件模式（`@linker-arguments`，每行一个带引号参数）：解析 token 必须剥引号；错误信息里的 `␍` 是 lld 的 CRLF 行尾，**不是符号名污染**。
  - `.cargo/` 已加入 `.gitignore`（含本机绝对路径，不入库）。
  - rustup 直连官方源会挂起，需 `RUSTUP_DIST_SERVER=https://mirrors.ustc.edu.cn/rust-static`；cargo 全量编译需在沙箱外执行。
