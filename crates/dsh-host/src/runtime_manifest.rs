//! MANIFEST.json 的**读取端**（资源组装清单 → 运行时可自述的身份）。
//!
//! 组装侧的唯一产地是 `scripts/prepare-harness.mjs` 的 `buildManifest()`：
//!
//! ```json
//! {
//!   "fingerprint": "…", "generatedAt": "2026-09-18T…",
//!   "lockfileHash": "…", "target": "alpha",
//!   "versions": { "dsh": "0.1.6-alpha.2", "node": "24.x", "pnpm": "…" },
//!   "patchFilesPresent": 13, "patchesStrict": false,
//!   "patches": [{ "name": "…", "layer": "brand", "outcome": "applied", … }]
//! }
//! ```
//!
//! # 为什么壳层要读它
//!
//! 「反馈问题时说清楚自己装的是哪个运行时」是 issue 模板的第一步，而在两条上游
//! 通道（`next` / `alpha`）并存之后，**光看桌面版本号已经推不出运行时**：同一个
//! `0.6.x` 可能是 alpha 线，也可能是 next 线。清单里的 `target` 与 `versions.dsh`
//! 才是权威答案，因此反馈页直接把它读出来，而不是让用户去翻安装目录。
//!
//! 另一个用途是补丁纪律：`patches[]` 里记着每个补丁是 `applied` / `skipped` /
//! `failed`（`AGENTS.md` §7.1 规则 3 要求降级必须写进产物）。把这些计数一并带进
//! 反馈页，用户报「某个桌面定制没生效」时就有了第一手线索。
//!
//! # 读了什么、不读什么
//!
//! * **只读**：本模块不写清单、不修补、不推导缺失字段。缺字段就是 `None`——
//!   宁可显示 `unknown`，也不猜一个看起来合理的值（§7.1 规则 2）。
//! * 缺失 / 损坏时返回**可辨识的错误**，由调用方决定怎么呈现；不返回空壳对象，
//!   否则「读不到清单」与「清单说没有 patch」会变成同一个结果。
//!
//! ⚠️ 开发态与桩资源（`scripts/stub-tauri-resources.mjs`）写的是
//! `{"assembledAt": "ci-stub", …}`——没有 `target` / `versions` 是**预期形态**，
//! 因此解析必须容忍字段缺失（见 `stub_manifest_parses_with_unknown_identity`）。

use serde::{Deserialize, Serialize};

use crate::error::{HostError, HostResult};
use crate::paths::Layout;

/// 单个补丁的执行结果（`MANIFEST.json` → `patches[]`）。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PatchOutcome {
    /// 补丁名（`patch-package` 的 `<package>+<version>.patch`）。
    #[serde(default)]
    pub name: String,
    /// 分级（`brand` / `ui-behavior` / `functional`）。
    #[serde(default)]
    pub layer: Option<String>,
    /// `applied` / `skipped` / `failed`。
    #[serde(default)]
    pub outcome: Option<String>,
}

impl PatchOutcome {
    /// 是否已应用。判据是**文字相等**，而不是「不是 failed」——未知取值一律算未应用。
    pub fn is_applied(&self) -> bool {
        self.outcome.as_deref() == Some("applied")
    }
}

/// 组装清单的读取结果（字段全部可缺省，见模块文档）。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct RuntimeManifest {
    /// 这份资源属于哪条上游通道（`next` / `alpha`）。
    ///
    /// 与 [`Self::dsh_version`] 分开记录：目标名是「从哪儿来」，版本号是「是哪一版」。
    pub target: Option<String>,
    /// 内置 DSH 运行时版本（`versions.dsh`）。
    pub dsh_version: Option<String>,
    /// 内置 Node 版本（`versions.node`）。
    pub node_version: Option<String>,
    /// 组装时间（`generatedAt`，ISO 8601）。
    pub generated_at: Option<String>,
    /// 清单登记的补丁总数（`patchesStrict` 之外的 `patches[]` 长度口径由组装侧决定）。
    pub patch_total: usize,
    /// 其中 `outcome == "applied"` 的数量。
    pub patch_applied: usize,
    /// 其中 `outcome == "failed"` 的数量。
    pub patch_failed: usize,
    /// 其中 `outcome == "skipped"` 的数量。
    pub patch_skipped: usize,
}

impl RuntimeManifest {
    /// 供界面显示的一行身份描述（未知字段显示 `unknown`，不猜）。
    ///
    /// 形如 `DSH 0.1.6-alpha.2 · channel alpha`；读不到时是 `unknown`。
    pub fn identity_line(&self) -> String {
        let dsh = self.dsh_version.as_deref().unwrap_or("unknown");
        let channel = self.target.as_deref().unwrap_or("unknown");
        format!("DSH {dsh} · channel {channel}")
    }

    /// 补丁统计的一句话摘要，形如 `13 applied, 0 failed, 0 skipped`。
    pub fn patch_summary(&self) -> String {
        format!(
            "{} applied, {} failed, {} skipped",
            self.patch_applied, self.patch_failed, self.patch_skipped
        )
    }
}

/// 反序列化用的裸结构（字段与组装侧一一对应，全部 `Option`）。
///
/// 刻意不复用 [`RuntimeManifest`] 做 `Deserialize`：前者是**面向消费者的形态**
/// （计数已算好），后者是**面向文件的形态**（原始数组）。两者合成一个类型会让
/// 「计数」在反序列化后处于未初始化状态，读的人无从判断它是否可信。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawManifest {
    target: Option<String>,
    versions: Option<RawVersions>,
    generated_at: Option<String>,
    #[serde(default)]
    patches: Vec<PatchOutcome>,
}

#[derive(Debug, Default, Deserialize)]
struct RawVersions {
    dsh: Option<String>,
    node: Option<String>,
}

/// 读取并解析 `<resource_dir>/MANIFEST.json`。
///
/// # 参数
///
/// * `layout` — 目录布局；清单路径取自 [`Layout::manifest`]。
///
/// # 失败
///
/// * 文件不存在 → [`HostError::MissingResource`]（只在桩资源或损坏安装里出现）；
/// * 内容不是 JSON → [`HostError::Environment`]，消息里带**文件路径**与底层解析错误。
pub fn read(layout: &Layout) -> HostResult<RuntimeManifest> {
    let path = &layout.manifest;
    let text = std::fs::read_to_string(path)
        .map_err(|_| HostError::missing(crate::contracts::MANIFEST_FILE, path.clone()))?;
    parse(&text, path)
}

/// 解析清单文本（与 [`read`] 分离，便于无文件单测）。
///
/// # 参数
///
/// * `text` — JSON 文本。
/// * `path` — 出错信息里显示的路径（不参与解析）。
pub fn parse(text: &str, path: &std::path::Path) -> HostResult<RuntimeManifest> {
    let raw: RawManifest = serde_json::from_str(text).map_err(|error| {
        HostError::Environment(format!(
            "{} is not a readable assembly manifest: {error}",
            path.display()
        ))
    })?;

    let patch_applied = raw
        .patches
        .iter()
        .filter(|patch| patch.is_applied())
        .count();
    let patch_failed = raw
        .patches
        .iter()
        .filter(|patch| patch.outcome.as_deref() == Some("failed"))
        .count();
    let patch_skipped = raw
        .patches
        .iter()
        .filter(|patch| patch.outcome.as_deref() == Some("skipped"))
        .count();

    Ok(RuntimeManifest {
        target: raw.target,
        dsh_version: raw.versions.as_ref().and_then(|v| v.dsh.clone()),
        node_version: raw.versions.as_ref().and_then(|v| v.node.clone()),
        generated_at: raw.generated_at,
        patch_total: raw.patches.len(),
        patch_applied,
        patch_failed,
        patch_skipped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path() -> std::path::PathBuf {
        std::path::PathBuf::from("/res/MANIFEST.json")
    }

    /// 正常清单：目标 / 版本 / 补丁统计都要读出来。
    #[test]
    fn reads_target_versions_and_patch_counts() {
        let text = r#"{
          "fingerprint": "abc",
          "generatedAt": "2026-09-18T10:00:00.000Z",
          "lockfileHash": "deadbeef",
          "target": "alpha",
          "versions": { "dsh": "0.1.6-alpha.2", "node": "24.14.0", "pnpm": "9.0.0" },
          "patchFilesPresent": 13,
          "patchesStrict": false,
          "patches": [
            { "name": "a+1.patch", "layer": "brand", "outcome": "applied" },
            { "name": "b+1.patch", "layer": "functional", "outcome": "applied" },
            { "name": "c+1.patch", "layer": "ui-behavior", "outcome": "failed" },
            { "name": "d+1.patch", "layer": "brand", "outcome": "skipped" }
          ]
        }"#;
        let manifest = parse(text, &path()).expect("must parse");
        assert_eq!(manifest.target.as_deref(), Some("alpha"));
        assert_eq!(manifest.dsh_version.as_deref(), Some("0.1.6-alpha.2"));
        assert_eq!(manifest.node_version.as_deref(), Some("24.14.0"));
        assert_eq!(
            manifest.generated_at.as_deref(),
            Some("2026-09-18T10:00:00.000Z")
        );
        assert_eq!(manifest.patch_total, 4);
        assert_eq!(manifest.patch_applied, 2);
        assert_eq!(manifest.patch_failed, 1);
        assert_eq!(manifest.patch_skipped, 1);
        assert_eq!(
            manifest.identity_line(),
            "DSH 0.1.6-alpha.2 · channel alpha"
        );
        assert_eq!(manifest.patch_summary(), "2 applied, 1 failed, 1 skipped");
    }

    /// 桩资源写的清单只有 `assembledAt` / `lockfileHash` / `pinned`——**没有**
    /// `target` 与 `versions`。这是预期形态，必须解析成功并把身份留成 `None`，
    /// 而不是报错或编一个默认通道名。
    #[test]
    fn stub_manifest_parses_with_unknown_identity() {
        let text = r#"{ "assembledAt": "ci-stub", "lockfileHash": "ci-stub", "pinned": {} }"#;
        let manifest = parse(text, &path()).expect("stub manifest must parse");
        assert_eq!(manifest.target, None);
        assert_eq!(manifest.dsh_version, None);
        assert_eq!(manifest.patch_total, 0);
        assert_eq!(manifest.identity_line(), "DSH unknown · channel unknown");
    }

    /// 补丁 outcome 出现未知取值时**不得**算作 applied——否则「补丁没打上」
    /// 会在报告里显示成成功（§7.1 规则 2：禁止伪造成功）。
    #[test]
    fn unknown_patch_outcome_is_not_counted_as_applied() {
        let text = r#"{ "patches": [ { "name": "a+1.patch", "outcome": "half-applied" } ] }"#;
        let manifest = parse(text, &path()).expect("must parse");
        assert_eq!(manifest.patch_total, 1);
        assert_eq!(manifest.patch_applied, 0);
        assert_eq!(manifest.patch_failed, 0);
        assert_eq!(manifest.patch_skipped, 0);
    }

    /// 损坏的清单必须变成可辨识的错误（带路径），而不是静默的空对象。
    #[test]
    fn malformed_manifest_is_an_identifiable_error() {
        let error = parse("{ not json", &path()).expect_err("must fail");
        let message = error.to_string();
        assert!(message.contains("MANIFEST.json"), "{message}");
        assert!(
            message.contains("not a readable assembly manifest"),
            "{message}"
        );
    }

    /// 缺失文件走 `MissingResource`（退出码 3 那一族），与「解析失败」区分开。
    #[test]
    fn missing_manifest_reports_missing_resource() {
        let layout = Layout::resolve("/res-does-not-exist", "/data");
        let error = read(&layout).expect_err("must fail");
        assert!(matches!(error, HostError::MissingResource(..)), "{error:?}");
    }
}
