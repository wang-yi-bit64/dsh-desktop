//! # 资源清单与完整性校验契约

use serde::{Deserialize, Serialize};

/// 捆绑资源清单
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceManifest {
    pub version: String,
    pub created_at: String,
    pub node_version: String,
    pub harness_version: String,
    pub files: Vec<ManifestFileEntry>,
}

/// 清单文件条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestFileEntry {
    pub path: String,
    pub size_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}
