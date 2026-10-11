use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PsRow {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    pub agent_id: String,
    pub status: String,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
}

impl PsRow {
    pub fn new(
        pid: Option<u32>,
        agent_id: impl Into<String>,
        status: impl Into<String>,
        cwd: impl Into<String>,
        started_at: Option<impl Into<String>>,
    ) -> Self {
        Self {
            pid,
            agent_id: agent_id.into(),
            status: status.into(),
            cwd: cwd.into(),
            started_at: started_at.map(Into::into),
        }
    }
}

/// Formats a list of agent/worktree rows as a clean aligned terminal table.
pub fn format_ps_table(rows: &[PsRow]) -> String {
    if rows.is_empty() {
        return "No active agents or worktrees found.\n".to_string();
    }

    let mut col_pid = "PID".len();
    let mut col_agent = "AGENT ID".len();
    let mut col_status = "STATUS".len();
    let mut col_cwd = "CWD".len();
    let mut col_started = "STARTED AT".len();

    for r in rows {
        let pid_str = r
            .pid
            .map(|p| p.to_string())
            .unwrap_or_else(|| "-".to_string());
        col_pid = col_pid.max(pid_str.len());
        col_agent = col_agent.max(r.agent_id.len());
        col_status = col_status.max(r.status.len());
        col_cwd = col_cwd.max(r.cwd.len());
        col_started = col_started.max(r.started_at.as_deref().unwrap_or("-").len());
    }

    let mut out = String::new();
    out.push_str(&format!(
        "{:<w_pid$}  {:<w_agent$}  {:<w_status$}  {:<w_cwd$}  {:<w_started$}\n",
        "PID",
        "AGENT ID",
        "STATUS",
        "CWD",
        "STARTED AT",
        w_pid = col_pid,
        w_agent = col_agent,
        w_status = col_status,
        w_cwd = col_cwd,
        w_started = col_started,
    ));

    for r in rows {
        let pid_str = r
            .pid
            .map(|p| p.to_string())
            .unwrap_or_else(|| "-".to_string());
        let started_str = r.started_at.as_deref().unwrap_or("-");
        out.push_str(&format!(
            "{:<w_pid$}  {:<w_agent$}  {:<w_status$}  {:<w_cwd$}  {:<w_started$}\n",
            pid_str,
            r.agent_id,
            r.status,
            r.cwd,
            started_str,
            w_pid = col_pid,
            w_agent = col_agent,
            w_status = col_status,
            w_cwd = col_cwd,
            w_started = col_started,
        ));
    }

    out
}

/// Formats any serializable value as pretty-printed JSON.
pub fn format_json<T: Serialize>(value: &T) -> Result<String, serde_json::Error> {
    serde_json::to_string_pretty(value)
}

/// Converts a millisecond UNIX timestamp to an ISO-8601 UTC string.
pub fn format_timestamp_ms(ms: u64) -> String {
    let total_secs = ms / 1000;
    let sec = total_secs % 60;
    let total_mins = total_secs / 60;
    let min = total_mins % 60;
    let total_hours = total_mins / 60;
    let hour = total_hours % 24;
    let mut days = (total_hours / 24) as i64;

    // Epoch 1970-01-01 was a Thursday
    // Compute year, month, day from days since epoch
    let mut year = 1970;
    loop {
        let leap = is_leap_year(year);
        let days_in_year = if leap { 366 } else { 365 };
        if days >= days_in_year {
            days -= days_in_year;
            year += 1;
        } else {
            break;
        }
    }

    let leap = is_leap_year(year);
    let days_in_months = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];

    let mut month = 1;
    for &dim in &days_in_months {
        if days >= dim {
            days -= dim;
            month += 1;
        } else {
            break;
        }
    }
    let day = days + 1;

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hour, min, sec
    )
}

fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_ps_table_empty() {
        let rows: Vec<PsRow> = vec![];
        let table = format_ps_table(&rows);
        assert_eq!(table, "No active agents or worktrees found.\n");
    }

    #[test]
    fn test_format_ps_table_aligned() {
        let rows = vec![
            PsRow::new(
                Some(1234),
                "claude-sonnet-1",
                "live",
                "/workspace/orca",
                Some("2026-10-11T00:00:00Z"),
            ),
            PsRow::new(
                None,
                "subagent-99",
                "exited",
                "/workspace/orca/sub",
                None::<String>,
            ),
        ];
        let table = format_ps_table(&rows);
        let lines: Vec<&str> = table.lines().collect();
        assert_eq!(lines.len(), 3);
        assert!(lines[0].contains("PID"));
        assert!(lines[0].contains("AGENT ID"));
        assert!(lines[0].contains("STATUS"));
        assert!(lines[0].contains("CWD"));
        assert!(lines[0].contains("STARTED AT"));
        assert!(lines[1].contains("1234"));
        assert!(lines[1].contains("claude-sonnet-1"));
        assert!(lines[2].contains("-"));
        assert!(lines[2].contains("subagent-99"));
    }

    #[test]
    fn test_format_json() {
        let row = PsRow::new(
            Some(42),
            "agent-1",
            "live",
            "/app",
            Some("2026-10-11T00:00:00Z"),
        );
        let json = format_json(&row).unwrap();
        assert!(json.contains("\"pid\": 42"));
        assert!(json.contains("\"agentId\": \"agent-1\""));
    }

    #[test]
    fn test_format_timestamp_ms() {
        // 1700000000000 ms is 2023-11-14T22:13:20Z
        let formatted = format_timestamp_ms(1700000000000);
        assert_eq!(formatted, "2023-11-14T22:13:20Z");
    }
}
