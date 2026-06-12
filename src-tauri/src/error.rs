// Unified error type for Tauri commands. Serializes to a plain string so the
// frontend receives a readable message (mirrors the Electron handlers' thrown Errors).
use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum InstallerError {
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("download failed: {0}")]
    Download(String),
    #[error("pty error: {0}")]
    Pty(String),
    #[cfg(not(windows))]
    #[error("authorization failed: {0}")]
    Sudo(String),
    #[error("{0}")]
    Other(String),
}

impl Serialize for InstallerError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type CmdResult<T> = std::result::Result<T, InstallerError>;
