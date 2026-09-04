//! Safe Mode: an isolated profile containing only official core bundles.
//!
//! Rust port of `src/main/state/safe-mode-profile.ts`. Shares DSH_HOME
//! settings, credentials, sessions and workspaces with the normal profile,
//! but never reads that profile's bundle list or user patch layer.

use std::path::{Path, PathBuf};

pub const SAFE_MODE_PROFILE: &str = "desktop-safe-mode";
pub const SAFE_MODE_BUNDLES: [&str; 2] =
    ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];

const SAFE_MODE_PATCH: &str = "# Managed by DSH Desktop Safe Mode.\n\
# Third-party bundles and the normal web profile's patch layer are intentionally omitted.\n\
[]\n";

const SAFE_MODE_WORKSPACE: &str = "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n";

/// Materialize the isolated safe-mode profile directory.
pub fn ensure_safe_mode_profile(dsh_home: &Path) -> std::io::Result<PathBuf> {
    let directory = dsh_home.join("profiles").join(SAFE_MODE_PROFILE);
    std::fs::create_dir_all(&directory)?;

    let manifest = serde_json::json!({
        "name": "dsh-profile-desktop-safe-mode",
        "private": true,
        "dependencies": {},
        "dsh": { "profile": { "bundles": SAFE_MODE_BUNDLES } }
    });
    let manifest = format!("{}\n", serde_json::to_string_pretty(&manifest).unwrap());

    write_if_changed(&directory.join("package.json"), &manifest)?;
    write_if_changed(&directory.join("cordis.patch.yml"), SAFE_MODE_PATCH)?;
    write_if_changed(&directory.join("pnpm-workspace.yaml"), SAFE_MODE_WORKSPACE)?;

    Ok(directory)
}

fn write_if_changed(path: &Path, content: &str) -> std::io::Result<()> {
    if let Ok(existing) = std::fs::read_to_string(path) {
        if existing == content {
            return Ok(());
        }
    }
    std::fs::write(path, content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_profile_files() {
        let temp = std::env::temp_dir().join("dsh-safe-mode-test");
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
