//! Errors returned by commands.
//!
//! They cross IPC as a plain string (`Display`). Variants the UI needs to react to carry a
//! stable `CODE: ` prefix (`STALE`, `EXISTS`, `GH_MISSING`, `GH_AUTH`, `NO_REPO`,
//! `AZ_MISSING`, `AZ_AUTH`, `NO_UPDATE`) that `errorText` in `lib/ipc.ts` can match on.

use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{}: {source}", path.display())]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("{} is outside the scanned folders and library", .0.display())]
    OutOfScope(PathBuf),
    #[error("{} doesn't exist", .0.display())]
    NotFound(PathBuf),
    #[error("{} is too large ({bytes} bytes; the limit is {max})", path.display())]
    TooLarge { path: PathBuf, bytes: u64, max: u64 },
    #[error("{} isn't UTF-8 text", .0.display())]
    NotUtf8(PathBuf),
    #[error("STALE: {} changed on disk since it was loaded. Reload it first.", .0.display())]
    Stale(PathBuf),
    #[error("EXISTS: {} already exists", .0.display())]
    Exists(PathBuf),
    #[error("{} isn't a dotenv file", .0.display())]
    NotDotenv(PathBuf),
    #[error("{0}")]
    InvalidDotenv(String),
    #[error("\"{0}\" isn't a valid file name")]
    InvalidName(String),
    #[error("Couldn't use the EnvDeck config file: {0}")]
    Manifest(String),
    /// A native facility (dialog, clipboard, drag, reveal) failed.
    #[error("{0}")]
    Native(String),
    #[error("GH_MISSING: The GitHub CLI (gh) isn't installed or couldn't be found")]
    GhMissing,
    /// The GitHub CLI isn't signed in to the repository's host, or GitHub rejected its token.
    #[error("GH_AUTH: {0}")]
    GhAuth(String),
    #[error("NO_REPO: {0}")]
    NoRepo(String),
    /// `gh` ran and failed; carries its (trimmed) error output.
    #[error("{0}")]
    Gh(String),
    #[error("AZ_MISSING: The Azure CLI (az) isn't installed or couldn't be found")]
    AzMissing,
    /// The Azure CLI isn't signed in, or its sign-in expired.
    #[error("AZ_AUTH: {0}")]
    AzAuth(String),
    /// `az` ran and failed, or an Azure request was refused; carries a short message.
    #[error("{0}")]
    Az(String),
    /// Checking for, downloading or installing an update failed.
    #[error("Couldn't update EnvDeck: {0}")]
    Update(String),
    /// Install was asked for without a check that found an update.
    #[error("NO_UPDATE: Check for updates first")]
    NoPendingUpdate,
}

impl Error {
    /// Wraps an I/O error with the path it happened on; `NotFound` becomes [`Error::NotFound`].
    pub fn io(path: impl AsRef<Path>, source: std::io::Error) -> Self {
        let path = path.as_ref().to_path_buf();
        if source.kind() == std::io::ErrorKind::NotFound {
            Error::NotFound(path)
        } else {
            Error::Io { path, source }
        }
    }
}

impl serde::Serialize for Error {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialises_as_display_string() {
        let json = serde_json::to_string(&Error::Stale(PathBuf::from("a.env"))).unwrap();
        assert!(json.starts_with("\"STALE: a.env"), "{json}");
    }

    #[test]
    fn io_not_found_maps_to_not_found() {
        let e = Error::io("x", std::io::Error::from(std::io::ErrorKind::NotFound));
        assert!(matches!(e, Error::NotFound(_)));
        let e = Error::io(
            "x",
            std::io::Error::from(std::io::ErrorKind::PermissionDenied),
        );
        assert!(matches!(e, Error::Io { .. }));
    }
}
