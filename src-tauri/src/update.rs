//! In-app updates from EnvDeck's GitHub Releases.
//!
//! The endpoint (`latest.json` on the newest published release) and the signing public key are
//! fixed in `tauri.conf.json` under `plugins.updater`; the webview can't name a URL or a
//! version. It asks for a check, then asks to install the update that check found. The
//! installer is downloaded into memory, its signature verified against the public key, then
//! run. Nothing about updates is stored: a found update is forgotten on quit.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::error::{Error, Result};

/// Event carrying download progress while an update installs.
pub const PROGRESS_EVENT: &str = "update-progress";

/// What the UI shows about an available update.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    /// Release notes from the release body, trimmed; `None` when empty.
    pub notes: Option<String>,
    /// RFC 3339 publish date as announced in `latest.json`.
    pub date: Option<String>,
}

impl UpdateInfo {
    fn new(
        version: &str,
        current_version: &str,
        body: Option<&str>,
        raw_json: &serde_json::Value,
    ) -> Self {
        UpdateInfo {
            version: version.to_owned(),
            current_version: current_version.to_owned(),
            notes: body
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned),
            date: raw_json
                .get("pub_date")
                .and_then(|d| d.as_str())
                .map(str::to_owned),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

/// The update the last check found, if any. Separate from `AppState` because `Update` holds
/// the download URL and signature, which never cross IPC.
#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

impl Pending {
    fn set(&self, update: Option<Update>) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = update;
    }

    fn get(&self) -> Result<Update> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or(Error::NoPendingUpdate)
    }
}

pub fn init(app: &AppHandle) {
    app.manage(Pending::default());
}

fn update_error(e: tauri_plugin_updater::Error) -> Error {
    Error::Update(e.to_string())
}

/// Asks the release endpoint for a newer version. Remembers what it found for [`install`].
pub async fn check(app: &AppHandle) -> Result<Option<UpdateInfo>> {
    let found = app
        .updater()
        .map_err(update_error)?
        .check()
        .await
        .map_err(update_error)?;
    let info = found.as_ref().map(|u| {
        UpdateInfo::new(
            &u.version,
            &u.current_version,
            u.body.as_deref(),
            &u.raw_json,
        )
    });
    app.state::<Pending>().set(found);
    Ok(info)
}

/// Downloads, verifies and installs the update the last check found, then restarts. On
/// Windows the installer closes the app itself.
pub async fn install(app: &AppHandle) -> Result<()> {
    let update = app.state::<Pending>().get()?;
    let mut downloaded = 0u64;
    update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                let _ = app.emit(PROGRESS_EVENT, Progress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(update_error)?;
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn info_trims_notes_and_reads_pub_date() {
        let raw = serde_json::json!({ "version": "0.2.0", "pub_date": "2026-10-06T12:00:00Z" });
        let info = UpdateInfo::new("0.2.0", "0.1.0", Some("\n  Fixes  \n"), &raw);
        assert_eq!(info.notes.as_deref(), Some("Fixes"));
        assert_eq!(info.date.as_deref(), Some("2026-10-06T12:00:00Z"));

        let info = UpdateInfo::new("0.2.0", "0.1.0", Some("  "), &serde_json::json!({}));
        assert_eq!(info.notes, None);
        assert_eq!(info.date, None);
    }

    #[test]
    fn info_serialises_camel_case() {
        let info = UpdateInfo::new("0.2.0", "0.1.0", None, &serde_json::Value::Null);
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "version": "0.2.0",
                "currentVersion": "0.1.0",
                "notes": null,
                "date": null,
            })
        );
    }

    #[test]
    fn install_needs_a_checked_update() {
        let e = Pending::default().get().err().unwrap();
        assert!(matches!(e, Error::NoPendingUpdate));
        assert!(e.to_string().starts_with("NO_UPDATE: "));
    }
}
