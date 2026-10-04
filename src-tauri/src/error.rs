//! Errors returned by commands.
//!
//! They cross IPC as a plain string (`Display`). Variants the UI needs to react to carry a
//! stable `CODE: ` prefix (`STALE`, `EXISTS`) that `errorText` in `lib/ipc.ts` can match on.

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
