//! # 错误分类体系与通用错误定义

use crate::constants::*;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// 错误类别（用于前端分类呈现与上报统计）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCategory {
    /// 环境与配置错误（缺文件、权限、Node版本）
    Environment,
    /// 网络与端口错误（端口占用、DNS、探测超时）
    Network,
    /// 进程生命周期错误（派生失败、过早退出、孤儿进程）
    ProcessLifecycle,
    /// 鉴权与安全错误（Token 缺失、Cookie 超长）
    Authentication,
    /// 插件与扩展错误（沙盒崩溃、加载失败、死锁超时）
    PluginSandbox,
    /// 模型网关与工具调用错误（Schema 校验、方言转换失败）
    ModelGateway,
    /// 内部未知异常
    Internal,
}

impl ErrorCategory {
    /// 稳定的机器可读标识（与 `serde` 的 `snake_case` 表示一致）。
    ///
    /// 跨语言消费者（前端页面）拿到的是 IPC 封套里的字符串，不是这个枚举，
    /// 因此两侧的取值集合必须一致；本方法就是那条对应关系。
    pub fn as_str(&self) -> &'static str {
        match self {
            ErrorCategory::Environment => "environment",
            ErrorCategory::Network => "network",
            ErrorCategory::ProcessLifecycle => "process_lifecycle",
            ErrorCategory::Authentication => "authentication",
            ErrorCategory::PluginSandbox => "plugin_sandbox",
            ErrorCategory::ModelGateway => "model_gateway",
            ErrorCategory::Internal => "internal",
        }
    }
}

/// 标准错误码总表（契约）。
///
/// # 编号规则
///
/// `E<族><序号>`，四位。族号与 [`ErrorCategory`] 一一对应：
///
/// | 前缀 | 族 | 对应类别 |
/// |------|----|---------|
/// | `E1xxx` | 环境与配置 | [`ErrorCategory::Environment`] |
/// | `E2xxx` | 网络与端口 | [`ErrorCategory::Network`] |
/// | `E3xxx` | 进程生命周期 | [`ErrorCategory::ProcessLifecycle`] |
/// | `E4xxx` | 鉴权与安全 | [`ErrorCategory::Authentication`] |
/// | `E5xxx` | 插件与扩展 | [`ErrorCategory::PluginSandbox`] |
/// | `E6xxx` | 模型网关 | [`ErrorCategory::ModelGateway`] |
/// | `E7xxx` | 内部 | [`ErrorCategory::Internal`] |
///
/// # 为什么这些常量必须存在
///
/// IPC 命令面此前一律返回 `Result<T, String>`，前端只能拿到一个人类可读
/// 字符串，**无法编程化区分**「端口占用」与「插件入口失败」——两类故障的处置
/// 完全不同（前者换端口重试，后者进安全模式）。把类别编码成稳定字符串后，
/// 页面的分派逻辑才不依赖英文文案。
pub mod codes {
    // ---- E1xxx 环境与配置 ----
    /// 捆绑资源缺失（安装损坏）。
    pub const RESOURCE_MISSING: &str = "E1001";
    /// 资源或配置存在但不可读 / 不可解析。
    pub const RESOURCE_UNREADABLE: &str = "E1002";
    /// 更新器不可用（未配置更新源或初始化失败）。
    pub const UPDATER_UNAVAILABLE: &str = "E1003";
    /// 日志目录不可写。
    pub const LOG_DIR_UNWRITABLE: &str = "E1004";

    // ---- E2xxx 网络与端口 ----
    /// 端口被占用（EADDRINUSE）。
    pub const PORT_IN_USE: &str = "E2001";
    /// 就绪探测超时。
    pub const READY_TIMEOUT: &str = "E2002";

    // ---- E3xxx 进程生命周期 ----
    /// 无法派生子进程。
    pub const SPAWN_FAILED: &str = "E3001";
    /// 子进程过早退出。
    pub const PROCESS_EXITED: &str = "E3002";
    /// Harness 尚未就绪（请求的动作此刻无处落地，属正常状态而非故障）。
    pub const NOT_READY: &str = "E3003";

    // ---- E4xxx 鉴权与安全 ----
    /// launch token 缺失或无效。
    pub const TOKEN_MISSING: &str = "E4001";
    /// 调用方不是本地页（命令守卫拒绝）。
    pub const PERMISSION_DENIED: &str = "E4002";

    // ---- E5xxx 插件与扩展 ----
    /// 插件挂载或运行故障。
    pub const PLUGIN_FAULT: &str = "E5001";
    /// 要求插件隔离能力，但该能力未接线。
    pub const PLUGIN_ISOLATION_UNWIRED: &str = "E5002";

    // ---- E6xxx 模型网关 ----
    /// 模型网关工具调用转换失败。
    pub const MODEL_GATEWAY: &str = "E6001";

    // ---- E7xxx 内部 ----
    /// 未归类的内部错误。
    pub const INTERNAL: &str = "E7001";
    /// 请求的动作名不被识别。
    pub const UNKNOWN_ACTION: &str = "E7002";
}

/// 统一结构化错误
///
/// # 为什么这个类型必须被用起来
///
/// 它此前在 `dsh-contracts` 里定义了却**零消费方**：命令面用的是一串裸
/// `String`，于是「错误码 + 类别 + 建议动作」这套结构在运行路径上从未存在。
/// 2026-09-10 起它是 [`crate::ipc::IpcEnvelope`] 的 `error` 载荷类型，才真正
/// 成为跨语言契约。字段名改动等于改契约。
#[derive(Debug, Error, Clone, Serialize, Deserialize)]
#[error("[{code}] {message}")]
pub struct AppError {
    /// 机器可读错误码（[`codes`] 里的 `E` 码）
    pub code: String,
    /// 人类可读错误信息
    pub message: String,
    /// 错误分类
    pub category: ErrorCategory,
    /// 建议修复动作
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_action: Option<String>,
    /// 详细上下文字段 (JSON 键值对)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl AppError {
    pub fn new(
        code: impl Into<String>,
        message: impl Into<String>,
        category: ErrorCategory,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            category,
            suggested_action: None,
            details: None,
        }
    }

    pub fn with_action(mut self, action: impl Into<String>) -> Self {
        self.suggested_action = Some(action.into());
        self
    }

    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }

    /// 映射到进程退出码。
    ///
    /// 命令行（`dsh-host-cli`）用整数退出码；IPC 面用 [`codes`] 的 `E` 码。
    /// 两者是同一套归因的两个出口，因此这张表按 `E` 码族映射——**不要**再引入
    /// 第二套错误码字符串。
    pub fn exit_code(&self) -> i32 {
        match self.code.as_str() {
            codes::RESOURCE_MISSING | codes::RESOURCE_UNREADABLE | codes::LOG_DIR_UNWRITABLE => {
                EXIT_MISSING_RESOURCE
            }
            codes::SPAWN_FAILED | codes::PROCESS_EXITED => EXIT_SPAWN_FAILED,
            codes::TOKEN_MISSING => EXIT_TOKEN_NOT_FOUND,
            codes::READY_TIMEOUT => EXIT_READY_TIMEOUT,
            codes::PORT_IN_USE => EXIT_PORT_IN_USE,
            codes::PLUGIN_FAULT => EXIT_HARNESS_FAILED,
            codes::UNKNOWN_ACTION => EXIT_USAGE,
            _ => EXIT_UNEXPECTED,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 错误码族号与类别必须一一对应，否则前端按 `category` 分派会错族。
    #[test]
    fn every_code_family_maps_to_its_category() {
        let pairs: [(&str, ErrorCategory); 13] = [
            (codes::RESOURCE_MISSING, ErrorCategory::Environment),
            (codes::RESOURCE_UNREADABLE, ErrorCategory::Environment),
            (codes::UPDATER_UNAVAILABLE, ErrorCategory::Environment),
            (codes::LOG_DIR_UNWRITABLE, ErrorCategory::Environment),
            (codes::PORT_IN_USE, ErrorCategory::Network),
            (codes::READY_TIMEOUT, ErrorCategory::Network),
            (codes::SPAWN_FAILED, ErrorCategory::ProcessLifecycle),
            (codes::PROCESS_EXITED, ErrorCategory::ProcessLifecycle),
            (codes::NOT_READY, ErrorCategory::ProcessLifecycle),
            (codes::TOKEN_MISSING, ErrorCategory::Authentication),
            (codes::PERMISSION_DENIED, ErrorCategory::Authentication),
            (codes::PLUGIN_FAULT, ErrorCategory::PluginSandbox),
            (
                codes::PLUGIN_ISOLATION_UNWIRED,
                ErrorCategory::PluginSandbox,
            ),
        ];
        for (code, category) in pairs {
            let family = &code[1..2];
            let expected = match category {
                ErrorCategory::Environment => "1",
                ErrorCategory::Network => "2",
                ErrorCategory::ProcessLifecycle => "3",
                ErrorCategory::Authentication => "4",
                ErrorCategory::PluginSandbox => "5",
                ErrorCategory::ModelGateway => "6",
                ErrorCategory::Internal => "7",
            };
            assert_eq!(family, expected, "{code} 的族号与类别 {category:?} 不符");
        }
        assert_eq!(&codes::MODEL_GATEWAY[1..2], "6");
        assert_eq!(&codes::INTERNAL[1..2], "7");
        assert_eq!(&codes::UNKNOWN_ACTION[1..2], "7");
    }

    #[test]
    fn exit_codes_follow_the_e_code_families() {
        let error = |code: &str| AppError::new(code, "x", ErrorCategory::Internal);
        assert_eq!(
            error(codes::RESOURCE_MISSING).exit_code(),
            EXIT_MISSING_RESOURCE
        );
        assert_eq!(error(codes::PORT_IN_USE).exit_code(), EXIT_PORT_IN_USE);
        assert_eq!(error(codes::READY_TIMEOUT).exit_code(), EXIT_READY_TIMEOUT);
        assert_eq!(error(codes::SPAWN_FAILED).exit_code(), EXIT_SPAWN_FAILED);
        assert_eq!(
            error(codes::TOKEN_MISSING).exit_code(),
            EXIT_TOKEN_NOT_FOUND
        );
        assert_eq!(error(codes::UNKNOWN_ACTION).exit_code(), EXIT_USAGE);
    }
}
