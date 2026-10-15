use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalModes {
    pub bracketed_paste: bool,
    pub mouse_tracking: bool,
    pub mouse_tracking_mode: Option<String>,
    pub sgr_mouse_mode: Option<bool>,
    pub sgr_mouse_pixels_mode: Option<bool>,
    pub application_cursor: bool,
    pub alternate_screen: bool,
    pub kitty_keyboard_flags: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOscLinkRange {
    pub row: usize,
    pub start_col: usize,
    pub end_col: usize,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSnapshot {
    pub snapshot_ansi: String,
    pub scrollback_ansi: String,
    pub pending_escape_tail_ansi: Option<String>,
    pub osc_links: Option<Vec<TerminalOscLinkRange>>,
    pub rehydrate_sequences: String,
    pub frame_restore_ansi: Option<String>,
    pub cwd: Option<String>,
    pub modes: TerminalModes,
    pub cols: u16,
    pub rows: u16,
    pub scrollback_lines: usize,
    pub last_title: Option<String>,
    pub output_sequence: Option<u64>,
    pub terminal_owner: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingOutputRecord {
    pub kind: String, // "output", "resize", "clear"
    pub data: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TakePendingOutputResult {
    pub records: Vec<PendingOutputRecord>,
    pub seq: u64,
    pub overflowed: bool,
    pub snapshot: Option<TerminalSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PausePtyParams {
    pub terminal_id: Option<String>,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumePtyParams {
    pub terminal_id: Option<String>,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSessionBackgroundParams {
    pub terminal_id: Option<String>,
    pub session_id: Option<String>,
    pub background: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalParams {
    pub terminal_id: Option<String>,
    pub session_id: Option<String>,
    pub signal: String,
}
