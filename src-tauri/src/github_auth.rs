//! "Sign in with GitHub" to the EnvDeck **GitHub App**, via the Device Flow. Tokens live in Rust
//! memory only (never on disk, never sent to the webview) and are handed to `gh` as `GH_TOKEN`
//! (see github.rs).
//!
//! A GitHub App (not an OAuth App) keeps the token narrow: it carries only the app's permissions
//! (Secrets, Variables, Environments, Actions read, Metadata), reaches only repositories where
//! the app is installed, and expires after 8 hours. It is refreshed in memory while EnvDeck runs.
//!
//! The app's client ID and slug are compiled in from `ENVDECK_GITHUB_CLIENT_ID` and
//! `ENVDECK_GITHUB_APP_SLUG`. Neither is secret: the Device Flow (and refreshing its tokens)
//! needs no client secret. Without them, sign-in reports `GH_NO_CLIENT`.
//!
//! These are EnvDeck's only HTTP requests, all to github.com and only after the user clicks
//! "Sign in".

use std::fmt;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

pub const CLIENT_ID: Option<&str> = option_env!("ENVDECK_GITHUB_CLIENT_ID");
pub const APP_SLUG: Option<&str> = option_env!("ENVDECK_GITHUB_APP_SLUG");
const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const USER_URL: &str = "https://api.github.com/user";
/// Opened from Rust; GitHub's response is never used as a URL to open.
pub const VERIFY_URL: &str = "https://github.com/login/device";
const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
/// Refresh this long before GitHub's expiry, so a push never starts with a dying token.
const EXPIRY_MARGIN: Duration = Duration::from_secs(5 * 60);

/// A credential that never shows up in `Debug` output.
#[derive(Clone, PartialEq, Eq)]
pub struct Token(String);

impl Token {
    pub fn new(s: impl Into<String>) -> Self {
        Token(s.into())
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Token(redacted)")
    }
}

/// A Device Flow in progress.
#[derive(Debug, Clone)]
pub struct Flow {
    pub device_code: Token,
    pub interval_secs: u64,
    pub expires_in_secs: u64,
    /// Matches `Session::generation` while the flow is current; sign-out bumps it.
    pub generation: u64,
}

/// What the token endpoint returns on success. The lifetimes are absent when the app has
/// token expiry turned off.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grant {
    pub access: Token,
    pub expires_in: Option<u64>,
    pub refresh: Option<Token>,
    pub refresh_expires_in: Option<u64>,
}

/// The signed-in GitHub account for this session.
#[derive(Debug, Default)]
pub struct Session {
    pub token: Option<Token>,
    /// When `token` expires (`None`: it doesn't).
    pub expires_at: Option<Instant>,
    pub refresh: Option<Token>,
    pub refresh_expires_at: Option<Instant>,
    pub login: Option<String>,
    pub flow: Option<Flow>,
    pub generation: u64,
}

/// Whether the session's token can be used as is.
#[derive(Debug, PartialEq, Eq)]
pub enum TokenState {
    Valid(Token),
    /// Expired (or about to); refresh with this refresh token.
    NeedsRefresh(Token),
    SignedOut,
}

impl Session {
    /// Forgets the tokens and cancels any sign-in in progress.
    pub fn sign_out(&mut self) {
        self.token = None;
        self.expires_at = None;
        self.refresh = None;
        self.refresh_expires_at = None;
        self.login = None;
        self.flow = None;
        self.generation += 1;
    }

    /// Stores a grant received at `now` (sign-in or refresh).
    pub fn store(&mut self, grant: Grant, now: Instant) {
        let at = |secs: Option<u64>| secs.map(|s| now + Duration::from_secs(s));
        self.token = Some(grant.access);
        self.expires_at = at(grant.expires_in);
        self.refresh = grant.refresh;
        self.refresh_expires_at = at(grant.refresh_expires_in);
    }

    pub fn token_state(&self, now: Instant) -> TokenState {
        let Some(token) = &self.token else {
            return TokenState::SignedOut;
        };
        let live = |at: Option<Instant>| at.is_none_or(|at| now + EXPIRY_MARGIN < at);
        if live(self.expires_at) {
            return TokenState::Valid(token.clone());
        }
        match &self.refresh {
            Some(refresh) if live(self.refresh_expires_at) => {
                TokenState::NeedsRefresh(refresh.clone())
            }
            _ => TokenState::SignedOut,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    /// This build has the GitHub App's client ID and slug.
    pub configured: bool,
    /// Signed-in user, or null.
    pub login: Option<String>,
}

pub fn account(session: &Session) -> Account {
    Account {
        configured: client_id().is_ok() && app_slug().is_ok(),
        login: session.login.clone(),
    }
}

pub fn client_id() -> Result<&'static str> {
    CLIENT_ID
        .filter(|c| !c.is_empty())
        .ok_or(Error::GithubNotConfigured)
}

/// A slug goes into a URL; GitHub's are lower-case letters, digits and dashes.
pub fn is_valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

pub fn app_slug() -> Result<&'static str> {
    APP_SLUG
        .filter(|s| is_valid_slug(s))
        .ok_or(Error::GithubNotConfigured)
}

/// Where a user installs the EnvDeck GitHub App on their repositories.
pub fn install_url(slug: &str) -> String {
    format!("https://github.com/apps/{slug}/installations/new")
}

// ---------------------------------------------------------------------------------------------
// HTTP

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(20)))
        .http_status_as_error(false)
        .user_agent("EnvDeck")
        .build()
        .into()
}

fn net_error(e: ureq::Error) -> Error {
    Error::Gh(format!("Couldn't reach GitHub: {e}"))
}

fn post_form(url: &str, form: &[(&str, &str)]) -> Result<serde_json::Value> {
    let mut resp = agent()
        .post(url)
        .header("Accept", "application/json")
        .send_form(form.iter().copied())
        .map_err(net_error)?;
    resp.body_mut()
        .read_json::<serde_json::Value>()
        .map_err(|_| Error::Gh(format!("GitHub returned HTTP {}", resp.status())))
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceLogin {
    /// The code the user types at github.com/login/device.
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
}

#[derive(Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: Option<u64>,
}

fn oauth_error(json: &serde_json::Value) -> Option<(String, String)> {
    let code = json.get("error")?.as_str()?.to_string();
    let text = json
        .get("error_description")
        .and_then(|d| d.as_str())
        .unwrap_or(&code)
        .to_string();
    Some((code, text))
}

/// Step 1: ask GitHub for a device and user code. GitHub Apps take no scopes: the token gets
/// the app's permissions.
pub fn request_device_code(client_id: &str) -> Result<(DeviceLogin, Token, u64)> {
    let json = post_form(DEVICE_CODE_URL, &[("client_id", client_id)])?;
    if let Some((code, text)) = oauth_error(&json) {
        return Err(Error::Gh(if code == "device_flow_disabled" {
            "Device Flow isn't enabled for the EnvDeck GitHub App".into()
        } else {
            format!("GitHub refused the sign-in: {text}")
        }));
    }
    let r: DeviceCodeResponse = serde_json::from_value(json)
        .map_err(|e| Error::Gh(format!("Unexpected reply from GitHub: {e}")))?;
    Ok((
        DeviceLogin {
            user_code: r.user_code,
            verification_uri: r.verification_uri,
            expires_in: r.expires_in,
        },
        Token::new(r.device_code),
        r.interval.unwrap_or(5),
    ))
}

#[derive(Debug, PartialEq, Eq)]
pub enum Poll {
    Pending,
    /// Wait this many seconds between polls from now on.
    SlowDown(u64),
    Done(Grant),
    Failed(String),
}

/// Interprets a reply from the token endpoint (device-code poll or refresh).
pub fn poll_outcome(json: &serde_json::Value, interval: u64) -> Poll {
    let str_of = |k: &str| json.get(k).and_then(|v| v.as_str());
    let u64_of = |k: &str| json.get(k).and_then(|v| v.as_u64());
    if let Some(token) = str_of("access_token") {
        return Poll::Done(Grant {
            access: Token::new(token),
            expires_in: u64_of("expires_in"),
            refresh: str_of("refresh_token").map(Token::new),
            refresh_expires_in: u64_of("refresh_token_expires_in"),
        });
    }
    match oauth_error(json) {
        Some((code, _)) if code == "authorization_pending" => Poll::Pending,
        Some((code, _)) if code == "slow_down" => {
            Poll::SlowDown(u64_of("interval").unwrap_or(interval + 5))
        }
        Some((code, _)) if code == "expired_token" => {
            Poll::Failed("The sign-in code expired. Start again.".into())
        }
        Some((code, _)) if code == "access_denied" => {
            Poll::Failed("Sign-in was cancelled on GitHub.".into())
        }
        Some((code, _)) if code == "bad_refresh_token" => {
            Poll::Failed("Your GitHub sign-in expired. Sign in again.".into())
        }
        Some((_, text)) => Poll::Failed(format!("GitHub refused the sign-in: {text}")),
        None => Poll::Failed("Unexpected reply from GitHub".into()),
    }
}

/// Step 2 (repeated): has the user approved the code yet?
pub fn poll_token(client_id: &str, device_code: &Token, interval: u64) -> Result<Poll> {
    let json = post_form(
        TOKEN_URL,
        &[
            ("client_id", client_id),
            ("device_code", device_code.expose()),
            ("grant_type", DEVICE_GRANT),
        ],
    )?;
    Ok(poll_outcome(&json, interval))
}

/// Swaps a refresh token for a new grant. Tokens from the Device Flow refresh without a client
/// secret.
pub fn refresh(client_id: &str, refresh_token: &Token) -> Result<Poll> {
    let json = post_form(
        TOKEN_URL,
        &[
            ("client_id", client_id),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token.expose()),
        ],
    )?;
    Ok(poll_outcome(&json, 0))
}

/// Step 3: who signed in, for display.
pub fn fetch_login(token: &Token) -> Result<String> {
    let mut resp = agent()
        .get(USER_URL)
        .header("Accept", "application/vnd.github+json")
        .header("Authorization", &format!("Bearer {}", token.expose()))
        .call()
        .map_err(net_error)?;
    if !resp.status().is_success() {
        return Err(Error::Gh(format!(
            "GitHub returned HTTP {} for the signed-in user",
            resp.status()
        )));
    }
    let json: serde_json::Value = resp
        .body_mut()
        .read_json()
        .map_err(|e| Error::Gh(format!("Unexpected reply from GitHub: {e}")))?;
    json.get("login")
        .and_then(|l| l.as_str())
        .map(str::to_string)
        .ok_or_else(|| Error::Gh("GitHub didn't say who signed in".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn grant(access: &str, expires_in: Option<u64>, refresh: Option<(&str, u64)>) -> Grant {
        Grant {
            access: Token::new(access),
            expires_in,
            refresh: refresh.map(|(t, _)| Token::new(t)),
            refresh_expires_in: refresh.map(|(_, s)| s),
        }
    }

    #[test]
    fn tokens_are_redacted_in_debug_output() {
        let mut session = Session::default();
        session.store(
            grant("ghu_secret", Some(28800), Some(("ghr_secret", 1))),
            Instant::now(),
        );
        let printed = format!("{session:?}");
        assert!(!printed.contains("_secret"), "{printed}");
    }

    #[test]
    fn reads_token_endpoint_replies() {
        assert_eq!(
            poll_outcome(
                &json!({
                    "access_token": "ghu_x",
                    "expires_in": 28800,
                    "refresh_token": "ghr_y",
                    "refresh_token_expires_in": 15897600,
                    "token_type": "bearer",
                    "scope": ""
                }),
                5
            ),
            Poll::Done(grant("ghu_x", Some(28800), Some(("ghr_y", 15897600))))
        );
        // An app with token expiry turned off.
        assert_eq!(
            poll_outcome(&json!({"access_token": "ghu_x"}), 5),
            Poll::Done(grant("ghu_x", None, None))
        );
        assert_eq!(
            poll_outcome(&json!({"error": "authorization_pending"}), 5),
            Poll::Pending
        );
        assert_eq!(
            poll_outcome(&json!({"error": "slow_down", "interval": 10}), 5),
            Poll::SlowDown(10)
        );
        assert_eq!(
            poll_outcome(&json!({"error": "slow_down"}), 5),
            Poll::SlowDown(10)
        );
        assert!(matches!(
            poll_outcome(&json!({"error": "expired_token"}), 5),
            Poll::Failed(m) if m.contains("expired")
        ));
        assert!(matches!(
            poll_outcome(&json!({"error": "access_denied"}), 5),
            Poll::Failed(m) if m.contains("cancelled")
        ));
        assert!(matches!(
            poll_outcome(&json!({"error": "bad_refresh_token"}), 0),
            Poll::Failed(m) if m.contains("Sign in again")
        ));
        assert!(matches!(
            poll_outcome(&json!({"error": "x", "error_description": "Nope"}), 5),
            Poll::Failed(m) if m.contains("Nope")
        ));
        assert!(matches!(poll_outcome(&json!({}), 5), Poll::Failed(_)));
    }

    #[test]
    fn token_state_tracks_expiry_and_refresh() {
        let t0 = Instant::now();
        let hours = |h: u64| Duration::from_secs(h * 3600);
        let mut s = Session::default();
        assert_eq!(s.token_state(t0), TokenState::SignedOut);

        s.store(grant("a", Some(8 * 3600), Some(("r", 24 * 3600))), t0);
        assert_eq!(s.token_state(t0), TokenState::Valid(Token::new("a")));
        // Within the margin before expiry: refresh early.
        assert_eq!(
            s.token_state(t0 + hours(8) - Duration::from_secs(60)),
            TokenState::NeedsRefresh(Token::new("r"))
        );
        assert_eq!(
            s.token_state(t0 + hours(9)),
            TokenState::NeedsRefresh(Token::new("r"))
        );
        // Refresh token expired too.
        assert_eq!(s.token_state(t0 + hours(25)), TokenState::SignedOut);

        // Expired with no refresh token.
        s.store(grant("b", Some(60), None), t0);
        assert_eq!(s.token_state(t0 + hours(1)), TokenState::SignedOut);

        // Non-expiring token.
        s.store(grant("c", None, None), t0);
        assert_eq!(
            s.token_state(t0 + hours(1000)),
            TokenState::Valid(Token::new("c"))
        );
    }

    #[test]
    fn sign_out_forgets_everything_and_cancels_flows() {
        let mut s = Session {
            login: Some("octocat".into()),
            flow: Some(Flow {
                device_code: Token::new("d"),
                interval_secs: 5,
                expires_in_secs: 900,
                generation: 0,
            }),
            ..Default::default()
        };
        s.store(grant("t", Some(10), Some(("r", 10))), Instant::now());
        s.sign_out();
        assert!(s.token.is_none() && s.refresh.is_none() && s.login.is_none() && s.flow.is_none());
        assert!(s.expires_at.is_none() && s.refresh_expires_at.is_none());
        assert_eq!(s.generation, 1);
    }

    #[test]
    fn validates_slugs_and_builds_the_install_url() {
        for ok in ["envdeck", "env-deck-2"] {
            assert!(is_valid_slug(ok), "{ok}");
        }
        for bad in ["", "EnvDeck", "env deck", "x/../y", "a?b"] {
            assert!(!is_valid_slug(bad), "{bad}");
        }
        assert_eq!(
            install_url("envdeck"),
            "https://github.com/apps/envdeck/installations/new"
        );
    }
}
