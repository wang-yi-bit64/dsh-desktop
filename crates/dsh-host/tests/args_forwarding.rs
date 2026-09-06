//! T05 — C1 参数转发回归：`HarnessArgs`（新路径）与 `process::build_*_arguments`
//! （GUI 依赖的老路径）必须逐项相等；`--port 0` 语义；C2 env 覆盖不冲掉 PATH。
//!
//! 这些断言不需要系统 Node / mock 资源，全部在纯路径上完成。

use std::sync::atomic::{AtomicU64, Ordering};

use dsh_host::args::{parse_env_overrides, HarnessArgs};
use dsh_host::contracts::{ENV_PATH, HARNESS_HOST};
use dsh_host::env::{harness_env_with_overrides, path_key, HarnessEnv};
use dsh_host::paths::Layout;
use dsh_host::process::{build_harness_arguments, build_node_arguments};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// 构造一个不依赖任何真实文件的纯布局（仅拼路径，不做 IO）。
fn pure_layout() -> Layout {
    let unique = format!("dsh-host-args-{}-{}", std::process::id(), {
        COUNTER.fetch_add(1, Ordering::Relaxed)
    });
    let root = std::env::temp_dir().join(unique);
    Layout::resolve(root.join("res"), root.join("data"))
}

/// C1 回归护栏：新参数构造必须与 GUI 依赖的 legacy 构造逐项相等。
#[test]
fn harness_args_match_legacy_argv_per_item() {
    let layout = pure_layout();

    // 关键回归：HarnessArgs::dsh_arguments 与 process::build_harness_arguments。
    let legacy_dsh = build_harness_arguments(&layout, 4173);
    let new_dsh = HarnessArgs::default_for(layout.clone(), 4173).dsh_arguments();
    assert_eq!(legacy_dsh.len(), new_dsh.len(), "参数个数漂移");
    for (index, (left, right)) in legacy_dsh.iter().zip(new_dsh.iter()).enumerate() {
        assert_eq!(left, right, "第 {index} 个 dsh 参数漂移");
    }

    // 完整 node argv（含 --expose-internals 与入口）同样逐项相等。
    let legacy_node = build_node_arguments(&layout, 4173);
    let new_node = HarnessArgs::default_for(layout, 4173).node_arguments();
    assert_eq!(legacy_node.len(), new_node.len(), "node 参数个数漂移");
    for (index, (left, right)) in legacy_node.iter().zip(new_node.iter()).enumerate() {
        assert_eq!(left, right, "第 {index} 个 node 参数漂移");
    }
}

/// C1 端口策略：`--port 0`（Ephemeral）必须原样出现在契约参数尾部。
#[test]
fn port_zero_is_forwarded_as_contract_tail() {
    let layout = pure_layout();
    for (index, builder) in [
        ("legacy", build_harness_arguments(&layout, 0)),
        (
            "new",
            HarnessArgs::default_for(layout.clone(), 0).dsh_arguments(),
        ),
    ]
    .into_iter()
    {
        let tail: Vec<&str> = builder.iter().map(String::as_str).collect();
        assert_eq!(
            &tail[tail.len() - 2..],
            &["--port", "0"],
            "{index} 路径未透传 --port 0"
        );
    }

    let args = HarnessArgs::default_for(layout, 0);
    let snapshot = args.argv_snapshot();
    assert!(snapshot.args.windows(2).any(|pair| pair == ["--port", "0"]));
}

/// C1 主机名覆盖：`host` 字段会替换契约默认的 127.0.0.1。
#[test]
fn host_override_reaches_argv() {
    let layout = pure_layout();
    let mut args = HarnessArgs::default_for(layout.clone(), 4173);
    args.host = "127.0.0.2".to_string();
    let built = args.dsh_arguments();
    assert!(built.windows(2).any(|pair| pair == ["--host", "127.0.0.2"]));

    // 默认值仍指向契约常量。
    let default_host = HarnessArgs::default_for(layout, 4173).dsh_arguments();
    assert!(default_host
        .windows(2)
        .any(|pair| pair == ["--host", HARNESS_HOST]));
}

/// C1 透传段：`extra` 追加在契约参数之后，且不重排既有参数。
#[test]
fn passthrough_extra_is_appended_last_without_reordering() {
    let layout = pure_layout();
    let mut args = HarnessArgs::default_for(layout, 4173);
    args.extra = vec!["--profile".into(), "work".into(), "--verbose".into()];
    let built = args.dsh_arguments();

    // 契约前缀完整保留。
    assert_eq!(built[0], "web");
    assert!(built
        .windows(2)
        .any(|pair| pair == ["--patch", &args.layout.patch.display().to_string()]));
    // 透传段在最后且顺序原样。
    assert_eq!(
        &built[built.len() - 3..],
        &["--profile", "work", "--verbose"]
    );
    // 透传之前必须是契约的 --port <n>。
    assert_eq!(built[built.len() - 4], "4173");
}

/// C2 env 覆盖：覆盖 `PATH` 走合并而不是整体替换（系统 PATH 不能被冲掉）。
#[test]
fn env_override_does_not_clobber_system_path() {
    let layout = pure_layout();
    let separator = dsh_host::env::path_separator();
    let base_path = format!("/usr/bin{separator}/usr/local/bin");
    let shell = HarnessEnv::from_pairs([(path_key().to_string(), base_path.clone())]);

    let extra_dir = "/extra/tools".to_string();
    let env = harness_env_with_overrides(
        &layout,
        &shell,
        None,
        &[(path_key().to_string(), extra_dir.clone())],
    );

    let merged = env.path().map(String::as_str).unwrap_or_default();
    assert!(
        merged.contains(&base_path),
        "系统 PATH 被覆盖项冲掉了：{merged}"
    );
    assert!(merged.contains(&extra_dir), "覆盖项没有进入 PATH：{merged}");
}

/// C2 env 覆盖：非 PATH 的契约项可以被覆盖（`NO_COLOR=0` 能盖掉契约值 `1`）。
#[test]
fn env_override_wins_over_contract_value_for_non_path() {
    let layout = pure_layout();
    let shell = HarnessEnv::default();
    let overrides = vec![("NO_COLOR".to_string(), "0".to_string())];
    let env = harness_env_with_overrides(&layout, &shell, None, &overrides);
    assert_eq!(env.get("NO_COLOR").map(String::as_str), Some("0"));
}

/// C2 env 解析：`--env K=V` 解析器接受值内等号、拒绝缺等号项。
#[test]
fn env_override_parser_validates_shape() {
    let parsed = parse_env_overrides(&[
        "NO_COLOR=0".to_string(),
        "NODE_OPTIONS=--max-old-space-size=4096".to_string(),
    ])
    .expect("合法 K=V 应可解析");
    assert_eq!(parsed[0], ("NO_COLOR".to_string(), "0".to_string()));
    assert_eq!(
        parsed[1],
        (
            "NODE_OPTIONS".to_string(),
            "--max-old-space-size=4096".to_string()
        )
    );

    assert!(parse_env_overrides(&["NOEQUALS".to_string()]).is_err());
    assert!(parse_env_overrides(&["=value".to_string()]).is_err());
}

/// C2 PATH 键：Windows 下 `get` 对大小写不敏感，且不会出现 `Path`/`PATH` 双份。
#[test]
fn env_path_key_is_case_insensitive_on_windows() {
    let mut env = HarnessEnv::from_pairs([("Path".to_string(), "C:\\Windows".to_string())]);
    env.set(ENV_PATH, "C:\\Bin".to_string());

    let path_values: Vec<String> = env.iter().map(|(key, _)| key.clone()).collect();
    if cfg!(windows) {
        assert_eq!(path_values.len(), 1, "不应同时存在 Path 与 PATH");
    }
    assert_eq!(env.path().map(String::as_str), Some("C:\\Bin"));
}
