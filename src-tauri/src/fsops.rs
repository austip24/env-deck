//! Size-capped reads, atomic writes and copy with a conflict policy.
//!
//! Callers pass paths that already went through `state::ensure_within`.

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::envfile;
use crate::error::{Error, Result};

const BOM: &[u8] = b"\xEF\xBB\xBF";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextFile {
    /// Contents without a UTF-8 BOM.
    pub text: String,
    pub had_bom: bool,
    pub modified_ms: u64,
    pub size: u64,
}

fn file_modified_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

pub fn modified_ms(path: &Path) -> Result<u64> {
    let meta = fs::metadata(path).map_err(|e| Error::io(path, e))?;
    Ok(file_modified_ms(&meta))
}

/// Reads a file's bytes, refusing anything larger than `max` bytes.
pub fn read_bytes(path: &Path, max: u64) -> Result<(Vec<u8>, fs::Metadata)> {
    let meta = fs::metadata(path).map_err(|e| Error::io(path, e))?;
    if !meta.is_file() {
        return Err(Error::NotFound(path.to_path_buf()));
    }
    let too_large = |bytes| Error::TooLarge {
        path: path.to_path_buf(),
        bytes,
        max,
    };
    if meta.len() > max {
        return Err(too_large(meta.len()));
    }
    let bytes = fs::read(path).map_err(|e| Error::io(path, e))?;
    // The file may have grown between the metadata call and the read.
    if bytes.len() as u64 > max {
        return Err(too_large(bytes.len() as u64));
    }
    Ok((bytes, meta))
}

/// Reads a UTF-8 text file of at most `max` bytes. A leading BOM is stripped and remembered.
pub fn read_text(path: &Path, max: u64) -> Result<TextFile> {
    let (bytes, meta) = read_bytes(path, max)?;
    let size = bytes.len() as u64;
    let (had_bom, body) = match bytes.strip_prefix(BOM) {
        Some(rest) => (true, rest.to_vec()),
        None => (false, bytes),
    };
    let text = String::from_utf8(body).map_err(|_| Error::NotUtf8(path.to_path_buf()))?;
    Ok(TextFile {
        text,
        had_bom,
        modified_ms: file_modified_ms(&meta),
        size,
    })
}

fn with_bom(text: &str, bom: bool) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(text.len() + 3);
    if bom {
        bytes.extend_from_slice(BOM);
    }
    bytes.extend_from_slice(text.as_bytes());
    bytes
}

fn file_name_str(path: &Path) -> Result<&str> {
    path.file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| Error::InvalidName(path.display().to_string()))
}

fn temp_path(target: &Path) -> Result<PathBuf> {
    let name = file_name_str(target)?;
    Ok(target.with_file_name(format!(".{name}.envdeck-tmp")))
}

/// Writes `bytes` to `path` atomically: a temp file in the same folder, fsync, then rename over
/// the target. A symlinked target is resolved first so the link itself survives. On Unix the
/// existing file's permissions (e.g. `600`) are kept.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let is_link = fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink());
    let target = if is_link {
        dunce::canonicalize(path).map_err(|e| Error::io(path, e))?
    } else {
        path.to_path_buf()
    };
    let tmp = temp_path(&target)?;

    let result = (|| -> std::io::Result<()> {
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&tmp) {
            Err(e) if e.kind() == ErrorKind::AlreadyExists => {
                // Left over from a crash: it's ours, so replace it.
                fs::remove_file(&tmp)?;
                OpenOptions::new().write(true).create_new(true).open(&tmp)?
            }
            other => other?,
        };
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        #[cfg(unix)]
        if let Ok(meta) = fs::metadata(&target) {
            fs::set_permissions(&tmp, meta.permissions())?;
        }
        rename_replacing(&tmp, &target)
    })();

    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(Error::io(&target, e));
    }
    Ok(())
}

/// `rename` replaces the destination on both platforms. On Windows an editor or virus scanner
/// can hold the file for a moment, so retry briefly on "access denied".
fn rename_replacing(from: &Path, to: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        let mut attempt = 0;
        loop {
            match fs::rename(from, to) {
                Err(e) if e.kind() == ErrorKind::PermissionDenied && attempt < 5 => {
                    attempt += 1;
                    std::thread::sleep(std::time::Duration::from_millis(40 * attempt));
                }
                other => return other,
            }
        }
    }
    #[cfg(not(windows))]
    fs::rename(from, to)
}

/// Saves edited text, refusing with [`Error::Stale`] if the file's mtime no longer matches the
/// one the editor loaded. Keeps a BOM if the file on disk has one. Returns the new mtime.
pub fn write_checked(path: &Path, text: &str, expected_modified_ms: u64) -> Result<u64> {
    let meta = fs::metadata(path).map_err(|e| Error::io(path, e))?;
    if file_modified_ms(&meta) != expected_modified_ms {
        return Err(Error::Stale(path.to_path_buf()));
    }
    write_atomic(path, &with_bom(text, starts_with_bom(path)))?;
    modified_ms(path)
}

fn starts_with_bom(path: &Path) -> bool {
    use std::io::Read;
    let mut head = [0u8; 3];
    fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut head))
        .is_ok()
        && head == BOM
}

/// Upserts `vars` into an existing dotenv file (see [`envfile::upsert`]). Returns the new mtime.
pub fn set_env_vars(path: &Path, vars: &[(String, String)], max: u64) -> Result<u64> {
    if !envfile::is_dotenv_name(file_name_str(path)?) {
        return Err(Error::NotDotenv(path.to_path_buf()));
    }
    let file = read_text(path, max)?;
    let updated = envfile::upsert(&file.text, vars)?;
    write_atomic(path, &with_bom(&updated, file.had_bom))?;
    modified_ms(path)
}

/// [`set_env_vars`] for an edit made against a loaded copy: refuses with [`Error::Stale`] if the
/// file's mtime no longer matches the one the caller loaded.
pub fn set_env_vars_checked(
    path: &Path,
    vars: &[(String, String)],
    max: u64,
    expected_modified_ms: u64,
) -> Result<u64> {
    if modified_ms(path)? != expected_modified_ms {
        return Err(Error::Stale(path.to_path_buf()));
    }
    set_env_vars(path, vars, max)
}

/// What to do when a copy's destination already exists.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OnConflict {
    #[default]
    Fail,
    /// Copy the existing file to `<name>.bak-<unix secs>`, then overwrite.
    Backup,
    /// Write to `<name>.copy` (then `.copy-2`, ...) instead.
    KeepBoth,
    /// dotenv only: upsert the source's variables into the existing file.
    Merge,
    Overwrite,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CopyAction {
    Created,
    BackedUp,
    KeptBoth,
    Merged,
    Overwritten,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyOutcome {
    pub path: PathBuf,
    pub action: CopyAction,
    pub backup_path: Option<PathBuf>,
}

/// Rejects names that aren't a single, portable path component.
pub fn validate_file_name(name: &str) -> Result<()> {
    let bad = name.is_empty()
        || name == "."
        || name == ".."
        || name.ends_with(['.', ' '])
        || name.chars().any(|c| {
            c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        });
    if bad {
        return Err(Error::InvalidName(name.to_string()));
    }
    Ok(())
}

/// First of `base`, `base-2`, `base-3`, ... that doesn't exist in `dir`.
fn unused_name(dir: &Path, base: &str) -> PathBuf {
    let mut candidate = dir.join(base);
    let mut n = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{base}-{n}"));
        n += 1;
    }
    candidate
}

/// Copies `src` to `dest_dir/file_name`, resolving an existing destination with `policy`.
/// Reads are capped at `max` bytes; every write is atomic.
pub fn copy(
    src: &Path,
    dest_dir: &Path,
    file_name: &str,
    policy: OnConflict,
    max: u64,
) -> Result<CopyOutcome> {
    validate_file_name(file_name)?;
    let dest = dest_dir.join(file_name);
    let (bytes, _) = read_bytes(src, max)?;
    let outcome = |action, backup_path| CopyOutcome {
        path: dest.clone(),
        action,
        backup_path,
    };

    if !dest.exists() {
        write_atomic(&dest, &bytes)?;
        return Ok(outcome(CopyAction::Created, None));
    }

    match policy {
        OnConflict::Fail => Err(Error::Exists(dest.clone())),
        OnConflict::Overwrite => {
            write_atomic(&dest, &bytes)?;
            Ok(outcome(CopyAction::Overwritten, None))
        }
        OnConflict::Backup => {
            let secs = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_secs());
            let backup = unused_name(dest_dir, &format!("{file_name}.bak-{secs}"));
            fs::copy(&dest, &backup).map_err(|e| Error::io(&backup, e))?;
            write_atomic(&dest, &bytes)?;
            Ok(outcome(CopyAction::BackedUp, Some(backup)))
        }
        OnConflict::KeepBoth => {
            let target = unused_name(dest_dir, &format!("{file_name}.copy"));
            write_atomic(&target, &bytes)?;
            Ok(CopyOutcome {
                path: target,
                action: CopyAction::KeptBoth,
                backup_path: None,
            })
        }
        OnConflict::Merge => {
            if !envfile::is_dotenv_name(file_name_str(src)?) {
                return Err(Error::NotDotenv(src.to_path_buf()));
            }
            let source = String::from_utf8(bytes).map_err(|_| Error::NotUtf8(src.to_path_buf()))?;
            let source = source.strip_prefix('\u{feff}').unwrap_or(&source);
            let vars = envfile::parse(source).vars();
            set_env_vars(&dest, &vars, max)?;
            Ok(outcome(CopyAction::Merged, None))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAX: u64 = 512 * 1024;

    fn write(path: &Path, text: &str) {
        fs::write(path, text).unwrap();
    }

    fn read(path: &Path) -> String {
        fs::read_to_string(path).unwrap()
    }

    fn no_temp_files(dir: &Path) -> bool {
        fs::read_dir(dir).unwrap().all(|e| {
            !e.unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".envdeck-tmp")
        })
    }

    #[test]
    fn read_text_strips_and_reports_bom() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("appsettings.json");
        fs::write(&p, b"\xEF\xBB\xBF{}").unwrap();
        let f = read_text(&p, MAX).unwrap();
        assert_eq!(f.text, "{}");
        assert!(f.had_bom);
        assert_eq!(f.size, 5);
        assert!(f.modified_ms > 0);
    }

    #[test]
    fn read_text_refuses_large_and_binary_and_missing() {
        let dir = tempfile::tempdir().unwrap();
        let big = dir.path().join("big.env");
        write(&big, &"x".repeat(100));
        assert!(matches!(
            read_text(&big, 99),
            Err(Error::TooLarge {
                bytes: 100,
                max: 99,
                ..
            })
        ));
        assert!(read_text(&big, 100).is_ok());

        let bin = dir.path().join("bin.env");
        fs::write(&bin, [0xff, 0xfe, 0x00]).unwrap();
        assert!(matches!(read_text(&bin, MAX), Err(Error::NotUtf8(_))));

        let missing = dir.path().join("missing.env");
        assert!(matches!(read_text(&missing, MAX), Err(Error::NotFound(_))));
        assert!(matches!(
            read_text(dir.path(), MAX),
            Err(Error::NotFound(_))
        ));
    }

    #[test]
    fn write_atomic_creates_and_replaces_without_leftovers() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join(".env");
        write_atomic(&p, b"A=1\n").unwrap();
        assert_eq!(read(&p), "A=1\n");
        write_atomic(&p, b"A=2\n").unwrap();
        assert_eq!(read(&p), "A=2\n");
        assert!(no_temp_files(dir.path()));
    }

    #[test]
    fn write_atomic_replaces_a_stale_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join(".env");
        write(&dir.path().join("..env.envdeck-tmp"), "junk from a crash");
        write_atomic(&p, b"A=1\n").unwrap();
        assert_eq!(read(&p), "A=1\n");
        assert!(no_temp_files(dir.path()));
    }

    #[test]
    fn write_atomic_cleans_up_when_rename_fails() {
        let dir = tempfile::tempdir().unwrap();
        // A directory at the target path makes the rename fail on every platform.
        let p = dir.path().join("taken");
        fs::create_dir(&p).unwrap();
        fs::write(p.join("inner"), "x").unwrap();
        assert!(write_atomic(&p, b"A=1\n").is_err());
        assert!(no_temp_files(dir.path()));
    }

    #[cfg(unix)]
    #[test]
    fn write_atomic_keeps_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join(".env");
        write(&p, "A=1\n");
        fs::set_permissions(&p, fs::Permissions::from_mode(0o600)).unwrap();
        write_atomic(&p, b"A=2\n").unwrap();
        assert_eq!(
            fs::metadata(&p).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_atomic_writes_through_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.env");
        let link = dir.path().join(".env");
        write(&real, "A=1\n");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        write_atomic(&link, b"A=2\n").unwrap();
        assert!(
            fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(read(&real), "A=2\n");
    }

    #[test]
    fn write_checked_refuses_stale_and_keeps_bom() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("appsettings.json");
        fs::write(&p, b"\xEF\xBB\xBF{\"a\":1}").unwrap();
        let loaded = read_text(&p, MAX).unwrap();

        assert!(matches!(
            write_checked(&p, "{}", loaded.modified_ms + 1),
            Err(Error::Stale(_))
        ));
        let new_mtime = write_checked(&p, "{\"a\":2}", loaded.modified_ms).unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"\xEF\xBB\xBF{\"a\":2}");
        assert_eq!(new_mtime, modified_ms(&p).unwrap());
    }

    #[test]
    fn set_env_vars_upserts_and_rejects_non_dotenv() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join(".env.local");
        write(&p, "# keep\r\nA=1\r\n");
        set_env_vars(
            &p,
            &[("A".into(), "2".into()), ("B".into(), "x y".into())],
            MAX,
        )
        .unwrap();
        assert_eq!(read(&p), "# keep\r\nA=2\r\nB='x y'\r\n");

        let json = dir.path().join("settings.json");
        write(&json, "{}");
        assert!(matches!(
            set_env_vars(&json, &[("A".into(), "1".into())], MAX),
            Err(Error::NotDotenv(_))
        ));
    }

    #[test]
    fn set_env_vars_checked_refuses_a_stale_edit() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join(".env");
        write(&p, "A=1 # note\nexport B=2\n");
        let loaded = modified_ms(&p).unwrap();
        let edit = |v: &str| vec![("A".to_string(), v.to_string())];
        assert!(matches!(
            set_env_vars_checked(&p, &edit("x"), MAX, loaded + 1),
            Err(Error::Stale(_))
        ));
        assert_eq!(read(&p), "A=1 # note\nexport B=2\n", "untouched");
        set_env_vars_checked(&p, &edit("a $b"), MAX, loaded).unwrap();
        assert_eq!(read(&p), "A='a $b' # note\nexport B=2\n");
    }

    struct CopyFixture {
        _dir: tempfile::TempDir,
        src: PathBuf,
        dest_dir: PathBuf,
    }

    fn copy_fixture(existing: Option<&str>) -> CopyFixture {
        let dir = tempfile::tempdir().unwrap();
        let src_dir = dir.path().join("api");
        let dest_dir = dir.path().join("web");
        fs::create_dir_all(&src_dir).unwrap();
        fs::create_dir_all(&dest_dir).unwrap();
        let src = src_dir.join(".env");
        write(&src, "A=from-src\nNEW=1\n");
        if let Some(text) = existing {
            write(&dest_dir.join(".env"), text);
        }
        CopyFixture {
            _dir: dir,
            src,
            dest_dir,
        }
    }

    #[test]
    fn copy_without_conflict_creates_for_every_policy() {
        for policy in [
            OnConflict::Fail,
            OnConflict::Backup,
            OnConflict::KeepBoth,
            OnConflict::Merge,
            OnConflict::Overwrite,
        ] {
            let f = copy_fixture(None);
            let out = copy(&f.src, &f.dest_dir, ".env", policy, MAX).unwrap();
            assert_eq!(out.action, CopyAction::Created, "{policy:?}");
            assert_eq!(read(&out.path), "A=from-src\nNEW=1\n");
        }
    }

    #[test]
    fn copy_fail_is_the_default_and_leaves_dest_alone() {
        assert_eq!(OnConflict::default(), OnConflict::Fail);
        let f = copy_fixture(Some("A=old\n"));
        let err = copy(&f.src, &f.dest_dir, ".env", OnConflict::Fail, MAX).unwrap_err();
        assert!(matches!(err, Error::Exists(_)));
        assert!(err.to_string().starts_with("EXISTS: "));
        assert_eq!(read(&f.dest_dir.join(".env")), "A=old\n");
    }

    #[test]
    fn copy_overwrite() {
        let f = copy_fixture(Some("A=old\n"));
        let out = copy(&f.src, &f.dest_dir, ".env", OnConflict::Overwrite, MAX).unwrap();
        assert_eq!(out.action, CopyAction::Overwritten);
        assert_eq!(read(&out.path), "A=from-src\nNEW=1\n");
    }

    #[test]
    fn copy_backup_keeps_the_old_file() {
        let f = copy_fixture(Some("A=old\n"));
        let out = copy(&f.src, &f.dest_dir, ".env", OnConflict::Backup, MAX).unwrap();
        assert_eq!(out.action, CopyAction::BackedUp);
        let backup = out.backup_path.unwrap();
        let backup_name = backup.file_name().unwrap().to_string_lossy().into_owned();
        assert!(backup_name.starts_with(".env.bak-"), "{backup_name}");
        assert_eq!(read(&backup), "A=old\n");
        assert_eq!(read(&out.path), "A=from-src\nNEW=1\n");

        // A second backup in the same second doesn't overwrite the first.
        write(&out.path, "A=second\n");
        let again = copy(&f.src, &f.dest_dir, ".env", OnConflict::Backup, MAX).unwrap();
        let second = again.backup_path.unwrap();
        assert_ne!(second, backup);
        assert_eq!(read(&backup), "A=old\n");
        assert_eq!(read(&second), "A=second\n");
    }

    #[test]
    fn copy_keep_both_never_overwrites_previous_copies() {
        let f = copy_fixture(Some("A=old\n"));
        let first = copy(&f.src, &f.dest_dir, ".env", OnConflict::KeepBoth, MAX).unwrap();
        assert_eq!(first.action, CopyAction::KeptBoth);
        assert_eq!(first.path, f.dest_dir.join(".env.copy"));
        let second = copy(&f.src, &f.dest_dir, ".env", OnConflict::KeepBoth, MAX).unwrap();
        assert_eq!(second.path, f.dest_dir.join(".env.copy-2"));
        assert_eq!(read(&f.dest_dir.join(".env")), "A=old\n");
        assert_eq!(read(&second.path), "A=from-src\nNEW=1\n");
    }

    #[test]
    fn copy_merge_upserts_into_existing_dotenv() {
        let f = copy_fixture(Some("# web\r\nA=old\r\nKEEP=me\r\n"));
        let out = copy(&f.src, &f.dest_dir, ".env", OnConflict::Merge, MAX).unwrap();
        assert_eq!(out.action, CopyAction::Merged);
        assert_eq!(
            read(&out.path),
            "# web\r\nA=from-src\r\nKEEP=me\r\nNEW=1\r\n"
        );
    }

    #[test]
    fn copy_merge_requires_dotenv() {
        let f = copy_fixture(None);
        let json = f.dest_dir.join("settings.json");
        write(&json, "{}");
        let src_json = f.src.with_file_name("settings.json");
        write(&src_json, "{\"a\":1}");
        assert!(matches!(
            copy(
                &src_json,
                &f.dest_dir,
                "settings.json",
                OnConflict::Merge,
                MAX
            ),
            Err(Error::NotDotenv(_))
        ));
        assert_eq!(read(&json), "{}");
    }

    #[test]
    fn copy_respects_size_cap_and_validates_name() {
        let f = copy_fixture(None);
        assert!(matches!(
            copy(&f.src, &f.dest_dir, ".env", OnConflict::Fail, 3),
            Err(Error::TooLarge { .. })
        ));
        for bad in ["", ".", "..", "a/b", "a\\b", "../.env", "c:x", "x.", "x "] {
            assert!(
                matches!(
                    copy(&f.src, &f.dest_dir, bad, OnConflict::Fail, MAX),
                    Err(Error::InvalidName(_))
                ),
                "{bad:?}"
            );
        }
    }
}
