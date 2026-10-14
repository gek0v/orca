//! Windows command-line construction and dual escaping algorithms.
//!
//! Two parsers read the line passed to CreateProcess on Windows, and they disagree:
//! - The target program's startup code (`CommandLineToArgvW`) understands `\"` as a
//!   literal quote and `\\` as a literal backslash.
//! - `cmd.exe` (unavoidable for `.cmd`/`.bat` targets) does NOT. It counts `"` naively
//!   to track quote state, and inside that state it still expands `%VAR%`.
//!
//! The encoding below satisfies both parsers simultaneously, writing embedded quotes
//! as `""` (which CommandLineToArgvW decodes to `"` while keeping cmd's quote count even)
//! and escaping percent signs as `"^%"` so `%VAR%` is never expanded by cmd.exe.
//! See `src/shared/child-process/windows-command-line.ts`.

use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CommandEscapingError {
    #[error("cmd.exe cannot receive an argument containing a line break")]
    LineBreakNotAllowed,
}

/// Quotes one argument for `CommandLineToArgvW`, encoding embedded quotes as `""`.
pub fn quote_windows_argument(value: &str) -> String {
    quote_windows(value, false)
}

/// Quotes one argument that must survive both `cmd.exe` and `CommandLineToArgvW`.
pub fn quote_windows_cmd_argument(value: &str) -> String {
    quote_windows(value, true)
}

fn quote_windows(value: &str, escape_percent: bool) -> String {
    let needs_quote = if escape_percent {
        value.contains('\\') || value.contains('"') || value.contains('%') || value.contains(' ') || value.is_empty()
    } else {
        value.contains('\\') || value.contains('"') || value.contains(' ') || value.is_empty()
    };

    if !needs_quote {
        return format!("\"{}\"", value);
    }

    let mut quoted = String::with_capacity(value.len() + 8);
    quoted.push('"');

    let mut backslashes = 0;
    for ch in value.chars() {
        if ch == '\\' {
            backslashes += 1;
            continue;
        }

        if ch == '"' {
            // The backslash run is literal, so double it; the quote itself becomes `""`.
            for _ in 0..(backslashes * 2) {
                quoted.push('\\');
            }
            quoted.push_str("\"\"");
            backslashes = 0;
            continue;
        }

        if escape_percent && ch == '%' {
            // `%VAR%` expands even inside quotes in cmd.exe. Break the pair: close quote,
            // escape percent, reopen. The backslash run must be doubled first.
            for _ in 0..(backslashes * 2) {
                quoted.push('\\');
            }
            quoted.push_str("\"^%\"");
            backslashes = 0;
            continue;
        }

        for _ in 0..backslashes {
            quoted.push('\\');
        }
        quoted.push(ch);
        backslashes = 0;
    }

    // Trailing backslashes precede closing quote, so double them to avoid escaping the closing quote.
    for _ in 0..(backslashes * 2) {
        quoted.push('\\');
    }
    quoted.push('"');

    quoted
}

/// Validates that no arguments contain CR or LF line breaks.
pub fn validate_windows_cmd_arguments<T: AsRef<str>>(values: &[T]) -> Result<(), CommandEscapingError> {
    for val in values {
        if val.as_ref().contains('\r') || val.as_ref().contains('\n') {
            return Err(CommandEscapingError::LineBreakNotAllowed);
        }
    }
    Ok(())
}

/// Constructs the composite command-line for `cmd.exe /c` execution.
///
/// Uses `/d` (skip AutoRun registry scripts), `/v:off` (disable delayed expansion so `!` stays literal),
/// and `/s` (strip outer quotes and treat inner verbatim).
pub fn build_windows_cmd_shim_command_line(
    program: &str,
    args: &[&str],
) -> Result<String, CommandEscapingError> {
    validate_windows_cmd_arguments(&[program])?;
    validate_windows_cmd_arguments(args)?;

    let mut inner = quote_windows_cmd_argument(program);
    for arg in args {
        inner.push(' ');
        inner.push_str(&quote_windows_cmd_argument(arg));
    }

    Ok(format!("/d /v:off /s /c \"{}\"", inner))
}

/// Checks whether `program` ends in `.cmd` or `.bat` (case-insensitive).
pub fn is_cmd_interpreted_program(program: &str) -> bool {
    let lower = program.to_ascii_lowercase();
    lower.ends_with(".cmd") || lower.ends_with(".bat")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Basic CommandLineToArgvW parser simulation for verification.
    fn parse_command_line_to_argv(line: &str) -> Vec<String> {
        let mut argv = Vec::new();
        let mut current = String::new();
        let mut quoted = false;
        let mut started = false;
        let chars: Vec<char> = line.chars().collect();
        let mut i = 0;

        while i < chars.len() {
            let ch = chars[i];
            if !started && ch.is_whitespace() {
                i += 1;
                continue;
            }
            started = true;

            if ch == '\\' {
                let mut backslashes = 0;
                while i < chars.len() && chars[i] == '\\' {
                    backslashes += 1;
                    i += 1;
                }
                if i < chars.len() && chars[i] == '"' {
                    for _ in 0..(backslashes / 2) {
                        current.push('\\');
                    }
                    if backslashes % 2 == 1 {
                        current.push('"');
                        i += 1;
                    }
                } else {
                    for _ in 0..backslashes {
                        current.push('\\');
                    }
                }
                continue;
            }

            if ch == '"' {
                if quoted && i + 1 < chars.len() && chars[i + 1] == '"' {
                    current.push('"');
                    i += 2;
                    continue;
                }
                quoted = !quoted;
                i += 1;
                continue;
            }

            if !quoted && ch.is_whitespace() {
                argv.push(current);
                current = String::new();
                started = false;
                i += 1;
                continue;
            }

            current.push(ch);
            i += 1;
        }

        if started {
            argv.push(current);
        }

        argv
    }

    fn quote_parity(line: &str) -> usize {
        line.chars().filter(|&c| c == '"').count() % 2
    }

    #[test]
    fn test_quote_windows_argument_embedded_quotes() {
        let quoted = quote_windows_argument("c\"d");
        assert_eq!(quoted, "\"c\"\"d\"");
        assert_eq!(quote_parity(&quoted), 0);
        assert_eq!(parse_command_line_to_argv(&quoted), vec!["c\"d"]);
    }

    #[test]
    fn test_quote_windows_argument_trailing_backslash() {
        let quoted = quote_windows_argument("C:\\dir\\");
        assert_eq!(quoted, "\"C:\\dir\\\\\"");
        assert_eq!(parse_command_line_to_argv(&quoted), vec!["C:\\dir\\"]);
    }

    #[test]
    fn test_quote_windows_cmd_argument_percent_escaping() {
        let quoted = quote_windows_cmd_argument("e%F%g");
        assert_eq!(quoted, "\"e\"^%\"F\"^%\"g\"");
        assert_eq!(quote_parity(&quoted), 0);
    }

    #[test]
    fn test_build_windows_cmd_shim_command_line() {
        let cmd = build_windows_cmd_shim_command_line("C:\\test.cmd", &["arg1", "arg with space", "c\"d"]).unwrap();
        assert!(cmd.starts_with("/d /v:off /s /c \""));
        assert!(cmd.ends_with('"'));
    }

    #[test]
    fn test_validate_windows_cmd_arguments_rejects_line_break() {
        let res = validate_windows_cmd_arguments(&["line1\nline2"]);
        assert_eq!(res, Err(CommandEscapingError::LineBreakNotAllowed));

        let res_cr = validate_windows_cmd_arguments(&["line1\rline2"]);
        assert_eq!(res_cr, Err(CommandEscapingError::LineBreakNotAllowed));
    }

    #[test]
    fn test_is_cmd_interpreted_program() {
        assert!(is_cmd_interpreted_program("script.cmd"));
        assert!(is_cmd_interpreted_program("run.BAT"));
        assert!(!is_cmd_interpreted_program("app.exe"));
        assert!(!is_cmd_interpreted_program("node"));
    }
}
