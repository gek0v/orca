//! Process isolation flags and execution constants.

/// Windows creation flag to suppress the creation of a new console window.
///
/// In GUI applications, spawning console executables without this flag causes
/// `conhost.exe` to flash a black console window on screen, stealing active focus.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
