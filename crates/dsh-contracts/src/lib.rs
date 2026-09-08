//! # `dsh-contracts`
//!
//! DeepSeek Harness 桌面外壳的通用契约、协议封套、错误分类与跨平台常量定义库。
//! 该 crate 零 UI 依赖、零 Tauri 依赖，可在任何环境下被跨平台轻量引用。

pub mod constants;
pub mod diagnostics;
pub mod errors;
pub mod ipc;
pub mod lifecycle;
pub mod manifest;
pub mod rpc;

pub use constants::*;
pub use diagnostics::*;
pub use errors::*;
pub use ipc::*;
pub use lifecycle::*;
pub use manifest::*;
pub use rpc::*;
