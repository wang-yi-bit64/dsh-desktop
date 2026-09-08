//! # 故障诊断、崩溃归因与排障数据包契约

use serde::{Deserialize, Serialize};

/// 崩溃故障归因类别
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CrashCategory {
    /// 插件故障（扩展初始化、重复工具定义、插件沙盒异常）
    PluginFailure,
    /// 端口冲突 (EADDRINUSE)
    PortInUse,
    /// 内存溢出 (OOM)
    OutOfMemory,
    /// 缺少文件/模块缺失
    ModuleMissing,
    /// 权限拒绝 (EACCES / EPERM)
    PermissionDenied,
    /// 进程异常退出 (非 0 退出码且无明显已知特征)
    ProcessExited,
    /// 未知异常
    Unknown,
}

/// 崩溃诊断结构化数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrashDiagnostics {
    pub category: CrashCategory,
    pub primary_cause: String,
    pub offending_plugins: Vec<String>,
    pub exit_code: Option<i32>,
    pub recommended_action: String,
    pub safe_mode_available: bool,
    pub timestamp_ms: u64,
}

/// 一键导出的诊断数据包元数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticsBundleMeta {
    pub app_version: String,
    pub os_info: String,
    pub timestamp_ms: u64,
    pub log_files: Vec<String>,
    pub anonymized: bool,
}
