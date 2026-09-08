//! Plugin recovery: extract failing plugins from Harness startup logs.
//!
//! Re-exports and wraps `dsh_host::diagnostics` for use within Tauri.

#![allow(dead_code)]
#![allow(unused_imports)]

pub use dsh_host::diagnostics::*;

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
        let logs =
            vec!["[stderr] failed to apply loader entry x (@deepseek-ai/dsh-base)".to_string()];
        let plugins = extract_offending_plugins(&logs);
        assert!(plugins.is_empty());
    }
}
