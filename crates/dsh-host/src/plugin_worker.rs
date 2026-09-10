//! 插件分级进程隔离管理器与看门狗
//!
//! # ⚠️ 状态：未接线（experimental / not wired）
//!
//! 本模块提供 Tier 0/1/2 分级的**数据结构、状态机与断路器语义**，但
//! **尚未与真正的沙箱执行通道对接**：
//!
//! * [`PluginIsolationManager::call_tool`] 不会派生任何 Worker / 子进程，
//!   一律返回 [`ISOLATION_NOT_WIRED`] 错误。它**刻意不返回伪造的成功结果**——
//!   伪造结果会让上层把「未执行的插件调用」误判为已执行（该 mock 分支已于
//!   2026-09-10 移除）。
//! * Node 侧 `build/plugin-worker-host.mjs` 实现了真实的 stdio JSON-RPC 宿主，
//!   但只有 `build/plugin-safety-guard.mjs` 中的 `PluginWorkerClient` 能拉起它，
//!   而该客户端目前没有任何调用方（`build/harness-node-entry.mjs` 只取用
//!   `formatFaultDetails`）。两端因此都处于「有实现、无接线」状态。
//!
//! 真正生效的插件挂载发生在 Harness Node 进程内部（官方 Cordis 插件体系 +
//! `dsh.profile.bundles` 投影 + dshmarket shim），**不经过本模块**。因此本模块
//! 既不是插件挂载路径上的组件，也不构成「第二套插件体系」。是否接线属独立议题，
//! 详见 `docs/plugin_isolation_architecture.md` 顶部的状态说明。
//!
//! 保留价值：状态机与断路器逻辑是独立可测的纯逻辑单元
//! （见本文件 `tests`；`cargo test -p dsh-host` 覆盖）。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;

/// `call_tool` 在未接线状态下返回的错误前缀（供调用方与测试匹配）。
///
/// 调用方应当把它当作「能力未启用」而非「插件执行失败」处理。
pub const ISOLATION_NOT_WIRED: &str = "plugin isolation is not wired in this build";

/// 插件安全隔离等级
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginTier {
    /// 内置高信任度插件（同进程或受信任 Worker）
    Tier0,
    /// 官方生态插件（独立 Worker 线程/轻量子进程）
    Tier1,
    /// 第三方/社区插件（最高级别严格隔离子进程与看门狗保护）
    #[default]
    Tier2,
}

/// 插件元信息与隔离配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginDescriptor {
    pub id: String,
    pub name: String,
    pub version: String,
    pub tier: PluginTier,
    pub entry_file: String,
    pub restart_limit: u32,
}

/// 插件运行状态
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginWorkerStatus {
    Starting,
    Ready,
    Degraded,
    Faulted { reason: String },
    Terminated,
}

/// 插件调用请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginToolCall {
    pub plugin_id: String,
    pub tool_name: String,
    pub arguments: Value,
}

/// 插件调用响应结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginToolResult {
    pub success: bool,
    pub content: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 插件隔离看门狗与调度器
#[derive(Clone)]
pub struct PluginIsolationManager {
    counter: Arc<AtomicU64>,
    plugins: Arc<Mutex<HashMap<String, PluginDescriptor>>>,
    statuses: Arc<Mutex<HashMap<String, PluginWorkerStatus>>>,
    fault_counts: Arc<Mutex<HashMap<String, u32>>>,
}

impl PluginIsolationManager {
    pub fn new() -> Self {
        Self {
            counter: Arc::new(AtomicU64::new(1)),
            plugins: Arc::new(Mutex::new(HashMap::new())),
            statuses: Arc::new(Mutex::new(HashMap::new())),
            fault_counts: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 注册插件
    pub async fn register_plugin(&self, desc: PluginDescriptor) {
        let id = desc.id.clone();
        let mut plugins = self.plugins.lock().await;
        let mut statuses = self.statuses.lock().await;
        plugins.insert(id.clone(), desc);
        statuses.insert(id, PluginWorkerStatus::Ready);
    }

    /// 获取插件当前状态
    pub async fn get_status(&self, plugin_id: &str) -> Option<PluginWorkerStatus> {
        let statuses = self.statuses.lock().await;
        statuses.get(plugin_id).cloned()
    }

    /// 获取所有插件状态清单
    pub async fn list_statuses(&self) -> HashMap<String, PluginWorkerStatus> {
        let statuses = self.statuses.lock().await;
        statuses.clone()
    }

    /// 执行插件工具调用并进行看门狗防护。
    ///
    /// # 未接线行为（experimental / not wired）
    ///
    /// 本方法**不会**派生沙箱进程。签名与熔断前置检查保留，以便将来接线时
    /// 调用方无需改动；但当前一律以 [`ISOLATION_NOT_WIRED`] 开头的原因返回
    /// 错误，**绝不返回伪造的成功结果**。
    ///
    /// # 参数
    ///
    /// * `call` — 目标插件 id、工具名与参数。
    ///
    /// # 返回
    ///
    /// * `Err` — 插件未注册、处于熔断隔离态，或本模块未接线（当前恒为该情形）。
    ///
    /// # 示例
    ///
    /// ```no_run
    /// # use dsh_host::plugin_worker::*;
    /// # async fn demo(mgr: PluginIsolationManager) {
    /// let err = mgr
    ///     .call_tool(PluginToolCall {
    ///         plugin_id: "p".into(),
    ///         tool_name: "t".into(),
    ///         arguments: serde_json::json!({}),
    ///     })
    ///     .await
    ///     .unwrap_err();
    /// assert!(err.contains(ISOLATION_NOT_WIRED));
    /// # }
    /// ```
    pub async fn call_tool(&self, call: PluginToolCall) -> Result<PluginToolResult, String> {
        // 注册校验单独成块：guard 必须在调用 get_status 之前释放，避免与
        // record_fault 形成「plugins → statuses」与「statuses → plugins」的
        // 反向锁序。
        {
            let plugins = self.plugins.lock().await;
            if !plugins.contains_key(&call.plugin_id) {
                return Err(format!(
                    "Plugin '{}' not registered in isolation manager",
                    call.plugin_id
                ));
            }
        }

        // 熔断态优先上报：熔断原因对排障比「未接线」更有信息量。
        let status = self
            .get_status(&call.plugin_id)
            .await
            .unwrap_or(PluginWorkerStatus::Terminated);
        if let PluginWorkerStatus::Faulted { reason } = status {
            return Err(format!(
                "Plugin '{}' is faulted and isolated: {}",
                call.plugin_id, reason
            ));
        }

        let _req_id = self.counter.fetch_add(1, Ordering::Relaxed);

        Err(format!(
            "{}: refusing to report plugin '{}' tool '{}' as executed",
            ISOLATION_NOT_WIRED, call.plugin_id, call.tool_name
        ))
    }

    /// 标记插件发生崩溃或故障，触发熔断与隔离。
    ///
    /// # 参数
    ///
    /// * `plugin_id` — 插件标识。
    /// * `reason` — 归因描述，会并入熔断状态。
    ///
    /// # 返回
    ///
    /// * `true` — 未达 `restart_limit`，允许自愈重启（状态置 `Degraded`）。
    /// * `false` — 超过上限，进入永久熔断隔离（状态置 `Faulted`）。
    pub async fn record_fault(&self, plugin_id: &str, reason: &str) -> bool {
        // 三把锁顺序获取、互不嵌套，避免与 call_tool 形成反向锁序。
        let limit = {
            let plugins = self.plugins.lock().await;
            plugins.get(plugin_id).map(|p| p.restart_limit).unwrap_or(3)
        };
        let exceeded = {
            let mut counts = self.fault_counts.lock().await;
            let count = counts.entry(plugin_id.to_string()).or_insert(0);
            *count += 1;
            *count > limit
        };

        let mut statuses = self.statuses.lock().await;
        if exceeded {
            // 超出重启上限，进入永久熔断隔离态
            statuses.insert(
                plugin_id.to_string(),
                PluginWorkerStatus::Faulted {
                    reason: format!("Circuit broken after more than {limit} faults: {reason}"),
                },
            );
            false // 不再自愈重启
        } else {
            // 处于降级自愈中
            statuses.insert(plugin_id.to_string(), PluginWorkerStatus::Degraded);
            true // 允许重启自愈
        }
    }

    /// 重置插件状态为 Ready
    pub async fn recover_plugin(&self, plugin_id: &str) {
        let mut statuses = self.statuses.lock().await;
        statuses.insert(plugin_id.to_string(), PluginWorkerStatus::Ready);
    }
}

impl Default for PluginIsolationManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_plugin_registration_and_execution() {
        let mgr = PluginIsolationManager::new();
        mgr.register_plugin(PluginDescriptor {
            id: "plugin-bash".into(),
            name: "Bash Plugin".into(),
            version: "1.0.0".into(),
            tier: PluginTier::Tier2,
            entry_file: "bash.js".into(),
            restart_limit: 2,
        })
        .await;

        assert_eq!(
            mgr.get_status("plugin-bash").await,
            Some(PluginWorkerStatus::Ready)
        );

        // 未接线不变量：call_tool 必须明确报错，绝不能报告「已执行」。
        // 回归此断言可防止伪造成功结果的 mock 分支被重新引入。
        let err = mgr
            .call_tool(PluginToolCall {
                plugin_id: "plugin-bash".into(),
                tool_name: "exec".into(),
                arguments: serde_json::json!({"cmd": "ls"}),
            })
            .await
            .unwrap_err();

        assert!(
            err.contains(ISOLATION_NOT_WIRED),
            "expected not-wired error, got: {err}"
        );
    }

    #[tokio::test]
    async fn test_unregistered_plugin_is_rejected_before_wiring_check() {
        let mgr = PluginIsolationManager::new();
        let err = mgr
            .call_tool(PluginToolCall {
                plugin_id: "nope".into(),
                tool_name: "exec".into(),
                arguments: serde_json::json!({}),
            })
            .await
            .unwrap_err();

        assert!(err.contains("not registered in isolation manager"), "{err}");
        assert!(!err.contains(ISOLATION_NOT_WIRED), "{err}");
    }

    #[tokio::test]
    async fn test_plugin_fault_and_circuit_breaker() {
        let mgr = PluginIsolationManager::new();
        mgr.register_plugin(PluginDescriptor {
            id: "plugin-faulty".into(),
            name: "Faulty Plugin".into(),
            version: "0.1.0".into(),
            tier: PluginTier::Tier2,
            entry_file: "faulty.js".into(),
            restart_limit: 2,
        })
        .await;

        // 第一次故障 -> Degraded (自愈)
        let can_restart_1 = mgr.record_fault("plugin-faulty", "OOM 1").await;
        assert!(can_restart_1);
        assert_eq!(
            mgr.get_status("plugin-faulty").await,
            Some(PluginWorkerStatus::Degraded)
        );

        // 第二次故障 -> Degraded (自愈)
        let can_restart_2 = mgr.record_fault("plugin-faulty", "OOM 2").await;
        assert!(can_restart_2);

        // 第三次故障 -> 熔断 (Faulted)
        let can_restart_3 = mgr.record_fault("plugin-faulty", "OOM 3").await;
        assert!(!can_restart_3);

        let status = mgr.get_status("plugin-faulty").await.unwrap();
        matches!(status, PluginWorkerStatus::Faulted { .. });

        // 熔断后调用应直接被拦截拒绝
        let err = mgr
            .call_tool(PluginToolCall {
                plugin_id: "plugin-faulty".into(),
                tool_name: "test".into(),
                arguments: serde_json::json!({}),
            })
            .await
            .unwrap_err();

        assert!(err.contains("is faulted and isolated"));
    }
}
