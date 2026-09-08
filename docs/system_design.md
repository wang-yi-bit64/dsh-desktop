# dsh-host / dsh-host-cli 增量架构设计（V2）

> 架构师：高见远。仓库 `D:\works\github\dsh-desktop`，基线 HEAD `440d8b0`，工作区干净。
> 范围：`crates/dsh-host` + `crates/dsh-host-cli`；**不触碰 `src-tauri`**，但保证其调用点兼容。
> 配套图：`docs/class-diagram.mermaid`、`docs/sequence-diagram.mermaid`

## 0. 三条先行结论

1. **工具链是唯一硬阻塞，且比预想的严重**：本机 stable `1.76` 与 nightly `1.79.0-nightly (2024-03-18)` **都编不过 `dsh-host`**。真实报错不是 MSRV 提示，而是：

   ```text
   error: failed to download replaced source registry `crates-io`
     Caused by: failed to parse manifest at ...\idna_adapter-1.2.2\Cargo.toml
     Caused by: feature `edition2024` is required
       The package requires the Cargo feature called `edition2024`, but that feature
       is not stabilized in this version of Cargo (1.76.0)
   ```

   `idna_adapter 1.2.2` 是 `url 2.5.8` 的传递依赖，用 edition 2024。`edition2024` 在 **Rust 1.85** 才稳定。所以 (a) 降 `rust-version` 到 1.76 无效，(b) 换 nightly 1.79 也无效 → 唯一解是升到 stable ≥ 1.85。

2. **本次重写的真正缺口有 4 处**，其余模块质量已经很高：
   - CLI **完全没有 `--` 透传**（用户诉求「原样透传未知参数」零实现）；
   - **stderr 不落盘**（`launch.rs:328` 给 stderr 泵传了 `None`）；
   - `HostError` 与 `FailureCause` **两套错误体系割裂、无退出码映射**；
   - 三个契约常量**定义了但从未被使用**：`LOG_STARTING_MARKER`、`APP_LOG_FILE` / `app_log_path`、`ProbeConfig::probe_timeout`（`launch.rs:352` 硬编码 800ms）。

3. **GUI 兼容面比清单说的更宽松**：`RunningHarness.logs` 字段在 `src-tauri` 中**零引用**（只在 `dsh-host-cli/src/main.rs` 用），是唯一可以安全改形状的公开字段；其余公开项一律只增不改即可零改动通过。

---

## 1. 现状评估（优点 / 缺陷，带证据）

### 1.1 优点（这些不要动）

| 项 | 证据 | 评价 |
|---|---|---|
| INV-4 契约集中 | `contracts.rs:1-283`，每个常量带 `CX —` 前缀注释 | 做得好，是全仓库最有价值的资产 |
| 纯函数化 + 注入式测试 | `readiness.rs:196` `wait_for_ready` 把 probe/alive/token/port_in_use 全部闭包注入 | 无网络无子进程即可覆盖 C4 全部分支 |
| 手写 HTTP/1.0 探测 | `readiness.rs:105` | 不引 reqwest/hyper，符合 INV-5，正确取舍 |
| 平台孤儿防护双机制 | `process.rs:214-282`（Job Object / PDEATHSIG / 进程组） | INV-3 落地扎实 |
| 所有权拆分 | `process.rs:126` `into_parts()` | 把管道/Child/Job 拆给三个 owner，规避借用冲突，设计干净 |
| 编码容错 | `logs.rs:216` `sanitize_line` UTF-8 → GBK 回退 → 去 ANSI → 按字符边界截断 | 中文 Windows 控制台的实战经验，别删 |
| 失败归因优先级链 | `logs.rs:406` | C7 语义正确 |

### 1.2 缺陷清单

#### A. 参数解析与转发（缺口最大）

| # | 缺陷 | 证据 | 影响 |
|---|---|---|---|
| A1 | **CLI 无 `--` 透传语义**，用户无法把任意参数交给底层 dsh | `main.rs:31-66` 四个子命令的参数全部是固定命名字段，无 `trailing_var_arg` / `allow_hyphen_values` | 用户诉求「透传」完全未实现 |
| A2 | `start` 只有 `--resource/--data/--timeout`，无 `--port`/`--host`/`--env` 覆盖 | `main.rs:34-43` | 排障时无法固定端口复现 |
| A3 | `Probe` 默认端口 `4173` 是魔数，`contracts.rs` 里没有 `DEFAULT_PROBE_PORT` | `main.rs:61` | **INV-4 违规** |
| A4 | `apply_mock_if_requested` 只在 `start` 调用（`main.rs:89`），`status` 不调用 → status 报告的「资源齐备」与实际启动路径不一致 | `main.rs:215` vs `main.rs:148` | 排障误导 |
| A5 | `tail` 用 `Layout::resolve(PathBuf::from("."), &data)` 硬编码 `.` 当资源目录 | `main.rs:175` | 能跑是巧合（只读 `log_path`），语义是 hack |
| A6 | `Cargo.toml` 描述写 `start / stop / status / tail`，但**没有 `stop` 子命令** | `crates/dsh-host-cli/Cargo.toml:8` | 文档与实现不一致 |
| A7 | 无退出码规范：`main` 返回 `Box<dyn Error>`，失败 `exit(1)`（`main.rs:141`）、资源缺失 `exit(2)`（`main.rs:169`），无映射表 | — | 脚本/CI 无法区分失败类型 |
| A8 | **无 `--print-argv` / dry-run**，无法验证「宿主拼的 argv 与直接跑 dsh 一致」 | — | 透传诉求缺验收抓手 |

#### B. 错误处理

| # | 缺陷 | 证据 |
|---|---|---|
| B1 | `HostError` 只有 8 个变体且全是 IO 类；没有 `ReadyTimeout`/`TokenNotFound`/`PortInUse`/`ProcessExited`/`LogIo` | `error.rs:7-35` |
| B2 | `HostError` 与 `FailureCause` **无任何转换函数**，两套体系割裂 | `error.rs` 全文无 `FailureCause`；`logs.rs:296` 另起炉灶 |
| B3 | `HostError` 无 `exit_code()`，CLI 只能靠 `Box<dyn Error>` 兜底 | `error.rs:40-45` 只有 `missing()` 一个构造器 |
| B4 | `launch()` 把「可预期失败」包成 `Ok(LaunchOutcome::Failed)`，导致 `state.rs:178` 把 `Ok(Failed)` 与 `Err(_)` 同等对待，语义模糊 | `launch.rs:277/444` vs `state.rs:178` |
| B5 | `FailureCause::SpawnFailed` 只存 `error.to_string()`，丢掉 `io::Error::raw_os_error()` | `launch.rs:278-281` |
| B6 | **`ProbeConfig::probe_timeout` 是死字段**：`launch.rs:352` 硬编码 `Duration::from_millis(800)`，配置完全没生效 | `launch.rs:349-353` vs `readiness.rs:29` |

#### C. 日志

| # | 缺陷 | 证据 |
|---|---|---|
| C1 | **stderr 不落盘**：只有 stdout 泵拿到 `log_file`，stderr 传 `None` | `launch.rs:320-328`。排障最关键的错误行进不了 `harness.log`，`tail` 读不到 |
| C2 | `app_log_path` / `APP_LOG_FILE` 定义了但**无人写入** | `contracts.rs:167-168`、`paths.rs:66,107`；`grep -rn app_log_path` 全仓库只有定义与测试 |
| C3 | `LOG_STARTING_MARKER = "[desktop] starting"` 定义了但**从未使用**；实现用的是硬编码 `text.starts_with("starting")` | `contracts.rs:123` vs `logs.rs:171`。**INV-4 违规**，两者一旦漂移归因就静默失效 |
| C4 | 无日志级别概念，CLI 无法 `--log-level` 过滤 | `logs.rs:29-39` 只有 `LogSource` 三值 |
| C5 | 就绪后 `abort()` 掉两个日志泵 → **Ready 之后 harness 的后续输出完全丢失** | `launch.rs:384-386` |
| C6 | 停止/清扫路径里有多处裸魔数：`Duration::from_secs(2)` ×2、`from_millis(200)`、`from_millis(300)`、`from_millis(50)` | `stop.rs:83,108`；`process.rs:400,422`；`launch.rs:384`。**全部 INV-4 违规** |

#### D. 就绪与端口

| # | 缺陷 | 证据 |
|---|---|---|
| D1 | `token_known` / `port_in_use` 闭包用 `try_lock()`，锁竞争时返回 `false` → 高负载下「token 已抓到却被判定未知」，就绪被无谓推迟 | `launch.rs:365-378` |
| D2 | 端口冲突重试**无退避**，三次尝试背靠背立即发起 | `launch.rs:414-425`（`continue` 前没有 sleep），退避时长在 `contracts.rs` 中无常量 |
| D3 | `PortMode::Reserved` 下若 stdout 自报端口与预留端口不一致（dsh 自己换了端口），**静默采用 stdout 端口，不记 warning** | `launch.rs:339-345` |

#### E. 测试与验证

| # | 缺陷 | 证据 |
|---|---|---|
| E1 | **无 `tests/` 集成测试目录**，只有单元测试 + doctest；没有基于 `mock-harness.mjs` 的端到端测试 | `ls crates/dsh-host` 无 `tests/` |
| E2 | `stop.rs` 的测试依赖系统 node，找不到就 `[skip]` 静默跳过 → 无 node 环境下 C6 停止语义**零覆盖** | `stop.rs:191,201,219` |
| E3 | `probe_status` 无真实网络测试 | `readiness.rs:240-386` 全是纯函数 |
| E4 | `launch.rs` 只有 1 个负例测试（`missing_resources`），happy path 完全没测 | `launch.rs:538-620` |
| E5 | **`fault-inject.mjs` 依赖 300MB 资源包**：从 `src-tauri/resources/node/node.exe` 拷 node，而该目录**当前不存在** → 故障注入在干净机器上直接以 exit 2 退出，与 INV-6 冲突 | `fault-inject.mjs:78` + `:239` |
| E6 | **fault-inject 场景 A 的实现是坏的**：`Stop-Process -Id ${process.exitCode ?? 0}` —— `process.exitCode` 是 Node 自己的退出码（`null → 0`），`Stop-Process -Id 0` 必然失败，整个 A 场景从未真正验证「正常退出」 | `fault-inject.mjs:139-147` |
| E7 | CI 只有 `cargo test --workspace`（会拉起 24 分钟级的 src-tauri 编译），**没有 `cargo test -p dsh-host -p dsh-host-cli` 的快门禁** | `.github/workflows/ci.yml` |
| E8 | 阶段 1 验证记录（原 `docs/verification-phase1.md`，已在文档清理中移除）的自动化验证表全部标 ✅，但**当前 `target/` 目录不存在**，说明本 checkout 从未真正跑过；归档文档中的「75 单测 + 19 doctest 全过」需重新验证 | 实测 |

#### F. 契约与文档

| # | 缺陷 | 证据 |
|---|---|---|
| F1 | `contracts.rs:63` 注释说诊断行是 `[arness-node]`，实际 `build/harness-node-entry.mjs:29` 输出的是 **`[harness-node]`**（有 h）。不改变正则行为，但会误导后来人 | `contracts.rs:61-63` vs `build/harness-node-entry.mjs:29` |
| F2 | 契约表列到 C9 与 C12，**C10 / C11 在全仓库无任何痕迹** | 计划原文不在仓库 |
| F3 | `PORT_ZERO_SUPPORTED = false` 是 Spike 回填位，但 Spike 结论模板（原 `docs/spike-webview-results.md`，已在文档清理中移除）始终未被回填 | `contracts.rs:84-90` |

---

## 2. 目标架构（模块职责表）

| 模块 | 职责 | 对应契约 | 是否变更 |
|---|---|---|---|
| `contracts` | 消费 DSH 未文档化行为的**唯一**常量/阈值存放地 | §4 全表 | **增量**：修 3 处注释漂移，新增约 12 个常量 |
| `error` | 统一错误 + 退出码 + 与 `FailureCause` 双向映射 | — | **重写**（变体只增不改） |
| `paths` | 资源 / userData 布局，INV-1 唯一实现点 | C8 | 增量：`ensure_dirs` 显式建 logs 目录 |
| `env` | 子进程环境组装 | C2 | 增量：新增 `harness_env_with_overrides`（3 参 `harness_env` 保留委托） |
| `logs` | 环形缓冲 / 滚动落盘 / 失败归因 / **新增日志级别** | C7 | 增量：`LogLevel`、`push_with`、`latest_attempt` 改用 `LOG_STARTING_MARKER` |
| `token` | stdout URL 与 token 解析 | C3 / C5 | **不变** |
| `readiness` | HTTP/1.0 探测与稳定窗 | C4 | 增量：新增端口不一致 warning 辅助函数 |
| `process` | 派生 / 平台孤儿防护 / 清扫 | C1、INV-3 | 增量：`build_harness_arguments` 委托到 `args`；新增 `spawn_with_args` |
| `stop` | SIGTERM → 4s → SIGKILL | C6 | 增量：魔数抽到 `contracts` |
| `launch` | 编排 spawn → 日志泵 → token → 就绪 → 停止 | C1–C7 | **重写** |
| **`args`（新增）** | argv / env 的构造、校验、透传分流、`--print-argv` 快照 | C1 / C2 | **新增** |
| **`logging`（新增）** | 宿主日志（`app.log`）落盘门面 + 级别过滤 | C7 | **新增** |
| `lib` | 模块表与 re-export | — | 增量 |
| **`tests/`（新增）** | 基于 `mock-harness.mjs` 的端到端集成测试 | C1–C7 | **新增** |

CLI：

| 文件 | 职责 | 变更 |
|---|---|---|
| `src/main.rs` | 门面：解析 → 分发 → 退出码 | **重写**（缩到约 80 行） |
| `src/cli.rs` | clap 定义 + `--` 透传语义 | **新增** |
| `src/commands/mod.rs` | 子命令聚合 + 退出码统一出口 | **新增** |
| `src/commands/start.rs` | `start` / `stop` 生命周期 | **新增** |
| `src/commands/inspect.rs` | `status` / `probe` / `tail` | **新增** |
| `src/commands/doctor.rs` | 环境自检（node / 资源 / 日志 / 端口 / pidfile） | **新增** |

---

## 3. 关键设计决策

### 3.1 工具链与 MSRV —— 结论：升级到 stable ≥ 1.85，workspace `rust-version` 从 1.77 上调到 1.85

| 工具链 | 结果 |
|---|---|
| stable `1.76.0` | ❌ `feature edition2024 is required`（`idna_adapter 1.2.2`，`url 2.5.8` 的传递依赖） |
| nightly `1.79.0-nightly (2024-03-18)` | ❌ 同样 < 1.85，`edition2024` 未稳定 |
| `rust-version = "1.77"` + cargo 1.76 | ❌ `error: package ... requires rustc 1.77 or newer, while the currently active rustc version is 1.76.0` |

依赖 MSRV 实测（从本地 cargo index cache 解析 `rust_version` 字段）：

| crate（Cargo.lock 锁定版） | MSRV | 是否满足 1.76 |
|---|---|---|
| `clap 4.6.6` / `clap_builder 4.6.6` | **1.85**（且 edition 2024） | ❌ |
| `windows-sys 0.61.2` | 1.71 | ✅ |
| `tokio 1.53.1` | 1.71 | ✅ |
| `regex 1.13.1` | 1.65 | ✅ |
| `serde 1.0.229` | 1.56 | ✅ |
| `thiserror 1.0.69` | 1.61 | ✅ |
| `url 2.5.8` | 1.63 | ✅ |
| `winreg 0.55.0` | 1.60 | ✅ |
| `libc 0.2.189` | 1.65 | ✅ |
| `win32job 1.0.4` | （未声明） | ✅ |

**理由**：阻塞点是**传递依赖的 edition**，不是我们自己写的 `rust-version`，所以降 `rust-version` 与换 nightly 都是伪选项。想保 1.76 需要同时降级 `url`（避开 `idna_adapter`）**和** `clap 4.6 → ~4.5`，并重新生成 `Cargo.lock` —— 对 600 个锁定版本的连锁改动，风险远大于升级工具链，且会让本地与 CI（`dtolnay/rust-toolchain@stable`）永久漂移。

**落地步骤**：

```bash
rustup toolchain install stable      # 或 rustup update stable
rustup default stable
rustc -V                             # 断言 >= 1.85
```

- **不写 `rust-toolchain.toml`**：CI 与各开发者机器的 stable 版本本就漂移，写死反而制造分歧；改用 `rust-version = "1.85"` 作为**下界声明**，让老工具链给出清晰报错而不是诡异的 `edition2024` 错误。
- `windows-sys 0.61` 等全部依赖的 MSRV 都 ≤ 1.71，升级 stable 无副作用。

### 3.2 CLI 参数解析结构

**方案：显式两段式 —— 宿主选项用 `--opt`，透传段用 `--` 分隔，追加在契约参数之后。**

```rust
// crates/dsh-host-cli/src/cli.rs
#[derive(Parser, Debug)]
#[command(name = "dsh-host-cli", version, about = "Headless Harness host runner")]
pub struct Cli {
    /// 全局：日志级别（error|warn|info|debug），默认 info
    #[arg(long, global = true, default_value = "info")]
    pub log_level: LogLevelArg,
    /// 全局：JSON 输出（供 fault-inject / CI 断言）
    #[arg(long, global = true)]
    pub json: bool,
    #[command(subcommand)]
    pub command: Commands,
}

pub struct StartArgs {
    #[arg(long)] pub resource: PathBuf,
    #[arg(long)] pub data: PathBuf,
    #[arg(long)] pub timeout: Option<u64>,          // 秒，默认取 contracts::startup_timeout()
    #[arg(long)] pub port: Option<u16>,             // 省略 → 预留；0 → Ephemeral
    #[arg(long)] pub host: Option<String>,          // 默认 contracts::HARNESS_HOST
    #[arg(long, value_name = "K=V")] pub env: Vec<String>,   // 覆盖 C2 契约 env
    #[arg(long)] pub no_open: bool,                 // 默认 true（C1），--open 反向
    #[arg(long)] pub mock: bool,                    // 替代 DSH_MOCK=1（环境变量仍兼容）
    #[arg(long)] pub print_argv: bool,              // dry-run：打印 program/args/cwd/env_delta
    #[arg(long)] pub hold: bool,                    // 就绪后保持前台（默认），--no-hold 就绪即退出
    /// `--` 之后的全部内容原样透传给底层 dsh
    #[arg(last = true, allow_hyphen_values = true)]
    pub dsh_args: Vec<String>,
}
```

**用法语义**：

```bash
dsh-host-cli start --resource R --data D --timeout 30 -- --profile my-profile --verbose
# → node --expose-internals <entry> <bin.js> web --patch P --no-open --host 127.0.0.1 --port N \
#        --profile my-profile --verbose
```

**被否决的备选**：

| 备选 | 否决理由 |
|---|---|
| `allow_external_subcommands` + `Vec<OsString>` | 把顶层未知 token 当子命令，语义错位（透传应作用于 `start` 之后）；且会吞掉拼错的子命令名 |
| 不分隔，靠「已知集合」过滤未知参数 | `--typo` 会被静默当透传给 dsh，用户拿不到拼写错误反馈 |
| 环境变量透传 `DSH_ARGS="..."` | 不可组合、不可调试、Windows/POSIX 引号语义分裂 |

**冲突处理原则**：透传段若含 `--host/--port/--patch/--no-open`，**不报错**，只记一条 warn：
`[desktop] WARN  passthrough overrides contract arg: --port`。
理由：dsh 的参数语义由 dsh 自己（yargs）定义，宿主不应重复实现它的校验；宿主的责任是「忠实转发 + 可观测」，不是「替它仲裁」。

**`--print-argv` 输出（JSON，供逐字节对照与 CI 断言）**：

```json
{
  "program": "D:\\...\\resources\\node\\node.exe",
  "args": ["--expose-internals", "...harness-node-entry.mjs", "...bin.js",
           "web", "--patch", "...", "--no-open", "--host", "127.0.0.1",
           "--port", "4173", "--profile", "my-profile", "--verbose"],
  "cwd": "...\\launch-root",
  "env_delta": { "DSH_HOME": "...", "NO_COLOR": "1", "FORCE_COLOR": "0", "PATH": "..." }
}
```

`env_delta` **只列 C2 契约项 + 覆盖项 + PATH**，不 dump 全部环境（避免把宿主进程的密钥/token 写进日志与 CI 输出）。

### 3.3 argv 与 env 的构造与转发规则

新增 `crates/dsh-host/src/args.rs`：

```rust
/// C1 的完整 argv 构造（含用户透传）。
pub struct HarnessArgs {
    pub layout: Layout,
    pub port: u16,                 // 0 = Ephemeral
    pub host: String,              // 默认 contracts::HARNESS_HOST
    pub no_open: bool,             // 默认 true
    pub extra: Vec<String>,        // 用户 `--` 透传段
}

impl HarnessArgs {
    /// 与既有行为逐字节等价的默认构造。
    pub fn default_for(layout: Layout, port: u16) -> Self;
    /// C1：传给 <dsh>/lib/bin.js 的参数（web --patch --no-open --host --port <extra>）
    pub fn dsh_arguments(&self) -> Vec<String>;
    /// C1：完整 node argv（--expose-internals <entry> <bin.js> + dsh_arguments）
    pub fn node_arguments(&self) -> Vec<String>;
    /// 供 --print-argv：不落盘的纯数据快照
    pub fn argv_snapshot(&self) -> ArgvSnapshot;   // { program, args, cwd }
}

/// C2 的 env 覆盖项解析（"K=V"，按第一个 '=' 切分）。
pub fn parse_env_overrides(pairs: &[String]) -> HostResult<Vec<(String, String)>>;
```

**顺序规则（关键，决定了与 dsh 行为一致）**：

```text
[node 自身] --expose-internals <node_entry> <dsh_entry>
[契约固定]  web --patch <P> --no-open --host <H> --port <N>
[用户透传]  <extra...>
```

透传**放在最后** → yargs 的「后者胜」语义让 `-- --port 5000` 能覆盖宿主的 `--port N`，与「直接跑 dsh 并手工加 `--port`」的结果一致。

**行为一致性护栏（硬要求）**：
- `process::build_harness_arguments(layout, port)` / `build_node_arguments(layout, port)` **签名与输出完全不变**，改为委托 `HarnessArgs::default_for(...)`。
- 新增回归测试 `args::tests::matches_legacy_argv`：对新旧两条路径的输出做 `assert_eq!`，确保 GUI 走的老路径零行为变化。

**env 规则**：
- `harness_env(layout, shell, inherited_path)` **3 参签名保留**，内部委托给新的 `harness_env_with_overrides(layout, shell, inherited_path, &[])`。
- 覆盖项在 C2 契约项**之后**写入，因此 `--env NO_COLOR=0` 能覆盖契约值；覆盖 PATH 时走 `merge_path` 而非整体替换（避免把系统 PATH 冲掉）。
- 每次覆盖记一条 `[desktop] WARN  env override: NO_COLOR`。

### 3.4 错误分类体系

`error.rs` **重写**（变体只增不改，`MissingResource` 保持 `(&'static str, PathBuf)`）：

```rust
#[derive(Debug, thiserror::Error)]
pub enum HostError {
    // —— 原有 8 个，签名一字不改 ——
    MissingResource(&'static str, PathBuf),
    CreateDir(PathBuf, std::io::Error),
    Spawn(std::io::Error),
    Port(std::io::Error),
    ProcessGuard(String),
    Environment(String),
    InvalidArgument(String),

    // —— 新增 ——
    /// 落盘日志打开/写入失败（不致命，降级为内存日志）。
    LogIo(PathBuf, std::io::Error),
    /// C4 就绪超时。
    ReadyTimeout { seconds: u64 },
    /// C3 超时前未抓到 token 行。
    TokenNotFound,
    /// 就绪前子进程退出。
    ProcessExited { code: Option<i32> },
    /// 端口冲突且重试耗尽。
    PortInUse { port: u16, attempts: usize },
    /// 兜底：把结构化归因包成错误。
    HarnessFailed(FailureCause),
}

impl HostError {
    /// CLI 退出码（映射表在 contracts::EXIT_*）。
    pub fn exit_code(&self) -> i32;
    /// 统一降级为前端可消费的结构化归因。
    pub fn to_failure_cause(&self) -> FailureCause;
}
impl From<FailureCause> for HostError;
```

**退出码映射（常量进 `contracts.rs`，INV-4）**：

| 常量 | 值 | 触发 |
|---|---|---|
| `EXIT_OK` | 0 | 成功 |
| `EXIT_UNEXPECTED` | 1 | 兜底 / `Box<dyn Error>` |
| `EXIT_USAGE` | 2 | clap 参数错误、`InvalidArgument` |
| `EXIT_MISSING_RESOURCE` | 3 | `MissingResource`、doctor 有 FAIL 项 |
| `EXIT_SPAWN_FAILED` | 4 | `Spawn` / `ProcessGuard` |
| `EXIT_TOKEN_NOT_FOUND` | 5 | `TokenNotFound` |
| `EXIT_READY_TIMEOUT` | 6 | `ReadyTimeout` |
| `EXIT_PORT_IN_USE` | 7 | `PortInUse` |
| `EXIT_HARNESS_FAILED` | 8 | `HarnessFailed(_)` / `ProcessExited` |

**双轨结果 API（解决 B4 语义模糊，同时不破坏 GUI）**：

```rust
impl Launcher {
    /// GUI / 既有调用点：语义不变。
    pub async fn launch<E: FnMut(LaunchEvent)>(&self, shell: Option<&HarnessEnv>, on_event: E)
        -> HostResult<LaunchOutcome>;

    /// CLI / 测试：成功即 Ready，失败即 Err（含归因）。
    pub async fn run<E: FnMut(LaunchEvent)>(&self, shell: Option<&HarnessEnv>, on_event: E)
        -> HostResult<RunningHarness>;
}
```

`launch()` 内部调用 `run()` 再做一次折叠，**单一实现源**。GUI 零改动。

**被否决的备选**：直接把 `launch()` 改成返回 `HostResult<RunningHarness>` —— 会破坏 `src-tauri/src/state.rs:158-181` 的 `Ok(LaunchOutcome::Ready/Failed)` 两分支匹配，代价是改 GUI，超出本次范围。

### 3.5 日志体系（零新增依赖）

**决策：不引入 `tracing` / `log`。** 理由：① dsh-host 是库，不应强制全局 subscriber/sink；② INV-6 要求无 GUI 依赖、最小依赖面；③ 需求只是「分级 + 落盘 + 过滤」，20 行代码就够。

**分级不侵入 `LogLine` 结构（关键取舍）**：`LogLine` 是 GUI 依赖的公开结构（`state.rs:255`、`state.rs:362`），加字段会破坏 `LogLine::new(source, text)` 两参构造与 serde 形状。

→ **级别用文本前缀承载**：

```rust
// logs.rs 新增
pub enum LogLevel { Error, Warn, Info, Debug }   // Display → "ERROR"/"WARN "/"INFO "/"DEBUG"
impl LogRing {
    /// 现有 push / push_desktop 语义不变（默认 Info，输出无级别前缀）。
    pub fn push_with(&mut self, level: LogLevel, source: LogSource, text: impl Into<String>);
}
```

渲染结果：`[desktop] WARN  passthrough overrides contract arg: --port`
→ `LogLine::parse()`、`Display`、`latest_attempt()`、GUI 的 `logs.tail(200)` **全部零改动**。

**落盘分工**：

| 文件 | 内容 | 修复项 |
|---|---|---|
| `<data>/logs/harness.log` | 子进程 stdout **+ stderr**（滚动 5MB × 3） | 修 C1：两个泵都传 `log_file` |
| `<data>/logs/app.log` | 宿主自身诊断行（带级别前缀） | 修 C2：新增 `logging::AppLog` 写入器 |

**新增强化（C5 的修复）**：
- 就绪后**不再 abort 日志泵**，改为让它们随 `RunningHarness` 生命周期继续运行。
- `RunningHarness` **新增**字段 `pub live_logs: Arc<Mutex<LogRing>>` + `pub fn live_tail(&self, n: usize) -> Vec<String>`。
- 原 `pub logs: LogRing` **保留**（就绪时刻快照，语义不变）。安全依据：`grep -rn "\.logs" src-tauri/src/state.rs` 只命中 `inner.logs`（监督者自己的 ring），`RunningHarness.logs` 在 GUI 层**零引用**。

**CLI 侧**：`--log-level` 只过滤 stdout 输出，**落盘始终全量**（排障时不能因为级别过滤丢证据）。

### 3.6 端口策略

- **保留** `PortMode` 双模式与 `PORT_ZERO_SUPPORTED` 回填位，**不改默认值**（仍 `false` / `Reserved`）。
- **回填位处理原则：不臆测 Spike 结果。** 本次**不执行 Spike**，只提供工具位：
  - CLI 新增 `--port-mode reserved|ephemeral`，让工程师能手动试验 `--port 0`。
  - `contracts.rs` 新增 `PORT_ZERO_EVIDENCE: Option<&'static str>`（记录 Spike 结论来源与日期），`PORT_ZERO_SUPPORTED` 只有在 DSH 官方确认支持 `--port 0` 的结论来源与日期写入 `PORT_ZERO_EVIDENCE` 后才能改为 `true`。
  - 新增单测 `launch::tests::ephemeral_mode_sends_port_zero`，保证开关真的接到了 argv。
- **新增契约常量**（消除裸魔数）：

  ```text
  PORT_RETRY_BACKOFF: Duration = 200ms   // 端口冲突重试退避（修 D2）
  EXIT_REAP_TIMEOUT: Duration = 2s       // 失败路径等待子进程退出的上限
  LOG_PUMP_DRAIN_DELAY: Duration = 50ms  // 就绪后等日志泵收尾
  STOP_KILL_DELAY: Duration = 2s         // stop.rs 强杀后等待（原魔数）
  SWEEP_REAP_DELAY: Duration = 200ms     // process.rs:400（原魔数）
  SWEEP_KILL_DELAY: Duration = 300ms     // process.rs:422（原魔数）
  DEFAULT_PROBE_PORT: u16 = 4173         // 修 A3
  PROBE_TIMEOUT: Duration = 800ms        // 修 B6，作为 ProbeConfig::probe_timeout 的默认值
  ```

- **端口不一致处理（修 D3）**：`Reserved` 模式下若 stdout 自报端口 ≠ 预留端口，记 `[desktop] WARN  port mismatch: reserved {A}, reported {B}`，**以 stdout 为准**（那是 dsh 自报的事实），不失败。

### 3.7 测试策略（三层）

**第 1 层 — 单元测试**（现状保留，模块内 `#[cfg(test)]`）：纯函数、无 IO。

**第 2 层 — 集成测试（本次新增，`crates/dsh-host/tests/`）**：

```rust
// tests/fixture/mod.rs —— 无资源包即可跑（INV-6）
pub struct MockFixture { pub layout: Layout, pub data_dir: TempDir }
pub fn fixture() -> Option<MockFixture>;   // 找不到系统 node → None → 调用方 skip
```

构造方式（**关键**：不需要 300MB 依赖树）：
- `node_executable` ← 系统 node（`which node` / `where node`）
- `node_entry` ← `concat!(env!("CARGO_MANIFEST_DIR"), "/../../scripts/mock-harness.mjs")`
- `dsh_entry` ← 同上（mock 会忽略这两个位置参数）
- `patch` ← `build/dsh-desktop.patch.yml`
- `app_data_dir` ← 自建临时目录（`std::env::temp_dir()` + pid + nanos）

| 文件 | 覆盖 |
|---|---|
| `tests/args_forwarding.rs` | `HarnessArgs` 与 legacy `build_node_arguments` 逐项相等；`--port 0`；env 覆盖不污染 PATH |
| `tests/mock_launch.rs` | happy path；`--fail startup` → `dsh_entry_failed`；`--fail no-url` → `startup_timeout`；`--fail port-in-use` → 3 次重试后 `port_in_use`；`--fail after-ready` → 就绪后 exit watcher 兑现 |
| `tests/mock_lifecycle.rs` | 停止语义 C6：正常退出 / 忽略 SIGTERM 被强杀 / 停止后无孤儿；pidfile 清扫 F |

故障注入手段**优先用 argv 而非环境变量**：`HarnessArgs.extra = vec!["--fail", "startup"]`（`mock-harness.mjs:43` 已支持 `--fail`），不依赖 `DSH_MOCK_FAIL`，可组合、可并行。

**第 3 层 — 故障注入脚本 `scripts/fault-inject.mjs`（本次修复）**：
- **修 E5**：`buildMockResourceDir()` 改用 **`process.execPath`**（脚本本身由 node 运行，保证版本 ≥ 20），不再从 `src-tauri/resources/node/` 拷 node → 无资源包可跑。
- **修 E6**：场景 A 改为 —— Windows `taskkill /PID <pid>`（**不带 `/F`**，先给优雅退出机会，2s 后仍未退再 `/F`）；POSIX `child.kill('SIGINT')`；然后等 CLI 退出并断言孤儿为空。
- 新增：断言 CLI 退出码 == `contracts::EXIT_*` 映射值；`--json` 输出供结构化断言。

**验证命令集**：

```bash
cargo fmt --all -- --check
cargo clippy -p dsh-host -p dsh-host-cli --all-targets -- -D warnings
cargo test  -p dsh-host -p dsh-host-cli
cargo run -q -p dsh-host-cli -- start --print-argv --data <tmp> -- --profile x
node scripts/fault-inject.mjs
```

**GUI 兼容用静态核对，不做全量编译门禁**：

```bash
grep -rn "dsh_host::" src-tauri/src    # 逐项对照调用点清单，确认每个符号仍存在且形状兼容
```

（可选最终确认：`cargo check -p dsh-desktop`。已知耗时 >24 分钟，仅作收尾确认。）

---

## 4. 文件清单

### `crates/dsh-host/`

| 文件 | 变更 | 要做的事 |
|---|---|---|
| `Cargo.toml` | 增量 | `rust-version.workspace = true`（随根上调到 1.85）。**零新增依赖** |
| `src/lib.rs` | 增量 | 模块表补 `args` / `logging`；re-export `pub use args::HarnessArgs;` |
| `src/contracts.rs` | 增量 | ① `EXIT_*` 9 个退出码常量；② 8 个时长/端口常量；③ `LOG_LEVEL_*` 4 个前缀串；④ `MIN_NODE_MAJOR` / `RECOMMENDED_NODE_MAJOR` / `PORT_ZERO_EVIDENCE`；⑤ 修正 `[arness-node]` → `[harness-node]`；⑥ 补 C10/C11 占位说明 |
| `src/error.rs` | **重写** | 变体扩充到 14 个（原 8 个签名不动）；`exit_code()` / `to_failure_cause()` / `From<FailureCause>`；每个新变体带 doctest |
| `src/paths.rs` | 增量 | `ensure_dirs()` 显式创建 logs 目录 |
| `src/env.rs` | 增量 | 新增 `harness_env_with_overrides`；3 参 `harness_env` 内部委托（**签名与输出零变化**） |
| `src/logs.rs` | 增量 | `LogLevel` 枚举 + `LogRing::push_with`；`latest_attempt()` 改用 `LOG_STARTING_MARKER`（修 C3） |
| `src/token.rs` | 不变 | — |
| `src/readiness.rs` | 增量 | `ProbeConfig::probe_timeout` 默认值改为 `contracts::PROBE_TIMEOUT`；新增 `pub fn describe_port_mismatch(reserved, reported) -> String` |
| `src/process.rs` | 增量 | `build_harness_arguments` / `build_node_arguments` 委托到 `args::HarnessArgs`（输出逐字节不变）；新增 `spawn_with_args`；3 处裸魔数改引 `contracts` |
| `src/stop.rs` | 增量 | 2 处 `Duration::from_secs(2)` 改引 `contracts::STOP_KILL_DELAY` |
| `src/launch.rs` | **重写** | ① stderr 泵也传 `log_file`（修 C1）；② 就绪后不 abort 泵，产出 `live_logs`（修 C5）；③ `token_known`/`port_in_use` 改读 `AtomicBool` 快照（修 D1）；④ 重试加 `PORT_RETRY_BACKOFF`（修 D2）；⑤ `probe_status` 改用 `self.config.probe.probe_timeout`（修 B6）；⑥ 端口不一致记 warn（修 D3）；⑦ 新增 `Launcher::with_extra(Vec<String>)`；⑧ 新增 `Launcher::run()`；⑨ `launch()` 改为委托 `run()` |
| `src/args.rs` | **新增** | `HarnessArgs`、`parse_env_overrides`、`ArgvSnapshot` |
| `src/logging.rs` | **新增** | `AppLog`、`init_app_log(&Layout) -> Option<AppLog>` |
| `tests/fixture/mod.rs` | **新增** | 共享 fixture（系统 node + mock-harness） |
| `tests/args_forwarding.rs` | **新增** | argv/env 转发等价性断言 |
| `tests/mock_launch.rs` | **新增** | mock 端到端：happy path + 4 种 `--fail` |
| `tests/mock_lifecycle.rs` | **新增** | 停止语义 C6 + pidfile 清扫 INV-3 |

### `crates/dsh-host-cli/`

| 文件 | 变更 | 要做的事 |
|---|---|---|
| `Cargo.toml` | 增量 | description 修正为实际子命令集合 |
| `src/main.rs` | **重写** | 门面：`Cli::parse()` → 分发 → `std::process::exit(err.exit_code())`。缩到约 80 行 |
| `src/cli.rs` | **新增** | clap 定义 + `--` 透传语义 |
| `src/commands/mod.rs` | **新增** | 子命令模块聚合 + 退出码统一出口 |
| `src/commands/start.rs` | **新增** | `start`（透传 / `--print-argv` / `--env` / `--port-mode` / `--mock` / `--hold`）+ `stop` |
| `src/commands/inspect.rs` | **新增** | `status`（修 A4）+ `probe`（修 A3）+ `tail`（修 A5） |
| `src/commands/doctor.rs` | **新增** | 环境自检：node 版本 / 四必需资源 / MANIFEST / logs 可写 / 端口可用 / pidfile 状态 |

### 仓库其它

| 文件 | 变更 | 要做的事 |
|---|---|---|
| `Cargo.toml`（根） | 增量 | `rust-version = "1.77"` → `"1.85"` |
| `scripts/fault-inject.mjs` | 修改 | 用 `process.execPath` 代替资源目录 node（修 E5）；重写场景 A（修 E6）；加退出码断言；加 `--json` |
| `scripts/mock-harness.mjs` | 增量（P2） | 增加 `--exit-after <ms>` / `--stderr-before-url <msg>`，支撑更细的集成测试 |

---

## 5. 有序任务列表

> 依赖：`T01 → {T02 ∥ T03} → T04 → T05`。T02 与 T03 可并行。

### T01 — 工具链与契约/错误基线

- **涉及文件**：`Cargo.toml`（根）、`crates/dsh-host/src/{contracts.rs, error.rs, lib.rs}`、`crates/dsh-host/Cargo.toml`、`crates/dsh-host-cli/Cargo.toml`
- **依赖**：无
- **要做**：
  1. 升级并切换 stable ≥ 1.85；把根 `rust-version` 从 `1.77` 改为 `1.85`
  2. `contracts.rs` 补齐退出码表、时长常量、默认端口、日志级别前缀、node 版本下限；修 `[arness-node]` 注释漂移
  3. `error.rs` 重写：14 个变体 + `exit_code()` + `to_failure_cause()` + `From<FailureCause>`
  4. `lib.rs` 模块表与 re-export
- **验收（可执行）**：

  ```bash
  rustc -V                                # >= 1.85
  cargo check -p dsh-host -p dsh-host-cli  # 退出码 0（不再有 edition2024 错误）
  cargo test  -p dsh-host -p dsh-host-cli  # 现有 75 单测 + 19 doctest 不回归
  ```

  新增断言：
  - `contracts::tests::exit_codes_are_distinct` —— 9 个 `EXIT_*` 两两不等
  - `error::tests::exit_code_mapping_is_stable` —— 每个变体 → 固定码值表
  - `error::tests::failure_cause_round_trip` —— `HostError → FailureCause → HostError` 的 `kind()` 不变

### T02 — dsh-host 核心增强（日志 / 进程 / 编排）

- **涉及文件**：`src/launch.rs`（重写）、`src/logs.rs`、`src/process.rs`、`src/stop.rs`、`src/paths.rs`、`src/readiness.rs`
- **依赖**：T01
- **要做**：
  1. 修 C1：stderr 泵也传 `log_file`
  2. 修 C3：`latest_attempt()` 改用 `LOG_STARTING_MARKER`
  3. 修 C5：就绪后不 abort 泵，新增 `RunningHarness.live_logs` + `live_tail()`
  4. 修 D1：`token_known` / `port_in_use` 改读 `AtomicBool` 快照
  5. 修 D2 / D3：退避常量 + 端口不一致 warn
  6. 修 B6：`probe_status` 用 `self.config.probe.probe_timeout`
  7. 修 C6 魔数：`stop.rs` / `process.rs` 的 4 处裸 Duration 改引 `contracts`
  8. 新增 `Launcher::run()`；`launch()` 改为委托
- **验收（可执行）**：

  ```bash
  cargo test -p dsh-host
  cargo clippy -p dsh-host --all-targets -- -D warnings
  ```

  具体断言：
  - `launch::tests::stderr_is_persisted_to_log_file` —— 跑一次 `--fail startup`，读 `<data>/logs/harness.log` 必须含 `[stderr] DSH entry failed:`
  - `logs::tests::latest_attempt_uses_contract_marker` —— 改常量后测试仍绿（防漂移）
  - `launch::tests::probe_timeout_comes_from_config` —— 把 `probe_timeout` 设成 1ms，断言探测立即返回
  - `launch::tests::live_logs_grow_after_ready` —— 就绪后 mock 再输出一行，`live_tail(10)` 能读到

### T03 — 参数转发层（`args.rs` / `logging.rs` / `env.rs`）

- **涉及文件**：**新增** `src/args.rs`、`src/logging.rs`；改 `src/env.rs`、`src/process.rs`、`src/lib.rs`、`src/contracts.rs`
- **依赖**：T01（**与 T02 可并行**）
- **要做**：
  1. `args.rs`：`HarnessArgs`（`default_for` / `dsh_arguments` / `node_arguments` / `argv_snapshot`）、`parse_env_overrides`
  2. `process.rs`：`build_harness_arguments` / `build_node_arguments` 委托到 `args`（**输出逐字节不变**）；新增 `spawn_with_args`
  3. `env.rs`：新增 `harness_env_with_overrides`；3 参 `harness_env` 委托
  4. `logging.rs`：`LogLevel` 过滤 + `AppLog`（写 `app.log`）
- **验收（可执行）**：

  ```bash
  cargo test -p dsh-host
  cargo clippy -p dsh-host --all-targets -- -D warnings
  ```

  具体断言：
  - `args::tests::matches_legacy_argv` —— `HarnessArgs::default_for(layout,1234).dsh_arguments()` **逐项相等**于 `build_harness_arguments(&layout,1234)`（最关键回归护栏）
  - `args::tests::ephemeral_mode_sends_port_zero` —— `port=0` 时末尾为 `--port 0`
  - `args::tests::extra_args_are_appended_last` —— `extra=["--profile","x"]` 落在 `--port N` 之后
  - `args::tests::env_override_does_not_clobber_path` —— `--env PATH=/x` 走 `merge_path` 而非整体替换
  - `logging::tests::app_log_writes_level_prefix` —— `[desktop] WARN  ...` 出现在 `app.log`
  - `env::tests::overrides_win_over_contract_values` —— `--env NO_COLOR=0` 后 `env.get("NO_COLOR") == Some("0")`

### T04 — CLI 重写（透传 + 子命令 + 退出码）

- **涉及文件**：`crates/dsh-host-cli/src/main.rs`（重写）、**新增** `src/cli.rs`、`src/commands/{mod,start,inspect,doctor}.rs`
- **依赖**：T02、T03
- **要做**：
  1. `cli.rs`：clap 定义 + `--` 透传（`last = true` + `allow_hyphen_values`）
  2. `start.rs`：`start`（透传 / `--print-argv` / `--env` / `--port-mode` / `--mock` / `--hold`）+ **`stop`**（补 A6）
  3. `inspect.rs`：`status`（修 A4，感知 mock）、`probe`（修 A3）、`tail`（修 A5）
  4. `doctor.rs`：环境自检
  5. `main.rs`：退出码统一出口（修 A7），`DSH_MOCK=1` 环境变量保持兼容
- **验收（可执行）**：

  ```bash
  cargo run -q -p dsh-host-cli -- start --print-argv --data <tmp> -- --profile x
  #   → JSON 的 args 前部必须逐项等于 build_node_arguments 的输出，尾部为 ["--profile","x"]
  cargo run -q -p dsh-host-cli -- probe --port 9      # 退出码 1，stderr 含 unreachable
  cargo run -q -p dsh-host-cli -- status --resource X --data Y   # 资源缺失 → 退出码 3
  cargo run -q -p dsh-host-cli -- doctor --resource X --data Y   # PASS/WARN/FAIL 表
  cargo run -q -p dsh-host-cli -- start --data <tmp> --mock -- --fail startup
  #   → 退出码 8，stderr 含 "dsh_entry_failed"
  cargo test -p dsh-host-cli
  ```

  具体断言：
  - `commands::tests::exit_code_table` —— 每个 `FailureCause::kind()` → 唯一退出码
  - `cli::tests::passthrough_after_double_dash` —— `["--profile","x","--verbose"]` 原样进入 `dsh_args`
  - `cli::tests::unknown_host_option_is_rejected` —— `--typo` 报 clap 错误（退出码 2），**不**被吞进透传

### T05 — 测试与验证补齐（集成测试 + fault-inject + 文档）

- **涉及文件**：**新增** `crates/dsh-host/tests/{fixture/mod.rs, args_forwarding.rs, mock_launch.rs, mock_lifecycle.rs}`；改 `scripts/fault-inject.mjs`；可选 `scripts/mock-harness.mjs`
- **依赖**：T04
- **要做**：
  1. fixture：系统 node + `scripts/mock-harness.mjs`，无资源包可跑
  2. 四组集成测试
  3. 修 E5：`fault-inject.mjs` 改用 `process.execPath`
  4. 修 E6：重写场景 A（Windows `taskkill` 不带 `/F` → 2s 后 `/F`；POSIX `SIGINT`）
  5. 加退出码断言
  6. CI 补快门禁：`cargo test -p dsh-host -p dsh-host-cli` 单独一步（修 E7）
- **验收（可执行）**：

  ```bash
  cargo test -p dsh-host -p dsh-host-cli    # 全绿；有 node 时集成测试不 skip
  cargo build -p dsh-host-cli
  node scripts/fault-inject.mjs              # A/B/C/D/E/F 六项全 PASS，退出码 0
  grep -rn "dsh_host::" src-tauri/src        # 静态核对调用点清单全部仍可解析
  ```

  补充断言：
  - `tests/mock_launch.rs::fail_port_in_use_retries_three_times` —— 日志出现 3 条 `[desktop] starting`，耗时 < 25s
  - `tests/mock_lifecycle.rs::stop_leaves_no_orphan` —— 停止后 `is_process_alive(pid)` 为 false
  - `tests/mock_lifecycle.rs::sweep_clears_dead_pidfile` —— 死记录被清理

---

## 6. 共享知识（跨文件约定）

**错误传播**
- 库内一律 `HostResult<T>`；**库层绝不调用 `std::process::exit`**，退出码只在 CLI 的 `main` 出口使用。
- `Launcher::launch()`（GUI 用）：可预期失败 → `Ok(LaunchOutcome::Failed { cause, logs })`；宿主自身故障（目录创建 / 端口预留 / 环境捕获）→ `Err`。
- `Launcher::run()`（CLI/测试用）：成功即 `Ok(RunningHarness)`，一切失败即 `Err`。两者共享同一实现，`launch()` 委托 `run()`。
- 任何新错误变体必须同时实现 `exit_code()` 与 `to_failure_cause()`，并在 `error::tests::exit_code_mapping_is_stable` 中登记。

**日志**
- 三前缀固定：`[desktop]` / `[stdout]` / `[stderr]`（契约常量，不可改）。
- 级别前缀格式：`[desktop] WARN  <text>`（级别 4 字符 + **两个空格**，便于 `cut -c1-15` 对齐）。
- `LogLine::new(source, text)` 两参构造**永久保留**（GUI 依赖）；级别一律走 `push_with`。
- `harness.log` = 子进程输出（全量）；`app.log` = 宿主诊断（带级别）。两者都 5MB × 3 滚动。
- CLI 的 `--log-level` 只过滤 stdout，**落盘始终全量**。

**命名**
- 测试辅助：单元测试用 `fn <case>_layout(root) -> Layout`；集成测试用 `fn fixture() -> Option<MockFixture>`（找不到 node 返回 `None`，调用方打印 `[skip]` 后 return）。
- 临时目录名：`dsh-host-<case>-<pid>-<nanos>`（沿用 `paths.rs:282` 现状），测试结束 `remove_dir_all`。
- 常量命名：一律 `<领域>_<语义>`，且**必须**带 `/// CX — 说明` 注释。

**平台分支**
- 一律 `#[cfg(windows)]` / `#[cfg(unix)]` 成对，并保留其它 unix 目标兜底（沿用 `process.rs:251`）。
- 不安全块必须紧贴 `unsafe` 且有「为什么安全/已知 race」的注释（沿用 `process.rs:233-235` 风格）。

**文档风格（强制）**
- 每个模块顶部 `//!` 文档 + 契约表格。
- 每个公开项 `///` 文档。
- 每个新公开函数带 `# 示例` doctest；平台相关或需要真实子进程的用 `no_run`。
- 注释用中文。

**测试约定**
- 故障注入优先用 **argv**（`HarnessArgs.extra`），不用环境变量（可组合、可并行）。
- 需要 node 的测试：找不到就 `eprintln!("[skip] …")` 后 return，**不算失败**（沿用 `stop.rs:191`）。
- 集成测试路径用 `concat!(env!("CARGO_MANIFEST_DIR"), "/../../scripts/mock-harness.mjs")`，不用相对路径。

**依赖**
- 新依赖一律走根 `[workspace.dependencies]`，成员 crate 用 `workspace = true`。
- 本次设计**零新增依赖**。`clap` 只用现有 `derive` feature。

---

## 7. 待明确事项 —— 交付总监拍板

| # | 问题 | 裁决 |
|---|---|---|
| 1 | 工具链升级：是否允许 `rustup toolchain install stable` 把 default 从 1.76 升到 ≥1.85？ | **批准**。1.76 与 1.79 都无法构建，无退路 |
| 2 | `HostError::MissingResource` 签名：清单写 `(String, Cow<str>)`，代码是 `(&'static str, PathBuf)` | **按代码现状保持** `(&'static str, PathBuf)`（`src-tauri/src/layout.rs:20` 已依赖） |
| 3 | C10 / C11 契约是什么？全仓库无任何痕迹 | **计划原文不可得**，在 `contracts.rs` 记「未定义」占位，不臆造 |
| 4 | Spike（任务 0.2）是否纳入本次范围？ | **不纳入**。只提供 `--port-mode ephemeral` 工具位 + `PORT_ZERO_EVIDENCE` 字段 |
| 5 | 是否新增 `stop` 子命令？ | **新增**，基于 pidfile（`PidRecord`）+ `terminate_process_tree` |
| 6 | 是否修 `scripts/fault-inject.mjs` 的资源依赖（改用 `process.execPath`）？ | **修**。INV-6 要求无资源包可跑；真 node 验证由 `npm run prepare:harness` 后的手工清单覆盖 |
| 7 | 集成测试可否依赖系统 node？ | **可以**。INV-6 约束的是「无显示器、无资源包」，node 是运行 DSH 的必要条件 |
| 8 | Node 版本下限？ | `MIN_NODE_MAJOR=20`（硬下限，doctor 报 FAIL）、`RECOMMENDED_NODE_MAJOR=24`（WARN） |
| 9 | `cargo check -p dsh-desktop` 是否作为门禁？ | **保持可选**，不设为门禁（已知 >24 分钟） |

---

## 8. 环境事实（实测，供复现）

| 项 | 实测结论 |
|---|---|
| Rust stable | 基线 `1.76.0`；升级目标 ≥ `1.85` |
| nightly | `1.79.0-nightly (2024-03-18)`，同样不可用 |
| Cargo 离线 | **不可用**：本地 registry 缓存缺 `windows-sys` / `win32job` / `winreg`，缓存版本普遍偏旧（`async-trait` 仅 0.1.78，锁文件要 0.1.92） |
| 网络 | `index.crates.io` HTTP 200 / 0.67s，`static.crates.io` 0.59s；国内镜像更慢 → **用默认源** |
| 首次 `Updating crates.io index` | 可能耗时数分钟，第一次 `cargo check` 要给足 10 分钟以上 |
| 真实 dsh 引擎 | **本机不存在**：`node_modules/` 未装、`src-tauri/resources/` 未组装、全局无 `dsh`；npm 上 `@deepseek-ai/dsh` 已漂到 `0.1.2-rc.1`，而 `patches/` 打的是 `0.1.2-alpha.4` |
| `src-tauri` 全量编译 | 历史记录 >24 分钟，不作门禁 |
