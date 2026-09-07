//! Safe Mode: an isolated profile containing only official core bundles.
//!
//! Re-exports and wraps `dsh_host::safe_mode` for use within Tauri.

pub use dsh_host::safe_mode::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_profile_files() {
        let temp = std::env::temp_dir().join("dsh-safe-mode-test-tauri");
        let _ = std::fs::remove_dir_all(&temp);
        std::fs::create_dir_all(&temp).unwrap();
        let directory = ensure_safe_mode_profile(&temp).unwrap();
        assert!(directory.join("package.json").exists());
        assert!(directory.join("cordis.patch.yml").exists());
        assert!(directory.join("pnpm-workspace.yaml").exists());
        let manifest = std::fs::read_to_string(directory.join("package.json")).unwrap();
        assert!(manifest.contains("@deepseek-ai/dsh-base"));
        let _ = std::fs::remove_dir_all(&temp);
    }
}
