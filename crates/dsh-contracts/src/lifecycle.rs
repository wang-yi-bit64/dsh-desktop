//! # 运行时生命周期与状态机契约

use serde::{Deserialize, Serialize};

/// 宿主服务生命周期状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostLifecycleState {
    /// 初始未运行状态
    Stopped,
    /// 启动中（进程派生、正在捕获 token 与等待 readiness）
    Starting,
    /// 正常健康运行
    Healthy,
    /// 降级运行（如部分 Tier 2 插件崩溃但核心可用）
    Degraded,
    /// 崩溃退出（正在触发故障归因或等待重启退避）
    Crashed,
    /// 正在受控关闭
    Stopping,
}

/// 插件工作隔离层级 (Tiers)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginTier {
    /// Tier 0: 核心宿主内建功能 (In-Process)
    Tier0Core,
    /// Tier 1: 官方受信任核心扩展 (独立 Worker 线程，高优先级)
    Tier1Trusted,
    /// Tier 2: 社区/第三方动态插件 (独立子进程，完全隔离与断路器保护)
    Tier2Community,
}
