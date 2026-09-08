//! 崩溃日志分析与诊断报告生成（契约 C7 / 任务 P3）。
//!
//! 提供针对 Harness / Node 子进程崩溃日志的多维分析能力：
//! - 提取导致崩溃的插件（Plugin Fault、Worker Fault、扩展初始化崩溃、模块加载失败等）
//! - 归类崩溃根因（端口冲突、端口抢占、未捕获异常、OOM、语法错误、沙盒违规等）
//! - 格式化生成结构化与人性化排查诊断报告

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use crate::contracts::{
    CORE_BUNDLES, OFFICIAL_BUNDLE_SCOPE, PATTERN_CANNOT_FIND_MODULE, PATTERN_ERR_EACCES,
    PATTERN_ERR_EPERM, PATTERN_GENERIC_PLUGIN, PATTERN_LOADER_ENTRY_FAILURE,
    PATTERN_OOM_ALLOCATION, PATTERN_OOM_HEAP, PATTERN_PLUGIN_FAULT, PATTERN_PORT_IN_USE,
    PATTERN_REQUIRE_PLUGIN, PATTERN_UNHANDLED_REJECTION, PATTERN_WORKER_FAULT,
};
use crate::logs::LogRing;

/// 崩溃诊断分析与报告结构。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CrashDiagnostics {
    /// 诊断报告
    pub report: DiagnosticReport,
}

/// 崩溃故障类别。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum CrashCategory {
    /// 插件内部代码异常或沙盒 Worker 崩溃
    PluginFault,
    /// 端口被占用冲突（EADDRINUSE）
    PortInUse,
    /// 未处理的 Promise Rejection 或未捕获的全局异常
    UnhandledException,
    /// 内存溢出（JavaScript heap out of memory）
    OutOfMemory,
    /// 模块未找到（Cannot find module）
    ModuleNotFound,
    /// 权限拒绝（EACCES / EPERM）
    PermissionDenied,
    /// 进程异常退出 / 未知错误
    Unknown,
}

/// 诊断分析结果。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DiagnosticReport {
    /// 故障类别
    pub category: CrashCategory,
    /// 提取出的嫌疑插件 ID / 插件名称列表（去重）
    pub offending_plugins: Vec<String>,
    /// 故障核心摘要信息
    pub summary: String,
    /// 详细的根因推断或错误行
    pub root_cause: Option<String>,
    /// 修复或恢复建议（例如切换安全模式、更换端口、禁用特定插件）
    pub suggestions: Vec<String>,
    /// 相关上下文日志切片（最后几行或匹配行）
    pub contextual_logs: Vec<String>,
    /// 是否推荐进入安全模式启动
    pub recommends_safe_mode: bool,
}

impl DiagnosticReport {
    /// 格式化为易于阅读的多行纯文本报告。
    pub fn format_text(&self) -> String {
        let mut out = String::new();
        out.push_str("================ DSH CRASH DIAGNOSTIC REPORT ================\n");
        out.push_str(&format!("Category   : {:?}\n", self.category));
        out.push_str(&format!("Summary    : {}\n", self.summary));
        if let Some(ref rc) = self.root_cause {
            out.push_str(&format!("Root Cause : {}\n", rc));
        }
        if !self.offending_plugins.is_empty() {
            out.push_str(&format!(
                "Offending Plugins : {}\n",
                self.offending_plugins.join(", ")
            ));
        }
        out.push_str(&format!(
            "Safe Mode Recommended : {}\n",
            self.recommends_safe_mode
        ));

        if !self.suggestions.is_empty() {
            out.push_str("\nSuggestions:\n");
            for (idx, sug) in self.suggestions.iter().enumerate() {
                out.push_str(&format!("  {}. {}\n", idx + 1, sug));
            }
        }

        if !self.contextual_logs.is_empty() {
            out.push_str("\nContext Logs:\n");
            for line in &self.contextual_logs {
                out.push_str(&format!("  {}\n", line));
            }
        }
        out.push_str("=============================================================");
        out
    }
}

/// 诊断分析器。
pub struct DiagnosticsAnalyzer;

impl DiagnosticsAnalyzer {
    /// 分析由 `LogRing` 捕获的日志行或字符串列表。
    pub fn analyze_lines(lines: &[String]) -> DiagnosticReport {
        let mut offending_plugins = HashSet::new();
        let mut category = CrashCategory::Unknown;
        let mut root_cause = None;
        let mut suggestions = Vec::new();
        let mut matched_logs = Vec::new();

        let plugin_fault_re = Regex::new(PATTERN_PLUGIN_FAULT).ok();
        let worker_fault_re = Regex::new(PATTERN_WORKER_FAULT).ok();
        let unhandled_re = Regex::new(PATTERN_UNHANDLED_REJECTION).ok();
        let loader_entry_re = Regex::new(PATTERN_LOADER_ENTRY_FAILURE).ok();

        // 插件名称正则模式（匹配 plugin "xxx" 或 plugin: xxx 或 [plugin-xxx] 或 require('xxx-plugin')）
        let generic_plugin_re = Regex::new(PATTERN_GENERIC_PLUGIN).ok();
        let require_plugin_re = Regex::new(PATTERN_REQUIRE_PLUGIN).ok();

        for line in lines {
            let lower = line.to_lowercase();

            // 1. 检查插件故障标记 [dsh-plugin-fault]
            if let Some(ref re) = plugin_fault_re {
                if let Some(caps) = re.captures(line) {
                    category = CrashCategory::PluginFault;
                    let detail = caps
                        .get(1)
                        .map(|m| m.as_str().trim().to_string())
                        .unwrap_or_default();
                    root_cause = Some(detail.clone());
                    matched_logs.push(line.clone());

                    if let Some(ref p_re) = generic_plugin_re {
                        if let Some(p_caps) = p_re.captures(&detail) {
                            if let Some(p_name) = p_caps.get(1).or_else(|| p_caps.get(2)) {
                                offending_plugins.insert(p_name.as_str().to_string());
                            }
                        }
                    }
                }
            }

            // 2. 检查 Worker 故障标记 [dsh-worker-fault]
            if let Some(ref re) = worker_fault_re {
                if let Some(caps) = re.captures(line) {
                    category = CrashCategory::PluginFault;
                    let detail = caps
                        .get(1)
                        .map(|m| m.as_str().trim().to_string())
                        .unwrap_or_default();
                    root_cause = Some(format!("Worker fault: {}", detail));
                    matched_logs.push(line.clone());

                    if let Some(ref p_re) = generic_plugin_re {
                        if let Some(p_caps) = p_re.captures(&detail) {
                            if let Some(p_name) = p_caps.get(1).or_else(|| p_caps.get(2)) {
                                offending_plugins.insert(p_name.as_str().to_string());
                            }
                        }
                    }
                }
            }

            // 3. 检查 Cordis loader 入口失败（`failed to apply loader entry x (plugin)`）
            //    官方核心 bundle 随 Harness 分发，不能作为第三方插件隔离，需过滤掉。
            if let Some(ref re) = loader_entry_re {
                if let Some(caps) = re.captures(line) {
                    if let Some(candidate) = caps.get(1) {
                        let candidate = candidate.as_str().trim();
                        let is_official = candidate.starts_with(OFFICIAL_BUNDLE_SCOPE)
                            || CORE_BUNDLES.contains(&candidate);
                        if !is_official && !candidate.is_empty() {
                            category = CrashCategory::PluginFault;
                            root_cause = Some(format!("Loader entry failure: {candidate}"));
                            offending_plugins.insert(candidate.to_string());
                        }
                        matched_logs.push(line.clone());
                    }
                }
            }

            // 4. 检查端口冲突
            if line.contains(PATTERN_PORT_IN_USE) {
                if category == CrashCategory::Unknown {
                    category = CrashCategory::PortInUse;
                    root_cause = Some("Port conflict (EADDRINUSE)".into());
                }
                matched_logs.push(line.clone());
            }

            // 5. 检查 OOM
            if lower.contains(PATTERN_OOM_HEAP) || lower.contains(PATTERN_OOM_ALLOCATION) {
                category = CrashCategory::OutOfMemory;
                root_cause = Some("Node.js JavaScript heap out of memory".into());
                matched_logs.push(line.clone());
            }

            // 6. 检查模块丢失
            if lower.contains(PATTERN_CANNOT_FIND_MODULE) {
                if category == CrashCategory::Unknown {
                    category = CrashCategory::ModuleNotFound;
                    root_cause = Some(line.trim().to_string());
                }
                if let Some(ref r_re) = require_plugin_re {
                    if let Some(caps) = r_re.captures(line) {
                        if let Some(m) = caps.get(1) {
                            offending_plugins.insert(m.as_str().to_string());
                            category = CrashCategory::PluginFault;
                        }
                    }
                }
                matched_logs.push(line.clone());
            }

            // 7. 检查权限问题
            if lower.contains(PATTERN_ERR_EACCES) || lower.contains(PATTERN_ERR_EPERM) {
                if category == CrashCategory::Unknown {
                    category = CrashCategory::PermissionDenied;
                    root_cause = Some("File system permission denied (EACCES/EPERM)".into());
                }
                matched_logs.push(line.clone());
            }

            // 8. 检查未捕获异常 / rejection
            if let Some(ref re) = unhandled_re {
                if let Some(caps) = re.captures(line) {
                    if category == CrashCategory::Unknown {
                        category = CrashCategory::UnhandledException;
                        root_cause = Some(
                            caps.get(1)
                                .map(|m| m.as_str().to_string())
                                .unwrap_or_else(|| line.clone()),
                        );
                    }
                    matched_logs.push(line.clone());
                }
            }
        }

        // 如果没有提取到具体 offending_plugins 但找到了通用关键词
        if offending_plugins.is_empty() {
            for line in lines {
                if let Some(ref p_re) = generic_plugin_re {
                    if let Some(p_caps) = p_re.captures(line) {
                        if let Some(p_name) = p_caps.get(1).or_else(|| p_caps.get(2)) {
                            offending_plugins.insert(p_name.as_str().to_string());
                        }
                    }
                }
            }
        }

        let offending_list: Vec<String> = offending_plugins.into_iter().collect();
        let recommends_safe_mode =
            category == CrashCategory::PluginFault || !offending_list.is_empty();

        // 依据分类构造摘要与建议
        let summary = match category {
            CrashCategory::PluginFault => {
                if !offending_list.is_empty() {
                    format!("Crash caused by plugin(s): {}", offending_list.join(", "))
                } else {
                    "Crash caused by plugin or sandbox worker failure".to_string()
                }
            }
            CrashCategory::PortInUse => {
                "Harness failed to bind to listening port (EADDRINUSE)".to_string()
            }
            CrashCategory::UnhandledException => {
                "Harness encountered unhandled exception or rejection".to_string()
            }
            CrashCategory::OutOfMemory => {
                "Harness exhausted available Node.js heap memory".to_string()
            }
            CrashCategory::ModuleNotFound => {
                "Harness runtime missing required dependency or module".to_string()
            }
            CrashCategory::PermissionDenied => {
                "Harness encountered filesystem permission denial".to_string()
            }
            CrashCategory::Unknown => "Harness process terminated unexpectedly".to_string(),
        };

        match category {
            CrashCategory::PluginFault => {
                suggestions
                    .push("Launch in Safe Mode to isolate and disable problematic plugins.".into());
                if !offending_list.is_empty() {
                    suggestions.push(format!(
                        "Disable or remove suspected plugins: {}",
                        offending_list.join(", ")
                    ));
                }
            }
            CrashCategory::PortInUse => {
                suggestions.push(
                    "Specify a different port or terminate the existing process holding the port."
                        .into(),
                );
                suggestions.push("Use ephemeral port allocation if supported.".into());
            }
            CrashCategory::OutOfMemory => {
                suggestions.push(
                    "Increase Node.js max_old_space_size via environment variable NODE_OPTIONS."
                        .into(),
                );
                suggestions.push("Reduce memory footprint or close background tasks.".into());
            }
            CrashCategory::ModuleNotFound => {
                suggestions.push(
                    "Verify that harness runtime bundles and node_modules are intact.".into(),
                );
                suggestions.push("Run resource integrity verification or re-install.".into());
            }
            CrashCategory::PermissionDenied => {
                suggestions
                    .push("Check write permissions for userData and DSH_HOME directories.".into());
                suggestions.push(
                    "Ensure antivirus or security software is not locking runtime files.".into(),
                );
            }
            CrashCategory::UnhandledException | CrashCategory::Unknown => {
                suggestions.push(
                    "Review logs for stack traces and check recent configuration changes.".into(),
                );
                suggestions.push("Try restarting in Safe Mode if issue persists.".into());
            }
        }

        // 如果匹配到的上下文日志较少，补充日志尾部行
        if matched_logs.is_empty() {
            let tail_count = lines.len().min(10);
            matched_logs = lines[lines.len() - tail_count..].to_vec();
        }

        DiagnosticReport {
            category,
            offending_plugins: offending_list,
            summary,
            root_cause,
            suggestions,
            contextual_logs: matched_logs,
            recommends_safe_mode,
        }
    }

    /// 分析 `LogRing` 实例。
    pub fn analyze_log_ring(ring: &LogRing) -> DiagnosticReport {
        let lines: Vec<String> = ring.to_vec().into_iter().map(|l| l.text).collect();
        Self::analyze_lines(&lines)
    }
}

/// 提取疑似引起故障的插件名称列表。
pub fn extract_offending_plugins(lines: &[String]) -> Vec<String> {
    let report = DiagnosticsAnalyzer::analyze_lines(lines);
    report.offending_plugins
}

/// 格式化崩溃诊断报告为多行文本字符串。
pub fn format_crash_diagnostics(lines: &[String]) -> String {
    let report = DiagnosticsAnalyzer::analyze_lines(lines);
    report.format_text()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_diagnose_plugin_fault() {
        let logs = vec![
            "[stdout] starting server...".into(),
            "[stderr] [dsh-plugin-fault] plugin \"translator-v2\" threw unhandled TypeError".into(),
            "[stderr] process exited with code 1".into(),
        ];

        let report = DiagnosticsAnalyzer::analyze_lines(&logs);
        assert_eq!(report.category, CrashCategory::PluginFault);
        assert!(report.recommends_safe_mode);
        assert_eq!(report.offending_plugins, vec!["translator-v2".to_string()]);
        assert!(report
            .root_cause
            .as_ref()
            .unwrap()
            .contains("translator-v2"));
        assert!(report.format_text().contains("Crash caused by plugin"));
    }

    #[test]
    fn test_diagnose_port_in_use() {
        let logs = vec![
            "[stdout] starting server on port 4173".into(),
            "[stderr] Error: listen EADDRINUSE: address already in use 127.0.0.1:4173".into(),
        ];

        let report = DiagnosticsAnalyzer::analyze_lines(&logs);
        assert_eq!(report.category, CrashCategory::PortInUse);
        assert!(!report.recommends_safe_mode);
        assert!(report.summary.contains("EADDRINUSE"));
    }

    #[test]
    fn test_diagnose_oom() {
        let logs = vec![
            "[stderr] <--- Last few GCs --->".into(),
            "[stderr] FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory".into(),
        ];

        let report = DiagnosticsAnalyzer::analyze_lines(&logs);
        assert_eq!(report.category, CrashCategory::OutOfMemory);
        assert!(report.summary.contains("heap memory"));
    }

    #[test]
    fn test_diagnose_worker_fault() {
        let logs = vec![
            "[stderr] [dsh-worker-fault] Worker sandbox crashed: [plugin:code-runner] memory limit exceeded".into(),
        ];

        let report = DiagnosticsAnalyzer::analyze_lines(&logs);
        assert_eq!(report.category, CrashCategory::PluginFault);
        assert_eq!(report.offending_plugins, vec!["code-runner".to_string()]);
    }

    #[test]
    fn test_diagnose_loader_entry_failure() {
        let logs = vec![
            "[desktop] starting 1".into(),
            "[stderr] failed to apply loader entry x (my-plugin)".into(),
        ];

        let report = DiagnosticsAnalyzer::analyze_lines(&logs);
        assert_eq!(report.category, CrashCategory::PluginFault);
        assert!(report.recommends_safe_mode);
        assert_eq!(report.offending_plugins, vec!["my-plugin".to_string()]);
    }

    #[test]
    fn test_diagnose_loader_entry_failure_skips_core_bundles() {
        let logs = vec![
            "[stderr] failed to apply loader entry x (@deepseek-ai/dsh-base)".into(),
            "[stderr] failed to apply loader entry x (dshmarket)".into(),
        ];

        let report = DiagnosticsAnalyzer::analyze_lines(&logs);
        assert!(report.offending_plugins.is_empty());
        assert!(!report.recommends_safe_mode);
    }
}
