//! Plugin recovery: extract failing plugins from Harness startup logs.
//!
//! Rust port of the extraction helpers in `harness-runtime.ts` plus the
//! detection flow in `plugin-recovery-detection.ts`. The desktop parses the
//! latest launch attempt's stderr for loader failures, duplicate routes, slot
//! conflicts and pending services, then offers a targeted removal.

use std::collections::{HashSet, VecDeque};
use std::path::Path;

use regex::Regex;
use serde::{Deserialize, Serialize};

const CORE_BUNDLES: [&str; 3] = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dshmarket"];

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PluginRecoveryDetection {
    pub logs: Vec<String>,
    pub plugins: Vec<String>,
}

fn is_package_reference(value: &str) -> bool {
    let candidate = value.trim();
    if candidate.is_empty() || candidate.contains(':') {
        return false;
    }
    let pattern = Regex::new(r"^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$").unwrap();
    pattern.is_match(candidate)
}

fn is_actionable_plugin_reference(value: &str) -> bool {
    let candidate = value.trim();
    is_package_reference(candidate)
        && !CORE_BUNDLES.contains(&candidate)
        && !candidate.starts_with("@deepseek-ai/")
}

/// Extract every plugin reference named by loader failures in the logs.
pub fn extract_plugin_failure_references(log_lines: &[String]) -> Vec<String> {
    extract_plugin_references(log_lines, is_package_reference)
}

/// Extract only third-party plugins that can be uninstalled.
pub fn extract_offending_plugins(log_lines: &[String]) -> Vec<String> {
    extract_plugin_references(log_lines, is_actionable_plugin_reference)
}

pub fn extract_duplicate_loader_entry_id(log_lines: &[String]) -> Option<String> {
    let regex = Regex::new(r#"duplicate loader entry id:\s*["']?([^\s"']+)["']?"#).ok()?;
    for line in latest_attempt(log_lines) {
        let Some(text) = line.strip_prefix("[stderr] ") else {
            continue;
        };
        if let Some(m) = regex.captures(text) {
            return m.get(1).map(|m| m.as_str().trim().to_string());
        }
    }
    None
}

pub fn extract_slot_conflict_name(log_lines: &[String]) -> Option<String> {
    let loader = Regex::new(r#"single slot\s+["']([^"']+)["']\s+already has a registration"#).ok()?;
    let renderer = Regex::new(r#"UI slot\s+["']([^"']+)["']\s+has duplicate registrations"#).ok()?;
    for line in latest_attempt(log_lines) {
        let Some(text) = line.strip_prefix("[stderr] ") else {
            continue;
        };
        if let Some(m) = loader.captures(text).or_else(|| renderer.captures(text)) {
            return m.get(1).map(|m| m.as_str().trim().to_string());
        }
    }
    None
}

fn latest_attempt(log_lines: &[String]) -> Vec<&String> {
    let mut start = 0;
    for (index, line) in log_lines.iter().enumerate() {
        if line.trim_start().starts_with("[desktop] starting ") {
            start = index + 1;
        }
    }
    log_lines.iter().skip(start).collect()
}

fn extract_plugin_references<F>(log_lines: &[String], accepts: F) -> Vec<String>
where
    F: Fn(&str) -> bool,
{
    let mut plugins: HashSet<String> = HashSet::new();
    let attempt = latest_attempt(log_lines);
    let has_duplicate_prefix_route = attempt.iter().any(|line| {
        line.starts_with("[stderr] ")
            && Regex::new(r#"duplicate prefix route ["'][^"']+["']"#)
                .map(|re| re.is_match(line))
                .unwrap_or(false)
    });

    let loader_re =
        Regex::new(r"failed to (?:apply|import) loader entry [^\s]+ \((@[^)]+|[^)]+)\)").unwrap();
    let profile_bundle_re = Regex::new(r#"cannot resolve profile bundle ["']([^"']+)["']"#).unwrap();
    let no_bundle_re =
        Regex::new(r#"profile bundle ["']([^"']+)["'] declares no dsh\.bundle"#).unwrap();
    let failed_list_re = Regex::new(r"plugin\(s\) failed to load:\s*([a-zA-Z0-9@/_-]+)").unwrap();
    let pending_re = Regex::new(
        r"^((?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*):\s*pending\s*\(waiting for service:\s*[^)]+\)\s*$",
    )
    .unwrap();
    let node_modules_re =
        Regex::new(r"[\\/]profiles[\\/][^\\/\s]+[\\/]node_modules[\\/]((?:@[^\\/\s]+[\\/])?[^\\/\s)]+)")
            .unwrap();

    for line in &attempt {
        let Some(text) = line.strip_prefix("[stderr] ") else {
            continue;
        };

        for m in loader_re.captures_iter(text) {
            if let Some(candidate) = m.get(1) {
                let candidate = candidate.as_str().trim();
                if accepts(candidate) {
                    plugins.insert(candidate.to_string());
                }
            }
        }
        if let Some(m) = profile_bundle_re.captures(text) {
            if let Some(candidate) = m.get(1) {
                if accepts(candidate.as_str()) {
                    plugins.insert(candidate.as_str().to_string());
                }
            }
        }
        if let Some(m) = no_bundle_re.captures(text) {
            if let Some(candidate) = m.get(1) {
                if accepts(candidate.as_str()) {
                    plugins.insert(candidate.as_str().to_string());
                }
            }
        }
        if let Some(m) = failed_list_re.captures(text) {
            if let Some(candidate) = m.get(1) {
                if accepts(candidate.as_str()) {
                    plugins.insert(candidate.as_str().to_string());
                }
            }
        }
        for boot_line in text.split('\n') {
            let boot_line = boot_line.trim();
            if let Some(m) = pending_re.captures(boot_line) {
                if let Some(candidate) = m.get(1) {
                    if accepts(candidate.as_str()) {
                        plugins.insert(candidate.as_str().to_string());
                    }
                }
            }
        }
        if has_duplicate_prefix_route {
            for m in node_modules_re.captures_iter(text) {
                if let Some(candidate) = m.get(1) {
                    let candidate = candidate.as_str().replace('\\', "/");
                    if accepts(&candidate) {
                        plugins.insert(candidate);
                    }
                }
            }
        }
    }

    plugins.into_iter().collect()
}

/// Run detection over the runtime's current log buffer.
pub fn detect_from_logs(log_lines: &VecDeque<String>) -> PluginRecoveryDetection {
    let logs: Vec<String> = log_lines.iter().cloned().collect();
    let plugins = extract_offending_plugins(&logs);
    PluginRecoveryDetection { logs, plugins }
}

/// Remove a plugin package from the normal web profile's dependencies.
/// Destructive: callers must confirm with the user first.
pub fn remove_plugin_from_profile(dsh_home: &Path, plugin: &str) -> std::io::Result<()> {
    let profile = dsh_home.join("profiles").join("web");
    let manifest_path = profile.join("package.json");
    let raw = std::fs::read_to_string(&manifest_path)?;
    let mut manifest: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    if let Some(deps) = manifest.get_mut("dependencies").and_then(|d| d.as_object_mut()) {
        deps.remove(plugin);
    }
    std::fs::write(
        &manifest_path,
        format!("{}\n", serde_json::to_string_pretty(&manifest).unwrap()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_loader_failure() {
        let logs = vec![
            "[desktop] starting 1".to_string(),
            "[stderr] failed to apply loader entry x (my-plugin)".to_string(),
        ];
        let plugins = extract_offending_plugins(&logs);
        assert!(plugins.contains(&"my-plugin".to_string()));
    }

    #[test]
    fn skips_core_bundles() {
        let logs = vec![
            "[stderr] failed to apply loader entry x (@deepseek-ai/dsh-base)".to_string(),
        ];
        let plugins = extract_offending_plugins(&logs);
        assert!(plugins.is_empty());
    }
}
