pub mod models;
pub mod osc;
pub mod session;

#[cfg(windows)]
pub mod windows;

#[cfg(unix)]
pub mod unix;

pub use models::*;
pub use osc::*;
pub use session::*;

#[cfg(windows)]
pub use windows::{
    spawn_windows_pty as spawn, warm_windows_conpty_once, WindowsPtySession as PtySession,
};

#[cfg(unix)]
pub use unix::{spawn_unix_pty as spawn, warm_windows_conpty_once, UnixPtySession as PtySession};
