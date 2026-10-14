//! Process supervisor and OS isolation primitives.

pub mod cmd_shim;
pub mod command_line;
pub mod isolation;
pub mod job_object;

pub use cmd_shim::{parse_windows_cmd_shim, resolve_windows_cmd_shim, ParsedWindowsCmdShim, ResolvedWindowsCmdShim};
pub use command_line::{
    build_windows_cmd_shim_command_line, is_cmd_interpreted_program, quote_windows_argument,
    quote_windows_cmd_argument, validate_windows_cmd_arguments, CommandEscapingError,
};
pub use isolation::CREATE_NO_WINDOW;
#[cfg(windows)]
pub use job_object::windows::ProcessJobObject;
#[cfg(not(windows))]
pub use job_object::unix::ProcessJobObject;
