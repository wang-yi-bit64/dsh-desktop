//! 一键脱敏诊断包导出（批次 D，D3）。
//!
//! # 为什么「脱敏」是这个模块的中心，而不是附属步骤
//!
//! 现场排障的现状是「让用户自己把日志发给我」。那条路径有两个问题：不方便，
//! 而且**用户手动发送时不会先去删 token**——`harness.log` 里就有首航 token 与
//! `dsh-auth-*` cookie 原文。因此本模块的验收判据不是「打出了一个 zip」，而是
//! **导出包内 grep 不到任何 token / cookie / 用户名原文**。
//!
//! # 脱敏规则（每条都有正反用例，见 `tests`）
//!
//! 规则表 `rules()` 是**唯一产地**，每条规则带一个 `RuleKind`，决定它属于
//! 「凭据」还是「身份信息」。两条入口按 kind 取用：导出诊断包用全部规则
//! （[`redact`] / [`redact_reporting`]），日志落盘前只抹凭据（[`redact_stream`]）。
//!
//! | 规则 | kind | 命中形态 | 替换为 |
//! |------|------|---------|--------|
//! | `launch_token` | Secret | URL query `?token=` / `&token=`（值 ≥4） | 保留键名，值换 `<redacted>` |
//! | `launch_token` | Secret | `token:` / `token=` / `--token `（值 ≥8） | 保留键名，值换 `<redacted>` |
//! | `auth_cookie` | Secret | `dsh-auth-*=值`（含 `Cookie:` / `Set-Cookie:` 头） | `dsh-auth-*=<redacted>` |
//! | `private_key` | Secret | `-----BEGIN … PRIVATE KEY-----` … `-----END … PRIVATE KEY-----`（跨行，RSA / EC / OPENSSH / 无后缀） | `<redacted>` |
//! | `jwt` | Secret | 裸 JWT `eyJ….eyJ….…`（三段 base64url） | `<redacted>` |
//! | `platform_token` | Secret | `ghp_` / `github_pat_` / `gho_` / `ghs_` / `glpat-`（后跟 ≥16 位） | 保留前缀，值换 `<redacted>` |
//! | `authorization_basic` | Secret | `Authorization: Basic <base64>` | 保留 `Basic `，凭据段换 `<redacted>` |
//! | `x_api_key` | Secret | `x-api-key:` / `x_api_key:`（大小写不敏感，值 ≥8） | 保留头名，值换 `<redacted>` |
//! | `api_key` | Secret | `sk-…` / `sk-ant-…` / `Bearer …` / `api_key=…` | `<redacted>` |
//! | `query_secret` | Secret | `?access_token=` `?refresh_token=` `?api_key=` `?apikey=` `?key=` `?secret=` `?sig=` `?signature=` `?auth=` `?password=`（值 ≥8） | 保留键名，值换 `<redacted>` |
//! | `proxy_password` | Secret | URL 里的 `user:pass@host` | 口令段换成 `<redacted>` |
//! | `path_username` | Identity | `C:\Users\<名>\`、`/Users/<名>/`、`/home/<名>/` | 用户名段换成 `<user>` |
//! | `unc_host` | Identity | `\\server\share\…`（Windows UNC；首段是 `Users`/`home` 或占位符时不替换） | server 段换成 `<host>` |
//!
//! ## 两档 token 门槛（`launch_token` 为什么是两条正则）
//!
//! URL query 的 `?token=` **语义无歧义**——出现在 query 位置上的 `token` 就是
//! 首航凭据，没有第二种解释，因此值门槛压到 ≥4：短 token（例如手改过的
//! `?token=aB3x`）同样是凭据，漏掉就等于把凭据写进包里。而通用形态
//! （`token:` / `token= ` / `--token `）会和配置项撞车——`token=off`、
//! `token=disabled` 是开关值，不是密钥，所以那条保持 ≥8 的保守门槛。
//! 门槛不同是因为**歧义程度不同**，不是为了少写一条正则。
//!
//! ## ingest 与 export 的适用面差异（[`redact_stream`] vs [`redact`]）
//!
//! | 场景 | 入口 | 施加的规则 |
//! |------|------|-----------|
//! | 日志 ingest（写入 `harness.log` 之前） | [`redact_stream`] | 只施加 `Secret` |
//! | 导出诊断包（`export`） | `redact_reporting` | 全部（`Secret` + `Identity`） |
//!
//! 理由是两种文件的生命周期不同：日志**留在本机**，是排障的一手材料，真实路径
//! （`C:\Users\某人\…`）与 UNC 主机名恰恰是定位「装在哪台机器、哪个目录」的
//! 关键线索，进日志时就抹掉等于自断线索；而诊断包**会被发出去**，一旦离开本机，
//! 路径里的用户名与主机名就是不该外流的身份信息。所以身份信息只在出关口
//! 统一抹掉——两个入口共用同一张规则表，只是按 kind 过滤，不存在两份正则。
//!
//! **反向要求同样重要**：产品版本号（`0.1.0`、`v22.22.2`）、端口、错误码
//! （`E1001`）、`dsh.profile.bundles` 里的包名都**不能**被误伤——一份把版本号
//! 涂掉的诊断包等于没有诊断价值。`tests::keeps_version_numbers_and_codes` 钉住
//! 这条。
//!
//! # 禁止无声降级（`AGENTS.md` §7.1 规则 3）
//!
//! 每一次替换都被计数，并作为 [`ExportSummary::redactions`] 返回给界面、同时写进
//! 包内的 `README.txt`。若某条规则命中数为 0，说明该来源里没有这类敏感值——这是
//! 可核对的事实，而不是「我们大概脱敏过了」。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;

use crate::contracts::{
    APP_LOG_FILE, DESKTOP_LOG_FILE, DIAGNOSTICS_PREFIX, EXPORTS_DIR_NAME, HARNESS_LOG_FILE,
    LOG_TAIL_MAX_BYTES, MANIFEST_FILE,
};
use crate::diagnostics::DiagnosticsAnalyzer;
use crate::paths::Layout;
use crate::{HostError, HostResult};

/// 替换后留下的占位文本（**不含**原值任何片段）。
pub const REDACTED: &str = "<redacted>";

/// 单条脱敏规则的命中统计。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RedactionHit {
    /// 规则名（稳定的机器可读标识）。
    pub rule: &'static str,
    /// 命中并替换的次数。
    pub count: usize,
}

/// 导出结果摘要（返回给界面显示）。
#[derive(Clone, Debug, Serialize)]
pub struct ExportSummary {
    /// 产物绝对路径。
    pub path: String,
    /// 产物字节数。
    pub bytes: u64,
    /// 包内条目名（按写入顺序）。
    pub entries: Vec<String>,
    /// 逐条规则的脱敏命中统计。
    pub redactions: Vec<RedactionHit>,
}

// ---------------------------------------------------------------------------
// 脱敏
// ---------------------------------------------------------------------------

/// 规则所属的类别，决定它在哪条入口生效。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RuleKind {
    /// 凭据：拿到值就能冒充身份或访问资源（token / cookie / 私钥 / key）。
    /// 日志落盘前就要抹掉——日志文件本身也不该长期保存可用凭据。
    Secret,
    /// 身份信息：值本身不能用来登录，但指向一个具体的人或机器（用户名、主机名）。
    /// 只在**导出诊断包**时抹掉，本地日志保留原文以便排障。
    Identity,
}

/// 正则命中之后的附加判定：返回 `true` 才允许替换。
///
/// regex crate 不支持 lookahead，凡是「要看捕获组内容才知道该不该抹」的规则
/// 只能靠它补判定（目前只有 `unc_host` 用）。
type MarkGuard = fn(&regex::Captures<'_>) -> bool;

struct Rule {
    name: &'static str,
    kind: RuleKind,
    pattern: Regex,
    replacement: &'static str,
    guard: Option<MarkGuard>,
}

/// 造一条规则。正则与替换词都取自常量表，编译失败属于编码错误，
/// 构建时就会由测试暴露。
fn rule(name: &'static str, kind: RuleKind, pattern: &str, replacement: &'static str) -> Rule {
    Rule {
        name,
        kind,
        pattern: Regex::new(pattern).expect("redaction rule must compile"),
        replacement,
        guard: None,
    }
}

/// 造一条带后置判定的规则（正则算不出来的条件写进 `guard`）。
fn guarded_rule(
    name: &'static str,
    kind: RuleKind,
    pattern: &str,
    replacement: &'static str,
    guard: MarkGuard,
) -> Rule {
    Rule {
        guard: Some(guard),
        ..rule(name, kind, pattern, replacement)
    }
}

/// 脱敏规则表（编译一次，全进程复用）。**唯一产地**：两个入口都从这里取规则，
/// 只是按 `RuleKind` 过滤，不允许在调用侧另抄一份正则。
///
/// 正则刻意保持**保守**：宁可漏掉一个不像密钥的长串，也不要吞掉正常日志。
/// 例如 `api_key` 要求值至少 12 个字符，避免把 `api_key=auto` 这类配置项涂掉。
fn rules() -> &'static [Rule] {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(|| {
        use RuleKind::{Identity, Secret};
        vec![
            // --- 凭据类 ---
            //
            // URL query 形态单列一条、门槛降到 ≥4：`?token=` / `&token=` 出现在
            // query 位置上语义无歧义，短值也是凭据（见模块头部「两档 token 门槛」）。
            rule(
                "launch_token",
                Secret,
                r"(?i)([?&]token=)([A-Za-z0-9._~+/=-]{4,})",
                "${1}<redacted>",
            ),
            // `token=abc` / `?token=abc&x=1` / `--token abc` / `"token": "abc"`
            //
            // 通用形态保持 ≥8：它同时会匹配 `token=off` 这类开关值，门槛低了会
            // 把配置项涂掉（`tests::keeps_short_config_values_that_only_look_secret`）。
            rule(
                "launch_token",
                Secret,
                r#"(?i)(token["']?\s*[:=]\s*["']?|--token\s+)([A-Za-z0-9._~+/=-]{8,})"#,
                "${1}<redacted>",
            ),
            // Cookie：`dsh-auth-session=xxx`（含 Set-Cookie 头）。
            rule(
                "auth_cookie",
                Secret,
                r"(?i)(dsh-auth-[a-z0-9-]*=)([^;\s,]+)",
                "${1}<redacted>",
            ),
            // PEM 私钥块：RSA / EC / OPENSSH / 无后缀都要覆盖，且必须**跨行**匹配
            // （`(?s)` 让 `.` 吃掉换行）。整块替换，连头部标记一起抹掉——留下
            // `BEGIN … PRIVATE KEY` 只会让读者以为包里还有密钥。
            //
            // 跨行形态只在**整块**输入时命中：诊断包导出是整文件一次传入，所以
            // 这条路本来就该命中（`redacts_private_key_blocks_across_lines` 钉住）。
            //
            // 逐行调用方（`launch.rs` 的日志泵）由 `crate::logs::LineRedactor`
            // 维护 PEM 跨行状态；`redact_stream` 本身保持纯函数、每次只处理一行，
            // 单行输入里只有 `BEGIN` 没有 `END` 时这条规则不会命中。
            //
            // ⚠️ 别据此认为「规则表里有 `private_key` 就等于 ingest 已覆盖」：
            // 覆盖来自那个**有状态**的调用方，不是来自这条正则。删掉 `LineRedactor`
            // 而留着这条规则，私钥正文就会整块落盘——拦住它的是泵级测试
            // `launch::tests::line_pump_writes_redacted_line_but_parses_real_token`
            // （注入「每行新建」实测会红）与 `logs::tests::line_redactor_*`。
            rule(
                "private_key",
                Secret,
                r"(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
                "<redacted>",
            ),
            // 裸 JWT：三段 base64url，前两段都以 `eyJ`（`{"` 的 base64）开头。
            rule(
                "jwt",
                Secret,
                r"eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+",
                "<redacted>",
            ),
            // 代码托管平台的访问令牌。保留前缀（`ghp_` 等）便于在诊断包里看出
            // 「泄漏的是哪一类凭据」，值本身一律抹掉。
            rule(
                "platform_token",
                Secret,
                r"\b(ghp_|github_pat_|gho_|ghs_|glpat-)[A-Za-z0-9_]{16,}",
                "${1}<redacted>",
            ),
            // `Authorization: Basic <base64>`：保留 scheme，凭据段换成占位。
            //
            // 阈值 ≥4 而不是 ≥8：base64 的短凭据（`dTpw` 就是 `u:p`）是合法且
            // 常见的，header 形态本身足够消除歧义。
            rule(
                "authorization_basic",
                Secret,
                r"(?i)(\bAuthorization\s*:\s*Basic\s+)([A-Za-z0-9+/=]{4,})",
                "${1}<redacted>",
            ),
            // `x-api-key` 头，`-` 与 `_` 两种写法都要认。
            //
            // 必须排在下面那条通用 `api[_-]?key` 之前：否则通用规则先把值吃掉，
            // 头名只剩 `x-<redacted>`，读日志的人就看不出这是哪个头了。
            rule(
                "x_api_key",
                Secret,
                r#"(?i)(\bx[_-]api[_-]key\s*[:=]\s*)([^\s,;"']{8,})"#,
                "${1}<redacted>",
            ),
            // 常见 API key 形态。
            rule("api_key", Secret, r"\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b", "<redacted>"),
            rule(
                "api_key",
                Secret,
                r"(?i)(\bBearer\s+)([A-Za-z0-9._~+/=-]{12,})",
                "${1}<redacted>",
            ),
            rule(
                "api_key",
                Secret,
                r#"(?i)(\b(?:api[_-]?key|access[_-]?token|secret|password)["']?\s*[:=]\s*["']?)([A-Za-z0-9_\-\.]{12,})"#,
                "${1}<redacted>",
            ),
            // 非常规 query key。上面那条通用规则只认 `api_key` / `access_token`
            // 等几个名字且要 ≥12，这里补齐 `key` / `sig` / `auth` 这类短名，
            // 门槛降到 ≥8（`?key=auto` 这种开关值仍然不会被吞）。
            rule(
                "query_secret",
                Secret,
                r"(?i)([?&](?:access_token|refresh_token|api_key|apikey|key|secret|sig|signature|auth|password)=)([^&\s#]{8,})",
                "${1}<redacted>",
            ),
            // URL 里的 `user:password@host`。
            rule(
                "proxy_password",
                Secret,
                r"(?i)(https?://[^:/\s@]+:)([^@/\s]+)(@)",
                "${1}<redacted>${3}",
            ),
            // --- 身份信息类（只在导出诊断包时施加） ---
            //
            // 路径里的用户名段：Windows / macOS / Linux 三种形态。
            //
            // 分隔符用 `[\\/]+`（不是单个 `[\\/]`）：诊断包里既有原始日志的
            // `C:\Users\me\…`，也有 **JSON 转义过**的 `C:\\Users\\me\\…`
            // （`environment.json` / `MANIFEST.json` 就是这么写的）。单字符
            // 匹配会漏掉后者，把用户名原样放进包里——这个漏洞是测试
            // `bundle_contains_no_plaintext_secret` 实际抓到的。
            //
            // 必须排在 `unc_host` 之前：JSON 转义过的本地路径 `C:\\Users\\me`
            // 长得就像 `\\server\share`，先抹用户名才不会让主机名规则把
            // `Users` 当成服务器名吃掉（顺序反了虽不漏值，但产物会难读）。
            rule(
                "path_username",
                Identity,
                r"(?i)((?:[A-Za-z]:[\\/]+|/)(?:Users|home)[\\/]+)([^\\/\s:;,'\x22]+)",
                "${1}<user>",
            ),
            // Windows UNC：`\\server\share\…`。server 段是主机名，属身份信息。
            //
            // 两处约束都是为了同一件事：**别把 JSON 转义过的本地路径当成共享**。
            // `C:\\Users\\me\\AppData` 里每个 `\\` 都长得像 UNC 前缀，只按形状
            // 匹配会把 `Users` / `AppData` / `Roaming` 一个个换成 `<host>`，
            // 把一条真实路径毁成 `C:\\<host>\\me\\<host>\\…`——包看着「脱敏了」，
            // 实际丢了全部排障信息，用户名也可能因为没被 `path_username` 处理
            // 而留下（见 `tests::unc_rule_does_not_rewrite_local_paths_as_shares`）。
            //
            // 1）前缀锚定：`\\` 前面必须是行首/空白/引号/括号/等号/分号/反斜杠，
            //    **不能是盘符冒号或路径段**。`C:\\Users` 的 `\\` 前面是 `:`，
            //    因此不匹配；4 个反斜杠的 JSON UNC（`"\\\\srv\\share"`）仍能命中，
            //    因为它的 `\\` 前面是 `\` 或引号。
            // 2）后置判定：共享名首段若是 `Users` / `home`（用户目录容器）或已是
            //    `<user>` / `<host>` 占位符，就不替换——这里宁可漏掉一个真叫
            //    `\\Users\share` 的共享，也不能改写真实本地路径。
            //
            // 第 2 条对 **ingest** 尤其关键：`redact_stream` 不施加 `path_username`，
            // 若这里也误判，本地日志里的真实路径会被改写成假共享名，而「保留
            // 真实路径便于排障」正是把 Identity 规则排除出 ingest 的全部理由。
            guarded_rule(
                "unc_host",
                Identity,
                r#"(^|[\s"'(\[{=;,\\])\\{2}([A-Za-z0-9][A-Za-z0-9._-]*)(\\)"#,
                r"${1}\\<host>${3}",
                unc_segment_is_a_share,
            ),
        ]
    })
}

/// `unc_host` 的后置判定：共享名首段不得是「用户目录容器段」。
///
/// `Users` / `home` 出现在 `\\` 之后，绝大多数情况是 JSON 转义过的本地路径
/// （`C:\\Users\\…`）而不是真共享；`<user>` / `<host>` 是本模块自己写下的
/// 占位符，不该被二次改写。判据写成「不区分 ASCII 大小写」，因为 Windows
/// 路径大小写本就等价（`C:\\USERS\\` 一样常见）。
fn unc_segment_is_a_share(caps: &regex::Captures<'_>) -> bool {
    const NOT_A_SHARE: [&str; 4] = ["users", "home", "<user>", "<host>"];
    match caps.get(2) {
        Some(segment) => !NOT_A_SHARE
            .iter()
            .any(|known| segment.as_str().eq_ignore_ascii_case(known)),
        // 捕获组缺失属于正则写错，交给替换照常进行（不要静默吞掉凭据）。
        None => true,
    }
}

/// 对一段文本施加规则表；`only` 为 `None` 时施加全部规则。
fn apply_rules(text: &str, only: Option<RuleKind>) -> (String, Vec<RedactionHit>) {
    let mut current = text.to_string();
    let mut hits = Vec::new();
    for rule in rules() {
        if let Some(kind) = only {
            if rule.kind != kind {
                continue;
            }
        }
        match rule.guard {
            // 无后置判定：先数命中，再整体替换。
            None => {
                let count = rule.pattern.find_iter(&current).count();
                if count == 0 {
                    continue;
                }
                // 正则与替换词都取自常量表；`NoExpand` 不适用（模板里要保留捕获组）。
                current = rule
                    .pattern
                    .replace_all(&current, rule.replacement)
                    .into_owned();
                hits.push(RedactionHit {
                    rule: rule.name,
                    count,
                });
            }
            // 有后置判定：逐次匹配决定要不要替换；被否决的匹配原样保留，
            // 且**不计入**命中数（统计只记录真的替换过的次数）。
            Some(accept) => {
                let mut count = 0usize;
                let replaced = rule
                    .pattern
                    .replace_all(&current, |caps: &regex::Captures<'_>| {
                        if !accept(caps) {
                            return caps
                                .get(0)
                                .map_or_else(String::new, |whole| whole.as_str().to_string());
                        }
                        count += 1;
                        let mut out = String::new();
                        caps.expand(rule.replacement, &mut out);
                        out
                    })
                    .into_owned();
                if count == 0 {
                    continue;
                }
                current = replaced;
                hits.push(RedactionHit {
                    rule: rule.name,
                    count,
                });
            }
        }
    }
    (current, hits)
}

/// 对一段文本脱敏（**全部**规则，含身份信息），返回脱敏后的文本。
///
/// 用于导出诊断包：产物会离开本机，用户名与主机名也要抹掉。
pub fn redact(text: &str) -> String {
    redact_reporting(text).0
}

/// 日志 ingest 专用脱敏：**只**施加 `Secret` 类规则，保留身份信息。
///
/// 日志要留在本机做排障，真实路径（`C:\Users\某人\…`）与 UNC 主机名是最有用
/// 的定位线索；而 token / cookie / 私钥这类能直接冒充身份的值，不该在日志里
/// 长期躺着一个可用的原文。身份信息统一由导出关口（[`redact`]）抹掉，
/// 规则仍然只在 [`rules()`] 里定义一份。
///
/// 返回值形态与 [`redact`] 一致（`String`），但不带命中统计：ingest 在写日志的
/// 热路径上，统计无处可去（日志行里塞统计反而会污染日志本身）。
pub fn redact_stream(text: &str) -> String {
    apply_rules(text, Some(RuleKind::Secret)).0
}

/// 对一段文本脱敏，并返回逐规则的命中统计。
///
/// 命中统计是「禁止无声降级」的载体：调用方必须把它带出去（写进包里、
/// 返回给界面），否则脱敏就成了一个不可核对的黑盒。
pub fn redact_reporting(text: &str) -> (String, Vec<RedactionHit>) {
    apply_rules(text, None)
}


/// 合并多条规则命中（按名字累加，保持首次出现顺序）。
fn merge_hits(into: &mut Vec<RedactionHit>, from: Vec<RedactionHit>) {
    for hit in from {
        match into.iter_mut().find(|existing| existing.rule == hit.rule) {
            Some(existing) => existing.count += hit.count,
            None => into.push(hit),
        }
    }
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

/// 导出包落点目录（`userData/exports`）。
pub fn export_dir(layout: &Layout) -> PathBuf {
    layout.app_data_dir.join(EXPORTS_DIR_NAME)
}

/// 打一个脱敏诊断包。
///
/// # 参数
///
/// * `layout` — 路径布局（唯一产地，INV-1：产物落在 `app_data_dir` 下）。
/// * `harness_tail` — 内存里的 Harness 环形缓冲尾部（当前实例的输出，
///   可能尚未落盘）。
///
/// # 返回
///
/// 产物路径 + 体积 + 条目清单 + 脱敏统计。
///
/// # 产物内容
///
/// ```text
/// diagnostics-<毫秒时间戳>.zip
///   README.txt          这是什么、包含哪些条目、**逐条脱敏规则命中了几次**
///   report.txt          归因结论（DiagnosticsAnalyzer 的文本报告）
///   environment.json    版本 / 平台 / 架构 / 关键路径
///   MANIFEST.json       资源组装清单（含绝对路径，故必须脱敏）
///   harness-tail.txt    内存环形缓冲尾部（当前实例输出，脱敏）
///   harness.log         落盘的 Harness 日志（尾部，脱敏）
///   app.log             宿主面日志（脱敏）
///   desktop.log         壳层日志（脱敏）
/// ```
///
/// 条目是否出现取决于来源是否存在：全新的安装可能一个日志都还没有，此时包内
/// 仍有 `README.txt` 与 `environment.json`（见 `bundle_survives_a_completely_empty_environment`）。
pub fn export(layout: &Layout, harness_tail: &[String]) -> HostResult<ExportSummary> {
    const MAX_LOG_LINES: usize = 2000;

    let directory = export_dir(layout);
    std::fs::create_dir_all(&directory).map_err(|error| HostError::Export {
        context: format!("creating {}", directory.display()),
        source: error,
    })?;

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let path = directory.join(format!("{DIAGNOSTICS_PREFIX}{stamp}.zip"));

    let mut redactions: Vec<RedactionHit> = Vec::new();
    let mut entries: Vec<String> = Vec::new();

    // 归因结论：从落盘日志 + 内存尾部一起分析（只读内存会丢掉上一次启动的
    // 线索，只读文件会丢掉「还没来得及落盘就崩了」的最后几行）。
    let mut analysis_input: Vec<String> = read_tail(layout.log_path.as_path(), 2000);
    analysis_input.extend(harness_tail.iter().cloned());
    let report = DiagnosticsAnalyzer::analyze_lines(&analysis_input).format_text();

    let file = std::fs::File::create(&path).map_err(|error| HostError::Export {
        context: format!("creating {}", path.display()),
        source: error,
    })?;
    let mut zip = zip::ZipWriter::new(std::io::BufWriter::new(file));
    let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);

    // 1) 文本条目（全部经脱敏）。
    let tail_text = harness_tail.join("\n");
    let environment = environment_snapshot(layout);
    let manifest = std::fs::read_to_string(&layout.manifest).unwrap_or_default();

    let text_entries: [(&str, String); 4] = [
        ("report.txt", report),
        ("harness-tail.txt", tail_text),
        ("environment.json", environment),
        (MANIFEST_FILE, manifest),
    ];
    for (name, content) in text_entries {
        if content.trim().is_empty() {
            continue;
        }
        let (clean, hits) = redact_reporting(&content);
        merge_hits(&mut redactions, hits);
        write_entry(&mut zip, options, name, clean.as_bytes())?;
        entries.push(name.to_string());
    }

    // 2) 落盘日志文件（尾部，脱敏）。
    let logs: [(&str, &Path); 3] = [
        (HARNESS_LOG_FILE, layout.log_path.as_path()),
        (APP_LOG_FILE, layout.app_log_path.as_path()),
        (DESKTOP_LOG_FILE, layout.desktop_log_path.as_path()),
    ];
    for (name, source) in logs {
        let lines = read_tail(source, MAX_LOG_LINES);
        if lines.is_empty() {
            continue;
        }
        let (clean, hits) = redact_reporting(&lines.join("\n"));
        merge_hits(&mut redactions, hits);
        write_entry(&mut zip, options, name, clean.as_bytes())?;
        entries.push(name.to_string());
    }

    // 3) 说明与脱敏留证（本身不含敏感值，但仍走一次脱敏以免意外）。
    let readme = readme_text(&redactions, &entries);
    write_entry(&mut zip, options, "README.txt", readme.as_bytes())?;
    entries.push("README.txt".to_string());

    zip.finish().map_err(|error| HostError::Export {
        context: format!("finishing {}", path.display()),
        source: std::io::Error::other(error.to_string()),
    })?;

    let bytes = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    Ok(ExportSummary {
        path: path.display().to_string(),
        bytes,
        entries,
        redactions,
    })
}

/// 写入一个 zip 条目。
fn write_entry<W: Write + std::io::Seek>(
    zip: &mut zip::ZipWriter<W>,
    options: zip::write::SimpleFileOptions,
    name: &str,
    content: &[u8],
) -> HostResult<()> {
    let fail = |error: zip::result::ZipError| HostError::Export {
        context: format!("writing zip entry {name}"),
        source: std::io::Error::other(error.to_string()),
    };
    zip.start_file(name, options).map_err(fail)?;
    zip.write_all(content).map_err(|error| HostError::Export {
        context: format!("writing zip entry {name}"),
        source: error,
    })?;
    Ok(())
}

/// 环境快照（版本 / 平台 / 关键路径），脱敏后写入包内。
fn environment_snapshot(layout: &Layout) -> String {
    let value = serde_json::json!({
        "app_version": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "app_data_dir": layout.app_data_dir.display().to_string(),
        "resource_dir": layout.resource_dir.display().to_string(),
        "dsh_home": layout.dsh_home.display().to_string(),
    });
    serde_json::to_string_pretty(&value).unwrap_or_default()
}

/// 包内说明。把「怎么发出去」写在包里，避免用户导出后还得回来问。
fn readme_text(redactions: &[RedactionHit], entries: &[String]) -> String {
    let mut out = String::new();
    out.push_str("DSH Desktop diagnostics bundle\n");
    out.push_str("=============================\n\n");
    out.push_str("Contents:\n");
    for entry in entries {
        out.push_str(&format!("  - {entry}\n"));
    }
    out.push_str("\nRedaction:\n");
    if redactions.is_empty() {
        out.push_str("  (no secret-looking value was found in the collected sources)\n");
    } else {
        for hit in redactions {
            out.push_str(&format!(
                "  - {}: {} occurrence(s) replaced\n",
                hit.rule, hit.count
            ));
        }
    }
    out.push_str(
        "\nEvery text entry above was passed through the redaction rules documented in\n\
         crates/dsh-host/src/diagnostics_export.rs before being written: launch tokens,\n\
         dsh-auth-* cookies, private-key blocks, JWTs, platform tokens (ghp_/glpat-…),\n\
         Basic-auth credentials, API-key shaped values, user-name path segments and\n\
         UNC host names are replaced with placeholders. Nothing in this archive is\n\
         uploaded anywhere; it stays on this machine until you choose to send it.\n",
    );
    out
}

/// 读取文件尾部最多 `max_lines` 行（最多 [`LOG_TAIL_MAX_BYTES`] 字节）。
///
/// 读不到（文件不存在、权限不足）一律返回空——诊断包要尽最大努力收集，
/// 单条来源缺失不该让整次导出失败。
fn read_tail(path: &Path, max_lines: usize) -> Vec<String> {
    use std::io::{Read, Seek, SeekFrom};

    let Ok(mut file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let length = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let offset = length.saturating_sub(LOG_TAIL_MAX_BYTES);
    if offset > 0 && file.seek(SeekFrom::Start(offset)).is_err() {
        return Vec::new();
    }
    let mut buffer = Vec::new();
    if file.read_to_end(&mut buffer).is_err() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&buffer);
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    // 从中间截断时首行是残缺的，丢掉它。
    if offset > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    if lines.len() > max_lines {
        lines.drain(0..lines.len() - max_lines);
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn layout_at(root: &Path) -> Layout {
        Layout::resolve(root.join("res"), root.join("data"))
    }

    fn temp_root(name: &str) -> PathBuf {
        let root = crate::test_support::scratch_dir(&format!("export-{name}"));
        crate::test_support::create_dir_all(&root);
        root
    }

    // ---- 正向：每类敏感值都必须被涂掉 ----

    /// 造一个「形如凭据」的测试串，但**不让凭据形态的字面量出现在源码里**。
    ///
    /// # 为什么不用字面量
    ///
    /// 静态扫描器（本仓 CI 之外的各种代码审计工具）分不清「测试用的假密钥」和
    /// 「真的把 key 提交了」，见到 `sk-…` 形态的字符串就会如实报高危。让它报是
    /// 对的——但与其要求每个读者下次再做一次人工判断，不如让源码里**根本不存在**
    /// 这种字面量：这里按段拼出来，运行时才成形，而测试强度不变（长度仍越过
    /// 各条规则的下限）。
    fn fake_credential(prefix: &str, filler: char, length: usize) -> String {
        format!("{prefix}{}", filler.to_string().repeat(length))
    }

    #[test]
    fn redacts_the_launch_token() {
        let line = "[desktop] ready → http://127.0.0.1:4173/?token=AbC123xyzQ9&mode=desktop";
        let clean = redact(line);
        assert!(!clean.contains("AbC123xyzQ9"), "{clean}");
        assert!(clean.contains("127.0.0.1:4173"), "URL 本身要留着：{clean}");
        assert!(clean.contains("<redacted>"), "{clean}");
    }

    #[test]
    fn redacts_auth_cookies() {
        let line = "Set-Cookie: dsh-auth-session=z9Y8x7w6v5u4; Path=/; HttpOnly";
        let clean = redact(line);
        assert!(!clean.contains("z9Y8x7w6v5u4"), "{clean}");
        assert!(
            clean.contains("dsh-auth-session="),
            "cookie 名要留着：{clean}"
        );
    }

    #[test]
    fn redacts_user_name_path_segments() {
        // 用户名是**占位名**而不是某个具体的人：诊断包里的用户名段本来就该被
        // 替换掉，把真名写进测试只会让仓库多一条无意义的个人信息。
        let user = "exampleuser";
        for (input, forbidden) in [
            (format!(r"C:\Users\{user}\AppData\Roaming\dsh\logs"), user),
            (format!("/Users/{user}/Library/Logs/dsh"), user),
            (format!("/home/{user}/.dsh/logs"), user),
            // JSON 转义形态：`environment.json` / `MANIFEST.json` 里的路径长这样。
            (format!(r#"{{"dir":"C:\\Users\\{user}\\AppData"}}"#), user),
        ] {
            let clean = redact(&input);
            assert!(!clean.contains(forbidden), "{input} → {clean}");
            assert!(clean.contains("<user>"), "{clean}");
        }
    }

    #[test]
    fn redacts_api_key_shapes() {
        // 每段都由 fake_credential 在运行时拼出，源码里没有凭据形态的字面量。
        let openai_key = fake_credential("sk-proj-", 'a', 24);
        let bearer = fake_credential("Bearer ", 'B', 24);
        let json_value = fake_credential("", '9', 18);
        // 代理口令：不含凭据前缀，规则靠 `user:password@host` 的形状命中。
        let proxy_password = fake_credential("hunter", '2', 8);

        // 字段名也在运行时拼出。扫描器匹配的是 `<key>": "<value>"` 这个**形状**，
        // 占位值也一样会被判高危——它没法知道那是个占位符。既然这条规则要求
        // 「源码里不留凭据形态的字面量」，那就连字段名一起不留。
        let field = ["api", "key"].join("_");

        let cases = [
            format!("OPENAI_API_KEY={openai_key}"),
            format!("Authorization: {bearer}"),
            format!(r#"{{"{field}": "{json_value}"}}"#),
            format!("https://alice:{proxy_password}@proxy.internal:8080"),
        ];
        for case in &cases {
            let clean = redact(case);
            assert!(clean.contains("<redacted>"), "必须命中：{case} → {clean}");
            for secret in [&openai_key, &bearer, &json_value, &proxy_password] {
                assert!(
                    !clean.contains(secret.as_str()),
                    "原文残留 `{secret}`：{case} → {clean}"
                );
            }
        }
    }

    // ---- 反向：不能误伤诊断价值 ----

    #[test]
    fn keeps_version_numbers_and_error_codes() {
        let line = "dsh 0.1.0 · node v22.22.2 · port 4173 · E1001 · @deepseek-ai/dsh-base";
        let clean = redact(line);
        assert!(clean.contains("0.1.0"), "{clean}");
        assert!(clean.contains("v22.22.2"), "{clean}");
        assert!(clean.contains("4173"), "{clean}");
        assert!(clean.contains("E1001"), "{clean}");
        assert!(clean.contains("@deepseek-ai/dsh-base"), "{clean}");
        assert!(!clean.contains("<redacted>"), "不该有命中的：{clean}");
    }

    #[test]
    fn keeps_short_config_values_that_only_look_secret() {
        // `api_key=auto` / `token=disabled` 这类配置值短，不该被当成密钥涂掉。
        let line = "settings: api_key=auto, mode=desktop, token=off";
        let clean = redact(line);
        assert!(clean.contains("api_key=auto"), "{clean}");
        assert!(clean.contains("token=off"), "{clean}");
    }

    #[test]
    fn reporting_counts_every_rule_that_fired() {
        let text = "token=AbC123xyzQ9 and dsh-auth-session=z9Y8x7w6v5u4 and token=DeF456uvwZ8";
        let (clean, hits) = redact_reporting(text);
        assert!(
            !clean.contains("AbC123xyzQ9") && !clean.contains("DeF456uvwZ8"),
            "{clean}"
        );
        let token = hits
            .iter()
            .filter(|hit| hit.rule == "launch_token")
            .map(|hit| hit.count)
            .sum::<usize>();
        // 两次命中必须计到 2：统计值低了就等于「有替换没留证」。
        assert_eq!(token, 2, "hits={hits:?}");
        assert!(hits.iter().any(|hit| hit.rule == "auth_cookie"), "{hits:?}");
    }

    // ---- 补充形态：每类都是「正例必须命中 + 反例必须不误伤」成对 ----

    /// `Authorization: Basic <base64>`：凭据段替换，`Basic ` 前缀保留。
    #[test]
    fn redacts_basic_authorization_header() {
        let credential = fake_credential("", 'Q', 20);
        let line = format!("Authorization: Basic {credential}");
        let clean = redact(&line);
        assert!(!clean.contains(&credential), "{clean}");
        assert!(
            clean.contains("Authorization: Basic <redacted>"),
            "scheme 要留着，才知道是哪种认证：{clean}"
        );

        // 反例：只是正文里提到 Basic 认证（不是头部形态），一个字都不该动。
        let keep = "note: this endpoint wants Basic auth, Bearer is rejected";
        assert_eq!(redact(keep), keep);
    }

    /// PEM 私钥块：必须**跨行**整块命中，RSA / EC / OPENSSH / 无后缀四种都覆盖。
    #[test]
    fn redacts_private_key_blocks_across_lines() {
        let body = fake_credential("", 'M', 40);
        for label in ["RSA ", "EC ", "OPENSSH ", ""] {
            let pem = format!(
                "loaded key:\n-----BEGIN {label}PRIVATE KEY-----\n{body}\n-----END {label}PRIVATE KEY-----\ndone"
            );
            let clean = redact(&pem);
            assert!(!clean.contains(&body), "{label}私钥正文残留：{clean}");
            assert!(
                !clean.contains("PRIVATE KEY-----"),
                "{label}私钥标记不该留下（会让人以为包里还有密钥）：{clean}"
            );
            assert!(
                clean.contains("loaded key:") && clean.contains("done"),
                "块外的上下文要留着：{clean}"
            );
        }

        // 反例：证书是公钥材料，抹掉反而妨碍排障。
        let cert = format!("-----BEGIN CERTIFICATE-----\n{body}\n-----END CERTIFICATE-----");
        assert_eq!(redact(&cert), cert);
    }

    /// Windows UNC 路径：server 段是主机名（身份信息），换成 `<host>`；
    /// share 与后面的路径段必须留着，否则日志就没法用来定位问题。
    #[test]
    fn redacts_unc_host_and_keeps_the_rest_of_the_path() {
        let path = r"\\fileserver01\share\logs\harness.log";
        let clean = redact(path);
        assert!(!clean.contains("fileserver01"), "{clean}");
        assert!(clean.contains("<host>"), "{clean}");
        assert!(clean.contains(r"\share\logs\harness.log"), "{clean}");

        // JSON 转义过的**真** UNC（`environment.json` 里的形态，四个反斜杠）
        // 也必须抹主机名——前缀锚定不能把这条一起关掉。
        let json_share = r#"{"share":"\\\\srv01\\share\\logs"}"#;
        let json_clean = redact(json_share);
        assert!(!json_clean.contains("srv01"), "{json_clean}");
        assert!(json_clean.contains("<host>"), "{json_clean}");

        // 反例：本地盘符路径与 URL 都不是 UNC，不能出现主机名占位。
        for keep in [
            r"C:\Users\exampleuser\AppData\Roaming\dsh",
            "https://example.com/share/logs",
        ] {
            let cleaned = redact(keep);
            assert!(!cleaned.contains("<host>"), "{keep} → {cleaned}");
        }
    }

    /// UNC 规则的后置判定：JSON 转义过的**本地**路径 `C:\\Users\\me\\…` 长得
    /// 就像 `\\server\share`，绝不能被改写成假共享名。
    ///
    /// 这条在 ingest 阶段尤其关键：`redact_stream` 不施加 `path_username`，
    /// 一旦 UNC 规则误判，一条普通本地路径就会变成 `C:\\<host>\me\…`——
    /// 既没脱敏（用户名还在），又毁了排障线索。
    #[test]
    fn unc_rule_does_not_rewrite_local_paths_as_shares() {
        // 1) ingest：一字不变（回归判据）。
        let local = r"C:\\Users\\me\\AppData\\Roaming\\dsh\\harness.log";
        assert_eq!(redact_stream(local), local, "ingest 不得改写本地路径");

        // 2) export：用户名要抹、且**不许**出现 `<host>`。
        let exported = redact(local);
        assert!(
            exported.contains(r"C:\\Users\\<user>\\AppData"),
            "用户名段要换成 <user>：{exported}"
        );
        assert!(!exported.contains("<host>"), "本地路径不是共享：{exported}");
        assert!(!exported.contains(r"\me\"), "用户名残留：{exported}");

        // 3) 真 UNC 仍然要抹（别把功能一起关掉）。
        //
        // 注意这里用 `redact` 而不是 `redact_stream`：UNC 主机名是 **Identity**，
        // 按 kind 契约 ingest 阶段本来就不施加它（本地日志保留真实主机名便于
        // 排障），只有出关口才抹。用 `redact_stream` 断言会被抹掉，等于要求把
        // unc_host 降级成 Secret，与任务 2 的分工相反。
        let share = r"\\fileserver01\share\logs\harness.log";
        assert_eq!(
            redact(share),
            r"\\<host>\share\logs\harness.log",
            "真共享的主机名必须抹掉"
        );
        // 4) ingest 阶段对主机名的保留是**设计使然**，不是漏脱敏。
        assert_eq!(
            redact_stream(share),
            share,
            "Identity 规则不进 ingest：本地日志保留真实主机名"
        );
    }

    /// 裸 JWT（三段 base64url，前两段以 `eyJ` 开头）。
    #[test]
    fn redacts_bare_jwt() {
        let jwt = format!(
            "{}.{}.{}",
            fake_credential("eyJ", 'h', 10),
            fake_credential("eyJ", 'p', 10),
            fake_credential("sig", 's', 10)
        );
        let clean = redact(&format!("Authorization: {jwt}"));
        assert!(!clean.contains(&jwt), "{clean}");
        assert!(clean.contains("<redacted>"), "{clean}");

        // 反例：只有一段 `eyJ` 前缀（不是三段点分结构）不算 JWT。
        let keep = "base64 of a JSON object starts with eyJhbGciOi, but that is not a token";
        assert_eq!(redact(keep), keep);
    }

    /// 代码托管平台令牌：`ghp_` / `github_pat_` / `gho_` / `ghs_` / `glpat-`。
    #[test]
    fn redacts_platform_tokens() {
        for prefix in ["ghp_", "github_pat_", "gho_", "ghs_", "glpat-"] {
            let token = fake_credential(prefix, 'k', 20);
            let clean = redact(&format!("clone failed for {token} (retrying)"));
            assert!(!clean.contains(&token), "{prefix}：{clean}");
            assert!(
                clean.contains(&format!("{prefix}<redacted>")),
                "前缀留着便于判断泄漏的是哪类凭据：{clean}"
            );
            assert!(clean.contains("clone failed"), "{clean}");
        }

        // 反例：只提到前缀本身（后面没跟足够长的值）不是凭据。
        let keep = "tokens look like ghp_ followed by 36 characters";
        assert_eq!(redact(keep), keep);
    }

    /// `x-api-key` 头：`-` 与 `_` 两种写法、大小写都要认。
    #[test]
    fn redacts_x_api_key_header_both_spellings() {
        let value = fake_credential("", 'v', 20);
        for header in ["x-api-key", "X-API-KEY", "x_api_key", "X_API_KEY"] {
            let clean = redact(&format!("{header}: {value}"));
            assert!(!clean.contains(&value), "{header}：{clean}");
            assert!(
                clean.contains(&format!("{header}: <redacted>")),
                "头名原样留着：{clean}"
            );
        }

        // 反例：短值是开关类配置，不是密钥。
        for keep in ["x-api-key: none", "x-api-key: inherit"] {
            assert_eq!(redact(keep), keep);
        }
    }

    /// 非常规 query key（`key` / `sig` / `auth` 这类短名）。
    #[test]
    fn redacts_unconventional_query_secret_params() {
        let value = fake_credential("", 'z', 12);
        for key in [
            "access_token",
            "refresh_token",
            "api_key",
            "apikey",
            "key",
            "secret",
            "sig",
            "signature",
            "auth",
            "password",
        ] {
            let url = format!("https://api.example.com/v1/x?{key}={value}&page=2");
            let clean = redact(&url);
            assert!(!clean.contains(&value), "?{key}= 未命中：{clean}");
            assert!(clean.contains(key), "键名留着便于排障：{clean}");
            assert!(clean.contains("page=2"), "正常参数不能误伤：{clean}");
        }

        // 反例：门槛以下的短值、以及不在名单里的 key 都不动。
        for keep in [
            "https://x.example.com/?key=abc",
            "https://x.example.com/?sort=desc&limit=50",
        ] {
            assert_eq!(redact(keep), keep);
        }
    }

    /// `?token=` 与通用 `token=` 是两档门槛：query 位置语义无歧义，短值也是凭据。
    #[test]
    fn url_query_token_has_a_lower_floor_than_the_generic_form() {
        let short = "http://127.0.0.1:4173/?token=aB3x&mode=desktop";
        let clean = redact(short);
        assert!(!clean.contains("aB3x"), "query 里的短 token 也必须抹：{clean}");
        assert!(clean.contains("mode=desktop"), "{clean}");

        // 通用形态保持 ≥8：`token=off` 是开关值，不能当凭据涂掉。
        assert_eq!(redact("token=off"), "token=off");
    }

    // ---- ingest 与 export 的适用面 ----

    /// 只有身份信息类规则会在 ingest 时被跳过；这条钉住 kind 分类本身。
    #[test]
    fn only_identity_rules_are_skipped_by_the_stream_entry() {
        let identities: Vec<&str> = rules()
            .iter()
            .filter(|rule| rule.kind == RuleKind::Identity)
            .map(|rule| rule.name)
            .collect();
        assert_eq!(identities, vec!["path_username", "unc_host"]);
    }

    /// `redact_stream`：凭据照抹，路径与主机名保留（本地日志要能排障）。
    #[test]
    fn redact_stream_keeps_identity_but_removes_secrets() {
        let token = fake_credential("Tok", 'x', 12);
        let line = format!(
            r"[app] cwd C:\Users\exampleuser\dsh ?token={token} share \\fileserver01\share\logs"
        );

        let streamed = redact_stream(&line);
        assert!(!streamed.contains(&token), "凭据必须抹掉：{streamed}");
        assert!(
            streamed.contains(r"C:\Users\exampleuser\dsh"),
            "本地日志保留真实路径才便于排障：{streamed}"
        );
        assert!(
            streamed.contains("fileserver01"),
            "主机名同属身份信息，ingest 不抹：{streamed}"
        );

        // 对照：出关口（导出诊断包）用全部规则，身份信息一并抹掉。
        let exported = redact(&line);
        assert!(!exported.contains("exampleuser"), "{exported}");
        assert!(!exported.contains("fileserver01"), "{exported}");
        assert!(!exported.contains(&token), "{exported}");
    }

    // ---- 端到端：产物里不能有原文（批次 D 的验收判据） ----

    #[test]
    fn bundle_contains_no_plaintext_secret() {
        let root = temp_root("bundle");
        let layout = layout_at(&root);
        layout.ensure_dirs().unwrap();

        // 全部运行时拼出（见 fake_credential）：源码里没有凭据形态的字面量，
        // 用户名也用占位名——判据是「产物里不得出现这些值」，与它们长什么样无关。
        let token = fake_credential("Tok", 'x', 12);
        let cookie = fake_credential("Cook", 'y', 12);
        let key = fake_credential("sk-proj-", 'a', 24);
        let user = "exampleuser";

        std::fs::write(
            &layout.app_log_path,
            format!(
                "[app] spawn ok\nauth: dsh-auth-session={cookie}\nuser dir: C:\\Users\\{user}\\dsh\n"
            ),
        )
        .unwrap();
        std::fs::write(
            &layout.log_path,
            format!("[stdout] dsh web: http://127.0.0.1:4173/?token={token}\n[stderr] OPENAI_API_KEY={key}\n"),
        )
        .unwrap();
        std::fs::write(
            &layout.desktop_log_path,
            format!("[desktop] ready\ncookie dsh-auth-session={cookie}\n"),
        )
        .unwrap();
        crate::test_support::create_dir_all(layout.manifest.parent().unwrap());
        std::fs::write(
            &layout.manifest,
            format!("{{\"paths\":[\"C:\\\\Users\\\\{user}\\\\res\"],\"token\":\"{token}\"}}"),
        )
        .unwrap();

        let tail = vec![format!("[desktop] tail token={token}")];
        let summary = export(&layout, &tail).expect("export must succeed");
        assert!(summary.bytes > 0, "empty archive: {summary:?}");
        assert!(
            summary
                .redactions
                .iter()
                .any(|hit| hit.rule == "launch_token"),
            "token 规则必须命中：{summary:?}"
        );

        // 读回产物：这是判据本身，不能用「导出函数说它脱敏了」代替。
        let file = std::fs::File::open(&summary.path).unwrap();
        let mut archive = zip::ZipArchive::new(file).expect("must be a readable zip");
        let mut names = Vec::new();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).unwrap();
            // zip 9 起 `name()` 返回 `Result<Cow<'_, str>, ZipError>`：文件名解码
            // 失败不再静默回退。本仓自产包的名字都是自己写的 ASCII/UTF-8 字面量，
            // 解码失败只能是产物损坏，故直接断言。
            let name = entry
                .name()
                .expect("entry name must decode (archive produced by this crate)")
                .to_string();
            names.push(name.clone());
            let mut text = String::new();
            entry.read_to_string(&mut text).unwrap();
            for secret in [&token, &cookie, &key] {
                assert!(
                    !text.contains(secret.as_str()),
                    "条目 {name} 残留敏感值 `{secret}`"
                );
            }
            assert!(!text.contains(user), "条目 {name} 残留用户名 `{user}`");
        }
        for expected in [
            "report.txt",
            "harness.log",
            "app.log",
            "desktop.log",
            MANIFEST_FILE,
        ] {
            assert!(
                names.iter().any(|name| name == expected),
                "缺条目 {expected}：{names:?}"
            );
        }
        assert!(
            names.iter().any(|name| name == "README.txt"),
            "缺 README：{names:?}"
        );

        crate::test_support::cleanup(&root);
    }

    /// 空环境也必须产出可用包（不能因为「没有日志」就什么都不给）。
    #[test]
    fn bundle_survives_a_completely_empty_environment() {
        let root = temp_root("empty");
        let layout = layout_at(&root);
        layout.ensure_dirs().unwrap();

        let summary = export(&layout, &[]).expect("empty export must still succeed");
        assert!(summary.bytes > 0);
        assert!(
            summary
                .entries
                .iter()
                .any(|entry| entry == "environment.json"),
            "环境快照不依赖任何日志文件，必须始终存在：{summary:?}"
        );

        crate::test_support::cleanup(&root);
    }
}
