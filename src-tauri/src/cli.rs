//! Runs the command-line tools EnvDeck drives on the user's behalf: the GitHub CLI (`gh`, for
//! Push to GitHub) and the Azure CLI (`az`, for Push to Azure App Service). This is the only
//! module that spawns processes.
//!
//! Each tool runs with its own credentials, untouched. Values go on stdin, never in argv
//! (visible in process listings). Nothing a tool prints is logged.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// What a finished run printed.
pub struct Output {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Runs `cmd` with stdin piped from `stdin` (or closed), capturing stdout and stderr. On
/// Windows no console window flashes up.
pub fn run(mut cmd: Command, stdin: Option<&str>) -> std::io::Result<Output> {
    use std::io::Write;
    cmd.stdin(if stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn()?;
    if let Some(body) = stdin
        && let Some(mut pipe) = child.stdin.take()
    {
        pipe.write_all(body.as_bytes())?;
        // Dropping the pipe closes stdin so the tool stops reading.
    }
    let out = child.wait_with_output()?;
    Ok(Output {
        success: out.status.success(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// The first existing file among `file` in each `PATH` directory, then `extra`. Apps started
/// from Finder don't get the shell's `PATH`, hence the usual install folders in `extra`.
pub fn find(file: &str, extra: &[PathBuf]) -> Option<PathBuf> {
    std::env::var_os("PATH")
        .map(|p| {
            std::env::split_paths(&p)
                .map(|d| d.join(file))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
        .into_iter()
        .chain(extra.iter().map(|d| d.join(file)))
        .find(|p| p.is_file())
}

/// `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`: where macOS installs usually land.
pub fn unix_bin_dirs() -> Vec<PathBuf> {
    ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
        .iter()
        .map(|d| Path::new(d).to_path_buf())
        .collect()
}

/// The useful part of a tool's stderr, capped so a chatty failure doesn't flood a toast.
pub fn message(stderr: &str, fallback: &str) -> String {
    let msg = stderr.trim();
    let msg = if msg.is_empty() { fallback } else { msg };
    let mut out: String = msg.chars().take(400).collect();
    if out.len() < msg.len() {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_are_trimmed_and_capped() {
        assert_eq!(message("  \n", "gh failed"), "gh failed");
        assert_eq!(message("HTTP 404\n", "gh failed"), "HTTP 404");
        assert_eq!(message(&"x".repeat(500), "gh failed").chars().count(), 401);
    }

    #[test]
    fn find_checks_extra_folders() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("envdeck-tool-x"), "").unwrap();
        assert_eq!(
            find("envdeck-tool-x", &[dir.path().to_path_buf()]),
            Some(dir.path().join("envdeck-tool-x"))
        );
        assert_eq!(
            find("envdeck-tool-missing", &[dir.path().to_path_buf()]),
            None
        );
    }
}
