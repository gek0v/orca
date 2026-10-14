//! Windows `.cmd`/`.bat` shim parser and resolution past `cmd.exe`.
//!
//! Why: a `.cmd` target forces process execution through `cmd.exe /c` with every argument
//! caret-escaped. A long `cmd.exe /c` invocation whose payload is natural-language prompt text
//! triggers Microsoft Defender for Endpoint heuristic alerts (ATT&CK T1059.003).
//! Furthermore, cmd's parser terminates commands at raw CR/LF regardless of quoting.
//!
//! Reading the shim and spawning `node.exe <script> <args...>` directly removes `cmd.exe`
//! and caret-escaping from the process hierarchy entirely.
//! See `src/shared/child-process/windows-cmd-shim-resolution.ts`.

use regex::Regex;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

/// Maximum size in bytes of a recognizable npm/pnpm shim file.
pub const MAX_SHIM_BYTES: usize = 64 * 1024;

/// Environment variable name that disables .cmd shim resolution past cmd.exe.
pub const DISABLE_CMD_SHIM_RESOLUTION_ENV: &str = "ORCA_DISABLE_CMD_SHIM_RESOLUTION";

/// Permitted file extensions for direct executable targets that CreateProcessW can start directly.
pub const DIRECT_TARGET_EXTENSIONS: &[&str] = &[".exe", ".com"];

/// Result of parsing an npm/pnpm cmd shim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedWindowsCmdShim {
    Node {
        script: String,
        node_path_prefix: Option<String>,
    },
    Direct {
        target: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedWindowsCmdShim {
    Node {
        script_path: PathBuf,
        node_path_prefix: Option<String>,
    },
    Direct {
        target_path: PathBuf,
    },
}

static UNSAFE_SHIM_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"[%^&|<>":\r\n]"#).expect("invalid UNSAFE_SHIM_PATH regex")
});

static NPM_PROG_NODE_SHIM: LazyLock<Regex> = LazyLock::new(|| {
    let pattern = r#"(?i)^@echo off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\nIF EXIST "(?:%~dp0|%dp0%)\\?node\.exe" \(\nSET "_prog=(?:%~dp0|%dp0%)\\?node\.exe"\n\) ELSE \(\nSET "_prog=node"\nSET PATHEXT=%PATHEXT:;\.JS;=;%\n\)\nendLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%_prog%" +"(?:%~dp0|%dp0%)\\?(?P<script>[^"\r\n]+)" +%\*$"#;
    Regex::new(pattern).expect("invalid NPM_PROG_NODE_SHIM regex")
});

static BRANCHED_NODE_SHIM: LazyLock<Regex> = LazyLock::new(|| {
    let pattern = r#"(?i)^(?:@SETLOCAL\n)?(?:@IF NOT DEFINED NODE_PATH \(\n@SET "NODE_PATH=(?P<nodePath>[^"\r\n]*)"\n\) ELSE \(\n@SET "NODE_PATH=(?P<nodePathElse>[^"\r\n]*)"\n\)\n)?@?IF EXIST "(?:%~dp0|%dp0%)\\?node\.exe" \(\n"(?:%~dp0|%dp0%)\\?node\.exe" +"(?:%~dp0|%dp0%)\\?(?P<script>[^"\r\n]+)" +%\*\n\) ELSE \(\n(?:@?SETLOCAL\n)?@?SET PATHEXT=%PATHEXT:;\.JS;=;%\nnode +"(?:%~dp0|%dp0%)\\?(?P<scriptElse>[^"\r\n]+)" +%\*\n\)$"#;
    Regex::new(pattern).expect("invalid BRANCHED_NODE_SHIM regex")
});

static NPM_DIRECT_SHIM: LazyLock<Regex> = LazyLock::new(|| {
    let pattern = r#"(?i)^@echo off\n(?:GOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\n)?"(?:%~dp0|%dp0%)\\?(?P<target>[^"\r\n]+)" +%\*$"#;
    Regex::new(pattern).expect("invalid NPM_DIRECT_SHIM regex")
});

static PNPM_DIRECT_SHIM: LazyLock<Regex> = LazyLock::new(|| {
    let pattern = r#"(?i)^(?:@SETLOCAL\n)?@?"(?:%~dp0|%dp0%)\\?(?P<target>[^"\r\n]+)" +%\*$"#;
    Regex::new(pattern).expect("invalid PNPM_DIRECT_SHIM regex")
});

fn is_plain_relative_path(spelled: &str) -> bool {
    if UNSAFE_SHIM_PATH.is_match(spelled) {
        return false;
    }
    // Reject absolute paths: starts with slash, backslash, or drive letter
    let path = Path::new(spelled);
    if path.is_absolute() {
        return false;
    }
    // Also check for leading slash/backslash
    if spelled.starts_with('/') || spelled.starts_with('\\') {
        return false;
    }
    true
}

fn canonicalize_shim_contents(contents: &str) -> String {
    let stripped = contents.strip_prefix('\u{feff}').unwrap_or(contents);
    let stripped = stripped.strip_prefix('\u{feff}').unwrap_or(stripped);

    stripped
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Parses the contents of a potential npm or pnpm `.cmd` shim.
///
/// Returns paths exactly as the shim spells them, relative to its own directory.
pub fn parse_windows_cmd_shim(contents: &str) -> Option<ParsedWindowsCmdShim> {
    let canonical = canonicalize_shim_contents(contents);

    if let Some(captures) = NPM_PROG_NODE_SHIM.captures(&canonical) {
        if let Some(script) = captures.name("script") {
            let script_str = script.as_str();
            if is_plain_relative_path(script_str) {
                return Some(ParsedWindowsCmdShim::Node {
                    script: script_str.to_string(),
                    node_path_prefix: None,
                });
            }
        }
        return None;
    }

    if let Some(captures) = BRANCHED_NODE_SHIM.captures(&canonical) {
        let script = captures.name("script")?.as_str();
        let script_else = captures.name("scriptElse")?.as_str();

        if script != script_else || !is_plain_relative_path(script) {
            return None;
        }

        let node_path = captures.name("nodePath").map(|m| m.as_str());
        let node_path_else = captures.name("nodePathElse").map(|m| m.as_str());

        match (node_path, node_path_else) {
            (None, None) => {
                return Some(ParsedWindowsCmdShim::Node {
                    script: script.to_string(),
                    node_path_prefix: None,
                });
            }
            (Some(np), Some(npe)) => {
                if np.contains('%') || npe != format!("{};%NODE_PATH%", np) {
                    return None;
                }
                return Some(ParsedWindowsCmdShim::Node {
                    script: script.to_string(),
                    node_path_prefix: Some(np.to_string()),
                });
            }
            _ => return None,
        }
    }

    for pattern in [&*NPM_DIRECT_SHIM, &*PNPM_DIRECT_SHIM] {
        if let Some(captures) = pattern.captures(&canonical) {
            if let Some(target) = captures.name("target") {
                let target_str = target.as_str();
                if is_plain_relative_path(target_str) {
                    let lower = target_str.to_ascii_lowercase();
                    if DIRECT_TARGET_EXTENSIONS.iter().any(|ext| lower.ends_with(ext)) {
                        return Some(ParsedWindowsCmdShim::Direct {
                            target: target_str.to_string(),
                        });
                    }
                }
            }
            return None;
        }
    }

    None
}

/// Attempts to read and resolve a `.cmd` shim file from disk.
pub fn resolve_windows_cmd_shim(shim_path: &Path) -> Option<ResolvedWindowsCmdShim> {
    if std::env::var(DISABLE_CMD_SHIM_RESOLUTION_ENV)
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
    {
        return None;
    }

    if !shim_path.is_absolute() {
        return None;
    }

    let metadata = std::fs::metadata(shim_path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_SHIM_BYTES as u64 {
        return None;
    }

    let contents = std::fs::read_to_string(shim_path).ok()?;
    let parsed = parse_windows_cmd_shim(&contents)?;
    let shim_dir = shim_path.parent()?;

    match parsed {
        ParsedWindowsCmdShim::Node { script, node_path_prefix } => {
            let target_path = shim_dir.join(&script);
            if target_path.exists() {
                Some(ResolvedWindowsCmdShim::Node {
                    script_path: target_path,
                    node_path_prefix,
                })
            } else {
                None
            }
        }
        ParsedWindowsCmdShim::Direct { target } => {
            let lower = target.to_ascii_lowercase();
            if !DIRECT_TARGET_EXTENSIONS.iter().any(|ext| lower.ends_with(ext)) {
                return None;
            }
            let target_path = shim_dir.join(&target);
            if target_path.exists() {
                Some(ResolvedWindowsCmdShim::Direct { target_path })
            } else {
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REAL_CODEX_CMD: &str = r#"@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
"#;

    const REAL_VITEST_CMD: &str = r#"@SETLOCAL
@IF NOT DEFINED NODE_PATH (
  @SET "NODE_PATH=C:\project\node_modules\.pnpm\vitest@3.0.0\node_modules"
) ELSE (
  @SET "NODE_PATH=C:\project\node_modules\.pnpm\vitest@3.0.0\node_modules;%NODE_PATH%"
)
@IF EXIST "%~dp0\node.exe" (
  "%~dp0\node.exe"  "%~dp0\..\vitest\vitest.mjs" %*
) ELSE (
  @SETLOCAL
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  node  "%~dp0\..\vitest\vitest.mjs" %*
)
"#;

    const REAL_PNPM_DIRECT_CMD: &str = r#"@SETLOCAL
@"%~dp0\..\global\pnpm.exe" %*
"#;

    #[test]
    fn test_parse_real_codex_cmd_shim() {
        let parsed = parse_windows_cmd_shim(REAL_CODEX_CMD);
        assert_eq!(
            parsed,
            Some(ParsedWindowsCmdShim::Node {
                script: r#"node_modules\@openai\codex\bin\codex.js"#.to_string(),
                node_path_prefix: None,
            })
        );
    }

    #[test]
    fn test_parse_real_vitest_cmd_shim() {
        let parsed = parse_windows_cmd_shim(REAL_VITEST_CMD);
        assert_eq!(
            parsed,
            Some(ParsedWindowsCmdShim::Node {
                script: r#"..\vitest\vitest.mjs"#.to_string(),
                node_path_prefix: Some(r#"C:\project\node_modules\.pnpm\vitest@3.0.0\node_modules"#.to_string()),
            })
        );
    }

    #[test]
    fn test_parse_pnpm_direct_cmd_shim() {
        let parsed = parse_windows_cmd_shim(REAL_PNPM_DIRECT_CMD);
        assert_eq!(
            parsed,
            Some(ParsedWindowsCmdShim::Direct {
                target: r#"..\global\pnpm.exe"#.to_string(),
            })
        );
    }

    #[test]
    fn test_refuse_drive_relative_path() {
        let malicious = r#"@echo off
"%~dp0\D:evil.exe" %*
"#;
        assert_eq!(parse_windows_cmd_shim(malicious), None);
    }

    #[test]
    fn test_refuse_unexpanded_variable_in_target() {
        let bad = r#"@echo off
"%~dp0\%TARGET%\a.exe" %*
"#;
        assert_eq!(parse_windows_cmd_shim(bad), None);
    }

    #[test]
    fn test_refuse_tampered_shim() {
        let tampered = format!("{}echo tampered\r\n", REAL_CODEX_CMD);
        assert_eq!(parse_windows_cmd_shim(&tampered), None);
    }

    #[test]
    fn test_parse_direct_cmd_shim_rejects_non_executable_extension() {
        let bad_ext = r#"@echo off
"%~dp0\nested\subscript.cmd" %*
"#;
        assert_eq!(parse_windows_cmd_shim(bad_ext), None);

        let bad_bat = r#"@echo off
"%~dp0\nested\subscript.bat" %*
"#;
        assert_eq!(parse_windows_cmd_shim(bad_bat), None);

        let no_ext = r#"@echo off
"%~dp0\nested\binary" %*
"#;
        assert_eq!(parse_windows_cmd_shim(no_ext), None);

        let valid_com = r#"@echo off
"%~dp0\legacy\tool.com" %*
"#;
        assert_eq!(
            parse_windows_cmd_shim(valid_com),
            Some(ParsedWindowsCmdShim::Direct {
                target: r#"legacy\tool.com"#.to_string(),
            })
        );
    }

    #[test]
    fn test_resolve_windows_cmd_shim_rejects_relative_path() {
        let rel_path = Path::new("relative/path/to/shim.cmd");
        assert_eq!(resolve_windows_cmd_shim(rel_path), None);
    }

    #[test]
    fn test_resolve_windows_cmd_shim_kill_switch() {
        let temp_dir = std::env::temp_dir().join(format!(
            "orca_cmd_shim_test_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let shim_file = temp_dir.join("cli.cmd");
        std::fs::write(&shim_file, REAL_PNPM_DIRECT_CMD).unwrap();

        // Target path specified in REAL_PNPM_DIRECT_CMD is `..\global\pnpm.exe`
        let target_dir = temp_dir.parent().unwrap().join("global");
        std::fs::create_dir_all(&target_dir).unwrap();
        let target_file = target_dir.join("pnpm.exe");
        std::fs::write(&target_file, b"executable").unwrap();

        // 1. Normal resolution when kill switch is unset
        std::env::remove_var(DISABLE_CMD_SHIM_RESOLUTION_ENV);
        let resolved = resolve_windows_cmd_shim(&shim_file);
        assert!(resolved.is_some(), "Shim resolution should succeed when kill switch is unset");

        // 2. Kill switch set to "1"
        std::env::set_var(DISABLE_CMD_SHIM_RESOLUTION_ENV, "1");
        assert_eq!(resolve_windows_cmd_shim(&shim_file), None);

        // 3. Kill switch set to "true"
        std::env::set_var(DISABLE_CMD_SHIM_RESOLUTION_ENV, "true");
        assert_eq!(resolve_windows_cmd_shim(&shim_file), None);

        // 4. Kill switch set to "TRUE" (case-insensitive)
        std::env::set_var(DISABLE_CMD_SHIM_RESOLUTION_ENV, "TRUE");
        assert_eq!(resolve_windows_cmd_shim(&shim_file), None);

        // Cleanup
        std::env::remove_var(DISABLE_CMD_SHIM_RESOLUTION_ENV);
        let _ = std::fs::remove_file(&shim_file);
        let _ = std::fs::remove_dir_all(&temp_dir);
        let _ = std::fs::remove_file(&target_file);
        let _ = std::fs::remove_dir(&target_dir);
    }
}
