use crate::models::GitWorktreeInfo;

/// Decodes Git's C-quoted path/string if enclosed in double quotes.
pub fn decode_git_cquoted_path(s: &str) -> String {
    let trimmed = s.trim();
    if !trimmed.starts_with('"') || !trimmed.ends_with('"') || trimmed.len() < 2 {
        return trimmed.to_string();
    }

    let inner = &trimmed[1..trimmed.len() - 1];
    let bytes = inner.as_bytes();
    let mut out_bytes = Vec::with_capacity(bytes.len());
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            match bytes[i + 1] {
                b'\\' => {
                    out_bytes.push(b'\\');
                    i += 2;
                }
                b'"' => {
                    out_bytes.push(b'"');
                    i += 2;
                }
                b'n' => {
                    out_bytes.push(b'\n');
                    i += 2;
                }
                b't' => {
                    out_bytes.push(b'\t');
                    i += 2;
                }
                b'r' => {
                    out_bytes.push(b'\r');
                    i += 2;
                }
                b'0'..=b'7' => {
                    let mut val = 0u8;
                    let mut count = 0;
                    i += 1;
                    while i < bytes.len() && (b'0'..=b'7').contains(&bytes[i]) && count < 3 {
                        val = val.wrapping_mul(8).wrapping_add(bytes[i] - b'0');
                        i += 1;
                        count += 1;
                    }
                    out_bytes.push(val);
                }
                other => {
                    out_bytes.push(other);
                    i += 2;
                }
            }
        } else {
            out_bytes.push(bytes[i]);
            i += 1;
        }
    }

    String::from_utf8_lossy(&out_bytes).into_owned()
}

/// Parses the output of `git worktree list --porcelain` (line or NUL delimited).
pub fn parse_git_worktree_porcelain(output: &str, nul_delimited: bool) -> Vec<GitWorktreeInfo> {
    let mut worktrees = Vec::new();

    let blocks: Vec<Vec<&str>> = if nul_delimited {
        output
            .split("\0\0")
            .map(|block| {
                block
                    .split('\0')
                    .map(|l| l.trim())
                    .filter(|l| !l.is_empty())
                    .collect()
            })
            .filter(|lines: &Vec<&str>| !lines.is_empty())
            .collect()
    } else {
        output
            .split("\n\n")
            .map(|block| {
                block
                    .lines()
                    .map(|l| l.trim())
                    .filter(|l| !l.is_empty())
                    .collect()
            })
            .filter(|lines: &Vec<&str>| !lines.is_empty())
            .collect()
    };

    for lines in blocks {
        let mut path: Option<String> = None;
        let mut head: Option<String> = None;
        let mut branch: Option<String> = None;
        let mut is_bare = false;
        let mut is_sparse = false;
        let mut locked = false;
        let mut lock_reason: Option<String> = None;
        let mut prunable = false;
        let mut prunable_reason: Option<String> = None;

        for line in lines {
            if let Some(rest) = line.strip_prefix("worktree ") {
                path = Some(if nul_delimited {
                    rest.to_string()
                } else {
                    decode_git_cquoted_path(rest)
                });
            } else if let Some(rest) = line.strip_prefix("HEAD ") {
                head = Some(rest.to_string());
            } else if let Some(rest) = line.strip_prefix("branch refs/heads/") {
                branch = Some(rest.to_string());
            } else if line == "detached" {
                branch = Some("detached".to_string());
            } else if line == "bare" {
                is_bare = true;
            } else if line == "sparse" {
                is_sparse = true;
            } else if line == "locked" {
                locked = true;
            } else if let Some(rest) = line.strip_prefix("locked ") {
                locked = true;
                lock_reason = Some(if nul_delimited {
                    rest.to_string()
                } else {
                    decode_git_cquoted_path(rest)
                });
            } else if line == "prunable" {
                prunable = true;
            } else if let Some(rest) = line.strip_prefix("prunable ") {
                prunable = true;
                prunable_reason = Some(if nul_delimited {
                    rest.to_string()
                } else {
                    decode_git_cquoted_path(rest)
                });
            }
        }

        if let Some(p) = path {
            let is_main = worktrees.is_empty();
            worktrees.push(GitWorktreeInfo {
                path: p,
                head,
                branch,
                is_bare,
                is_sparse,
                locked,
                lock_reason,
                prunable,
                prunable_reason,
                is_main,
            });
        }
    }

    worktrees
}
