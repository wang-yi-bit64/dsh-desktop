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

// ---------------------------------------------------------------------------
// 安全模式选择的持久化（2026-09-22）
// ---------------------------------------------------------------------------
//
// 缺陷背景见 `dsh-contracts::constants::SAFE_MODE_MARKER_FILE` 的文档。这里只
// 强调一个设计取舍：**判据是「文件是否存在」，不读内容**。
//
// 为什么不用 JSON 记 `{"profile":"desktop-safe-mode"}` 这类结构化内容——那会引入
// 「文件在但解析失败」的第三种状态，而唯一需要表达的意图只有「上次进了安全模式」
// 这一位信息。多一个字段就多一条解析失败路径，而这条路径上「宁可多恢复一次」
// 的取向是明确的。内容写诊断信息只为排障时能看出是谁写的，不参与判定。

/// 安全模式标记文件的完整路径（`<dsh_home>/.safe-mode`）。
pub fn safe_mode_marker_path(dsh_home: &Path) -> PathBuf {
    dsh_home.join(crate::contracts::SAFE_MODE_MARKER_FILE)
}

/// 持久化「下次启动走安全模式」。
///
/// 由进入安全模式的各个入口（菜单项 / 恢复页按钮 / 错误页按钮）在启动前调用。
/// 与 `ensure_safe_mode_profile` 一样只写 `dsh_home` 下的路径（INV-1）。
///
/// 写入内容仅用于排障（谁在什么时候请求的），判定只看文件是否存在。
pub fn persist_safe_mode_request(dsh_home: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dsh_home)?;
    let body = format!(
        "# Written by DSH Desktop when Safe Mode was requested.\n\
         # Presence of this file makes the next app start use the '{SAFE_MODE_PROFILE}' profile.\n\
         # Remove it (or use \"Restart in Normal Mode\") to go back to the default profile.\n"
    );
    std::fs::write(safe_mode_marker_path(dsh_home), body)
}

/// 清除安全模式请求（回到普通模式）。
///
/// 幂等：标记不存在时返回 `Ok(false)`，不算失败——「已经不在了」与「刚删掉」
/// 对调用方是同一个结果。
///
/// # 返回
/// `Ok(true)` 表示确实删掉了一个标记；`Ok(false)` 表示本来就没有。
pub fn clear_safe_mode_request(dsh_home: &Path) -> std::io::Result<bool> {
    let marker = safe_mode_marker_path(dsh_home);
    if !marker.exists() {
        return Ok(false);
    }
    std::fs::remove_file(marker)?;
    Ok(true)
}

/// 上次是否请求过安全模式（启动路径据此决定用哪个 profile）。
///
/// **不读文件内容、不区分损坏**：只要标记存在就返回 `true`。理由见常量文档。
///
/// # 示例
///
/// ```
/// use std::path::Path;
/// use dsh_host::safe_mode::{safe_mode_requested, persist_safe_mode_request, clear_safe_mode_request};
///
/// let dir = std::env::temp_dir().join("dsh-safe-marker-doc");
/// let _ = std::fs::remove_dir_all(&dir);
/// std::fs::create_dir_all(&dir).unwrap();
///
/// assert!(!safe_mode_requested(&dir));
/// persist_safe_mode_request(&dir).unwrap();
/// assert!(safe_mode_requested(&dir));
/// clear_safe_mode_request(&dir).unwrap();
/// assert!(!safe_mode_requested(&dir));
///
/// let _ = std::fs::remove_dir_all(&dir);
/// ```
pub fn safe_mode_requested(dsh_home: &Path) -> bool {
    safe_mode_marker_path(dsh_home).exists()
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

    /// 标记的唯一语义：存在 = 下次走安全模式。写 → 读 → 清 → 再读。
    #[test]
    fn safe_mode_marker_round_trips() {
        let temp = std::env::temp_dir().join(format!("dsh-safe-marker-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);

        // 目录都不存在时「没有请求」——不能因为读不到就 panic（启动路径必经此处）。
        assert!(!safe_mode_requested(&temp), "目录不存在时应视为未请求");

        persist_safe_mode_request(&temp).expect("标记应可写入（含建目录）");
        assert!(safe_mode_requested(&temp));
        assert!(
            safe_mode_marker_path(&temp).starts_with(&temp),
            "标记必须落在 dsh_home 下（INV-1：资源目录只读）"
        );

        assert_eq!(
            clear_safe_mode_request(&temp).expect("清除应成功"),
            true,
            "首次清除应报告确实删掉了"
        );
        assert!(!safe_mode_requested(&temp));
        assert_eq!(
            clear_safe_mode_request(&temp).expect("重复清除不算失败"),
            false,
            "幂等：本来就没有时返回 false 而不是 Err"
        );

        let _ = std::fs::remove_dir_all(&temp);
    }

    /// 判据是「文件是否存在」，因此**内容损坏不影响判定**。
    ///
    /// 这条是刻意的：安全模式是恢复路径，写了一半被杀、内容为空、内容不是文本，
    /// 都仍然表达「上次进了安全模式」这一个意图。若改为解析内容，这些情况会让
    /// 应用退回普通模式——即「坏插件照旧加载」，正是本次要修的症状。
    #[test]
    fn safe_mode_marker_ignores_corrupt_content() {
        let temp = std::env::temp_dir().join(format!("dsh-safe-corrupt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        std::fs::create_dir_all(&temp).unwrap();

        std::fs::write(safe_mode_marker_path(&temp), b"\x00\xff not json at all").unwrap();
        assert!(
            safe_mode_requested(&temp),
            "内容非法时仍须判定为「请求过安全模式」"
        );

        std::fs::write(safe_mode_marker_path(&temp), b"").unwrap();
        assert!(safe_mode_requested(&temp), "空文件同样算请求过");

        let _ = std::fs::remove_dir_all(&temp);
    }
}
