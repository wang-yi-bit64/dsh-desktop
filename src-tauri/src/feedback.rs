//! 应用内反馈入口（批次 0.2-D2）。
//!
//! # 为什么要有这一层，而不是只在菜单里挂一个外链
//!
//! `.github/ISSUE_TEMPLATE/bug_report.yml` 已经把「怎么报」写得很清楚了——
//! 但那条指引躺在 GitHub 上，用户要先离开应用、读完一屏文字，才知道「报告该带
//! 版本、通道、诊断包」。批次 D2 的目标就是**把这一步前移进应用**：
//!
//! * 版本 / 运行时通道 / DSH 版本 / 补丁统计由壳自己读出来（
//!   [`context`]），用户点一下就能复制，不需要去翻安装目录；
//! * 诊断包在同一页里一键导出（复用 `diagnostics_export` 命令，不另开路径）；
//! * 三个出口（Bug / 功能建议 / Discussions）按渠道枚举收敛，见
//!   [`Channel`]——`feedback_open` 只接受这三个值。
//!
//! # 隐私姿态
//!
//! 本模块**不发送任何东西**：它只读取本机信息填进页面、只在用户点击时调用
//! `opener` 打开浏览器。诊断包的脱敏在 `dsh_host::diagnostics_export` 里完成，
//! 上传与否完全由用户在 GitHub 上决定（与 README 的 "Nothing is uploaded
//! anywhere" 一致）。这是本仓**不做遥测**的同一套口径：反馈靠显式渠道。

use serde::Serialize;

use dsh_contracts::constants::{
    FEEDBACK_BUG_REPORT_URL, FEEDBACK_DISCUSSIONS_URL, FEEDBACK_FEATURE_REQUEST_URL,
    PROJECT_REPOSITORY_URL, UPSTREAM_REPOSITORY_URL,
};

use crate::state::AppState;

/// 反馈渠道（`feedback_open` 的 `channel` 参数取值）。
///
/// 枚举而不是裸 URL：命令面只接受这三个值，越界返回 `E7002`。三个渠道的 URL
/// 来自 `dsh-contracts` 的 CX-13 常量，因此仓库迁移时只有一处要改——见那里
/// `feedback_links_derive_from_the_project_repository` 测试。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Channel {
    /// Bug 报告（GitHub issue 表单）。
    Bug,
    /// 功能建议（GitHub issue 表单）。
    Feature,
    /// Discussions（用法提问 / 开放讨论）。
    Discussions,
    /// 上游 Harness 仓库（「这条其实是上游功能」的分诊出口）。
    Upstream,
}

impl Channel {
    /// 解析页面传来的渠道名。**未知值返回 `None`**，调用方据此报 `E7002`——
    /// 不静默回退到某个默认渠道（那会让一个拼错的按钮指向用户没预期的地址）。
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "bug" => Some(Self::Bug),
            "feature" => Some(Self::Feature),
            "discussions" => Some(Self::Discussions),
            "upstream" => Some(Self::Upstream),
            _ => None,
        }
    }

    /// 稳定的渠道标识（用于日志与页面回执）。
    pub fn key(self) -> &'static str {
        match self {
            Self::Bug => "bug",
            Self::Feature => "feature",
            Self::Discussions => "discussions",
            Self::Upstream => "upstream",
        }
    }

    /// 该渠道对应的 URL（唯一产地是 CX-13 常量）。
    pub fn url(self) -> &'static str {
        match self {
            Self::Bug => FEEDBACK_BUG_REPORT_URL,
            Self::Feature => FEEDBACK_FEATURE_REQUEST_URL,
            Self::Discussions => FEEDBACK_DISCUSSIONS_URL,
            Self::Upstream => UPSTREAM_REPOSITORY_URL,
        }
    }
}

/// 页面要展示的本机事实。
#[derive(Clone, Debug, Serialize)]
pub struct FeedbackContext {
    /// 桌面壳版本（`Cargo.toml` 的版本，与 `package.json` 同源）。
    pub app_version: String,
    /// 操作系统（`windows` / `macos` / `linux`）。
    pub platform: String,
    /// CPU 架构。
    pub arch: String,
    /// 内置运行时通道（`next` / `alpha`）；读不到清单时为 `None`。
    pub runtime_channel: Option<String>,
    /// 内置 DSH 版本；读不到清单时为 `None`。
    pub runtime_version: Option<String>,
    /// 运行时身份的一行摘要（见 `dsh_host::runtime_manifest`）。
    pub runtime_identity: String,
    /// 补丁统计摘要（`13 applied, 0 failed, 0 skipped`）。
    pub patch_summary: String,
    /// 组装清单是否可读。`false` 时页面应提示「安装可能不完整」，而不是
    /// 把 `unknown` 当成正常值展示。
    pub manifest_readable: bool,
    /// 读不到清单时的原因（原样展示，供用户贴进 issue）。
    pub manifest_error: Option<String>,
    /// 诊断包目录（用户要附的就是这里的产物）。
    pub exports_dir: String,
    /// 日志目录。
    pub log_dir: String,
    /// 四个渠道的 URL（页面渲染按钮用，避免前端再写一份字面量）。
    pub channels: Channels,
}

/// 渠道 URL 集合（字段名与 [`Channel`] 一一对应）。
#[derive(Clone, Debug, Serialize)]
pub struct Channels {
    /// Bug 报告。
    pub bug: String,
    /// 功能建议。
    pub feature: String,
    /// Discussions。
    pub discussions: String,
    /// 上游仓库。
    pub upstream: String,
    /// 项目主页。
    pub repository: String,
}

/// 组装页面要显示的本机事实。
///
/// 清单读取失败**不当作致命**：反馈页恰恰是「安装可能坏了」时最需要打开的页面，
/// 若因为读不到清单就报错，用户会连反馈入口都用不了。失败转成
/// [`FeedbackContext::manifest_readable`] + [`FeedbackContext::manifest_error`]
/// 两个字段如实上报（§7.1 规则 3：允许降级，但必须可见）。
pub fn context(state: &AppState) -> FeedbackContext {
    let (manifest, manifest_error) = match dsh_host::runtime_manifest::read(&state.layout) {
        Ok(manifest) => (Some(manifest), None),
        Err(error) => (None, Some(error.to_string())),
    };

    let exports_dir = state
        .layout
        .app_data_dir
        .join(dsh_contracts::constants::EXPORTS_DIR_NAME);
    let log_dir = state
        .layout
        .log_path
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(|| state.layout.app_data_dir.clone());

    FeedbackContext {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        runtime_channel: manifest.as_ref().and_then(|m| m.target.clone()),
        runtime_version: manifest.as_ref().and_then(|m| m.dsh_version.clone()),
        runtime_identity: manifest
            .as_ref()
            .map(|m| m.identity_line())
            .unwrap_or_else(|| "unknown".to_string()),
        patch_summary: manifest
            .as_ref()
            .map(|m| m.patch_summary())
            .unwrap_or_else(|| "unknown".to_string()),
        manifest_readable: manifest.is_some(),
        manifest_error,
        exports_dir: exports_dir.display().to_string(),
        log_dir: log_dir.display().to_string(),
        channels: Channels {
            bug: FEEDBACK_BUG_REPORT_URL.to_string(),
            feature: FEEDBACK_FEATURE_REQUEST_URL.to_string(),
            discussions: FEEDBACK_DISCUSSIONS_URL.to_string(),
            upstream: UPSTREAM_REPOSITORY_URL.to_string(),
            repository: PROJECT_REPOSITORY_URL.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 渠道解析必须**双向**对得上：每个已知 key 都能解析，且解析结果的 URL
    /// 与 CX-13 常量逐字相同。
    ///
    /// 这条钉的是「页面写 'bug'、这里匹配 'bugs'」这类静默断线——它不会造成
    /// 编译错误，只会让按钮点了没反应（或开到错的地址）。
    #[test]
    fn channel_keys_round_trip() {
        for (key, expected) in [
            ("bug", Channel::Bug),
            ("feature", Channel::Feature),
            ("discussions", Channel::Discussions),
            ("upstream", Channel::Upstream),
        ] {
            let parsed = Channel::parse(key).unwrap_or_else(|| panic!("`{key}` must parse"));
            assert_eq!(parsed, expected);
            assert_eq!(parsed.key(), key, "key() must round-trip `{key}`");
            assert!(!parsed.url().is_empty());
        }
    }

    /// 未登记的渠道**必须**被拒绝：不静默回退到 bug 表单。
    ///
    /// 可证伪：把 `parse` 的 `_ =>` 改成 `Some(Self::Bug)`，本测试立刻失败。
    #[test]
    fn unknown_channel_is_rejected_not_defaulted() {
        for value in [
            "",
            "bugs",
            "BUG",
            "https://evil.example/",
            "javascript:alert(1)",
        ] {
            assert!(
                Channel::parse(value).is_none(),
                "`{value}` must not be accepted as a channel"
            );
        }
    }

    /// 四个渠道必须指向四个**不同**的地址——把两个渠道写成同一个 URL
    /// （复制粘贴漏改）会让页面出现两个行为相同的按钮，用户看不出问题所在。
    #[test]
    fn channels_point_at_distinct_urls() {
        let urls: Vec<&str> = [
            Channel::Bug,
            Channel::Feature,
            Channel::Discussions,
            Channel::Upstream,
        ]
        .into_iter()
        .map(Channel::url)
        .collect();
        let unique: std::collections::HashSet<&&str> = urls.iter().collect();
        assert_eq!(unique.len(), urls.len(), "{urls:?}");
    }
}
