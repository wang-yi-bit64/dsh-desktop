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

/// 统一结构化错误
#[derive(Debug, Error, Clone, Serialize, Deserialize)]
#[error("[{code}] {message}")]
pub struct AppError {
    /// 机器可读错误码，如 "ERR_RESOURCE_MISSING"
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

    /// 映射到进程退出码
    pub fn exit_code(&self) -> i32 {
        match self.code.as_str() {
            "ERR_RESOURCE_MISSING" | "ERR_NODE_MISSING" => EXIT_MISSING_RESOURCE,
            "ERR_SPAWN_FAILED" | "ERR_PROCESS_EXITED" => EXIT_SPAWN_FAILED,
            "ERR_TOKEN_NOT_FOUND" => EXIT_TOKEN_NOT_FOUND,
            "ERR_READY_TIMEOUT" => EXIT_READY_TIMEOUT,
            "ERR_PORT_IN_USE" => EXIT_PORT_IN_USE,
            "ERR_HARNESS_FAILED" => EXIT_HARNESS_FAILED,
            "ERR_USAGE" => EXIT_USAGE,
            _ => EXIT_UNEXPECTED,
        }
    }
}
