//! 安全模式配置管理与隔离 Profile 生成（契约 C10 / 任务 P3）。
//!
//! 在 Harness 出现严重故障、插件死锁、循环崩溃时，提供干净隔离的最小化运行配置：
//! - 仅启用官方核心 bundle（如 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`）
//! - 自动生成纯净的 `package.json`、`cordis.patch.yml`、`pnpm-workspace.yaml`
//! - 注入安全模式环境变量 `DSH_SAFE_MODE=1`、`DSH_DISABLE_PLUGINS=1`
//! - 隔离第三方插件与用户 patch 补丁层

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::contracts::{ENV_DSH_SAFE_MODE, ENV_SAFE_MODE_DISABLE_PLUGINS, PROFILES_DIR_NAME};
use crate::paths::Layout;

/// 默认安全模式 profile 名称。
pub const SAFE_MODE_PROFILE: &str = "desktop-safe-mode";

/// 安全模式下允许加载的官方最小核心 bundles 列表。
pub const SAFE_MODE_BUNDLES: [&str; 2] = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];

/// 安全模式下的最小 patch 补丁（清空所有第三方插件挂载）。
pub const SAFE_MODE_PATCH: &str = "# Managed by DSH Desktop Safe Mode.\n\
# Third-party bundles and the normal web profile's patch layer are intentionally omitted.\n\
[]\n";

/// 安全模式下的工作空间配置。
pub const SAFE_MODE_WORKSPACE: &str =
    "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n";

/// 安全模式上下文信息。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SafeModeContext {
    /// 触发安全模式的原因或错误摘要
    pub reason: Option<String>,
    /// 被隔离的可疑插件列表
    pub disabled_plugins: Vec<String>,
    /// 安全模式 profile 路径
    pub profile_path: Option<PathBuf>,
}

/// 安全模式 Profile 配置选项。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SafeModeOptions {
    /// 自定义 profile 标识符，默认 `desktop-safe-mode`
    pub profile_id: String,
    /// 允许的核心 bundle 列表
    pub allowed_bundles: Vec<String>,
    /// 是否强制禁用所有第三方扩展
    pub disable_third_party_plugins: bool,
    /// 是否重置/隔离 patch 补丁层
    pub isolate_patch_layer: bool,
}

impl Default for SafeModeOptions {
    fn default() -> Self {
        Self {
            profile_id: SAFE_MODE_PROFILE.to_string(),
            allowed_bundles: SAFE_MODE_BUNDLES.iter().map(|s| s.to_string()).collect(),
            disable_third_party_plugins: true,
            isolate_patch_layer: true,
        }
    }
}

/// 安全模式管理器。
pub struct SafeModeManager;

impl SafeModeManager {
    /// 确保在指定的 `dsh_home` 目录下构建好隔离的安全模式 Profile 文件。
    ///
    /// # 目录结构
    /// ```text
    /// <dsh_home>/profiles/<profile_id>/
    ///   ├── package.json
    ///   ├── cordis.patch.yml
    ///   └── pnpm-workspace.yaml
    /// ```
    pub fn ensure_safe_mode_profile(dsh_home: &Path) -> std::io::Result<PathBuf> {
        Self::ensure_custom_safe_profile(dsh_home, &SafeModeOptions::default())
    }

    /// 使用自定义选项构建安全模式 Profile 目录。
    pub fn ensure_custom_safe_profile(
        dsh_home: &Path,
        options: &SafeModeOptions,
    ) -> std::io::Result<PathBuf> {
        let directory = dsh_home.join(PROFILES_DIR_NAME).join(&options.profile_id);
        std::fs::create_dir_all(&directory)?;

        let manifest = serde_json::json!({
            "name": format!("dsh-profile-{}", options.profile_id),
            "private": true,
            "dependencies": {},
            "dsh": {
                "profile": {
                    "bundles": options.allowed_bundles
                }
            }
        });
        let manifest_str = format!("{}\n", serde_json::to_string_pretty(&manifest).unwrap());

        write_if_changed(&directory.join("package.json"), &manifest_str)?;
        if options.isolate_patch_layer {
            write_if_changed(&directory.join("cordis.patch.yml"), SAFE_MODE_PATCH)?;
        }
        write_if_changed(&directory.join("pnpm-workspace.yaml"), SAFE_MODE_WORKSPACE)?;

        Ok(directory)
    }

    /// 基于 `Layout` 准备安全模式目录。
    pub fn ensure_profile_from_layout(layout: &Layout) -> std::io::Result<PathBuf> {
        Self::ensure_safe_mode_profile(&layout.dsh_home)
    }

    /// 生成安全模式所需的附加环境变量注入映射。
    pub fn generate_safe_mode_env(options: &SafeModeOptions) -> HashMap<String, String> {
        let mut envs = HashMap::new();
        envs.insert(ENV_DSH_SAFE_MODE.to_string(), "1".to_string());
        if options.disable_third_party_plugins {
            envs.insert(ENV_SAFE_MODE_DISABLE_PLUGINS.to_string(), "1".to_string());
        }
        envs.insert("DSH_PROFILE".to_string(), options.profile_id.clone());
        envs
    }
}

/// 快速函数：构建默认安全模式 profile 目录。
pub fn ensure_safe_mode_profile(dsh_home: &Path) -> std::io::Result<PathBuf> {
    SafeModeManager::ensure_safe_mode_profile(dsh_home)
}

/// 快速函数：生成隔离 profile 配置 JSON。
pub fn generate_isolated_profile_config(options: &SafeModeOptions) -> serde_json::Value {
    serde_json::json!({
        "name": format!("dsh-profile-{}", options.profile_id),
        "private": true,
        "dependencies": {},
        "dsh": {
            "profile": {
                "bundles": options.allowed_bundles
            }
        }
    })
}

/// 仅当内容变更时才写入文件（避免刷新 mtime）。
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
    fn test_ensure_safe_mode_profile() {
        let temp = std::env::temp_dir().join("dsh-safe-mode-host-test");
        let _ = std::fs::remove_dir_all(&temp);
        std::fs::create_dir_all(&temp).unwrap();

        let directory = ensure_safe_mode_profile(&temp).unwrap();
        assert!(directory.join("package.json").exists());
        assert!(directory.join("cordis.patch.yml").exists());
        assert!(directory.join("pnpm-workspace.yaml").exists());

        let manifest = std::fs::read_to_string(directory.join("package.json")).unwrap();
        assert!(manifest.contains("@deepseek-ai/dsh-base"));
        assert!(manifest.contains("@deepseek-ai/dsh-web-app"));

        let envs = SafeModeManager::generate_safe_mode_env(&SafeModeOptions::default());
        assert_eq!(envs.get(ENV_DSH_SAFE_MODE).map(|s| s.as_str()), Some("1"));
        assert_eq!(
            envs.get(ENV_SAFE_MODE_DISABLE_PLUGINS).map(|s| s.as_str()),
            Some("1")
        );
        assert_eq!(
            envs.get("DSH_PROFILE").map(|s| s.as_str()),
            Some(SAFE_MODE_PROFILE)
        );

        let cfg = generate_isolated_profile_config(&SafeModeOptions::default());
        assert!(cfg.get("dsh").is_some());

        let _ = std::fs::remove_dir_all(&temp);
    }
}
