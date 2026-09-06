//! # DSH 契约常量（不变量 INV-4）
//!
//! 本章集中存放「消费 DSH 未文档化行为」的全部常量与阈值，对应实施计划 §4
//! 契约清单。任何升级 DSH 的改动都必须先回到这里逐条回归（§4.2 流程），
//! 不允许把魔数散落到其它模块。
//!
//! | 常量 | 契约 | 来源 |
//! |---|---|---|
//! | [`HARNESS_CLI`] | C1 CLI 参数 | `harness-runtime.ts` |
//! | [`ENV_*`] | C2 环境变量 | `harness-runtime.ts` |
//! | [`TOKEN_LINE_PATTERN`] | C3 stdout URL 行 | `harness-node-entry.mjs` 输出 |
//! | [`ProbeConfig::default`] | C4 就绪语义 | `harness-runtime.ts` 轮询参数 |
//! | [`COOKIE_HEADER_LIMIT_HINT`] | C5 鉴权 / Cookie 431 | `window-navigation.ts` |
//! | [`GRACEFUL_STOP_TIMEOUT`] | C6 停止语义 | `harness-runtime.ts` |
//! | [`FAILURE_PATTERNS`] | C7 失败模式 | `extractFailureCause` |
//! | [`DSH_ENTRY_RELATIVE`] 等 | C8 包布局 | `prepare-harness.mjs` |
//! | [`WINDOWS_QUERY_*`] | C12 Windows URL 参数 | `window-navigation.ts` |
//!
//! > **C10 / C11 未定义**：《DSH Desktop Tauri 版实施计划 v2》原文未随本仓库
//! > 提交，C10 / C11 的内容在全仓库（docs / contracts / build / scripts）中均
//! > 无痕迹。此处不做臆造，待计划原文补全后再回填。

use std::time::Duration;

/// C1 — 传给 `<dsh>/lib/bin.js` 的子命令与参数前缀。
pub const HARNESS_CLI: &str = "web";

/// C1 — 桌面窗口是唯一展示面；缺了它 harness 每次启动都会把 URL 交给系统浏览器。
pub const HARNESS_NO_OPEN: &str = "--no-open";

/// C1 / C5 — harness 只监听回环地址，token 也随之只在本机流转。
pub const HARNESS_HOST: &str = "127.0.0.1";

/// C1 — `--expose-internals` 是 Cordis HMR 的前提，只授予本子进程，绝不授予 webview。
pub const NODE_EXPOSE_INTERNALS: &str = "--expose-internals";

/// C2 — Harness 的数据根目录（profiles / sessions / settings / credentials）。
pub const ENV_DSH_HOME: &str = "DSH_HOME";

/// C2 — 关闭彩色输出，避免 ANSI 逃逸序列污染 token 行解析。
pub const ENV_NO_COLOR: &str = "NO_COLOR";

/// C2 — 加固补充：双层关闭彩色（部分 npm 依赖只看 FORCE_COLOR）。
pub const ENV_FORCE_COLOR: &str = "FORCE_COLOR";

/// C2 — 关闭 npm 副作用缓存，避免插件安装写出额外状态。
pub const ENV_NPM_SIDE_EFFECTS_CACHE: &str = "npm_config_side_effects_cache";

/// C2 — 关闭 pnpm 副作用缓存（Harness 用捆绑 pnpm 装 profile 插件）。
pub const ENV_PNPM_SIDE_EFFECTS_CACHE: &str = "PNPM_CONFIG_SIDE_EFFECTS_CACHE";

/// C2 — 加固补充：稳定跨语言控制台输出编码。
pub const ENV_PYTHONIOENCODING: &str = "PYTHONIOENCODING";

/// C2 — 加固补充：source map 让子进程崩溃栈可读。
pub const ENV_NODE_OPTIONS: &str = "NODE_OPTIONS";

/// C2 — Windows 上很多子进程（pnpm/pwsh）依赖 `SystemRoot`。
pub const ENV_SYSTEM_ROOT: &str = "SystemRoot";

/// C2 — Windows PATH 键名在不同来源下大小写不定，统一按不区分大小写处理。
pub const ENV_PATH: &str = "PATH";

/// C3 — stdout 中承载启动 token 的 URL 行正则。
///
/// 注意 `\b` 与 `dsh` 的组合：`harness-node-entry.mjs` 打印的是
/// `[harness-node] …` 诊断行，真正承载 URL 的行以 `dsh web:` 出现。
/// （诊断行前缀以 `[harness-node]` 为准，见 `build/harness-node-entry.mjs`。）
pub const TOKEN_LINE_PATTERN: &str = r"\bdsh web:\s*(\S+)";

/// C3 — 换取 30 天 cookie 的 query 参数名。
pub const TOKEN_QUERY_KEY: &str = "token";

/// C7 — 失败归因：`DSH entry failed:` 一旦出现即可立即判失败，不必等超时。
pub const PATTERN_DSH_ENTRY_FAILED: &str = r"DSH entry failed:\s*(.+)";

/// C7 — 失败归因：未捕获异常。
pub const PATTERN_UNCAUGHT_EXCEPTION: &str = r"uncaught exception:\s*(.+)";

/// C7 — 失败归因：未处理 rejection。
pub const PATTERN_UNHANDLED_REJECTION: &str = r"unhandled rejection:\s*(.+)";

/// 端口策略（任务 1.3）：stderr 里出现 `EADDRINUSE` 立即快速失败并换端口重试。
pub const PATTERN_PORT_IN_USE: &str = "EADDRINUSE";

/// 端口策略：`--port 0` 试验失败后，最多快速重试的次数（含首次共 3 次）。
pub const MAX_PORT_ATTEMPTS: usize = 3;

/// 端口策略：**C1 Spike 结论回填位**（任务 0.2）。
///
/// DSH 是否支持 `--port 0`（让内核分配端口并在 stdout URL 里回报真实端口）。
/// 支持则 `PortMode::Ephemeral` 成为默认，彻底消除「预留→释放→传递」的
/// TOCTOU 窗口。当前默认 `false`：沿用与原仓库一致的预留策略，待 Spike 验证
/// 后连同 `docs/spike-webview-results.md` 一起回填。
pub const PORT_ZERO_SUPPORTED: bool = false;

/// C4 — 健康判据的健康区间下界。
pub const HEALTHY_STATUS_MIN: u16 = 200;

/// C4 — 健康判据的健康区间上界（401 属正常：未带 token 的 `GET /` 会被拒）。
pub const HEALTHY_STATUS_MAX: u16 = 500;

/// C6 — SIGTERM 之后的宽容期，超时即 SIGKILL。
pub const GRACEFUL_STOP_TIMEOUT: Duration = Duration::from_secs(4);

/// C7 — 内存日志环形缓冲容量（对齐原仓库 200 行）。
pub const LOG_RING_CAPACITY: usize = 200;

/// C7 — 单条日志行最大字节数，超出截断（防止一行几十 MB 拖垮环形缓冲）。
pub const LOG_LINE_MAX_BYTES: usize = 8 * 1024;

/// C7 — 落盘日志单文件上限。
pub const LOG_FILE_MAX_BYTES: u64 = 5 * 1024 * 1024;

/// C7 — 落盘日志保留份数（`harness.log`、`harness.log.1`、`harness.log.2`）。
pub const LOG_FILE_MAX_BACKUPS: usize = 3;

/// 日志前缀：宿主自身写入的诊断行。
pub const LOG_PREFIX_DESKTOP: &str = "[desktop]";

/// 日志前缀：子进程 stdout。
pub const LOG_PREFIX_STDOUT: &str = "[stdout]";

/// 日志前缀：子进程 stderr。
pub const LOG_PREFIX_STDERR: &str = "[stderr]";

/// 标记「本次尝试」起点的日志行前缀（`latest_attempt` 用它切片）。
pub const LOG_STARTING_MARKER: &str = "[desktop] starting";

/// 加固补充：ANSI 转义序列清洗正则。
pub const ANSI_ESCAPE_PATTERN: &str = r"\x1B\[[0-9;]*[a-zA-Z]";

/// CLI 退出码 — 成功。
pub const EXIT_OK: i32 = 0;

/// CLI 退出码 — 兜底错误（含 `Box<dyn Error>`）。
pub const EXIT_UNEXPECTED: i32 = 1;

/// CLI 退出码 — 参数用法错误（clap 解析失败 / `InvalidArgument`）。
pub const EXIT_USAGE: i32 = 2;

/// CLI 退出码 — 缺少捆绑资源（`MissingResource` / doctor 有 FAIL 项）。
pub const EXIT_MISSING_RESOURCE: i32 = 3;

/// CLI 退出码 — 无法派生子进程（`Spawn` / `ProcessGuard`）。
pub const EXIT_SPAWN_FAILED: i32 = 4;

/// CLI 退出码 — 超时前未抓到 token 行（C3）。
pub const EXIT_TOKEN_NOT_FOUND: i32 = 5;

/// CLI 退出码 — 超过就绪总超时（C4）。
pub const EXIT_READY_TIMEOUT: i32 = 6;

/// CLI 退出码 — 端口被占用且重试耗尽。
pub const EXIT_PORT_IN_USE: i32 = 7;

/// CLI 退出码 — Harness 自身启动失败 / 就绪前退出（`HarnessFailed` / `ProcessExited`）。
pub const EXIT_HARNESS_FAILED: i32 = 8;

/// 端口冲突重试之间的退避时长（C1 端口策略）。
///
/// 没有退避时三次尝试会背靠背发起，同一瞬间抢占同一端口，重试形同虚设。
pub const PORT_RETRY_BACKOFF: Duration = Duration::from_millis(200);

/// 失败路径上等待子进程退出的上限。
pub const EXIT_REAP_TIMEOUT: Duration = Duration::from_secs(2);

/// 就绪后等日志泵收尾的时长（避免丢掉最后几行）。
pub const LOG_PUMP_DRAIN_DELAY: Duration = Duration::from_millis(50);

/// C6 — 强杀之后等待进程句柄回收的时长。
pub const STOP_KILL_DELAY: Duration = Duration::from_secs(2);

/// INV-3 — 陈旧进程清扫中，请求优雅退出后的等待时长。
pub const SWEEP_REAP_DELAY: Duration = Duration::from_millis(200);

/// INV-3 — 陈旧进程清扫中，优雅退出超时后强杀的等待时长。
pub const SWEEP_KILL_DELAY: Duration = Duration::from_millis(300);

/// C4 — 排障子命令 `probe` 的默认端口（原为散落在 CLI 里的魔数）。
pub const DEFAULT_PROBE_PORT: u16 = 4173;

/// C4 — 单次 HTTP 探测的超时。
///
/// 作为 [`crate::readiness::ProbeConfig::probe_timeout`] 的默认值；
/// 之前在 `launch.rs` 里被硬编码，配置项形同虚设。
pub const PROBE_TIMEOUT: Duration = Duration::from_millis(800);

/// 日志级别前缀 — error。
pub const LOG_LEVEL_ERROR: &str = "ERROR";

/// 日志级别前缀 — warn（补空格凑齐 5 字符，便于按列对齐）。
pub const LOG_LEVEL_WARN: &str = "WARN ";

/// 日志级别前缀 — info（补空格凑齐 5 字符）。
pub const LOG_LEVEL_INFO: &str = "INFO ";

/// 日志级别前缀 — debug。
pub const LOG_LEVEL_DEBUG: &str = "DEBUG";

/// 运行 Harness 所需的最低 Node.js 主版本号（低于此值 doctor 报 FAIL）。
pub const MIN_NODE_MAJOR: u32 = 20;

/// 推荐使用的 Node.js 主版本号（低于此值 doctor 报 WARN）。
pub const RECOMMENDED_NODE_MAJOR: u32 = 24;

/// **C1 Spike 结论回填位**：`--port 0` 支持性结论的来源与日期。
///
/// 只有在 `docs/spike-webview-results.md` 的 C1 复选框被勾选、且证据
/// （实测平台与结论）写入本常量后，才允许把 [`PORT_ZERO_SUPPORTED`] 改为
/// `true`。在此之前不得臆测 Spike 结果。
pub const PORT_ZERO_EVIDENCE: Option<&str> = None;

/// C8 — 资源目录下的 Node.js 可执行文件名（非 Windows）。
pub const NODE_BIN_NAME_UNIX: &str = "node";
/// C8 — 资源目录下的 Node.js 可执行文件名（Windows）。
pub const NODE_BIN_NAME_WINDOWS: &str = "node.exe";

/// C8 — Node 包装入口文件名（argv 重写 + 诊断行）。
pub const NODE_ENTRY_FILE: &str = "harness-node-entry.mjs";

/// C8 — 资源目录内 Node.js 的相对路径（`resources/node/`）。
pub const NODE_RESOURCE_DIR: &str = "node";

/// C8 — 资源目录内依赖树的相对路径（`resources/harness/node_modules/`）。
pub const HARNESS_MODULES_DIR: &str = "harness/node_modules";

/// C8 — Harness CLI 入口相对依赖树的路径。
pub const DSH_ENTRY_RELATIVE: &str = "@deepseek-ai/dsh/lib/bin.js";

/// C8 — Windows 子进程控制台窗口隐藏补丁（[`NODE_ENTRY_FILE`] 的兄弟文件）。
pub const WINDOWS_HIDE_FILE: &str = "windows-child-process-hide.mjs";

/// C9 — 桌面 patch 层文件名。
pub const PATCH_FILE: &str = "dsh-desktop.patch.yml";

/// 资源组装清单文件名（任务 0.3 写入，运行时做 warning 级校验）。
pub const MANIFEST_FILE: &str = "MANIFEST.json";

/// userData 下的 DSH_HOME 目录名。
pub const DSH_HOME_DIR: &str = "harness";

/// userData 下的子进程工作目录名。
pub const LAUNCH_ROOT_DIR: &str = "launch-root";

/// userData 下的日志目录名。
pub const LOG_DIR: &str = "logs";

/// userData 下的 harness 日志文件名。
pub const HARNESS_LOG_FILE: &str = "harness.log";

/// userData 下的宿主应用日志文件名（阶段 2 引入，与 harness.log 分离）。
pub const APP_LOG_FILE: &str = "app.log";

/// INV-3 — 陈旧进程清扫用的 pidfile 名。
pub const PID_FILE: &str = "harness.pid";

/// C12 — Windows 下追加给 harness 的 query 参数：启用高级模式。
pub const WINDOWS_QUERY_MODE: (&str, &str) = ("dsh-desktop-mode", "advanced");

/// C12 — Windows 下追加给 harness 的 query 参数：平台标识。
pub const WINDOWS_QUERY_PLATFORM: (&str, &str) = ("dsh-desktop-platform", "win32");

/// C5 — Cookie 清理前缀（原仓库 `window-navigation.ts` 清理 `dsh-auth-*`
/// 以避免请求头膨胀到 HTTP 431）。
pub const AUTH_COOKIE_PREFIX: &str = "dsh-auth-";

/// C4 — 就绪超时：Windows 首次启动需要更久（WebView2 / 杀软扫描）。
pub const STARTUP_TIMEOUT_WINDOWS: Duration = Duration::from_secs(120);

/// C4 — 就绪超时：其它平台。
pub const STARTUP_TIMEOUT_OTHER: Duration = Duration::from_secs(45);

/// Windows 环境变量捕获（PowerShell 兜底路径）超时。
pub const SHELL_CAPTURE_TIMEOUT_WINDOWS: Duration = Duration::from_secs(15);

/// macOS / Linux login shell 捕获超时。
pub const SHELL_CAPTURE_TIMEOUT_UNIX: Duration = Duration::from_secs(10);

/// 返回当前平台的就绪总超时（C4）。
///
/// # 示例
///
/// ```
/// use dsh_host::contracts::startup_timeout;
/// assert!(startup_timeout().as_secs() >= 45);
/// ```
pub fn startup_timeout() -> Duration {
    if cfg!(windows) {
        STARTUP_TIMEOUT_WINDOWS
    } else {
        STARTUP_TIMEOUT_OTHER
    }
}

/// 返回当前平台的 Node.js 可执行文件名（C8）。
pub fn node_binary_name() -> &'static str {
    if cfg!(windows) {
        NODE_BIN_NAME_WINDOWS
    } else {
        NODE_BIN_NAME_UNIX
    }
}

/// 返回当前平台的环境变量捕获超时。
pub fn shell_capture_timeout() -> Duration {
    if cfg!(windows) {
        SHELL_CAPTURE_TIMEOUT_WINDOWS
    } else {
        SHELL_CAPTURE_TIMEOUT_UNIX
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_timeout_is_platform_specific() {
        let expected = if cfg!(windows) { 120 } else { 45 };
        assert_eq!(startup_timeout().as_secs(), expected);
    }

    #[test]
    fn node_binary_name_matches_platform() {
        let expected = if cfg!(windows) { "node.exe" } else { "node" };
        assert_eq!(node_binary_name(), expected);
    }

    #[test]
    fn token_pattern_matches_reference_line() {
        let regex = regex::Regex::new(TOKEN_LINE_PATTERN).unwrap();
        let captures = regex
            .captures("dsh web: http://127.0.0.1:4173/?token=abc")
            .unwrap();
        assert_eq!(
            captures.get(1).unwrap().as_str(),
            "http://127.0.0.1:4173/?token=abc"
        );
    }

    #[test]
    fn token_pattern_does_not_match_diagnostic_lines() {
        let regex = regex::Regex::new(TOKEN_LINE_PATTERN).unwrap();
        // `arness-node]` 是诊断行，不含 URL。
        assert!(regex
            .captures("[arness-node] runtime node=v24.9.0")
            .is_none());
    }

    #[test]
    fn exit_codes_are_distinct() {
        let codes = [
            EXIT_OK,
            EXIT_UNEXPECTED,
            EXIT_USAGE,
            EXIT_MISSING_RESOURCE,
            EXIT_SPAWN_FAILED,
            EXIT_TOKEN_NOT_FOUND,
            EXIT_READY_TIMEOUT,
            EXIT_PORT_IN_USE,
            EXIT_HARNESS_FAILED,
        ];
        for (index, code) in codes.iter().enumerate() {
            for other in &codes[index + 1..] {
                assert_ne!(code, other, "退出码重复：{code}");
            }
        }
    }

    /// 契约护栏：PORT_ZERO_SUPPORTED 为 true 时必须同时给出证据来源，
    /// 否则视为臆测。当前常量为 false，断言只对编译期常量求值，故允许
    /// `assertions_on_constants`——它就是为「Spike 之后翻转常量」这一刻准备的。
    #[test]
    #[allow(clippy::assertions_on_constants)]
    fn port_zero_evidence_is_empty_until_spike_lands() {
        assert!(
            !PORT_ZERO_SUPPORTED || PORT_ZERO_EVIDENCE.is_some(),
            "PORT_ZERO_SUPPORTED=true 必须有 PORT_ZERO_EVIDENCE 支撑"
        );
    }

    #[test]
    fn failure_patterns_capture_detail() {
        let entry = regex::Regex::new(PATTERN_DSH_ENTRY_FAILED).unwrap();
        assert_eq!(
            entry
                .captures("DSH entry failed: boom")
                .unwrap()
                .get(1)
                .unwrap()
                .as_str(),
            "boom"
        );
        let uncaught = regex::Regex::new(PATTERN_UNCAUGHT_EXCEPTION).unwrap();
        assert!(uncaught.captures("uncaught exception: nope").is_some());
        let rejection = regex::Regex::new(PATTERN_UNHANDLED_REJECTION).unwrap();
        assert!(rejection.captures("unhandled rejection: nope").is_some());
    }
}
