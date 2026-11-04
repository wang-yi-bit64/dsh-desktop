//! 更新失败的归因判据：**阶段是主判据**，错误文本只做阶段内细分。
//!
//! # 为什么这段判据住在无头 crate，而不是 `src-tauri/src/update.rs`
//!
//! 与 [`crate::install`] 同一条理由（`AGENTS.md` §3 的分流判据）：这里是**纯逻辑**
//! ——输入是「当前阶段 + 错误文本」，输出是一个枚举与一个稳定错误码，不碰任何
//! Tauri 类型。留在壳层的代价是**本地无法证伪**：本机 GNU 工具链下 `src-tauri`
//! 的测试二进制加载即 `STATUS_ENTRYPOINT_NOT_FOUND`
//! （`docs/incidents/local-toolchain-limits.md`），而这张表恰恰是 CD05 / CD06 的
//! 全部内容——判据本身跑不起来，「修好了」就只能靠嘴说。
//!
//! 壳层只负责把阶段推对（`UpdateStage` 的原子量、`on_download_finish` 回调），
//! 归因表在这里可被 `cargo test -p dsh-host` 完整覆盖（INV-6）。
//!
//! # 这张表要解决的问题
//!
//! 旧实现用 `percent >= 100` 推断「失败发生在安装还是下载」。它依赖两个前提：
//! ① 进度百分比真被写回状态；② 上游「下载完立刻安装」与百分比涨到 100 同步。
//! 前提 ① 在旧代码里**根本不成立**——进度回调只 `emit` 事件、从不写
//! `self.status`，于是 `percent` 恒为开头写入的 `Some(0.0)`，判定分支永假
//! ⇒ `E1007`（安装失败）成了死码，所有安装失败都被报成下载网络失败（`E1006`）。
//!
//! 改法是让「现在在哪一步」成为显式状态（[`UpdateStage`]），失败时读阶段。
//!
//! # 阶段边界与上游实现的对齐依据
//!
//! 全部对应 tauri-plugin-updater **2.13.0** 的源码位置（`updater.rs`）：
//!
//! | 事实 | 位置 |
//! |------|------|
//! | `download_and_install` 的实现就是 `download(...)` + `install(bytes)` | `:864-871` |
//! | `on_download_finish()` 在**验签之前**触发 | `:835` → `:837` |
//! | `verify_signature` 的失败面只有签名类错误（`MissingSignedVersion` / `SignedVersionMismatch` / `Signature*`） | `:1634`、`error.rs:63,110,120` |
//! | Windows 的 `install_inner` 启动安装器后 `std::process::exit(0)` | `:972` |
//!
//! 最后一条意味着：Windows 上「安装成功」的分支通常**不可达**，可观测的只有
//! 「安装失败」这一面——这正是需要 `E1007` 的原因。

use crate::contracts::{codes, ErrorCategory};

/// 更新流程的当前阶段：失败归因的**主判据**（内部账目，不进 wire）。
///
/// 壳层用 `AtomicU8` 承载它（进度回调是同步闭包，里面 `.await` 不了），
/// 因此这里 `#[repr(u8)]` 并配 [`UpdateStage::from_u8`] 做往返。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum UpdateStage {
    /// 检查阶段：`check()` 开始，或 `download()` 里的前置复查。
    Checking = 0,
    /// 传输阶段：字节还没走完。
    Downloading = 1,
    /// 验签阶段：字节已收完、正在校验签名（上游 `on_download_finish` 之后）。
    Verifying = 2,
    /// 安装阶段：字节已到位且已验签，正在交给安装器。
    Installing = 3,
    /// 重启阶段：用户确认安装，进程即将被替换。
    Restarting = 4,
    /// 终态：检查正常结束，或下载与安装都成功。
    Completed = 5,
}

impl UpdateStage {
    /// 写进 journal 与运行日志的稳定阶段名。
    ///
    /// 刻意保持 `check` / `download` 两个旧词形不变：诊断包里已有按它们检索的
    /// 习惯，换词形等于让历史日志失去可比性。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Checking => "check",
            Self::Downloading => "download",
            Self::Verifying => "verify",
            Self::Installing => "install",
            Self::Restarting => "restart",
            Self::Completed => "completed",
        }
    }

    /// 从原子量还原阶段。
    ///
    /// 越界值收敛到 [`UpdateStage::Completed`]：宁可少报一个失败阶段，也不要
    /// 让一个坏掉的原子量把「安装失败」错位成「下载失败」——那正是本次修复的
    /// 原始缺陷形态。
    pub fn from_u8(raw: u8) -> Self {
        match raw {
            0 => Self::Checking,
            1 => Self::Downloading,
            2 => Self::Verifying,
            3 => Self::Installing,
            4 => Self::Restarting,
            _ => Self::Completed,
        }
    }
}

/// 稳定错误码 + 类别：让页面**分派**而不是匹配字符串。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpdateFailure {
    /// 检查失败且可归因到网络。
    CheckNetwork,
    /// 下载失败且可归因到网络。
    DownloadNetwork,
    /// 安装（重启交接）失败。
    Install,
    /// 签名 / 校验和被拒：不可重试。
    SignatureRejected,
    /// 未细分（分类尽力而为，失败不至丢失原消息）。
    Other,
}

impl UpdateFailure {
    /// 由上游错误文本推断失败类别。
    ///
    /// 只做**保守**匹配：命中的关键词都是网络/传输层的确定性信号。推断不出就归
    /// `Other`——宁可少分类，也不要把「证书不匹配」说成「网络问题」。
    ///
    /// ⚠️ 单用这一个函数不足以归因（它不知道失败发生在哪一步），除非你**只想**
    /// 知道文本像不像网络问题。给失败归类请用 [`UpdateFailure::classify_at`]。
    pub fn classify(error: impl std::fmt::Display) -> Self {
        let text = error.to_string().to_ascii_lowercase();
        if text.contains("signature")
            || text.contains("checksum")
            || text.contains("invalid key")
            || text.contains("pubkey")
        {
            return Self::SignatureRejected;
        }
        let network = [
            "timed out",
            "timeout",
            "refused",
            "unreachable",
            "connection",
            "dns",
            "resolve",
            "network",
            "tls",
            "certificate",
            "proxy",
            "could not connect",
            "error sending request",
        ]
        .iter()
        .any(|hint| text.contains(hint));
        if network {
            Self::CheckNetwork
        } else {
            Self::Other
        }
    }

    /// 由「当前阶段 + 错误文本」共同推断失败类别。
    ///
    /// # 为什么不能只看错误文本
    ///
    /// 同一段文本在不同阶段的含义不同：`signature` 出现在**检查**阶段多为
    /// 公钥/端点配置问题（换配置还能好），出现在**验签**阶段则是「这个包没过」
    /// ——后者不可重试（`E1008` 的语义）。反过来，安装失败的文本往往只写
    /// `failed to install`，按文本分类会掉进 `Other`（`E1003`），把「装不上」
    /// 说成「更新器不可用」。
    pub fn classify_at(stage: UpdateStage, error: impl std::fmt::Display) -> Self {
        let hint = Self::classify(&error);
        match stage {
            // 检查阶段：签名类不可重试；网络类可重试；其余不猜。
            UpdateStage::Checking => match hint {
                Self::SignatureRejected => Self::SignatureRejected,
                Self::CheckNetwork => Self::CheckNetwork,
                _ => Self::Other,
            },
            // 传输阶段：字节没走完就是下载问题。例外是验签类文本——那说明校验
            // 发生在流里（或上游未来改了实现），宁可报「不可重试」。
            UpdateStage::Downloading => match hint {
                Self::SignatureRejected => Self::SignatureRejected,
                _ => Self::DownloadNetwork,
            },
            // 验签阶段：`download()` 在 `on_download_finish` 之后只做
            // `verify_signature`（上游 `:835-840`），这里失败只可能是验签失败。
            UpdateStage::Verifying => Self::SignatureRejected,
            // 安装阶段：字节已到位且已验签，失败只可能是交接安装器。
            UpdateStage::Installing => Self::Install,
            // 终态与重启不发生在这个返回面；真发生了也绝不冒充网络问题。
            UpdateStage::Restarting | UpdateStage::Completed => Self::Other,
        }
    }

    /// 对应的稳定错误码。
    pub fn code(self) -> &'static str {
        match self {
            Self::CheckNetwork => codes::UPDATE_CHECK_NETWORK,
            Self::DownloadNetwork => codes::UPDATE_DOWNLOAD_NETWORK,
            Self::Install => codes::UPDATE_INSTALL_FAILED,
            Self::SignatureRejected => codes::UPDATE_SIGNATURE_REJECTED,
            Self::Other => codes::UPDATER_UNAVAILABLE,
        }
    }

    /// 对应错误族（与 `codes` 模块的族号↔类别测试一致）。
    pub fn category(self) -> ErrorCategory {
        match self {
            Self::CheckNetwork | Self::DownloadNetwork => ErrorCategory::Network,
            Self::Install | Self::SignatureRejected | Self::Other => ErrorCategory::Environment,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 分类必须**保守**：网络信号命中、签名问题不得说成网络、未知归 Other。
    #[test]
    fn failure_classification_is_conservative() {
        assert_eq!(
            UpdateFailure::classify("request timed out after 30s"),
            UpdateFailure::CheckNetwork
        );
        assert_eq!(
            UpdateFailure::classify("error sending request for url"),
            UpdateFailure::CheckNetwork
        );
        assert_eq!(
            UpdateFailure::classify("Could not connect to the server"),
            UpdateFailure::CheckNetwork
        );
        assert_eq!(
            UpdateFailure::classify("signature verification failed"),
            UpdateFailure::SignatureRejected
        );
        assert_eq!(
            UpdateFailure::classify("minisign checksum mismatch"),
            UpdateFailure::SignatureRejected
        );
        // 归 Other 不得声称网络问题（判据：页面不能因此误导用户「检查网络」）。
        assert_eq!(
            UpdateFailure::classify("updater not configured"),
            UpdateFailure::Other
        );
    }

    /// 阶段是失败归因的**主判据**：同一段文本在不同阶段给出不同码。
    ///
    /// 这张表就是 CD05 / CD06 的验收清单——旧实现把「安装失败」判成「下载网络
    /// 失败」（`E1006`），把「检查阶段的签名失败」判成「网络可重试」（`E1005`）。
    #[test]
    fn failure_attribution_follows_stage_not_percent() {
        // ① 检查阶段：签名类不可重试 ⇒ E1008，不是 E1005。
        assert_eq!(
            UpdateFailure::classify_at(UpdateStage::Checking, "signature verification failed")
                .code(),
            codes::UPDATE_SIGNATURE_REJECTED
        );
        // ② 检查阶段：网络类仍是可重试的 E1005。
        assert_eq!(
            UpdateFailure::classify_at(UpdateStage::Checking, "request timed out after 30s").code(),
            codes::UPDATE_CHECK_NETWORK
        );
        // ③ 检查阶段：不认识的失败不得硬说成网络问题（旧实现无条件说网络）。
        assert_eq!(
            UpdateFailure::classify_at(UpdateStage::Checking, "updater not configured").code(),
            codes::UPDATER_UNAVAILABLE
        );
        // ④ 传输阶段：传输层错误一律 E1006。
        assert_eq!(
            UpdateFailure::classify_at(UpdateStage::Downloading, "connection reset by peer").code(),
            codes::UPDATE_DOWNLOAD_NETWORK
        );
        assert_eq!(
            UpdateFailure::classify_at(UpdateStage::Downloading, "unexpected end of file").code(),
            codes::UPDATE_DOWNLOAD_NETWORK
        );
        // ⑤ 安装阶段：文本里一个网络关键词都没有，仍必须是 E1007（不是 E1006）。
        assert_eq!(
            UpdateFailure::classify_at(UpdateStage::Installing, "failed to install the update")
                .code(),
            codes::UPDATE_INSTALL_FAILED
        );
        assert_eq!(
            UpdateFailure::classify_at(UpdateStage::Installing, "NSIS returned exit code 2").code(),
            codes::UPDATE_INSTALL_FAILED
        );
        // ⑥ 验签阶段：只可能是验签失败。
        assert_eq!(
            UpdateFailure::classify_at(UpdateStage::Verifying, "signature version mismatch").code(),
            codes::UPDATE_SIGNATURE_REJECTED
        );
        // ⑦ 终态与重启没有失败面；真发生也不冒充网络问题。
        assert_eq!(
            UpdateFailure::classify_at(UpdateStage::Completed, "connection reset").code(),
            codes::UPDATER_UNAVAILABLE
        );
        assert_eq!(
            UpdateFailure::classify_at(UpdateStage::Restarting, "timed out").code(),
            codes::UPDATER_UNAVAILABLE
        );
    }

    /// 六个阶段必须**各自成态**（不是只有「下载中/装完了」两态）：
    /// 阶段名不得为空、不得重复，原子量往返不得错位——错位会让安装失败
    /// 又静默报成下载失败，正是本次修复的原始缺陷。
    #[test]
    fn every_stage_round_trips_and_is_named() {
        let probes = [
            UpdateStage::Checking,
            UpdateStage::Downloading,
            UpdateStage::Verifying,
            UpdateStage::Installing,
            UpdateStage::Restarting,
            UpdateStage::Completed,
        ];
        let mut names: Vec<&str> = Vec::new();
        for stage in probes {
            assert!(!stage.as_str().is_empty(), "{stage:?} 缺阶段名");
            assert_eq!(
                UpdateStage::from_u8(stage as u8),
                stage,
                "{stage:?} 的原子量往返错位"
            );
            names.push(stage.as_str());
        }
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), probes.len(), "阶段名必须两两不同");
    }

    /// 验签与安装必须给出**不同**的码，否则「阶段能定位失败」无从谈起。
    #[test]
    fn verify_and_install_are_distinguishable() {
        let same_text = "signature checksum mismatch";
        assert_ne!(
            UpdateFailure::classify_at(UpdateStage::Verifying, same_text).code(),
            UpdateFailure::classify_at(UpdateStage::Installing, same_text).code(),
        );
    }

    /// 错误码与类别必须与 `codes` 的族号↔类别约定一致（否则 `gate -- ipc-surface`
    /// 的族号测试会红）。
    #[test]
    fn failure_codes_stay_in_family() {
        for failure in [
            UpdateFailure::CheckNetwork,
            UpdateFailure::DownloadNetwork,
            UpdateFailure::Install,
            UpdateFailure::SignatureRejected,
            UpdateFailure::Other,
        ] {
            let code = failure.code();
            assert!(
                code.starts_with("E1"),
                "{failure:?} 的码 {code} 必须是 E1 族"
            );
        }
        assert_eq!(
            UpdateFailure::CheckNetwork.category(),
            ErrorCategory::Network
        );
        assert_eq!(
            UpdateFailure::SignatureRejected.category(),
            ErrorCategory::Environment
        );
    }
}
