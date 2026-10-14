//! OS-native secure credential storage using keyring.
//!
//! Replaces Node.js credential storage with native OS vaults:
//! - Windows: Windows Credential Manager (CredReadW / CredWriteW)
//! - macOS: Apple Keychain Services
//! - Linux: Freedesktop Secret Service over D-Bus

use keyring::Entry;
use thiserror::Error;

pub const ORCA_KEYRING_SERVICE_DEFAULT: &str = "com.stablyai.orca";

#[derive(Debug, Error)]
pub enum CredentialError {
    #[error("Keyring OS vault error: {0}")]
    KeyringError(#[from] keyring::Error),
}

/// Stores a secure credential in the OS vault.
pub fn set_credential(service: &str, user: &str, secret: &str) -> Result<(), CredentialError> {
    let entry = Entry::new(service, user)?;
    entry.set_password(secret)?;
    Ok(())
}

/// Retrieves a secure credential from the OS vault.
///
/// Returns `Ok(None)` if no matching entry exists.
pub fn get_credential(service: &str, user: &str) -> Result<Option<String>, CredentialError> {
    let entry = Entry::new(service, user)?;
    match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(CredentialError::KeyringError(e)),
    }
}

/// Deletes a secure credential from the OS vault.
///
/// Returns `Ok(true)` if deleted, `Ok(false)` if the entry was not found.
pub fn delete_credential(service: &str, user: &str) -> Result<bool, CredentialError> {
    let entry = Entry::new(service, user)?;
    match entry.delete_credential() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(CredentialError::KeyringError(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_credential_roundtrip() {
        let service = "com.stablyai.orca.test";
        let user = "test_user_keyring";
        let secret = "sk-test-secret-token-12345";

        // Clean up any stale test key
        let _ = delete_credential(service, user);

        assert_eq!(get_credential(service, user).unwrap(), None);

        set_credential(service, user, secret).unwrap();
        assert_eq!(get_credential(service, user).unwrap(), Some(secret.to_string()));

        assert!(delete_credential(service, user).unwrap());
        assert_eq!(get_credential(service, user).unwrap(), None);
    }
}
