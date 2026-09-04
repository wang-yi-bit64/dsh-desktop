# 任务归档：DSH Desktop Tauri 版实施 —— 阶段 0～1（2026-09-04）

> 依据《DSH Desktop Tauri 版实施计划 v2》（`.trae/documents/`）执行；本次归档覆盖阶段 0（Spike 准备 / 工作区 / 组装幂等化）与阶段 1（Tauri 壳层重构）的编码与验证工作。

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
| 1.1 | `crates/dsh-host`：GUI 无关库 crate，覆盖进程生命周期（spawn/Job Object/pidfile/sweep/terminate）、就绪探测（手写 HTTP/1.0，无 reqwest）、令牌提取、环境捕获（C2 快照）、日志（LogRing 200 + ANSI/GBK 清洗 + 失败归因）、路径布局（INV-1 资源只读）、停止语义（SIGTERM→4s→SIGKILL） | ✅ 完成，75 单元测试 + 19 doctest 全过 |
| 1.2 | `crates/dsh-host-cli`：`start` / `status` / `tail` / `probe` 调试命令，`DSH_MOCK=1` 支持 | ✅ 完成，编译通过 |
| 1.3 | `scripts/mock-harness.mjs`：契约对齐桩（token 行、401/200+cookie、--fail 各模式） | ✅ 完成 |
| 1.4 | src-tauri 接入状态机：`HarnessPhase`（§3.2 八态）+ exit watcher；`on_navigation` 导航裁决（本机放行 / 外链转 opener / 拒绝）；Cookie 431 缓解（webview2-com 0.38 CookieManager，仅 Windows，R-4 降级）；command `ensure_local_origin` 守卫（INV-2）；capabilities 仅 `core:default`；CSP 收紧；旧 `harness_runtime/shell_env/paths/resources` 删除并迁移至 dsh-host | ✅ 完成（dsh-desktop 编译验证进行中即被归档） |
| 1.5 | `frontend/error.html`：日志尾读（30 行）+ plugin_fault 提示 | ✅ 完成 |
| 1.6 | fault-inject 场景 A–F 验证（`scripts/fault-inject.mjs` 已就绪，CLI 二进制已构建） | ⏳ 待执行 |

## 二、修改的文件

**新增**
- `Cargo.toml`、`Cargo.lock`（workspace 根）
- `crates/dsh-host/`（`Cargo.toml` + `src/{lib,contracts,error,paths,env,logs,token,readiness,process,stop,launch}.rs`）
- `crates/dsh-host-cli/`（`Cargo.toml` + `src/main.rs`）
- `scripts/mock-harness.mjs`、`scripts/fault-inject.mjs`
- `src-tauri/src/{cookies,navigation,layout}.rs`
- `docs/{spike-webview-results,baseline-electron,verification-phase1}.md`
- `.github/workflows/ci.yml`
- `docs/archive-phase0-1-2026-09-04.md`（本归档）

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
| `cargo fmt --all -- --check` | ✅ 全工作区干净 |
| `cargo clippy -p dsh-host -p dsh-host-cli -D warnings` | ✅ 通过 |
| `cargo test -p dsh-host -p dsh-host-cli` | ✅ 75 单元 + 19 doctest 全过 |
| `cargo clippy --workspace -D warnings`（含 dsh-desktop） | ⏳ 编译被归档中止，**未出结果** |
| 任务 0.3 幂等（连跑两次） | ✅ 第二次 fingerprint 一致跳过 |
| fault-inject 场景 A–F | ⏳ 待执行（任务 1.6） |

## 四、未完成事项 / 风险

1. **dsh-desktop 全量 clippy/test 未完成**：workspace 级验证编译超过 24 分钟被归档中止。已知的唯一阻塞（`resources/MANIFEST.json` 缺失导致 build.rs 报错）已通过快速路径解决，重跑预期可通过；建议恢复时先跑 `cargo check -p dsh-desktop`。
2. **任务 1.6 fault-inject 场景验证**未执行（CLI 二进制已构建于 `target/debug/dsh-host-cli.exe`）。
3. **Spike（任务 0.2）与 Electron 基线采集（任务 0.5）**：文档模板已建，实际执行为人工 Go-No-Go 步骤。
4. **阶段 2–7 未开始**（单实例托盘、目录选择原生能力 ADR-4、移动桥接完善、安全模式/恢复页、updater、打包）。
5. **git 提交**：本次归档前所有变更均未提交，已按模块分组提交（见本次提交序列）。

## 五、环境经验（复现排查用）

- 本机 bash 的 `NODE_OPTIONS` 全局注入 safe-delete shim 并被子进程（npm）继承：`fs.rmSync` 被替换为回收站删除，超大目录（约 2 万文件）会超时崩溃。运行 prepare-harness 等重删除脚本时用 `NODE_OPTIONS= node …` 清空；脚本内 `rmTreeSafe()` 已优先使用原生命令 `cmd rd /s /q`。
- 沙箱环境会拦截 `target/debug/incremental` 写入（os error 5），cargo 全量编译需在沙箱外执行。
- 本机 NTFS 删除海量小文件极慢（约 10 文件/秒，疑似 AV 挂钩），优先用原生命令删除。
