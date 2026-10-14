//! Security, OS credentials vault, and Registry integration.

pub mod credentials;
pub mod registry;

pub use credentials::{
    delete_credential, get_credential, set_credential, CredentialError,
    ORCA_KEYRING_SERVICE_DEFAULT,
};
pub use registry::{get_system_environment_variable, get_user_environment_variable};
