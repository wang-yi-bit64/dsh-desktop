//! # DSH 契约常量定义
//!
//! 包含全系统通用的常量契约 (CX-1 ~ CX-12)、默认配置与系统阈值。

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
pub const TOKEN_LINE_PATTERN: &str = r"\bdsh web:\s*(\S+)";

/// C3 — 换取 30 天 cookie 的 query 参数名。
pub const TOKEN_QUERY_KEY: &str = "token";

/// C7 — 失败归因：`DSH entry failed:` 一旦出现即可立即判失败，不必等超时。
pub const PATTERN_DSH_ENTRY_FAILED: &str = r"DSH entry failed:\s*(.+)";

/// C7 — 失败归因：未捕获异常。
pub const PATTERN_UNCAUGHT_EXCEPTION: &str = r"uncaught exception:\s*(.+)";

/// C7 — 失败归因：未处理 rejection。
pub const PATTERN_UNHANDLED_REJECTION: &str = r"unhandled rejection:\s*(.+)";

/// C7 — 失败归因：插件故障（重复工具、重复路由、扩展初始化崩溃等）。
pub const PATTERN_PLUGIN_FAULT: &str = r"\[dsh-plugin-fault\]\s*(.*)";

/// C7 — 失败归因：插件 Worker 沙盒进程引发的故障或异常退出。
pub const PATTERN_WORKER_FAULT: &str = r"\[dsh-worker-fault\]\s*(.*)";

/// C7 — 失败归因：Cordis loader 无法应用/导入某个插件入口
/// （`failed to apply loader entry x (plugin)`），括号内即插件名。
pub const PATTERN_LOADER_ENTRY_FAILURE: &str =
    r"failed to (?:apply|import) loader entry [^\s]+ \(([^)]+)\)";

/// C7 — 官方 bundle 作用域前缀：随 Harness 分发，不作为可隔离的第三方插件。
pub const OFFICIAL_BUNDLE_SCOPE: &str = "@deepseek-ai/";

/// C7 — 非官方作用域但同样随 Harness 分发的核心 bundle，不作为第三方插件隔离。
pub const CORE_BUNDLES: [&str; 1] = ["dshmarket"];

/// 端口策略：stderr 里出现 `EADDRINUSE` 立即快速失败并换端口重试。
pub const PATTERN_PORT_IN_USE: &str = "EADDRINUSE";

/// 端口策略：`--port 0` 试验失败后，最多快速重试的次数（含首次共 3 次）。
pub const MAX_PORT_ATTEMPTS: usize = 3;

/// 端口策略：是否支持 `--port 0`。
pub const PORT_ZERO_SUPPORTED: bool = false;

/// 端口策略：证据说明。
pub const PORT_ZERO_EVIDENCE: Option<&str> = None;

/// C4 — 健康判据的健康区间下界。
pub const HEALTHY_STATUS_MIN: u16 = 200;

/// C4 — 健康判据的健康区间上界（401 属正常：未带 token 的 `GET /` 会被拒）。
pub const HEALTHY_STATUS_MAX: u16 = 500;

/// C6 — SIGTERM 之后的宽容期，超时即 SIGKILL。
pub const GRACEFUL_STOP_TIMEOUT: Duration = Duration::from_secs(4);

/// C7 — 内存日志环形缓冲容量（对齐原仓库 200 行）。
pub const LOG_RING_CAPACITY: usize = 200;

/// C7 — 单条日志行最大字节数，超出截断。
pub const LOG_LINE_MAX_BYTES: usize = 8 * 1024;

/// C7 — 落盘日志单文件上限。
pub const LOG_FILE_MAX_BYTES: u64 = 5 * 1024 * 1024;

/// C7 — 落盘日志保留份数。
pub const LOG_FILE_MAX_BACKUPS: usize = 3;

/// 日志前缀：宿主自身写入的诊断行。
pub const LOG_PREFIX_DESKTOP: &str = "[desktop]";

/// 日志前缀：子进程 stdout。
pub const LOG_PREFIX_STDOUT: &str = "[stdout]";

/// 日志前缀：子进程 stderr。
pub const LOG_PREFIX_STDERR: &str = "[stderr]";

/// 标记「本次尝试」起点的日志行前缀。
pub const LOG_STARTING_MARKER: &str = "[desktop] starting";

/// 加固补充：ANSI 转义序列清洗正则。
pub const ANSI_ESCAPE_PATTERN: &str = r"\x1B\[[0-9;]*[a-zA-Z]";

/// CLI 退出码 — 成功。
pub const EXIT_OK: i32 = 0;

/// CLI 退出码 — 兜底错误。
pub const EXIT_UNEXPECTED: i32 = 1;

/// CLI 退出码 — 参数用法错误。
pub const EXIT_USAGE: i32 = 2;

/// CLI 退出码 — 缺少捆绑资源。
pub const EXIT_MISSING_RESOURCE: i32 = 3;

/// CLI 退出码 — 无法派生子进程。
pub const EXIT_SPAWN_FAILED: i32 = 4;

/// CLI 退出码 — 超时前未抓到 token 行。
pub const EXIT_TOKEN_NOT_FOUND: i32 = 5;

/// CLI 退出码 — 超过就绪总超时。
pub const EXIT_READY_TIMEOUT: i32 = 6;

/// CLI 退出码 — 端口被占用且重试耗尽。
pub const EXIT_PORT_IN_USE: i32 = 7;

/// CLI 退出码 — Harness 自身启动失败。
pub const EXIT_HARNESS_FAILED: i32 = 8;

/// 端口冲突重试之间的退避时长。
pub const PORT_RETRY_BACKOFF: Duration = Duration::from_millis(200);

/// 失败路径上等待子进程退出的上限。
pub const EXIT_REAP_TIMEOUT: Duration = Duration::from_secs(2);

/// 就绪后等日志泵收尾的时长。
pub const LOG_PUMP_DRAIN_DELAY: Duration = Duration::from_millis(50);

/// C6 — 强杀之后等待进程句柄回收的时长。
pub const STOP_KILL_DELAY: Duration = Duration::from_secs(2);

/// INV-3 — 陈旧进程清扫中，请求优雅退出后的等待时长。
pub const SWEEP_REAP_DELAY: Duration = Duration::from_millis(200);

/// INV-3 — 陈旧进程清扫中，优雅退出超时后强杀的等待时长。
pub const SWEEP_KILL_DELAY: Duration = Duration::from_millis(300);

/// C4 — 排障子命令 `probe` 的默认端口。
pub const DEFAULT_PROBE_PORT: u16 = 4173;

/// C4 — 单次 HTTP 探测的超时。
pub const PROBE_TIMEOUT: Duration = Duration::from_millis(800);

/// 日志级别前缀 — error。
pub const LOG_LEVEL_ERROR: &str = "ERROR";

/// 日志级别前缀 — warn。
pub const LOG_LEVEL_WARN: &str = "WARN ";

/// 日志级别前缀 — info。
pub const LOG_LEVEL_INFO: &str = "INFO ";

/// 日志级别前缀 — debug。
pub const LOG_LEVEL_DEBUG: &str = "DEBUG";

/// 运行 Harness 所需的最低 Node.js 主版本号。
pub const MIN_NODE_MAJOR: u32 = 20;

/// 推荐使用的 Node.js 主版本号。
pub const RECOMMENDED_NODE_MAJOR: u32 = 24;

/// C8 — 资源目录下的 Node.js 可执行文件名（非 Windows）。
pub const NODE_BIN_NAME_UNIX: &str = "node";
/// C8 — 资源目录下的 Node.js 可执行文件名（Windows）。
pub const NODE_BIN_NAME_WINDOWS: &str = "node.exe";

/// C8 — Node 包装入口文件名。
pub const NODE_ENTRY_FILE: &str = "harness-node-entry.mjs";

/// C8 — 资源目录内 Node.js 的相对路径。
pub const NODE_RESOURCE_DIR: &str = "node";

/// C8 (Sidecar) — 资源目录内独立单二进制/Sidecar 的相对子目录。
pub const SIDECAR_RESOURCE_DIR: &str = "bin";

/// C8 (Sidecar) — 独立单二进制/Sidecar 的默认文件名（非 Windows）。
pub const SIDECAR_BIN_NAME_UNIX: &str = "dsh-sidecar";
/// C8 (Sidecar) — 独立单二进制/Sidecar 的默认文件名（Windows）。
pub const SIDECAR_BIN_NAME_WINDOWS: &str = "dsh-sidecar.exe";

/// 环境变量：显式指定 Harness 运行模式。
pub const ENV_DSH_RUNNER: &str = "DSH_RUNNER";

/// C8 — 资源目录内依赖树的相对路径。
pub const HARNESS_MODULES_DIR: &str = "harness/node_modules";

/// C8 — Harness CLI 入口相对依赖树的路径。
pub const DSH_ENTRY_RELATIVE: &str = "@deepseek-ai/dsh/lib/bin.js";

/// C8 — Windows 子进程控制台窗口隐藏补丁。
pub const WINDOWS_HIDE_FILE: &str = "windows-child-process-hide.mjs";

/// C9 — 桌面 patch 层文件名。
pub const PATCH_FILE: &str = "dsh-desktop.patch.yml";

/// 资源组装清单文件名。
pub const MANIFEST_FILE: &str = "MANIFEST.json";

/// userData 下的 DSH_HOME 目录名。
pub const DSH_HOME_DIR: &str = "harness";

/// userData 下的子进程工作目录名。
pub const LAUNCH_ROOT_DIR: &str = "launch-root";

/// userData 下的日志目录名。
pub const LOG_DIR: &str = "logs";

/// userData 下的 harness 日志文件名。
pub const HARNESS_LOG_FILE: &str = "harness.log";

/// userData 下的宿主应用日志文件名。
pub const APP_LOG_FILE: &str = "app.log";

/// 契约 C10 — Profile 子目录名。
pub const PROFILES_DIR_NAME: &str = "profiles";

/// 契约 C10 — 会话子目录名。
pub const SESSIONS_DIR_NAME: &str = "sessions";

/// 契约 C10 — 默认 Profile 标识。
pub const DEFAULT_PROFILE_ID: &str = "default";

/// 契约 C10 — 安全模式 Profile 标识前缀。
pub const SAFE_MODE_PROFILE_PREFIX: &str = "safe-mode-";

/// 契约 C10 — Profile 配置文件名。
pub const PROFILE_CONFIG_FILE: &str = "profile.json";

/// 契约 C10 — 安全模式隔离环境变量名：禁用第三方插件。
pub const ENV_SAFE_MODE_DISABLE_PLUGINS: &str = "DSH_DISABLE_PLUGINS";

/// 契约 C10 — 安全模式隔离环境变量名：安全模式标记。
pub const ENV_DSH_SAFE_MODE: &str = "DSH_SAFE_MODE";

/// 契约 C10 — 重启退避初始间隔。
pub const SUPERVISOR_BACKOFF_INITIAL: Duration = Duration::from_millis(500);

/// 契约 C10 — 重启退避最大间隔。
pub const SUPERVISOR_BACKOFF_MAX: Duration = Duration::from_secs(10);

/// 契约 C10 — 重启退避倍数。
pub const SUPERVISOR_BACKOFF_MULTIPLIER: f64 = 2.0;

/// 契约 C10 — 进程被认定为「稳定运行」的时间阈值。
pub const SUPERVISOR_STABLE_UPTIME: Duration = Duration::from_secs(30);

/// 契约 C10 — 状态广播通道容量。
pub const SUPERVISOR_CHANNEL_CAPACITY: usize = 64;

/// INV-3 — 陈旧进程清扫用的 pidfile 名。
pub const PID_FILE: &str = "harness.pid";

/// C12 — Windows 下追加给 harness 的 query 参数：启用高级模式。
pub const WINDOWS_QUERY_MODE: (&str, &str) = ("dsh-desktop-mode", "advanced");

/// C12 — Windows 下追加给 harness 的 query 参数：平台标识。
pub const WINDOWS_QUERY_PLATFORM: (&str, &str) = ("dsh-desktop-platform", "win32");

/// C5 — Cookie 清理前缀。
pub const AUTH_COOKIE_PREFIX: &str = "dsh-auth-";

/// C4 — 就绪超时：Windows 首次启动需要更久。
pub const STARTUP_TIMEOUT_WINDOWS: Duration = Duration::from_secs(120);

/// C4 — 就绪超时：其它平台。
pub const STARTUP_TIMEOUT_OTHER: Duration = Duration::from_secs(45);

/// Windows 环境变量捕获超时。
pub const SHELL_CAPTURE_TIMEOUT_WINDOWS: Duration = Duration::from_secs(15);

/// macOS / Linux login shell 捕获超时。
pub const SHELL_CAPTURE_TIMEOUT_UNIX: Duration = Duration::from_secs(10);

/// 诊断分类模式与匹配常量。
pub const PATTERN_UNHANDLED_PROMISE_REJECTION: &str = r"UnhandledPromiseRejection:\s*(.*)";
pub const PATTERN_GENERIC_PLUGIN: &str =
    r#"(?:plugin[:\s]+["']?([a-zA-Z0-9_\-@/]+)["']?|\[(?:plugin|ext):([a-zA-Z0-9_\-@/]+)\])"#;
pub const PATTERN_REQUIRE_PLUGIN: &str =
    r#"Cannot find module\s+['"]([^'"]*(?:plugin|extension|dsh-)[^'"]*)['"]"#;
pub const PATTERN_OOM_HEAP: &str = "heap out of memory";
pub const PATTERN_OOM_ALLOCATION: &str = "allocation failed";
pub const PATTERN_CANNOT_FIND_MODULE: &str = "cannot find module";
pub const PATTERN_ERR_EACCES: &str = "eacces";
pub const PATTERN_ERR_EPERM: &str = "eperm";

/// 统一传输协议（Named Pipe / UDS / RPC）契约常量。
pub const NAMED_PIPE_PREFIX: &str = r"\\.\pipe\dsh-runtime-";
pub const UDS_SOCKET_FILENAME: &str = "dsh-runtime.sock";
pub const DEFAULT_RPC_TIMEOUT_SECS: u64 = 30;
pub const DEFAULT_RPC_TIMEOUT: Duration = Duration::from_secs(DEFAULT_RPC_TIMEOUT_SECS);

/// 插件隔离进程通信配置常量
pub const PLUGIN_RPC_CHANNEL_ENV: &str = "DSH_PLUGIN_RPC_FD";
pub const PLUGIN_HOST_TIER_ENV: &str = "DSH_PLUGIN_TIER";
pub const PLUGIN_HEARTBEAT_INTERVAL_MS: u64 = 3000;
pub const PLUGIN_HEARTBEAT_TIMEOUT_MS: u64 = 8000;
pub const PLUGIN_RESTART_MAX_ATTEMPTS: usize = 3;
pub const PLUGIN_RESTART_COOLING_PERIOD_MS: u64 = 10000;

/// 返回当前平台的就绪总超时。
pub fn startup_timeout() -> Duration {
    if cfg!(windows) {
        STARTUP_TIMEOUT_WINDOWS
    } else {
        STARTUP_TIMEOUT_OTHER
    }
}

/// 返回当前平台的 Node.js 可执行文件名。
pub fn node_binary_name() -> &'static str {
    if cfg!(windows) {
        NODE_BIN_NAME_WINDOWS
    } else {
        NODE_BIN_NAME_UNIX
    }
}

/// 返回当前平台的 Sidecar 独立二进制文件名。
pub fn sidecar_binary_name() -> &'static str {
    if cfg!(windows) {
        SIDECAR_BIN_NAME_WINDOWS
    } else {
        SIDECAR_BIN_NAME_UNIX
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
