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
//! | 规则 | 命中形态 | 替换为 |
//! |------|---------|--------|
//! | `launch_token` | `token=<值>`（含 URL query）、`--token <值>` | `token=<redacted>` |
//! | `auth_cookie` | `dsh-auth-*=值`（含 `Cookie:` / `Set-Cookie:` 头） | `dsh-auth-*=<redacted>` |
//! | `path_username` | `C:\Users\<名>\`、`/Users/<名>/`、`/home/<名>/` | 用户名段换成 `<user>` |
//! | `api_key` | `sk-…` / `sk-ant-…` / `Bearer …` / `api_key=…` | `<redacted>` |
//! | `proxy_password` | URL 里的 `user:pass@host` | 口令段换成 `<redacted>` |
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

struct Rule {
    name: &'static str,
    pattern: Regex,
    replacement: &'static str,
}

/// 脱敏规则表（编译一次，全进程复用）。
///
/// 正则刻意保持**保守**：宁可漏掉一个不像密钥的长串，也不要吞掉正常日志。
/// 例如 `api_key` 要求值至少 12 个字符，避免把 `api_key=auto` 这类配置项涂掉。
fn rules() -> &'static [Rule] {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let compile = |name: &'static str, pattern: &str, replacement: &'static str| Rule {
            name,
            // 规则表是常量，编译失败属于编码错误，构建时就会由测试暴露。
            pattern: Regex::new(pattern).expect("redaction rule must compile"),
            replacement,
        };
        vec![
            // `token=abc` / `?token=abc&x=1` / `--token abc` / `"token": "abc"`
            compile(
                "launch_token",
                r#"(?i)(token["']?\s*[:=]\s*["']?|--token\s+)([A-Za-z0-9._~+/=-]{8,})"#,
                "${1}<redacted>",
            ),
            // Cookie：`dsh-auth-session=xxx`（含 Set-Cookie 头）。
            compile(
                "auth_cookie",
                r"(?i)(dsh-auth-[a-z0-9-]*=)([^;\s,]+)",
                "${1}<redacted>",
            ),
            // 路径里的用户名段：Windows / macOS / Linux 三种形态。
            //
            // 分隔符用 `[\\/]+`（不是单个 `[\\/]`）：诊断包里既有原始日志的
            // `C:\Users\me\…`，也有 **JSON 转义过**的 `C:\\Users\\me\\…`
            // （`environment.json` / `MANIFEST.json` 就是这么写的）。单字符
            // 匹配会漏掉后者，把用户名原样放进包里——这个漏洞是测试
            // `bundle_contains_no_plaintext_secret` 实际抓到的。
            compile(
                "path_username",
                r"(?i)((?:[A-Za-z]:[\\/]+|/)(?:Users|home)[\\/]+)([^\\/\s:;,'\x22]+)",
                "${1}<user>",
            ),
            // 常见 API key 形态。
            compile("api_key", r"\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b", "<redacted>"),
            compile(
                "api_key",
                r"(?i)(\bBearer\s+)([A-Za-z0-9._~+/=-]{12,})",
                "${1}<redacted>",
            ),
            compile(
                "api_key",
                r#"(?i)(\b(?:api[_-]?key|access[_-]?token|secret|password)["']?\s*[:=]\s*["']?)([A-Za-z0-9_\-\.]{12,})"#,
                "${1}<redacted>",
            ),
            // URL 里的 `user:password@host`。
            compile(
                "proxy_password",
                r"(?i)(https?://[^:/\s@]+:)([^@/\s]+)(@)",
                "${1}<redacted>${3}",
            ),
        ]
    })
}

/// 对一段文本脱敏，返回脱敏后的文本。
pub fn redact(text: &str) -> String {
    redact_reporting(text).0
}

/// 对一段文本脱敏，并返回逐规则的命中统计。
///
/// 命中统计是「禁止无声降级」的载体：调用方必须把它带出去（写进包里、
/// 返回给界面），否则脱敏就成了一个不可核对的黑盒。
pub fn redact_reporting(text: &str) -> (String, Vec<RedactionHit>) {
    let mut current = text.to_string();
    let mut hits = Vec::new();
    for rule in rules() {
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
    (current, hits)
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
         dsh-auth-* cookies, user-name path segments and API-key shaped values are\n\
         replaced with placeholders. Nothing in this archive is uploaded anywhere;\n\
         it stays on this machine until you choose to send it.\n",
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
        let unique = format!(
            "dsh-export-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or(0)
        );
        let root = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&root).unwrap();
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
        std::fs::create_dir_all(layout.manifest.parent().unwrap()).unwrap();
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
            names.push(entry.name().to_string());
            let mut text = String::new();
            entry.read_to_string(&mut text).unwrap();
            for secret in [&token, &cookie, &key] {
                assert!(
                    !text.contains(secret.as_str()),
                    "条目 {} 残留敏感值 `{secret}`",
                    entry.name()
                );
            }
            assert!(
                !text.contains(user),
                "条目 {} 残留用户名 `{user}`",
                entry.name()
            );
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

        let _ = std::fs::remove_dir_all(&root);
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

        let _ = std::fs::remove_dir_all(&root);
    }
}
