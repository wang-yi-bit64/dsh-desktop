//! Application-owned data directories.
//!
//! Mirrors the Electron layout: userData/launch-root, userData/harness
//! (DSH_HOME), and logs/harness.log. Profiles, plugins and sessions live
//! outside the installation directory so upgrades never remove user data.

use std::path::{Path, PathBuf};

/// The launch directory used as the Harness child process cwd.
pub fn launch_root(data_dir: &Path) -> PathBuf {
    data_dir.join("launch-root")
}

/// DSH_HOME: where Harness keeps profiles, sessions, settings and plugins.
pub fn dsh_home(data_dir: &Path) -> PathBuf {
    data_dir.join("harness")
}

/// Desktop diagnostics log for Harness startup.
pub fn harness_log_path(data_dir: &Path) -> PathBuf {
    data_dir.join("logs").join("harness.log")
}

/// Cached desktop helper binaries (e.g. cloudflared).
pub fn bin_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("bin")
}

/// Remembered update-skip choice.
pub fn update_skip_path(data_dir: &Path) -> PathBuf {
    data_dir.join("update-skip.json")
}

/// Ensure the launch-root and DSH_HOME tree exists before starting Harness.
pub fn ensure_data_dirs(data_dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(launch_root(data_dir))?;
    std::fs::create_dir_all(dsh_home(data_dir))?;
    std::fs::create_dir_all(harness_log_path(data_dir).parent().unwrap())?;
    Ok(())
}

/// The normal web profile directory inside DSH_HOME.
pub fn web_profile_dir(dsh_home: &Path) -> PathBuf {
    dsh_home.join("profiles").join("web")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_matches_electron() {
        let base = PathBuf::from("/tmp/userdata");
        assert_eq!(launch_root(&base), base.join("launch-root"));
        assert_eq!(dsh_home(&base), base.join("harness"));
        assert_eq!(harness_log_path(&base), base.join("logs").join("harness.log"));
    }
}
