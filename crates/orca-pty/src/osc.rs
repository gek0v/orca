const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
const BACKSLASH: u8 = 0x5c;
const RIGHT_BRACKET: u8 = 0x5d;
const SEMICOLON: u8 = 0x3b;

pub const OSC_SCAN_TAIL_LIMIT: usize = 4096;
pub const MAX_OSC_TITLE_CHARS: usize = 1024;

#[derive(Debug, Clone, Default)]
pub struct OscScanner {
    scan_tail: Vec<u8>,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub wsl_distro: Option<String>,
}

impl OscScanner {
    pub fn new(wsl_distro: Option<String>) -> Self {
        Self {
            scan_tail: Vec::new(),
            cwd: None,
            title: None,
            wsl_distro,
        }
    }

    pub fn get_cwd(&self) -> Option<&str> {
        self.cwd.as_deref()
    }

    pub fn get_title(&self) -> Option<&str> {
        self.title.as_deref()
    }

    pub fn scan(&mut self, data: &[u8]) {
        // Fast pre-filter: if tail is empty and no OSC introducer present,
        // only retain if chunk ends with bare ESC.
        if self.scan_tail.is_empty() && !data.windows(2).any(|w| w == [ESC, RIGHT_BRACKET]) {
            if data.ends_with(&[ESC]) {
                self.scan_tail = vec![ESC];
            }
            return;
        }

        let mut input = std::mem::take(&mut self.scan_tail);
        input.extend_from_slice(data);

        self.extract_osc7(&input);
        self.extract_osc_titles(&input);

        self.scan_tail = extract_scan_tail(&input, OSC_SCAN_TAIL_LIMIT);
    }

    fn extract_osc7(&mut self, input: &[u8]) {
        let prefix = [ESC, RIGHT_BRACKET, b'7', SEMICOLON];
        let mut search_start = 0;

        while search_start + prefix.len() <= input.len() {
            if let Some(pos) = input[search_start..]
                .windows(prefix.len())
                .position(|w| w == prefix)
            {
                let start = search_start + pos;
                let uri_start = start + prefix.len();
                let mut cursor = uri_start;
                let mut found = false;

                while cursor < input.len() {
                    let b = input[cursor];
                    if b == BEL {
                        let uri_slice = &input[uri_start..cursor];
                        if let Ok(uri_str) = std::str::from_utf8(uri_slice) {
                            if let Some(parsed) =
                                parse_osc7_uri(uri_str, self.wsl_distro.as_deref())
                            {
                                self.cwd = Some(parsed);
                            }
                        }
                        search_start = cursor + 1;
                        found = true;
                        break;
                    } else if b == ESC {
                        if cursor + 1 < input.len() && input[cursor + 1] == BACKSLASH {
                            let uri_slice = &input[uri_start..cursor];
                            if let Ok(uri_str) = std::str::from_utf8(uri_slice) {
                                if let Some(parsed) =
                                    parse_osc7_uri(uri_str, self.wsl_distro.as_deref())
                                {
                                    self.cwd = Some(parsed);
                                }
                            }
                            search_start = cursor + 2;
                            found = true;
                            break;
                        } else if cursor + 1 == input.len() {
                            // Incomplete ST sequence at end of input
                            break;
                        }
                    }
                    cursor += 1;
                }

                if !found {
                    break;
                }
            } else {
                break;
            }
        }
    }

    fn extract_osc_titles(&mut self, input: &[u8]) {
        let mut search_start = 0;

        while search_start + 4 <= input.len() {
            if let Some(pos) = input[search_start..]
                .windows(2)
                .position(|w| w == [ESC, RIGHT_BRACKET])
            {
                let start = search_start + pos;
                if start + 3 >= input.len() {
                    break;
                }

                let cmd = input[start + 2];
                let semi = input[start + 3];

                if (cmd == b'0' || cmd == b'1' || cmd == b'2') && semi == SEMICOLON {
                    let title_start = start + 4;
                    let mut cursor = title_start;
                    let mut found = false;

                    while cursor < input.len() {
                        let b = input[cursor];
                        if b == BEL {
                            let title_slice = &input[title_start..cursor];
                            if let Ok(raw_title) = std::str::from_utf8(title_slice) {
                                self.title = Some(bound_osc_title(raw_title));
                            }
                            search_start = cursor + 1;
                            found = true;
                            break;
                        } else if b == ESC {
                            if cursor + 1 < input.len() && input[cursor + 1] == BACKSLASH {
                                let title_slice = &input[title_start..cursor];
                                if let Ok(raw_title) = std::str::from_utf8(title_slice) {
                                    self.title = Some(bound_osc_title(raw_title));
                                }
                                search_start = cursor + 2;
                                found = true;
                                break;
                            } else if cursor + 1 == input.len() {
                                break;
                            }
                        }
                        cursor += 1;
                    }

                    if !found {
                        break;
                    }
                } else {
                    search_start = start + 2;
                }
            } else {
                break;
            }
        }
    }
}

pub fn bound_osc_title(title: &str) -> String {
    if title.len() <= MAX_OSC_TITLE_CHARS {
        title.to_string()
    } else {
        let prefix_len = MAX_OSC_TITLE_CHARS / 2;
        let suffix_len = MAX_OSC_TITLE_CHARS - prefix_len;
        let prefix: String = title.chars().take(prefix_len).collect();
        let total_chars = title.chars().count();
        let skip_count = total_chars.saturating_sub(suffix_len);
        let suffix: String = title.chars().skip(skip_count).collect();
        format!("{}{}", prefix, suffix)
    }
}

pub fn extract_scan_tail(input: &[u8], limit: usize) -> Vec<u8> {
    if let Some(last_osc) = input.windows(2).rposition(|w| w == [ESC, RIGHT_BRACKET]) {
        let suffix = &input[last_osc..];
        let has_bel = suffix.contains(&BEL);
        let has_st = suffix.windows(2).any(|w| w == [ESC, BACKSLASH]);
        if !has_bel && !has_st {
            let tail_slice = if suffix.len() > limit {
                &suffix[suffix.len() - limit..]
            } else {
                suffix
            };
            return tail_slice.to_vec();
        }
    }

    if input.ends_with(&[ESC]) {
        return vec![ESC];
    }

    Vec::new()
}

pub fn percent_decode(s: &str) -> String {
    let mut bytes = Vec::with_capacity(s.len());
    let mut chars = s.bytes();
    while let Some(b) = chars.next() {
        if b == b'%' {
            let h1 = chars.next();
            let h2 = chars.next();
            if let (Some(c1), Some(c2)) = (h1, h2) {
                if let (Some(d1), Some(d2)) = (hex_digit(c1), hex_digit(c2)) {
                    bytes.push((d1 << 4) | d2);
                    continue;
                }
            }
        }
        bytes.push(b);
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn hex_digit(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

pub fn parse_osc7_uri(uri: &str, wsl_distro: Option<&str>) -> Option<String> {
    let rest = uri.strip_prefix("file://")?;
    let (hostname, path_raw) = match rest.find('/') {
        Some(idx) => (&rest[..idx], &rest[idx..]),
        None => (rest, "/"),
    };

    let decoded_path = percent_decode(path_raw);
    let host_lower = hostname.to_ascii_lowercase();

    // 1. WSL Distro translation
    if let Some(distro) = wsl_distro {
        // If drvfs mount (/mnt/c/...), map to Windows drive
        if decoded_path.starts_with("/mnt/") && decoded_path.len() >= 6 {
            let drive_char = decoded_path.as_bytes()[5] as char;
            if drive_char.is_ascii_alphabetic() {
                let tail = if decoded_path.len() > 6 && decoded_path.as_bytes()[6] == b'/' {
                    &decoded_path[7..]
                } else {
                    ""
                };
                let norm_tail = tail.replace('/', "\\");
                if norm_tail.is_empty() {
                    return Some(format!("{}:\\", drive_char.to_ascii_uppercase()));
                } else {
                    return Some(format!(
                        "{}:\\{}",
                        drive_char.to_ascii_uppercase(),
                        norm_tail
                    ));
                }
            }
        }

        // Generic WSL Linux path -> Windows UNC path: \\wsl.localhost\<distro>\<path>
        let norm = decoded_path.replace('/', "\\");
        let path_clean = if norm.is_empty() { "\\" } else { &norm };
        return Some(format!(r"\\wsl.localhost\{}{}", distro, path_clean));
    }

    // 2. Windows drive letters: /C:/Users/... -> C:\Users\... or C:/Users/... -> C:\Users\...
    let is_windows_host = cfg!(windows);
    let is_drive = (decoded_path.len() >= 3
        && decoded_path.starts_with('/')
        && decoded_path.as_bytes()[1].is_ascii_alphabetic()
        && decoded_path.as_bytes()[2] == b':')
        || (decoded_path.len() >= 2
            && decoded_path.as_bytes()[0].is_ascii_alphabetic()
            && decoded_path.as_bytes()[1] == b':');

    if is_drive {
        let clean = if decoded_path.starts_with('/') {
            &decoded_path[1..]
        } else {
            &decoded_path
        };
        return Some(clean.replace('/', "\\"));
    }

    // 3. UNC share if non-empty, non-local hostname on Windows
    if is_windows_host
        && !host_lower.is_empty()
        && host_lower != "localhost"
        && host_lower != "127.0.0.1"
    {
        let tail = decoded_path.replace('/', "\\");
        return Some(format!(r"\\{}{}", hostname, tail));
    }

    // 4. Default: return decoded path
    Some(decoded_path)
}
