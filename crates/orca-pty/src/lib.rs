pub mod session;

#[cfg(windows)]
pub mod windows;

#[cfg(unix)]
pub mod unix;

pub use session::*;

#[cfg(windows)]
pub use windows::{spawn_windows_pty as spawn, WindowsPtySession as PtySession};

#[cfg(unix)]
pub use unix::{spawn_unix_pty as spawn, UnixPtySession as PtySession};
