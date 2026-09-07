//! 会话与 Profile 元数据存储与持久化管理（契约 C10 / 任务 P3）。
//!
//! 不变量 **INV-1（资源只读）**：所有 Profile 与 Session 元数据只读/写在 `userData/harness/`
//! （即 `Layout::dsh_home`）下，零修改资源目录。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::contracts::{
    DEFAULT_PROFILE_ID, PROFILES_DIR_NAME, PROFILE_CONFIG_FILE, SESSIONS_DIR_NAME,
};
use crate::HostResult;

/// Profile 元数据描述。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfileMetadata {
    /// 唯一标识符（例如 "default", "safe-mode", "profile-work" 等）
    pub id: String,
    /// 显示名称
    pub name: String,
    /// 描述
    #[serde(default)]
    pub description: Option<String>,
    /// 是否为安全模式 / 隔离 Profile
    #[serde(default)]
    pub is_safe_mode: bool,
    /// 创建时间（ISO-8601 或时间戳字符串）
    #[serde(default)]
    pub created_at: Option<String>,
    /// 最后使用时间
    #[serde(default)]
    pub last_used_at: Option<String>,
    /// 额外配置扩展属性（例如自定义环境变量、禁用的插件列表等）
    #[serde(default)]
    pub extra: HashMap<String, serde_json::Value>,
}

pub type Profile = ProfileMetadata;

impl ProfileMetadata {
    /// 创建一个新的默认 Profile 元数据。
    pub fn new(id: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            description: None,
            is_safe_mode: false,
            created_at: None,
            last_used_at: None,
            extra: HashMap::new(),
        }
    }

    /// 创建一个安全模式隔离 Profile 元数据。
    pub fn new_safe_mode(id: impl Into<String>, name: impl Into<String>) -> Self {
        let mut meta = Self::new(id, name);
        meta.is_safe_mode = true;
        meta
    }
}

/// 会话（Session）元数据。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionMetadata {
    /// 会话唯一 ID
    pub session_id: String,
    /// 关联的 Profile ID
    pub profile_id: String,
    /// 会话标题或主题
    pub title: Option<String>,
    /// 创建时间
    pub created_at: Option<String>,
    /// 最后活跃时间
    pub updated_at: Option<String>,
    /// 会话标签或分类
    #[serde(default)]
    pub tags: Vec<String>,
    /// 会话自定义属性
    #[serde(default)]
    pub attributes: HashMap<String, serde_json::Value>,
}

pub type Session = SessionMetadata;

impl SessionMetadata {
    /// 创建新会话元数据。
    pub fn new(session_id: impl Into<String>, profile_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            profile_id: profile_id.into(),
            title: None,
            created_at: None,
            updated_at: None,
            tags: Vec::new(),
            attributes: HashMap::new(),
        }
    }
}

/// Session & Profile 管理器。
///
/// 负责在 `dsh_home` 路径下对 profiles 和 sessions 进行读取、写入和枚举。
#[derive(Clone, Debug)]
pub struct SessionStore {
    dsh_home: PathBuf,
}

pub type ProfileManager = SessionStore;
pub type SessionManager = SessionStore;

impl SessionStore {
    /// 基于 `dsh_home`（即 `Layout::dsh_home`）构建存储管理器。
    pub fn new(dsh_home: impl AsRef<Path>) -> Self {
        Self {
            dsh_home: dsh_home.as_ref().to_path_buf(),
        }
    }

    /// Profiles 根目录：`<dsh_home>/profiles`。
    pub fn profiles_dir(&self) -> PathBuf {
        self.dsh_home.join(PROFILES_DIR_NAME)
    }

    /// Sessions 根目录：`<dsh_home>/sessions`。
    pub fn sessions_dir(&self) -> PathBuf {
        self.dsh_home.join(SESSIONS_DIR_NAME)
    }

    /// 特定 Profile 目录：`<dsh_home>/profiles/<profile_id>`。
    pub fn profile_dir(&self, profile_id: &str) -> PathBuf {
        self.profiles_dir().join(profile_id)
    }

    /// 特定 Profile 配置文件路径：`<dsh_home>/profiles/<profile_id>/profile.json`。
    pub fn profile_config_path(&self, profile_id: &str) -> PathBuf {
        self.profile_dir(profile_id).join(PROFILE_CONFIG_FILE)
    }

    /// 特定 Session 配置文件路径：`<dsh_home>/sessions/<session_id>.json`。
    pub fn session_path(&self, session_id: &str) -> PathBuf {
        self.sessions_dir().join(format!("{session_id}.json"))
    }

    /// 确保必要目录存在。
    pub fn ensure_dirs(&self) -> HostResult<()> {
        fs::create_dir_all(self.profiles_dir())
            .map_err(|err| crate::HostError::CreateDir(self.profiles_dir(), err))?;
        fs::create_dir_all(self.sessions_dir())
            .map_err(|err| crate::HostError::CreateDir(self.sessions_dir(), err))?;
        Ok(())
    }

    /// 读取或初始化默认 Profile。
    pub fn get_or_create_default_profile(&self) -> HostResult<ProfileMetadata> {
        self.ensure_dirs()?;
        if let Ok(meta) = self.load_profile(DEFAULT_PROFILE_ID) {
            return Ok(meta);
        }
        let default_meta = ProfileMetadata::new(DEFAULT_PROFILE_ID, "Default Profile");
        self.save_profile(&default_meta)?;
        Ok(default_meta)
    }

    /// 保存 Profile 元数据。
    pub fn save_profile(&self, profile: &ProfileMetadata) -> HostResult<()> {
        let dir = self.profile_dir(&profile.id);
        fs::create_dir_all(&dir).map_err(|err| crate::HostError::CreateDir(dir.clone(), err))?;
        let config_path = self.profile_config_path(&profile.id);
        let content = serde_json::to_string_pretty(profile)
            .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))
            .map_err(|err| crate::HostError::CreateDir(config_path.clone(), err))?;
        fs::write(&config_path, content)
            .map_err(|err| crate::HostError::CreateDir(config_path, err))?;
        Ok(())
    }

    /// 加载指定 Profile 元数据。
    pub fn load_profile(&self, profile_id: &str) -> HostResult<ProfileMetadata> {
        let config_path = self.profile_config_path(profile_id);
        let bytes = fs::read(&config_path)
            .map_err(|err| crate::HostError::CreateDir(config_path.clone(), err))?;
        let meta: ProfileMetadata = serde_json::from_slice(&bytes)
            .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))
            .map_err(|err| crate::HostError::CreateDir(config_path, err))?;
        Ok(meta)
    }

    /// 列出所有 Profile 元数据。
    pub fn list_profiles(&self) -> HostResult<Vec<ProfileMetadata>> {
        self.ensure_dirs()?;
        let mut profiles = Vec::new();
        let entries = match fs::read_dir(self.profiles_dir()) {
            Ok(entries) => entries,
            Err(_) => return Ok(profiles),
        };

        for entry in entries.flatten() {
            if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
                let id = entry.file_name().to_string_lossy().to_string();
                if let Ok(meta) = self.load_profile(&id) {
                    profiles.push(meta);
                }
            }
        }
        Ok(profiles)
    }

    /// 删除指定 Profile 及其目录。
    pub fn delete_profile(&self, profile_id: &str) -> HostResult<bool> {
        let dir = self.profile_dir(profile_id);
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(|err| crate::HostError::CreateDir(dir, err))?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// 保存 Session 元数据。
    pub fn save_session(&self, session: &SessionMetadata) -> HostResult<()> {
        self.ensure_dirs()?;
        let path = self.session_path(&session.session_id);
        let content = serde_json::to_string_pretty(session)
            .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))
            .map_err(|err| crate::HostError::CreateDir(path.clone(), err))?;
        fs::write(&path, content).map_err(|err| crate::HostError::CreateDir(path, err))?;
        Ok(())
    }

    /// 加载指定 Session 元数据。
    pub fn load_session(&self, session_id: &str) -> HostResult<SessionMetadata> {
        let path = self.session_path(session_id);
        let bytes =
            fs::read(&path).map_err(|err| crate::HostError::CreateDir(path.clone(), err))?;
        let meta: SessionMetadata = serde_json::from_slice(&bytes)
            .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))
            .map_err(|err| crate::HostError::CreateDir(path, err))?;
        Ok(meta)
    }

    /// 列出所有 Session 元数据。
    pub fn list_sessions(&self) -> HostResult<Vec<SessionMetadata>> {
        self.ensure_dirs()?;
        let mut sessions = Vec::new();
        let entries = match fs::read_dir(self.sessions_dir()) {
            Ok(entries) => entries,
            Err(_) => return Ok(sessions),
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("json") {
                if let Ok(bytes) = fs::read(&path) {
                    if let Ok(meta) = serde_json::from_slice::<SessionMetadata>(&bytes) {
                        sessions.push(meta);
                    }
                }
            }
        }
        Ok(sessions)
    }

    /// 按 Profile ID 过滤 Sessions。
    pub fn list_sessions_for_profile(&self, profile_id: &str) -> HostResult<Vec<SessionMetadata>> {
        let all = self.list_sessions()?;
        Ok(all
            .into_iter()
            .filter(|s| s.profile_id == profile_id)
            .collect())
    }

    /// 删除指定 Session。
    pub fn delete_session(&self, session_id: &str) -> HostResult<bool> {
        let path = self.session_path(session_id);
        if path.exists() {
            fs::remove_file(&path).map_err(|err| crate::HostError::CreateDir(path, err))?;
            Ok(true)
        } else {
            Ok(false)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env::temp_dir;

    #[test]
    fn test_profile_crud() {
        let temp = temp_dir().join("dsh_test_profile_store");
        let _ = fs::remove_dir_all(&temp);
        let store = SessionStore::new(&temp);

        let default_profile = store.get_or_create_default_profile().unwrap();
        assert_eq!(default_profile.id, DEFAULT_PROFILE_ID);
        assert_eq!(default_profile.name, "Default Profile");

        let mut custom = ProfileMetadata::new_safe_mode("safe-1", "Safe Mode 1");
        custom.description = Some("Isolated test profile".into());
        store.save_profile(&custom).unwrap();

        let loaded = store.load_profile("safe-1").unwrap();
        assert_eq!(loaded.id, "safe-1");
        assert!(loaded.is_safe_mode);
        assert_eq!(loaded.description, Some("Isolated test profile".into()));

        let list = store.list_profiles().unwrap();
        assert_eq!(list.len(), 2);

        assert!(store.delete_profile("safe-1").unwrap());
        assert!(!store.delete_profile("safe-1").unwrap());
        assert_eq!(store.list_profiles().unwrap().len(), 1);

        let _ = fs::remove_dir_all(&temp);
    }

    #[test]
    fn test_session_crud() {
        let temp = temp_dir().join("dsh_test_session_store");
        let _ = fs::remove_dir_all(&temp);
        let store = SessionStore::new(&temp);

        let mut session1 = SessionMetadata::new("sess-1", "default");
        session1.title = Some("Session One".into());
        store.save_session(&session1).unwrap();

        let mut session2 = SessionMetadata::new("sess-2", "work");
        session2.title = Some("Session Two".into());
        store.save_session(&session2).unwrap();

        let loaded1 = store.load_session("sess-1").unwrap();
        assert_eq!(loaded1.title, Some("Session One".into()));

        let all = store.list_sessions().unwrap();
        assert_eq!(all.len(), 2);

        let filtered = store.list_sessions_for_profile("default").unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].session_id, "sess-1");

        assert!(store.delete_session("sess-1").unwrap());
        let filtered2 = store.list_sessions_for_profile("default").unwrap();
        assert_eq!(filtered2.len(), 0);

        let _ = fs::remove_dir_all(&temp);
    }
}
