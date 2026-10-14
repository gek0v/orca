//! Process supervisor and OS isolation primitives.

pub mod isolation;
pub mod job_object;

pub use isolation::CREATE_NO_WINDOW;
#[cfg(windows)]
pub use job_object::windows::ProcessJobObject;
#[cfg(not(windows))]
pub use job_object::unix::ProcessJobObject;
