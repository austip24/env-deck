//! Push dotenv keys to GitHub Actions secrets and variables by running the `gh` CLI.
//!
//! The user signs in to the EnvDeck GitHub App inside EnvDeck (Device Flow, github_auth.rs); the
//! token is passed to `gh` as `GH_TOKEN` for each run and is never written anywhere. It only
//! reaches repositories where the app is installed (`check_installed`). `gh` does the API
//! calls and the secret encryption. This is the only module that spawns processes.
//!
//! - The repository comes from `.git` in the same folder as the `.env` file (Rust reads it; the
//!   webview only names a remote).
//! - Values never travel in argv (visible in process listings): `gh secret set` and
//!   `gh variable set` read the body from stdin.
//! - Nothing `gh` prints is logged.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::fsops;
use crate::github_auth::Token;

// ---------------------------------------------------------------------------------------------
// Repository detection

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    /// The git remote's name (`origin`).
    pub remote: String,
    pub host: String,
    pub owner: String,
    pub name: String,
}

impl Remote {
    /// `host/owner/name`, the form `gh --repo` accepts for any host.
    pub fn slug(&self) -> String {
        format!("{}/{}/{}", self.host, self.owner, self.name)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// Remotes with a recognisable `owner/repo` URL, `origin` first.
    pub remotes: Vec<Remote>,
}

/// `host`, `owner` and `name` from a remote URL. Accepts `https://host/owner/repo(.git)`,
/// `ssh://git@host[:port]/owner/repo.git` and scp-style `git@host:owner/repo.git`.
pub fn parse_remote_url(url: &str) -> Option<(String, String, String)> {
    let url = url.trim();
    let (host, path) = if let Some((scheme, rest)) = url.split_once("://") {
        if !matches!(scheme, "https" | "http" | "ssh" | "git" | "git+ssh") {
            return None;
        }
        let (authority, path) = rest.split_once('/')?;
        let host = authority.rsplit('@').next()?;
        let host = host.split(':').next()?;
        (host, path)
    } else {
        // scp-style: [user@]host:owner/repo
        let (authority, path) = url.split_once(':')?;
        if authority.contains('/') || authority.contains('\\') {
            return None;
        }
        let host = authority.rsplit('@').next()?;
        (host, path)
    };
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut parts = path.split('/');
    let (owner, name) = (parts.next()?, parts.next()?);
    let ok = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    // One letter is a Windows drive (`C:/repos/shop`), not a host.
    let host_ok = host.len() > 1
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.'));
    (parts.next().is_none() && host_ok && ok(owner) && ok(name)).then(|| {
        (
            host.to_ascii_lowercase(),
            owner.to_string(),
            name.to_string(),
        )
    })
}

/// `(remote name, url)` for each `[remote "name"]` section of a git config file.
fn config_remotes(config: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut current: Option<String> = None;
    for line in config.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            current = line
                .strip_prefix("[remote \"")
                .and_then(|r| r.strip_suffix("\"]"))
                .map(str::to_string);
        } else if let Some(remote) = &current
            && let Some((k, v)) = line.split_once('=')
            && k.trim().eq_ignore_ascii_case("url")
        {
            let v = v.trim().trim_matches('"');
            if !out.iter().any(|(r, _): &(String, String)| r == remote) {
                out.push((remote.clone(), v.to_string()));
            }
        }
    }
    out
}

/// The git directory for a working tree: `dir/.git`, or where a `.git` file's `gitdir:` points
/// (worktrees, submodules). Worktrees keep their config in the `commondir`.
fn git_config_path(dir: &Path, max: u64) -> Result<PathBuf> {
    let dot_git = dir.join(".git");
    let not_repo = || Error::NoRepo(format!("{} has no .git folder", dir.display()));
    let meta = std::fs::metadata(&dot_git).map_err(|_| not_repo())?;
    let mut git_dir = if meta.is_dir() {
        dot_git
    } else {
        let text = fsops::read_text(&dot_git, max)?.text;
        let target = text
            .lines()
            .find_map(|l| l.trim().strip_prefix("gitdir:"))
            .map(str::trim)
            .ok_or_else(not_repo)?;
        dir.join(target)
    };
    if let Ok(common) = std::fs::read_to_string(git_dir.join("commondir")) {
        git_dir = git_dir.join(common.trim());
    }
    Ok(git_dir.join("config"))
}

/// Finds the GitHub remotes of the repository whose `.git` is directly in `dir`.
pub fn detect_repo(dir: &Path, max: u64) -> Result<RepoInfo> {
    let config = git_config_path(dir, max)?;
    let text = fsops::read_text(&config, max)
        .map_err(|_| Error::NoRepo(format!("Couldn't read {}", config.display())))?
        .text;
    let mut remotes: Vec<Remote> = config_remotes(&text)
        .into_iter()
        .filter_map(|(remote, url)| {
            parse_remote_url(&url).map(|(host, owner, name)| Remote {
                remote,
                host,
                owner,
                name,
            })
        })
        .collect();
    if remotes.is_empty() {
        return Err(Error::NoRepo(
            "The repository next to this file has no GitHub remote".into(),
        ));
    }
    remotes.sort_by_key(|r| r.remote != "origin");
    Ok(RepoInfo { remotes })
}

// ---------------------------------------------------------------------------------------------
// Validation

/// GitHub's rule for secret and variable names: `[A-Za-z_][A-Za-z0-9_]*`, not `GITHUB_*`.
pub fn is_valid_name(key: &str) -> bool {
    key.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
        && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !key.to_ascii_uppercase().starts_with("GITHUB_")
}

/// Environment names go into argv and URLs; keep them to something GitHub accepts.
pub fn is_valid_environment(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && !name.starts_with('-')
        && name.trim() == name
        && !name
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\'))
}

// ---------------------------------------------------------------------------------------------
// Running gh

/// Runs `gh` with arguments and optional stdin, returning stdout or `Error::Gh(stderr)`.
pub trait Gh: Sync {
    fn run(&self, args: &[String], stdin: Option<&str>) -> Result<String>;
}

pub struct GhCli {
    exe: PathBuf,
    token: Token,
}

impl GhCli {
    /// Finds `gh` on `PATH`, then in the usual install folders (apps started from Finder don't
    /// get the shell's `PATH`).
    pub fn locate(token: Token) -> Result<Self> {
        let file = if cfg!(windows) { "gh.exe" } else { "gh" };
        let mut candidates: Vec<PathBuf> = std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).map(|d| d.join(file)).collect())
            .unwrap_or_default();
        if cfg!(windows) {
            for var in ["ProgramFiles", "ProgramFiles(x86)"] {
                if let Some(base) = std::env::var_os(var) {
                    candidates.push(PathBuf::from(base).join("GitHub CLI").join(file));
                }
            }
            if let Some(local) = dirs::data_local_dir() {
                candidates.push(local.join("Programs").join("GitHub CLI").join(file));
            }
        } else {
            candidates.extend(
                ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
                    .iter()
                    .map(|d| Path::new(d).join(file)),
            );
        }
        candidates
            .into_iter()
            .find(|p| p.is_file())
            .map(|exe| GhCli { exe, token })
            .ok_or(Error::GhMissing)
    }
}

impl Gh for GhCli {
    fn run(&self, args: &[String], stdin: Option<&str>) -> Result<String> {
        use std::io::Write;
        let mut cmd = Command::new(&self.exe);
        cmd.args(args)
            // EnvDeck's sign-in, not whatever gh or the environment is logged in as.
            .env("GH_TOKEN", self.token.expose())
            .env("GH_HOST", "github.com")
            .env_remove("GITHUB_TOKEN")
            .env_remove("GH_ENTERPRISE_TOKEN")
            .env_remove("GITHUB_ENTERPRISE_TOKEN")
            .env("GH_PROMPT_DISABLED", "1")
            .env("GH_NO_UPDATE_NOTIFIER", "1")
            .env("NO_COLOR", "1")
            .stdin(if stdin.is_some() {
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
        let mut child = cmd.spawn().map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => Error::GhMissing,
            _ => Error::Gh(format!("Couldn't run gh: {e}")),
        })?;
        if let Some(body) = stdin
            && let Some(mut pipe) = child.stdin.take()
        {
            pipe.write_all(body.as_bytes())
                .map_err(|e| Error::Gh(format!("Couldn't write to gh: {e}")))?;
            // Dropping the pipe closes stdin so gh stops reading.
        }
        let out = child
            .wait_with_output()
            .map_err(|e| Error::Gh(format!("gh failed: {e}")))?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        } else {
            Err(gh_error(&String::from_utf8_lossy(&out.stderr)))
        }
    }
}

/// The useful part of gh's stderr, capped so a chatty failure doesn't flood a toast.
fn gh_message(stderr: &str) -> String {
    let msg = stderr.trim();
    let msg = if msg.is_empty() { "gh failed" } else { msg };
    let mut out: String = msg.chars().take(400).collect();
    if out.len() < msg.len() {
        out.push('…');
    }
    out
}

/// A failed run: a rejected token becomes `GhAuth` so the UI asks to sign in again.
fn gh_error(stderr: &str) -> Error {
    if stderr.contains("HTTP 401") || stderr.contains("Bad credentials") {
        Error::GhAuth("GitHub rejected the sign-in. Sign in again.".into())
    } else if stderr.contains("Resource not accessible by integration") {
        Error::Gh(format!(
            "GitHub refused: the EnvDeck GitHub App lacks a permission for this, or isn't \
             installed on the repository, or you can't change it. ({})",
            gh_message(stderr)
        ))
    } else {
        Error::Gh(gh_message(stderr))
    }
}

fn args(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|s| s.to_string()).collect()
}

/// Percent-encodes one URL path segment.
fn encode_segment(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Inspect: what already exists on GitHub (names only)

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Names {
    pub secrets: Vec<String>,
    pub variables: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubState {
    pub repo: String,
    pub environments: Vec<String>,
    /// Repository-level secrets and variables.
    pub repo_names: Names,
    /// Per-environment secrets and variables.
    pub env_names: BTreeMap<String, Names>,
    /// Lists that couldn't be read (e.g. variables without admin access); pushing may still work.
    pub warnings: Vec<String>,
}

#[derive(Deserialize)]
struct Named {
    name: String,
}

fn list_names(gh: &dyn Gh, what: &str, repo: &Remote, env: Option<&str>) -> Result<Vec<String>> {
    let mut a = args(&[what, "list", "--json", "name", "--repo"]);
    a.push(repo.slug());
    if let Some(env) = env {
        a.push("--env".into());
        a.push(env.into());
    }
    let out = gh.run(&a, None)?;
    let items: Vec<Named> = serde_json::from_str(out.trim())
        .map_err(|e| Error::Gh(format!("Unexpected output from gh {what} list: {e}")))?;
    Ok(items.into_iter().map(|n| n.name).collect())
}

fn list_environments(gh: &dyn Gh, repo: &Remote) -> Result<Vec<String>> {
    let path = format!(
        "repos/{}/{}/environments",
        encode_segment(&repo.owner),
        encode_segment(&repo.name)
    );
    let out = gh.run(
        &args(&[
            "api",
            "--hostname",
            &repo.host,
            "--paginate",
            &path,
            "--jq",
            ".environments[].name",
        ]),
        None,
    )?;
    Ok(out
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect())
}

/// Fails with `NotInstalled` unless the EnvDeck GitHub App is installed on the repository, on
/// an installation the signed-in user can access (`GET /user/installations`).
pub fn check_installed(gh: &dyn Gh, repo: &Remote) -> Result<()> {
    let installs = gh.run(
        &args(&[
            "api",
            "--hostname",
            &repo.host,
            "--paginate",
            "user/installations",
            "--jq",
            ".installations[] | [(.id | tostring), .account.login, .repository_selection] | @tsv",
        ]),
        None,
    )?;
    let full_name = format!("{}/{}", repo.owner, repo.name);
    for line in installs.lines() {
        let mut cols = line.trim().split('\t');
        let (Some(id), Some(account), Some(selection)) = (cols.next(), cols.next(), cols.next())
        else {
            continue;
        };
        if !account.eq_ignore_ascii_case(&repo.owner) || !id.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        if selection == "all" {
            return Ok(());
        }
        let path = format!("user/installations/{id}/repositories");
        let repos = gh.run(
            &args(&[
                "api",
                "--hostname",
                &repo.host,
                "--paginate",
                &path,
                "--jq",
                ".repositories[].full_name",
            ]),
            None,
        )?;
        if repos
            .lines()
            .any(|r| r.trim().eq_ignore_ascii_case(&full_name))
        {
            return Ok(());
        }
    }
    Err(Error::NotInstalled(full_name))
}

/// Environments plus the names of existing secrets and variables, so the UI can say which keys
/// would be replaced. GitHub never returns secret values, and variable values aren't fetched.
pub fn inspect(gh: &dyn Gh, repo: &Remote) -> Result<GithubState> {
    check_installed(gh, repo)?;
    let mut state = GithubState {
        repo: format!("{}/{}", repo.owner, repo.name),
        ..Default::default()
    };
    // The repository's secret list doubles as the access check: if it fails, nothing else will.
    state.repo_names.secrets = list_names(gh, "secret", repo, None)?;
    match list_environments(gh, repo) {
        Ok(envs) => state.environments = envs,
        Err(e) => state
            .warnings
            .push(format!("Couldn't list environments: {e}")),
    }
    let mut warnings = Vec::new();
    let mut warn = |what: &str, scope: &str, e: Error| {
        warnings.push(format!("Couldn't list {what} for {scope}: {e}"))
    };

    // Each list is a round trip; run them side by side.
    let envs = state.environments.clone();
    let (repo_vars, per_env) = std::thread::scope(|s| {
        let repo_vars = s.spawn(|| list_names(gh, "variable", repo, None));
        let handles: Vec<_> = envs
            .iter()
            .map(|env| {
                (
                    env,
                    s.spawn(move || list_names(gh, "secret", repo, Some(env))),
                    s.spawn(move || list_names(gh, "variable", repo, Some(env))),
                )
            })
            .collect();
        let join = |h: std::thread::ScopedJoinHandle<'_, Result<Vec<String>>>| {
            h.join()
                .unwrap_or_else(|_| Err(Error::Gh("gh list panicked".into())))
        };
        let per_env: Vec<_> = handles
            .into_iter()
            .map(|(env, sec, var)| (env.clone(), join(sec), join(var)))
            .collect();
        (join(repo_vars), per_env)
    });
    match repo_vars {
        Ok(v) => state.repo_names.variables = v,
        Err(e) => warn("variables", "the repository", e),
    }
    for (env, secrets, variables) in per_env {
        let mut names = Names::default();
        match secrets {
            Ok(v) => names.secrets = v,
            Err(e) => warn("secrets", &env, e),
        }
        match variables {
            Ok(v) => names.variables = v,
            Err(e) => warn("variables", &env, e),
        }
        state.env_names.insert(env, names);
    }
    state.warnings.extend(warnings);
    Ok(state)
}

// ---------------------------------------------------------------------------------------------
// Push

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Secret,
    Variable,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushItem {
    pub key: String,
    pub kind: Kind,
    /// `None` for the repository itself.
    pub environment: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushResult {
    pub key: String,
    pub kind: Kind,
    pub environment: Option<String>,
    /// `None` on success.
    pub error: Option<String>,
}

/// `gh secret|variable set KEY --repo host/owner/name [--env ENV]`. The value goes on stdin.
pub fn build_set_args(item: &PushItem, repo: &Remote) -> Vec<String> {
    let what = match item.kind {
        Kind::Secret => "secret",
        Kind::Variable => "variable",
    };
    let mut a = args(&[what, "set", &item.key, "--repo"]);
    a.push(repo.slug());
    if let Some(env) = &item.environment {
        a.push("--env".into());
        a.push(env.clone());
    }
    a
}

fn check_item(item: &PushItem, value: Option<&str>) -> std::result::Result<(), String> {
    if !is_valid_name(&item.key) {
        return Err(format!(
            "\"{}\" isn't a valid GitHub name (letters, digits and _; not GITHUB_*)",
            item.key
        ));
    }
    if let Some(env) = &item.environment
        && !is_valid_environment(env)
    {
        return Err(format!("\"{env}\" isn't a valid environment name"));
    }
    match value {
        None => Err(format!("{} isn't in the file any more", item.key)),
        Some("") => Err("GitHub doesn't accept empty values".into()),
        Some(_) => Ok(()),
    }
}

/// Sets each item from `vars` (the file's values, read by Rust). Items are independent: one
/// failure is reported and the rest still run. Environments must already exist: creating them
/// needs the `Administration` permission, which the EnvDeck GitHub App deliberately lacks.
pub fn push(
    gh: &dyn Gh,
    repo: &Remote,
    vars: &[(String, String)],
    items: &[PushItem],
) -> Result<Vec<PushResult>> {
    // A rejected sign-in stops everything (the UI asks to sign in again); other failures are
    // reported per item.
    let environments = if items.iter().any(|i| i.environment.is_some()) {
        match list_environments(gh, repo) {
            Ok(envs) => Some(envs),
            Err(e @ Error::GhAuth(_)) => return Err(e),
            // Can't tell; let `gh` report a missing environment itself.
            Err(_) => None,
        }
    } else {
        None
    };
    let mut results = Vec::with_capacity(items.len());
    for item in items {
        let value = vars
            .iter()
            .find(|(k, _)| k == &item.key)
            .map(|(_, v)| v.as_str());
        let mut error = check_item(item, value).err();
        if error.is_none()
            && let (Some(env), Some(envs)) = (&item.environment, &environments)
            && !envs.contains(env)
        {
            error = Some(format!(
                "The {env} environment doesn't exist on GitHub. Create it in the repository's \
                 settings first."
            ));
        }
        if error.is_none() {
            match gh.run(&build_set_args(item, repo), value) {
                Ok(_) => {}
                Err(e @ Error::GhAuth(_)) => return Err(e),
                Err(e) => error = Some(e.to_string()),
            }
        }
        results.push(PushResult {
            key: item.key.clone(),
            kind: item.kind,
            environment: item.environment.clone(),
            error,
        });
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn parse(url: &str) -> Option<(String, String, String)> {
        parse_remote_url(url)
    }

    fn triple(h: &str, o: &str, n: &str) -> Option<(String, String, String)> {
        Some((h.into(), o.into(), n.into()))
    }

    #[test]
    fn parses_remote_url_forms() {
        let want = triple("github.com", "acme", "shop");
        assert_eq!(parse("https://github.com/acme/shop.git"), want);
        assert_eq!(parse("https://github.com/acme/shop"), want);
        assert_eq!(parse("https://github.com/acme/shop/"), want);
        assert_eq!(parse("https://user:tok@github.com/acme/shop.git"), want);
        assert_eq!(parse("ssh://git@github.com/acme/shop.git"), want);
        assert_eq!(parse("ssh://git@github.com:22/acme/shop.git"), want);
        assert_eq!(parse("git@github.com:acme/shop.git"), want);
        assert_eq!(parse("  git@GitHub.com:acme/shop  "), want);
        assert_eq!(
            parse("git@ghe.example.com:team/app.js.git"),
            triple("ghe.example.com", "team", "app.js")
        );
    }

    #[test]
    fn rejects_non_repo_urls() {
        for url in [
            "",
            "garbage",
            "/srv/git/shop.git",
            "../other",
            "C:\\repos\\shop",
            "C:/repos/shop",
            "file:///srv/git/shop.git",
            "https://gitlab.com/group/sub/shop.git",
            "https://github.com/acme",
            "git@github.com:acme/sh op.git",
        ] {
            assert_eq!(parse(url), None, "{url}");
        }
    }

    const CONFIG: &str = r#"[core]
	repositoryformatversion = 0
[remote "upstream"]
	url = git@github.com:upstream/shop.git
	fetch = +refs/heads/*:refs/remotes/upstream/*
[remote "local"]
	url = /srv/git/shop.git
[remote "origin"]
	url = https://github.com/acme/shop.git
[branch "main"]
	remote = origin
	url = nope
"#;

    #[test]
    fn reads_remotes_from_git_config() {
        assert_eq!(
            config_remotes(CONFIG),
            vec![
                ("upstream".into(), "git@github.com:upstream/shop.git".into()),
                ("local".into(), "/srv/git/shop.git".into()),
                ("origin".into(), "https://github.com/acme/shop.git".into()),
            ]
        );
    }

    #[test]
    fn detects_repo_with_origin_first() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        std::fs::write(dir.path().join(".git/config"), CONFIG).unwrap();
        let info = detect_repo(dir.path(), 1 << 20).unwrap();
        let names: Vec<_> = info.remotes.iter().map(|r| r.remote.as_str()).collect();
        assert_eq!(names, ["origin", "upstream"]);
        assert_eq!(info.remotes[0].slug(), "github.com/acme/shop");
    }

    #[test]
    fn follows_gitdir_files_and_commondir() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("main/.git");
        std::fs::create_dir_all(main.join("worktrees/wt")).unwrap();
        std::fs::write(main.join("config"), CONFIG).unwrap();
        std::fs::write(main.join("worktrees/wt/commondir"), "../..\n").unwrap();
        let wt = dir.path().join("wt");
        std::fs::create_dir(&wt).unwrap();
        std::fs::write(wt.join(".git"), "gitdir: ../main/.git/worktrees/wt\n").unwrap();
        let info = detect_repo(&wt, 1 << 20).unwrap();
        assert_eq!(info.remotes[0].owner, "acme");
    }

    #[test]
    fn no_git_or_no_github_remote_is_no_repo() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            detect_repo(dir.path(), 1 << 20),
            Err(Error::NoRepo(_))
        ));
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        std::fs::write(
            dir.path().join(".git/config"),
            "[remote \"origin\"]\n\turl = /srv/git/x.git\n",
        )
        .unwrap();
        assert!(matches!(
            detect_repo(dir.path(), 1 << 20),
            Err(Error::NoRepo(_))
        ));
    }

    #[test]
    fn validates_names() {
        for ok in ["API_KEY", "_x", "a1"] {
            assert!(is_valid_name(ok), "{ok}");
        }
        for bad in ["", "1A", "A-B", "A.B", "GITHUB_TOKEN", "github_x", "A B"] {
            assert!(!is_valid_name(bad), "{bad}");
        }
        for ok in ["production", "Staging 2", "pr-12"] {
            assert!(is_valid_environment(ok), "{ok}");
        }
        for bad in ["", "-x", " x", "a/b", "a\nb", &"x".repeat(256)] {
            assert!(!is_valid_environment(bad), "{bad}");
        }
    }

    fn repo() -> Remote {
        Remote {
            remote: "origin".into(),
            host: "github.com".into(),
            owner: "acme".into(),
            name: "shop".into(),
        }
    }

    #[test]
    fn set_args_never_contain_the_value() {
        let item = PushItem {
            key: "API_KEY".into(),
            kind: Kind::Variable,
            environment: Some("production".into()),
        };
        assert_eq!(
            build_set_args(&item, &repo()),
            [
                "variable",
                "set",
                "API_KEY",
                "--repo",
                "github.com/acme/shop",
                "--env",
                "production"
            ]
        );
        let item = PushItem {
            kind: Kind::Secret,
            environment: None,
            ..item
        };
        assert_eq!(
            build_set_args(&item, &repo()),
            ["secret", "set", "API_KEY", "--repo", "github.com/acme/shop"]
        );
    }

    /// Records calls; fails any whose joined args contain `fail_on`.
    #[derive(Default)]
    struct FakeGh {
        calls: Mutex<Vec<(Vec<String>, Option<String>)>>,
        fail_on: Vec<&'static str>,
        /// What a failing run prints, e.g. "HTTP 401: Bad credentials".
        stderr: &'static str,
        stdout: BTreeMap<&'static str, &'static str>,
    }

    impl Gh for FakeGh {
        fn run(&self, args: &[String], stdin: Option<&str>) -> Result<String> {
            let joined = args.join(" ");
            self.calls
                .lock()
                .unwrap()
                .push((args.to_vec(), stdin.map(str::to_string)));
            if self.fail_on.iter().any(|f| joined.contains(f)) {
                return Err(gh_error(&format!("{} failed: {joined}", self.stderr)));
            }
            Ok(self
                .stdout
                .iter()
                .find(|(k, _)| joined.contains(*k))
                .map_or("", |(_, v)| v)
                .to_string())
        }
    }

    fn vars() -> Vec<(String, String)> {
        vec![
            ("API_KEY".into(), "s3cr3t\nline2".into()),
            ("EMPTY".into(), "".into()),
            ("LOG.LEVEL".into(), "debug".into()),
        ]
    }

    fn item(key: &str, kind: Kind, env: Option<&str>) -> PushItem {
        PushItem {
            key: key.into(),
            kind,
            environment: env.map(str::to_string),
        }
    }

    #[test]
    fn push_sends_values_on_stdin_and_reports_each_item() {
        let gh = FakeGh {
            stdout: BTreeMap::from([("environments", "staging\n")]),
            ..Default::default()
        };
        let results = push(
            &gh,
            &repo(),
            &vars(),
            &[
                item("API_KEY", Kind::Secret, None),
                item("API_KEY", Kind::Variable, Some("staging")),
                item("EMPTY", Kind::Secret, None),
                item("LOG.LEVEL", Kind::Variable, None),
                item("NOT_IN_FILE", Kind::Secret, None),
                item("API_KEY", Kind::Secret, Some("-x")),
            ],
        )
        .unwrap();
        let errors: Vec<_> = results.iter().map(|r| r.error.is_some()).collect();
        assert_eq!(errors, [false, false, true, true, true, true]);

        let calls = gh.calls.lock().unwrap();
        let sets: Vec<_> = calls.iter().filter(|(a, _)| a[1] == "set").collect();
        assert_eq!(sets.len(), 2);
        for (a, stdin) in sets {
            assert_eq!(stdin.as_deref(), Some("s3cr3t\nline2"));
            assert!(!a.iter().any(|s| s.contains("s3cr3t")));
        }
    }

    #[test]
    fn push_needs_existing_environments_and_never_creates_them() {
        let gh = FakeGh {
            stdout: BTreeMap::from([("environments", "production\n")]),
            ..Default::default()
        };
        let results = push(
            &gh,
            &repo(),
            &vars(),
            &[
                item("API_KEY", Kind::Secret, Some("production")),
                item("API_KEY", Kind::Secret, Some("preview")),
            ],
        )
        .unwrap();
        assert!(results[0].error.is_none());
        assert!(
            results[1]
                .error
                .as_deref()
                .unwrap()
                .contains("doesn't exist")
        );
        let calls = gh.calls.lock().unwrap();
        assert!(!calls.iter().any(|(a, _)| a.contains(&"PUT".to_string())));
        assert_eq!(calls.iter().filter(|(a, _)| a[1] == "set").count(), 1);
    }

    #[test]
    fn a_rejected_token_stops_push_and_inspect() {
        let gh = FakeGh {
            fail_on: vec!["set", "list", "installations"],
            stderr: "HTTP 401: Bad credentials (https://api.github.com/...)",
            ..Default::default()
        };
        let items = [
            item("API_KEY", Kind::Secret, None),
            item("API_KEY", Kind::Variable, None),
        ];
        let err = push(&gh, &repo(), &vars(), &items).unwrap_err();
        assert!(err.to_string().starts_with("GH_AUTH: "), "{err}");
        assert_eq!(gh.calls.lock().unwrap().len(), 1, "stops at the first 401");
        assert!(matches!(inspect(&gh, &repo()), Err(Error::GhAuth(_))));

        let gh = FakeGh {
            fail_on: vec!["set"],
            stderr: "HTTP 403: Resource not accessible by integration",
            ..Default::default()
        };
        let results = push(&gh, &repo(), &vars(), &items).unwrap();
        assert!(results.iter().all(|r| {
            let e = r.error.as_deref().unwrap();
            e.contains("403") && e.contains("EnvDeck GitHub App")
        }));
    }

    #[test]
    fn inspect_collects_names_and_tolerates_partial_failures() {
        let gh = FakeGh {
            fail_on: vec!["variable list --json name --repo github.com/acme/shop --env staging"],
            stdout: BTreeMap::from([
                ("installations", "7\tacme\tall\n"),
                ("environments", "production\nstaging\n"),
                ("--env production", r#"[{"name":"DB_URL"}]"#),
                ("--env staging", r#"[{"name":"STAGE_KEY"}]"#),
                ("list", r#"[{"name":"API_KEY"}]"#),
            ]),
            ..Default::default()
        };
        let state = inspect(&gh, &repo()).unwrap();
        assert_eq!(state.repo, "acme/shop");
        assert_eq!(state.environments, ["production", "staging"]);
        assert_eq!(state.repo_names.secrets, ["API_KEY"]);
        assert_eq!(state.repo_names.variables, ["API_KEY"]);
        assert_eq!(state.env_names["production"].variables, ["DB_URL"]);
        assert_eq!(state.env_names["staging"].secrets, ["STAGE_KEY"]);
        assert!(state.env_names["staging"].variables.is_empty());
        assert_eq!(state.warnings.len(), 1);
    }

    fn installed(installs: &'static str, repos: &'static str) -> Result<()> {
        let gh = FakeGh {
            // "/repositories" sorts first, so the per-installation call matches it.
            stdout: BTreeMap::from([("/repositories", repos), ("installations", installs)]),
            ..Default::default()
        };
        check_installed(&gh, &repo())
    }

    #[test]
    fn checks_the_app_is_installed_on_the_repository() {
        // All repositories of the owner.
        assert!(installed("7\tACME\tall\n", "").is_ok());
        // Selected repositories, including this one.
        assert!(installed("7\tacme\tselected\n", "acme/web\nacme/shop\n").is_ok());
        // Selected repositories, not this one.
        let err = installed("7\tacme\tselected\n", "acme/web\n").unwrap_err();
        assert!(err.to_string().starts_with("GH_NOT_INSTALLED: "), "{err}");
        assert!(err.to_string().contains("acme/shop"));
        // Only installed on another account, or nowhere.
        assert!(matches!(
            installed("8\tother\tall\n", ""),
            Err(Error::NotInstalled(_))
        ));
        assert!(matches!(installed("", ""), Err(Error::NotInstalled(_))));
        // Malformed ids are ignored rather than put into a URL.
        assert!(matches!(
            installed("../x\tacme\tselected\n", "acme/shop\n"),
            Err(Error::NotInstalled(_))
        ));
    }

    #[test]
    fn inspect_stops_when_the_app_isnt_installed() {
        let gh = FakeGh::default();
        assert!(matches!(inspect(&gh, &repo()), Err(Error::NotInstalled(_))));
        assert_eq!(gh.calls.lock().unwrap().len(), 1);
    }

    #[test]
    fn gh_messages_are_trimmed_and_capped() {
        assert_eq!(gh_message("  \n"), "gh failed");
        assert_eq!(gh_message("HTTP 404\n"), "HTTP 404");
        assert_eq!(gh_message(&"x".repeat(500)).chars().count(), 401);
    }
}
