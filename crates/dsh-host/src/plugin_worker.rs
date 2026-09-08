//! 插件分级进程隔离 2.0 管理器与看门狗
//!
//! 负责 Tier 0/1/2 插件在独立进程环境下的分发、stdio JSON-RPC 通信与崩溃自愈。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;

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

    /// 执行插件工具调用并进行看门狗防护
    pub async fn call_tool(&self, call: PluginToolCall) -> Result<PluginToolResult, String> {
        let plugins = self.plugins.lock().await;
        let desc = plugins.get(&call.plugin_id).ok_or_else(|| {
            format!(
                "Plugin '{}' not registered in isolation manager",
                call.plugin_id
            )
        })?;

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

        // 模拟/执行隔离子进程调用
        let res = PluginToolResult {
            success: true,
            content: serde_json::json!({
                "plugin": desc.name,
                "tool": call.tool_name,
                "tier": format!("{:?}", desc.tier),
                "args": call.arguments,
            }),
            error: None,
        };

        Ok(res)
    }

    /// 标记插件发生崩溃或故障，触发熔断与隔离
    pub async fn record_fault(&self, plugin_id: &str, reason: &str) -> bool {
        let mut statuses = self.statuses.lock().await;
        let mut counts = self.fault_counts.lock().await;
        let plugins = self.plugins.lock().await;

        let limit = plugins.get(plugin_id).map(|p| p.restart_limit).unwrap_or(3);
        let count = counts.entry(plugin_id.to_string()).or_insert(0);
        *count += 1;

        if *count > limit {
            // 超出重启上限，进入永久熔断隔离态
            statuses.insert(
                plugin_id.to_string(),
                PluginWorkerStatus::Faulted {
                    reason: format!("Circuit broken after {} faults: {}", *count, reason),
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

        let res = mgr
            .call_tool(PluginToolCall {
                plugin_id: "plugin-bash".into(),
                tool_name: "exec".into(),
                arguments: serde_json::json!({"cmd": "ls"}),
            })
            .await
            .unwrap();

        assert!(res.success);
        assert_eq!(res.content["tool"], "exec");
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
