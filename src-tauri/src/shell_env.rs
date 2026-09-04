//! Resolve the user's interactive login shell environment.
//!
//! Apps launched from Finder/Spotlight (macOS) or shortcuts (Windows) inherit
//! a minimal environment that never sources the user's shell profile, leaving
//! PATH without Homebrew, mise shims, ~/.local/bin, conda, scoop, etc. CLIs
//! like git or docker then become invisible to the Harness process and every
//! subprocess it spawns.
//!
//! This module shells out once to capture the full environment the user would
//! have in a terminal. On any failure it falls back to the inherited
//! environment. The result is memoised for the process lifetime.

use std::collections::HashMap;
use std::process::Command;
use std::sync::OnceLock;
use std::time::Duration;

static RESOLVED: OnceLock<HashMap<String, String>> = OnceLock::new();

pub fn resolve_shell_environment() -> &'static HashMap<String, String> {
    RESOLVED.get_or_init(|| match capture_shell_environment() {
        Some(env) => env,
        None => std::env::vars().collect(),
    })
}

fn capture_shell_environment() -> Option<HashMap<String, String>> {
    if cfg!(windows) {
        capture_windows_environment()
    } else {
        capture_posix_environment()
    }
}

/// PowerShell with the user profile loaded captures both registry environment
/// variables and any PATH additions sourced in $PROFILE (conda activate,
/// nvm use, scoop shim). Output encoding is pinned to UTF-8: on a CJK install
/// the console codepage would mangle non-ASCII paths (e.g. TEMP under
/// C:\Users\数据项素), and a mis-decoded TEMP makes Harness die in mkdtemp.
fn capture_windows_environment() -> Option<HashMap<String, String>> {
    let script = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; \
                  . $PROFILE 2>$null; \
                  Get-ChildItem Env: | ForEach-Object { \"$($_.Name)=$($_.Value)\" }";
    let output = run_with_timeout(
        Command::new("powershell")
            .args([
                "-NoLogo",
                "-NonInteractive",
                "-OutputFormat",
                "Text",
                "-Command",
                script,
            ])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null()),
        Duration::from_secs(15),
    )?;
    let inherited: HashMap<String, String> = std::env::vars().collect();
    Some(without_undecodable_values(
        parse_env_output(&output, "\r\n"),
        &inherited,
    ))
}

/// Run a login + interactive shell so both .zprofile (Homebrew, OrbStack) and
/// .zshrc (mise shims, ~/.local/bin, cargo, go) are sourced. stderr is
/// ignored to suppress prompt noise.
fn capture_posix_environment() -> Option<HashMap<String, String>> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let output = run_with_timeout(
        Command::new(&shell)
            .args(["-l", "-i", "-c", "env"])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null()),
        Duration::from_secs(10),
    )?;
    Some(parse_env_output(&output, "\n"))
}

fn run_with_timeout(command: &mut Command, timeout: Duration) -> Option<String> {
    let mut child = command.stdout(std::process::Stdio::piped()).spawn().ok()?;
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return None,
        }
    }
    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

fn parse_env_output(output: &str, line_separator: &str) -> HashMap<String, String> {
    let mut env = HashMap::new();
    for line in output.split(line_separator) {
        let line = line.trim_end_matches('\n');
        let Some(eq) = line.find('=') else { continue };
        if eq == 0 {
            continue;
        }
        env.insert(line[..eq].to_string(), line[eq + 1..].to_string());
    }
    env
}

/// Replace captured values that lost characters in decoding with the ones
/// this process already holds. A value carrying U+FFFD did not survive the
/// trip out of the shell; passing it on is harmful (TEMP would name a
/// directory that does not exist). The inherited value is always intact.
fn without_undecodable_values(
    captured: HashMap<String, String>,
    inherited: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut result = HashMap::new();
    for (name, value) in captured {
        if !value.contains('\u{FFFD}') {
            result.insert(name, value);
            continue;
        }
        if let Some(fallback) = inherited.get(&name) {
            result.insert(name, fallback.clone());
        }
    }
    result
}

/// The captured PATH, looked up the way Windows actually stores it.
/// Windows does not normalise registry value-name casing, so a machine whose
/// PATH value name is stored lowercase yields the key `path`. POSIX keeps the
/// exact read: there `path` and `PATH` are genuinely different variables.
pub fn resolve_environment_path(environment: &HashMap<String, String>) -> String {
    if !cfg!(windows) {
        return environment.get("PATH").cloned().unwrap_or_default();
    }
    if let Some(value) = environment.get("Path").or_else(|| environment.get("PATH")) {
        return value.clone();
    }
    for (name, value) in environment {
        if name.eq_ignore_ascii_case("path") {
            return value.clone();
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_env_lines() {
        let env = parse_env_output("FOO=bar\nPATH=/usr/bin\nEMPTY=\nnoequals", "\n");
        assert_eq!(env.get("FOO").unwrap(), "bar");
        assert_eq!(env.get("PATH").unwrap(), "/usr/bin");
        assert_eq!(env.get("EMPTY").unwrap(), "");
        assert!(!env.contains_key("noequals"));
    }

    #[test]
    fn drops_replacement_character_values() {
        let mut captured = HashMap::new();
        captured.insert("TEMP".to_string(), "C:\\Users\\\u{FFFD}\u{FFFD}".to_string());
        captured.insert("GOOD".to_string(), "ok".to_string());
        let mut inherited = HashMap::new();
        inherited.insert("TEMP".to_string(), "C:\\Users\\real".to_string());
        let result = without_undecodable_values(captured, &inherited);
        assert_eq!(result.get("TEMP").unwrap(), "C:\\Users\\real");
        assert_eq!(result.get("GOOD").unwrap(), "ok");
    }

    #[test]
    fn windows_path_lookup_is_case_insensitive() {
        let mut env = HashMap::new();
        env.insert("path".to_string(), "C:\\bin".to_string());
        if cfg!(windows) {
            assert_eq!(resolve_environment_path(&env), "C:\\bin");
        }
    }
}
