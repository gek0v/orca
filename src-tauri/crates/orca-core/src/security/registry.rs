//! Windows Registry query and environment hydration helper.

#[cfg(windows)]
pub mod windows {
    use winreg::enums::*;
    use winreg::RegKey;

    /// Reads a string value from `HKEY_CURRENT_USER\Environment`.
    pub fn get_user_environment_variable(name: &str) -> Option<String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let env_key = hkcu.open_subkey("Environment").ok()?;
        env_key.get_value(name).ok()
    }

    /// Reads a string value from `HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Session Manager\Environment`.
    pub fn get_system_environment_variable(name: &str) -> Option<String> {
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        let env_key = hklm
            .open_subkey(r#"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"#)
            .ok()?;
        env_key.get_value(name).ok()
    }
}

#[cfg(not(windows))]
pub mod unix {
    pub fn get_user_environment_variable(_name: &str) -> Option<String> {
        None
    }

    pub fn get_system_environment_variable(_name: &str) -> Option<String> {
        None
    }
}

#[cfg(windows)]
pub use windows::*;
#[cfg(not(windows))]
pub use unix::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_read_registry_environment() {
        #[cfg(windows)]
        {
            // On Windows, the system PATH environment variable is always defined
            let path_val = get_system_environment_variable("Path")
                .or_else(|| get_system_environment_variable("PATH"));
            assert!(path_val.is_some(), "Expected to read system PATH from Windows registry");
        }
    }
}
