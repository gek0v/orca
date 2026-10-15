//! Linux systemd user scope management and cgroup isolation for Orca daemon.
//!
//! Provides cgroup isolation under `orca-daemon-<nonce>.scope` so that background
//! daemon and PTY processes are not killed when a user session or service terminates.

use std::path::Path;

pub const UNIT_NAME_PREFIX: &str = "orca-daemon-";
pub const SYSTEMD_BOOT_PATH: &str = "/run/systemd/system";

/// Sanitizes a nonce and formats it into the canonical transient scope unit name:
/// `orca-daemon-<sanitized-nonce>.scope`
pub fn daemon_scope_unit_name(launch_nonce: &str) -> String {
    let sanitized: String = launch_nonce
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == ':' || c == '_' || c == '.' || c == '-' || c == '@'
            {
                c
            } else {
                '-'
            }
        })
        .collect();
    format!("{}{}.scope", UNIT_NAME_PREFIX, sanitized)
}

/// Checks whether the host was booted under systemd by checking for the existence
/// of `/run/systemd/system`.
pub fn is_systemd_booted() -> bool {
    Path::new(SYSTEMD_BOOT_PATH).exists()
}

/// Resolves user runtime directory where systemd `--user` bus lives (`/run/user/<uid>` or `$XDG_RUNTIME_DIR`).
pub fn resolve_user_runtime_dir() -> Option<String> {
    #[cfg(unix)]
    {
        let uid = unsafe { libc::getuid() };
        let canonical = format!("/run/user/{}", uid);
        let bus_socket = format!("{}/bus", canonical);
        if Path::new(&bus_socket).exists() {
            return Some(canonical);
        }
    }

    if let Ok(xdg) = std::env::var("XDG_RUNTIME_DIR") {
        if !xdg.is_empty() {
            return Some(xdg);
        }
    }

    None
}

/// Returns whether systemd transient user scope creation is supported on this platform.
pub fn is_systemd_user_scope_supported() -> bool {
    if !cfg!(target_os = "linux") {
        return false;
    }

    if !is_systemd_booted() {
        return false;
    }

    resolve_user_runtime_dir().is_some()
}

/// Parses the current process's cgroup paths from `/proc/self/cgroup` content (v1 or v2 unified).
pub fn parse_cgroup_scope(cgroup_content: &str) -> Option<String> {
    for line in cgroup_content.lines() {
        let parts: Vec<&str> = line.split(':').collect();
        if parts.len() >= 3 {
            let path = parts[2].trim();
            if let Some(scope_pos) = path.find(".scope") {
                let prefix = &path[..scope_pos + 6];
                if let Some(last_slash) = prefix.rfind('/') {
                    let unit = &prefix[last_slash + 1..];
                    if unit.starts_with(UNIT_NAME_PREFIX) || unit.starts_with("app-orca-") {
                        return Some(unit.to_string());
                    }
                }
            }
        }
    }
    None
}

/// Builds the arguments for `systemd-run --user --scope --collect --unit=<unit> <exec> <args...>`.
pub fn build_systemd_run_args(unit_name: &str, exec_path: &str, args: &[String]) -> Vec<String> {
    let mut cmd_args = vec![
        "--user".to_string(),
        "--scope".to_string(),
        "--collect".to_string(),
        format!("--unit={}", unit_name),
        "--".to_string(),
        exec_path.to_string(),
    ];
    cmd_args.extend(args.iter().cloned());
    cmd_args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_daemon_scope_unit_name_formatting() {
        assert_eq!(
            daemon_scope_unit_name("123e4567-e89b-12d3-a456-426614174000"),
            "orca-daemon-123e4567-e89b-12d3-a456-426614174000.scope"
        );
        assert_eq!(
            daemon_scope_unit_name("invalid/chars$@here"),
            "orca-daemon-invalid-chars-@here.scope"
        );
    }

    #[test]
    fn test_parse_cgroup_scope_v2_unified() {
        let sample =
            "0::/user.slice/user-1000.slice/user@1000.service/app.slice/orca-daemon-abc123.scope\n";
        assert_eq!(
            parse_cgroup_scope(sample),
            Some("orca-daemon-abc123.scope".to_string())
        );
    }

    #[test]
    fn test_parse_cgroup_scope_v1_controllers() {
        let sample = "2:cpu,cpuacct:/user.slice/user-1000.slice/orca-daemon-session-xyz.scope\n1:name=systemd:/user.slice/user-1000.slice/orca-daemon-session-xyz.scope\n";
        assert_eq!(
            parse_cgroup_scope(sample),
            Some("orca-daemon-session-xyz.scope".to_string())
        );
    }

    #[test]
    fn test_build_systemd_run_args() {
        let args = build_systemd_run_args(
            "orca-daemon-test.scope",
            "/usr/bin/orcad",
            &["--listen".to_string(), "127.0.0.1".to_string()],
        );
        assert_eq!(
            args,
            vec![
                "--user",
                "--scope",
                "--collect",
                "--unit=orca-daemon-test.scope",
                "--",
                "/usr/bin/orcad",
                "--listen",
                "127.0.0.1"
            ]
        );
    }
}
