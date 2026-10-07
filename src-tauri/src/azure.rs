//! Push dotenv keys to an Azure App Service's configuration by running the Azure CLI (`az`).
//!
//! Authentication is the Azure CLI's own login (`az login`): EnvDeck never sees, receives or
//! stores a token (it never runs `az account get-access-token`) and makes no network requests
//! itself. `az rest` does the ARM calls. Processes are spawned through `cli.rs`.
//!
//! - The app is one `az` listed this session (`commands.rs` checks); the webview names it and a
//!   slot, plus keys and destinations from a fixed catalog ([`FIELDS`]). It never names an ARM
//!   path.
//! - Values never travel in argv: every write is `az rest --body @-` with the JSON body on stdin
//!   (the Azure CLI reads `@-` from stdin).
//! - App settings and connection strings are replaced as a whole collection by ARM, so they are
//!   read, merged and written back (as `az webapp config appsettings set` does). Existing values
//!   stay in memory for that one call and are never returned or logged. Nothing is ever deleted.
//! - Nothing `az` prints is logged.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::cli;
use crate::error::{Error, Result};
use crate::fsops;

/// `Microsoft.Web` API version for every ARM call.
pub const API_VERSION: &str = "2023-12-01";

// ---------------------------------------------------------------------------------------------
// Resource ids

/// An App Service (web app, function app, ...) by subscription, resource group and name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiteRef {
    pub subscription: String,
    pub group: String,
    pub name: String,
}

impl SiteRef {
    pub fn id(&self) -> String {
        format!(
            "/subscriptions/{}/resourceGroups/{}/providers/Microsoft.Web/sites/{}",
            self.subscription, self.group, self.name
        )
    }

    /// The ARM path of the site, or of one of its deployment slots.
    pub fn path(&self, slot: Option<&str>) -> String {
        match slot {
            Some(slot) => format!("{}/slots/{slot}", self.id()),
            None => self.id(),
        }
    }

    /// The key `AppState::azure_sites` uses.
    pub fn session_key(&self) -> String {
        self.id().to_ascii_lowercase()
    }
}

pub fn is_guid(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// Resource group names: letters, digits, `-_.()`, up to 90, not ending in `.`. ASCII only here.
fn is_group_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 90
        && !s.ends_with('.')
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '(' | ')'))
}

/// App and slot names: letters, digits and `-`, not at either end.
fn is_host_label(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.len() <= max
        && !s.starts_with('-')
        && !s.ends_with('-')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

pub fn is_slot_name(s: &str) -> bool {
    is_host_label(s, 59)
}

/// `/subscriptions/<guid>/resourceGroups/<rg>/providers/Microsoft.Web/sites/<name>`, any case.
pub fn parse_site_id(id: &str) -> Option<SiteRef> {
    let parts: Vec<&str> = id.split('/').collect();
    let eq = |a: &str, b: &str| a.eq_ignore_ascii_case(b);
    (parts.len() == 9
        && parts[0].is_empty()
        && eq(parts[1], "subscriptions")
        && is_guid(parts[2])
        && eq(parts[3], "resourceGroups")
        && is_group_name(parts[4])
        && eq(parts[5], "providers")
        && eq(parts[6], "Microsoft.Web")
        && eq(parts[7], "sites")
        && is_host_label(parts[8], 60))
    .then(|| SiteRef {
        subscription: parts[2].to_ascii_lowercase(),
        group: parts[4].to_string(),
        name: parts[8].to_string(),
    })
}

// ---------------------------------------------------------------------------------------------
// Local hint: `.azure/config` next to the file (written by `az webapp up`)

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hint {
    pub group: Option<String>,
    pub web: Option<String>,
}

fn parse_defaults(text: &str) -> Hint {
    let mut hint = Hint::default();
    let mut in_defaults = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_defaults = line.eq_ignore_ascii_case("[defaults]");
        } else if in_defaults && let Some((k, v)) = line.split_once('=') {
            let v = v.trim();
            if v.is_empty() {
                continue;
            }
            match k.trim().to_ascii_lowercase().as_str() {
                "group" => hint.group = Some(v.to_string()),
                "web" => hint.web = Some(v.to_string()),
                _ => {}
            }
        }
    }
    hint
}

/// The app named in `dir/.azure/config`, if any. Reads one small file.
pub fn local_hint(dir: &Path, max: u64) -> Option<Hint> {
    let text = fsops::read_text(&dir.join(".azure").join("config"), max)
        .ok()?
        .text;
    let hint = parse_defaults(&text);
    hint.web.is_some().then_some(hint)
}

// ---------------------------------------------------------------------------------------------
// Running az

/// Runs `az` with arguments and optional stdin, returning stdout or an error from its stderr.
pub trait Az: Sync {
    fn run(&self, args: &[String], stdin: Option<&str>) -> Result<String>;
}

pub struct AzCli {
    exe: PathBuf,
    /// Arguments before the command (`-IBm azure.cli` when running the bundled Python).
    prefix: Vec<String>,
}

impl AzCli {
    /// On Windows `az` is `az.cmd`, a batch file; batch files run through cmd.exe, with its
    /// quoting rules. Run the CLI's bundled Python directly instead, as `az.cmd` itself does.
    /// Elsewhere `az` is on `PATH` or in the usual install folders.
    pub fn locate() -> Result<Self> {
        if cfg!(windows) {
            let mut cli2: Vec<PathBuf> = Vec::new();
            if let Some(az_cmd) = cli::find("az.cmd", &[])
                && let Some(dir) = az_cmd.parent().and_then(Path::parent)
            {
                cli2.push(dir.to_path_buf());
            }
            let sdk = |base: PathBuf| base.join("Microsoft SDKs").join("Azure").join("CLI2");
            for var in ["ProgramFiles", "ProgramFiles(x86)"] {
                if let Some(base) = std::env::var_os(var) {
                    cli2.push(sdk(PathBuf::from(base)));
                }
            }
            if let Some(local) = dirs::data_local_dir() {
                cli2.push(sdk(local.join("Programs")));
            }
            cli2.into_iter()
                .map(|d| d.join("python.exe"))
                .find(|p| p.is_file())
                .map(|exe| AzCli {
                    exe,
                    prefix: vec!["-IBm".into(), "azure.cli".into()],
                })
                .ok_or(Error::AzMissing)
        } else {
            cli::find("az", &cli::unix_bin_dirs())
                .map(|exe| AzCli {
                    exe,
                    prefix: Vec::new(),
                })
                .ok_or(Error::AzMissing)
        }
    }
}

impl Az for AzCli {
    fn run(&self, args: &[String], stdin: Option<&str>) -> Result<String> {
        let mut cmd = Command::new(&self.exe);
        // The Azure CLI's own login is used as it is; EnvDeck passes no token. These only quiet
        // the output and turn off the CLI's telemetry and surveys for EnvDeck's runs.
        cmd.args(&self.prefix)
            .args(args)
            .env("AZURE_CORE_ONLY_SHOW_ERRORS", "true")
            .env("AZURE_CORE_NO_COLOR", "true")
            .env("AZURE_CORE_COLLECT_TELEMETRY", "false")
            .env("AZURE_CORE_SURVEY_MESSAGE", "false");
        let out = cli::run(cmd, stdin).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => Error::AzMissing,
            _ => Error::Az(format!("Couldn't run az: {e}")),
        })?;
        if out.success {
            Ok(out.stdout)
        } else {
            Err(az_error(&out.stderr))
        }
    }
}

/// What the UI shows when az has no usable login.
pub const NOT_SIGNED_IN: &str = "The Azure CLI isn't signed in, or its sign-in expired. Run az login in a terminal, then try again.";

/// A failed run: az without a (valid) login becomes `AzAuth` so the UI shows how to sign in.
fn az_error(stderr: &str) -> Error {
    let lower = stderr.to_ascii_lowercase();
    let msg = cli::message(stderr, "az failed");
    if lower.contains("az login")
        || lower.contains("aadsts")
        || lower.contains("interactive authentication is needed")
    {
        Error::AzAuth(NOT_SIGNED_IN.into())
    } else if lower.contains("authorizationfailed")
        || lower.contains("does not have authorization")
        || lower.contains("(forbidden)")
    {
        Error::Az(format!(
            "Azure refused: your account needs write access to the app (for example the Website \
             Contributor role). ({msg})"
        ))
    } else {
        Error::Az(msg)
    }
}

fn args(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|s| s.to_string()).collect()
}

fn parse_json(out: &str, what: &str) -> Result<Value> {
    if out.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(out.trim())
        .map_err(|e| Error::Az(format!("Unexpected output from az {what}: {e}")))
}

/// `az rest` against an ARM path (`/subscriptions/...`; az adds the cloud's endpoint). A body
/// goes on stdin via `--body @-`.
fn rest(az: &dyn Az, method: &str, path: &str, body: Option<&Value>) -> Result<Value> {
    let uri = format!("{path}?api-version={API_VERSION}");
    let mut a = args(&[
        "rest", "--method", method, "--uri", &uri, "--output", "json",
    ]);
    let body = body.map(Value::to_string);
    if body.is_some() {
        a.push("--body".into());
        a.push("@-".into());
    }
    parse_json(&az.run(&a, body.as_deref())?, "rest")
}

// ---------------------------------------------------------------------------------------------
// Account, apps and slots

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    /// The account `az login` signed in as.
    pub user: String,
    pub subscriptions: Vec<Subscription>,
}

fn str_of(v: &Value, key: &str) -> String {
    v[key].as_str().unwrap_or_default().to_string()
}

/// Who az is signed in as, and the enabled subscriptions it can see (default first). Doubles as
/// the sign-in check.
pub fn account(az: &dyn Az) -> Result<Account> {
    let show = parse_json(
        &az.run(&args(&["account", "show", "--output", "json"]), None)?,
        "account show",
    )?;
    let user = show["user"]["name"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    if user.is_empty() {
        return Err(Error::AzAuth(NOT_SIGNED_IN.into()));
    }
    let list = parse_json(
        &az.run(&args(&["account", "list", "--output", "json"]), None)?,
        "account list",
    )?;
    let mut subscriptions: Vec<Subscription> = list
        .as_array()
        .into_iter()
        .flatten()
        .filter(|s| s["state"].as_str().is_none_or(|st| st == "Enabled"))
        .filter(|s| is_guid(s["id"].as_str().unwrap_or_default()))
        .map(|s| Subscription {
            id: str_of(s, "id").to_ascii_lowercase(),
            name: str_of(s, "name"),
            is_default: s["isDefault"].as_bool().unwrap_or(false),
        })
        .collect();
    subscriptions.sort_by_key(|s| (!s.is_default, s.name.to_lowercase()));
    Ok(Account {
        user,
        subscriptions,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Site {
    pub id: String,
    pub name: String,
    pub resource_group: String,
    /// `app`, `app,linux`, `functionapp,linux`, ...
    pub kind: String,
    pub location: String,
}

/// Every App Service in a subscription (web, API, function and container apps).
pub fn list_sites(az: &dyn Az, subscription: &str) -> Result<Vec<Site>> {
    if !is_guid(subscription) {
        return Err(Error::Az(format!(
            "\"{subscription}\" isn't a subscription id"
        )));
    }
    let out = az.run(
        &args(&[
            "resource",
            "list",
            "--resource-type",
            "Microsoft.Web/sites",
            "--subscription",
            subscription,
            "--output",
            "json",
        ]),
        None,
    )?;
    let list = parse_json(&out, "resource list")?;
    let mut sites: Vec<Site> = list
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| {
            let site = parse_site_id(s["id"].as_str()?)?;
            Some(Site {
                id: site.id(),
                name: site.name,
                resource_group: site.group,
                kind: str_of(s, "kind"),
                location: str_of(s, "location"),
            })
        })
        .collect();
    sites.sort_by_key(|s| s.name.to_lowercase());
    Ok(sites)
}

/// Deployment slot names (without the `site/` prefix).
pub fn list_slots(az: &dyn Az, site: &SiteRef) -> Result<Vec<String>> {
    let v = rest(az, "get", &format!("{}/slots", site.id()), None)?;
    let mut slots: Vec<String> = v["value"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| s["name"].as_str())
        .map(|n| n.rsplit('/').next().unwrap_or(n).to_string())
        .filter(|n| is_slot_name(n))
        .collect();
    slots.sort();
    Ok(slots)
}

// ---------------------------------------------------------------------------------------------
// Destinations: app settings, connection strings and the field catalog

/// App setting and connection string names. Windows apps accept `:` (nested .NET config);
/// Linux apps only keep letters, digits and `_` (the UI warns).
pub fn is_valid_setting_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 256
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | ':'))
}

pub const CONNECTION_TYPES: &[&str] = &[
    "Custom",
    "SQLAzure",
    "SQLServer",
    "MySql",
    "PostgreSQL",
    "RedisCache",
    "DocDb",
    "EventHub",
    "ServiceBus",
    "NotificationHub",
    "ApiHub",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Target {
    /// A `siteConfig` property, set with `PATCH config/web`.
    SiteConfig(&'static str),
    /// `linuxFxVersion = DOCKER|<image>`.
    Container,
    /// A fixed app setting (the registry settings).
    AppSetting(&'static str),
    /// A `sourcecontrols/web` property.
    Source(&'static str),
}

impl Target {
    /// Two rows can't write the same place.
    fn slot_key(self) -> String {
        match self {
            Target::SiteConfig(p) => format!("web:{p}"),
            Target::Container => "web:linuxFxVersion".into(),
            Target::AppSetting(n) => format!("app:{}", n.to_ascii_lowercase()),
            Target::Source(p) => format!("src:{p}"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ty {
    Text,
    /// Text starting with `/`.
    Path,
    Bool,
    /// A whole number of at least 1.
    Count,
    Choice(&'static [&'static str]),
}

struct Field {
    id: &'static str,
    label: &'static str,
    section: &'static str,
    target: Target,
    ty: Ty,
    secret: bool,
    note: Option<&'static str>,
}

const TLS: &[&str] = &["1.0", "1.1", "1.2", "1.3"];
const FTPS: &[&str] = &["AllAllowed", "FtpsOnly", "Disabled"];
const REDEPLOYS: Option<&str> = Some("Changing the source starts a deployment");

/// Everything besides app settings and connection strings that a key can be pushed to.
const FIELDS: &[Field] = &[
    Field {
        id: "startupCommand",
        label: "Startup command",
        section: "general",
        target: Target::SiteConfig("appCommandLine"),
        ty: Ty::Text,
        secret: false,
        note: None,
    },
    Field {
        id: "runtimeStack",
        label: "Runtime stack (Linux, e.g. NODE|20-lts)",
        section: "general",
        target: Target::SiteConfig("linuxFxVersion"),
        ty: Ty::Text,
        secret: false,
        note: None,
    },
    Field {
        id: "alwaysOn",
        label: "Always on",
        section: "general",
        target: Target::SiteConfig("alwaysOn"),
        ty: Ty::Bool,
        secret: false,
        note: None,
    },
    Field {
        id: "http20Enabled",
        label: "HTTP 2.0",
        section: "general",
        target: Target::SiteConfig("http20Enabled"),
        ty: Ty::Bool,
        secret: false,
        note: None,
    },
    Field {
        id: "webSocketsEnabled",
        label: "Web sockets",
        section: "general",
        target: Target::SiteConfig("webSocketsEnabled"),
        ty: Ty::Bool,
        secret: false,
        note: None,
    },
    Field {
        id: "use32BitWorkerProcess",
        label: "32-bit worker process",
        section: "general",
        target: Target::SiteConfig("use32BitWorkerProcess"),
        ty: Ty::Bool,
        secret: false,
        note: None,
    },
    Field {
        id: "minTlsVersion",
        label: "Minimum TLS version",
        section: "general",
        target: Target::SiteConfig("minTlsVersion"),
        ty: Ty::Choice(TLS),
        secret: false,
        note: None,
    },
    Field {
        id: "ftpsState",
        label: "FTP state",
        section: "general",
        target: Target::SiteConfig("ftpsState"),
        ty: Ty::Choice(FTPS),
        secret: false,
        note: None,
    },
    Field {
        id: "healthCheckPath",
        label: "Health check path",
        section: "general",
        target: Target::SiteConfig("healthCheckPath"),
        ty: Ty::Path,
        secret: false,
        note: None,
    },
    Field {
        id: "numberOfWorkers",
        label: "Number of workers",
        section: "general",
        target: Target::SiteConfig("numberOfWorkers"),
        ty: Ty::Count,
        secret: false,
        note: None,
    },
    Field {
        id: "containerImage",
        label: "Container image (Linux)",
        section: "deployment",
        target: Target::Container,
        ty: Ty::Text,
        secret: false,
        note: None,
    },
    Field {
        id: "registryUrl",
        label: "Registry server URL",
        section: "deployment",
        target: Target::AppSetting("DOCKER_REGISTRY_SERVER_URL"),
        ty: Ty::Text,
        secret: false,
        note: None,
    },
    Field {
        id: "registryUsername",
        label: "Registry username",
        section: "deployment",
        target: Target::AppSetting("DOCKER_REGISTRY_SERVER_USERNAME"),
        ty: Ty::Text,
        secret: false,
        note: None,
    },
    Field {
        id: "registryPassword",
        label: "Registry password",
        section: "deployment",
        target: Target::AppSetting("DOCKER_REGISTRY_SERVER_PASSWORD"),
        ty: Ty::Text,
        secret: true,
        note: None,
    },
    Field {
        id: "repoUrl",
        label: "Source repository URL",
        section: "deployment",
        target: Target::Source("repoUrl"),
        ty: Ty::Text,
        secret: false,
        note: REDEPLOYS,
    },
    Field {
        id: "branch",
        label: "Source branch",
        section: "deployment",
        target: Target::Source("branch"),
        ty: Ty::Text,
        secret: false,
        note: REDEPLOYS,
    },
];

/// A catalog entry as the UI sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldInfo {
    pub id: String,
    pub label: String,
    /// `general` or `deployment`.
    pub section: String,
    /// `text`, `path`, `bool`, `count` or `choice`.
    pub kind: String,
    pub choices: Vec<String>,
    pub secret: bool,
    /// For registry fields: the app setting they write, so the UI can say "replaces".
    pub app_setting: Option<String>,
    /// Where the field writes; two rows with the same target conflict.
    pub target: String,
    pub note: Option<String>,
}

pub fn fields() -> Vec<FieldInfo> {
    FIELDS
        .iter()
        .map(|f| {
            let (kind, choices) = match f.ty {
                Ty::Text => ("text", Vec::new()),
                Ty::Path => ("path", Vec::new()),
                Ty::Bool => ("bool", Vec::new()),
                Ty::Count => ("count", Vec::new()),
                Ty::Choice(c) => ("choice", c.iter().map(|s| s.to_string()).collect()),
            };
            FieldInfo {
                id: f.id.into(),
                label: f.label.into(),
                section: f.section.into(),
                kind: kind.into(),
                choices,
                secret: f.secret,
                app_setting: match f.target {
                    Target::AppSetting(n) => Some(n.into()),
                    _ => None,
                },
                target: f.target.slot_key(),
                note: f.note.map(str::to_string),
            }
        })
        .collect()
}

fn field(id: &str) -> Option<&'static Field> {
    FIELDS.iter().find(|f| f.id == id)
}

/// The JSON value a field gets from a dotenv value, or why it can't take it.
fn parse_value(ty: Ty, raw: &str) -> std::result::Result<Value, String> {
    let v = raw.trim();
    if v.is_empty() {
        return Err("needs a value".into());
    }
    match ty {
        Ty::Text => Ok(Value::String(raw.to_string())),
        Ty::Path if v.starts_with('/') => Ok(Value::String(v.to_string())),
        Ty::Path => Err("must start with /".into()),
        Ty::Bool => match v.to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" | "on" => Ok(Value::Bool(true)),
            "false" | "0" | "no" | "off" => Ok(Value::Bool(false)),
            _ => Err("must be true or false".into()),
        },
        Ty::Count => match v.parse::<u32>() {
            Ok(n) if n >= 1 => Ok(json!(n)),
            _ => Err("must be a whole number of at least 1".into()),
        },
        Ty::Choice(choices) => choices
            .iter()
            .find(|c| c.eq_ignore_ascii_case(v))
            .map(|c| Value::String(c.to_string()))
            .ok_or_else(|| format!("must be one of {}", choices.join(", "))),
    }
}

// ---------------------------------------------------------------------------------------------
// Inspect: what already exists (names only)

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AzureState {
    pub site: String,
    pub slot: Option<String>,
    pub linux: bool,
    pub app_settings: Vec<String>,
    pub connection_strings: Vec<String>,
    /// Slot settings ("sticky" to their slot), from the production site.
    pub sticky_app_settings: Vec<String>,
    pub sticky_connection_strings: Vec<String>,
    pub fields: Vec<FieldInfo>,
    pub connection_types: Vec<String>,
    /// Lists that couldn't be read; pushing may still work.
    pub warnings: Vec<String>,
}

fn property_names(v: &Value) -> Vec<String> {
    let mut names: Vec<String> = v["properties"]
        .as_object()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    names.sort_by_key(|n| n.to_lowercase());
    names
}

fn string_list(v: &Value) -> Vec<String> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| s.as_str().map(str::to_string))
        .collect()
}

fn is_linux(site: &Value) -> bool {
    site["kind"]
        .as_str()
        .is_some_and(|k| k.to_ascii_lowercase().contains("linux"))
        || site["properties"]["reserved"].as_bool() == Some(true)
}

/// Names of existing app settings and connection strings (values are read by the list calls
/// and dropped here), which are slot settings, and whether the app runs on Linux.
pub fn inspect(az: &dyn Az, site: &SiteRef, slot: Option<&str>) -> Result<AzureState> {
    let base = site.path(slot);
    // Reading the app doubles as the access check: if it fails, nothing else will work.
    let info = rest(az, "get", &base, None)?;
    let mut state = AzureState {
        site: site.name.clone(),
        slot: slot.map(str::to_string),
        linux: is_linux(&info),
        fields: fields(),
        connection_types: CONNECTION_TYPES.iter().map(|s| s.to_string()).collect(),
        ..Default::default()
    };
    let (app, conn, sticky) = std::thread::scope(|s| {
        let app = s.spawn(|| rest(az, "post", &format!("{base}/config/appsettings/list"), None));
        let conn = s.spawn(|| {
            rest(
                az,
                "post",
                &format!("{base}/config/connectionstrings/list"),
                None,
            )
        });
        let sticky = s.spawn(|| {
            rest(
                az,
                "get",
                &format!("{}/config/slotConfigNames", site.id()),
                None,
            )
        });
        let join = |h: std::thread::ScopedJoinHandle<'_, Result<Value>>| {
            h.join()
                .unwrap_or_else(|_| Err(Error::Az("az panicked".into())))
        };
        (join(app), join(conn), join(sticky))
    });
    // Listing app settings needs the same access as writing them; that failure stops here.
    state.app_settings = property_names(&app?);
    match conn {
        Ok(v) => state.connection_strings = property_names(&v),
        Err(e @ Error::AzAuth(_)) => return Err(e),
        Err(e) => state
            .warnings
            .push(format!("Couldn't list connection strings: {e}")),
    }
    match sticky {
        Ok(v) => {
            state.sticky_app_settings = string_list(&v["properties"]["appSettingNames"]);
            state.sticky_connection_strings =
                string_list(&v["properties"]["connectionStringNames"]);
        }
        Err(e @ Error::AzAuth(_)) => return Err(e),
        Err(e) => state
            .warnings
            .push(format!("Couldn't list slot settings: {e}")),
    }
    Ok(state)
}

// ---------------------------------------------------------------------------------------------
// Push

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Dest {
    AppSetting,
    ConnectionString,
    Field,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushItem {
    /// The key in the dotenv file; Rust reads its value.
    pub key: String,
    pub dest: Dest,
    /// App setting or connection string name; defaults to `key`.
    #[serde(default)]
    pub name: Option<String>,
    /// Catalog id when `dest` is `field`.
    #[serde(default)]
    pub field: Option<String>,
    /// Connection string type; defaults to `Custom`.
    #[serde(default)]
    pub conn_type: Option<String>,
    /// Make the app setting or connection string stick to its slot.
    #[serde(default)]
    pub slot_setting: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushResult {
    pub key: String,
    /// `None` on success.
    pub error: Option<String>,
}

/// One write, before grouping into requests.
#[derive(Debug, Clone, PartialEq)]
enum Write {
    App {
        name: String,
        value: String,
    },
    Conn {
        name: String,
        value: String,
        ty: String,
    },
    Web {
        prop: &'static str,
        value: Value,
        container: bool,
    },
    Source {
        prop: &'static str,
        value: String,
    },
}

impl Write {
    fn slot_key(&self) -> String {
        match self {
            Write::App { name, .. } => format!("app:{}", name.to_ascii_lowercase()),
            Write::Conn { name, .. } => format!("conn:{}", name.to_ascii_lowercase()),
            Write::Web { prop, .. } => format!("web:{prop}"),
            Write::Source { prop, .. } => format!("src:{prop}"),
        }
    }
}

fn plan_item(item: &PushItem, value: Option<&str>) -> std::result::Result<Write, String> {
    let value = value.ok_or_else(|| format!("{} isn't in the file any more", item.key))?;
    let name = || {
        let name = item.name.clone().unwrap_or_else(|| item.key.clone());
        if is_valid_setting_name(&name) {
            Ok(name)
        } else {
            Err(format!(
                "\"{name}\" isn't a valid name (letters, digits, _ . - :)"
            ))
        }
    };
    match item.dest {
        Dest::AppSetting => Ok(Write::App {
            name: name()?,
            value: value.to_string(),
        }),
        Dest::ConnectionString => {
            let ty = item.conn_type.as_deref().unwrap_or("Custom");
            let ty = CONNECTION_TYPES
                .iter()
                .find(|t| t.eq_ignore_ascii_case(ty))
                .ok_or_else(|| format!("\"{ty}\" isn't a connection string type"))?;
            Ok(Write::Conn {
                name: name()?,
                value: value.to_string(),
                ty: ty.to_string(),
            })
        }
        Dest::Field => {
            let id = item.field.as_deref().unwrap_or_default();
            let f = field(id).ok_or_else(|| format!("\"{id}\" isn't a setting EnvDeck can set"))?;
            let parsed = parse_value(f.ty, value).map_err(|e| format!("{} {e}", f.label))?;
            let text = parsed.as_str().unwrap_or_default().to_string();
            Ok(match f.target {
                Target::SiteConfig(prop) => Write::Web {
                    prop,
                    value: parsed,
                    container: false,
                },
                Target::Container => {
                    let image = text.trim();
                    let fx = if image
                        .get(..7)
                        .is_some_and(|p| p.eq_ignore_ascii_case("DOCKER|"))
                    {
                        format!("DOCKER|{}", &image[7..])
                    } else {
                        format!("DOCKER|{image}")
                    };
                    Write::Web {
                        prop: "linuxFxVersion",
                        value: Value::String(fx),
                        container: true,
                    }
                }
                Target::AppSetting(name) => Write::App {
                    name: name.to_string(),
                    value: text,
                },
                Target::Source(prop) => Write::Source {
                    prop,
                    value: text.trim().to_string(),
                },
            })
        }
    }
}

/// Settles one request for the items it carried: `AzAuth` stops the push (the UI shows
/// `az login`), anything else is reported on each item.
fn settle(res: Result<()>, idx: &[usize], errors: &mut [Option<String>]) -> Result<()> {
    match res {
        Ok(()) => Ok(()),
        Err(e @ Error::AzAuth(_)) => Err(e),
        Err(e) => {
            let msg = e.to_string();
            for &i in idx {
                errors[i] = Some(msg.clone());
            }
            Ok(())
        }
    }
}

/// Reads a collection (`appsettings`, `connectionstrings`), merges `entries` in and writes it
/// back. Keys not pushed keep their values.
fn merge_collection(
    az: &dyn Az,
    base: &str,
    collection: &str,
    entries: Vec<(String, Value)>,
) -> Result<()> {
    let current = rest(
        az,
        "post",
        &format!("{base}/config/{collection}/list"),
        None,
    )?;
    let mut props: Map<String, Value> = current["properties"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    for (name, value) in entries {
        props.insert(name, value);
    }
    rest(
        az,
        "put",
        &format!("{base}/config/{collection}"),
        Some(&json!({ "properties": props })),
    )?;
    Ok(())
}

/// Adds names to the production site's slot setting lists (they stick to their slot).
fn add_sticky(az: &dyn Az, site: &SiteRef, apps: &[String], conns: &[String]) -> Result<()> {
    let path = format!("{}/config/slotConfigNames", site.id());
    let current = rest(az, "get", &path, None)?;
    let mut props = current["properties"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    for (field, add) in [("appSettingNames", apps), ("connectionStringNames", conns)] {
        let mut names = string_list(&props.get(field).cloned().unwrap_or_default());
        for n in add {
            if !names.iter().any(|x| x.eq_ignore_ascii_case(n)) {
                names.push(n.clone());
            }
        }
        props.insert(field.into(), json!(names));
    }
    rest(az, "put", &path, Some(&json!({ "properties": props })))?;
    Ok(())
}

/// Sets each item from `vars` (the file's values, read by Rust) on the app or slot. Writes are
/// grouped into one request per kind; a failed request is reported on the items it carried and
/// the others still run.
pub fn push(
    az: &dyn Az,
    site: &SiteRef,
    slot: Option<&str>,
    vars: &[(String, String)],
    items: &[PushItem],
) -> Result<Vec<PushResult>> {
    let base = site.path(slot);
    let mut errors: Vec<Option<String>> = vec![None; items.len()];
    let mut writes: Vec<Option<Write>> = vec![None; items.len()];
    let mut taken = HashSet::new();
    for (i, item) in items.iter().enumerate() {
        let value = vars
            .iter()
            .find(|(k, _)| k == &item.key)
            .map(|(_, v)| v.as_str());
        match plan_item(item, value) {
            Ok(w) if !taken.insert(w.slot_key()) => {
                errors[i] = Some("Another row already sets this".into());
            }
            Ok(w) => writes[i] = Some(w),
            Err(e) => errors[i] = Some(e),
        }
    }
    let pick = |f: fn(&Write) -> bool| -> Vec<usize> {
        (0..items.len())
            .filter(|&i| writes[i].as_ref().is_some_and(f))
            .collect()
    };

    // App settings, including the registry fields.
    let app = pick(|w| matches!(w, Write::App { .. }));
    if !app.is_empty() {
        let entries = app
            .iter()
            .filter_map(|&i| match &writes[i] {
                Some(Write::App { name, value }) => Some((name.clone(), json!(value))),
                _ => None,
            })
            .collect();
        settle(
            merge_collection(az, &base, "appsettings", entries),
            &app,
            &mut errors,
        )?;
    }

    // Connection strings.
    let conn = pick(|w| matches!(w, Write::Conn { .. }));
    if !conn.is_empty() {
        let entries = conn
            .iter()
            .filter_map(|&i| match &writes[i] {
                Some(Write::Conn { name, value, ty }) => {
                    Some((name.clone(), json!({ "value": value, "type": ty })))
                }
                _ => None,
            })
            .collect();
        settle(
            merge_collection(az, &base, "connectionstrings", entries),
            &conn,
            &mut errors,
        )?;
    }

    // Slot settings, for the ones that were saved.
    let sticky: Vec<usize> = app
        .iter()
        .chain(&conn)
        .copied()
        .filter(|&i| items[i].slot_setting && errors[i].is_none())
        .collect();
    if !sticky.is_empty() {
        let names = |dest: Dest| -> Vec<String> {
            sticky
                .iter()
                .filter(|&&i| items[i].dest == dest)
                .filter_map(|&i| match &writes[i] {
                    Some(Write::App { name, .. } | Write::Conn { name, .. }) => Some(name.clone()),
                    _ => None,
                })
                .collect()
        };
        if let Err(e) = add_sticky(
            az,
            site,
            &names(Dest::AppSetting),
            &names(Dest::ConnectionString),
        ) {
            for &i in &sticky {
                errors[i] = Some(format!("Saved, but couldn't make it a slot setting: {e}"));
            }
        }
    }

    // General settings and the container image: one PATCH of the site config.
    let mut web = pick(|w| matches!(w, Write::Web { .. }));
    if web.iter().any(|&i| {
        matches!(
            writes[i],
            Some(Write::Web {
                container: true,
                ..
            })
        )
    }) {
        match rest(az, "get", &base, None) {
            Ok(info) if is_linux(&info) => {}
            Ok(_) => {
                web.retain(|&i| {
                    let container = matches!(
                        writes[i],
                        Some(Write::Web {
                            container: true,
                            ..
                        })
                    );
                    if container {
                        errors[i] =
                            Some("Container images can only be set here for Linux apps".into());
                    }
                    !container
                });
            }
            Err(e @ Error::AzAuth(_)) => return Err(e),
            Err(e) => {
                for &i in &web {
                    errors[i] = Some(e.to_string());
                }
                web.clear();
            }
        }
    }
    if !web.is_empty() {
        let props: Map<String, Value> = web
            .iter()
            .filter_map(|&i| match &writes[i] {
                Some(Write::Web { prop, value, .. }) => Some((prop.to_string(), value.clone())),
                _ => None,
            })
            .collect();
        let res = rest(
            az,
            "patch",
            &format!("{base}/config/web"),
            Some(&json!({ "properties": props })),
        )
        .map(|_| ());
        settle(res, &web, &mut errors)?;
    }

    // Deployment Center source: read, merge and write back (starts a deployment).
    let source = pick(|w| matches!(w, Write::Source { .. }));
    if !source.is_empty() {
        let res = (|| -> Result<()> {
            let path = format!("{base}/sourcecontrols/web");
            let current = match rest(az, "get", &path, None) {
                Ok(v) => v,
                Err(Error::Az(m)) if m.to_ascii_lowercase().contains("not found") => Value::Null,
                Err(e) => return Err(e),
            };
            let mut props = current["properties"]
                .as_object()
                .cloned()
                .unwrap_or_else(|| {
                    // A new external Git source, synced on demand rather than by a webhook.
                    Map::from_iter([("isManualIntegration".to_string(), json!(true))])
                });
            for &i in &source {
                if let Some(Write::Source { prop, value }) = &writes[i] {
                    props.insert(prop.to_string(), json!(value));
                }
            }
            if props
                .get("repoUrl")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .is_empty()
            {
                return Err(Error::Az(
                    "The source needs a repository URL; push one with the branch".into(),
                ));
            }
            rest(az, "put", &path, Some(&json!({ "properties": props })))?;
            Ok(())
        })();
        settle(res, &source, &mut errors)?;
    }

    Ok(items
        .iter()
        .zip(errors)
        .map(|(item, error)| PushResult {
            key: item.key.clone(),
            error,
        })
        .collect())
}

/// A portal page for the app or slot, built in Rust.
pub fn portal_url(site: &SiteRef, slot: Option<&str>, page: &str) -> Result<String> {
    let blade = match page {
        "environment" => "environmentVariablesAppSettings",
        "configuration" => "configuration",
        "deploymentCenter" => "vstscd",
        _ => {
            return Err(Error::Native(format!(
                "Unknown Azure portal page \"{page}\""
            )));
        }
    };
    Ok(format!(
        "https://portal.azure.com/#resource{}/{blade}",
        site.path(slot)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    const SUB: &str = "0b1f6471-1bf0-4dda-aec3-111122223333";

    fn site() -> SiteRef {
        SiteRef {
            subscription: SUB.into(),
            group: "shop-rg".into(),
            name: "shop-api".into(),
        }
    }

    #[test]
    fn parses_and_validates_site_ids() {
        let id = format!(
            "/subscriptions/{}/resourcegroups/shop-rg/providers/microsoft.web/sites/shop-api",
            SUB.to_uppercase()
        );
        assert_eq!(parse_site_id(&id), Some(site()));
        assert_eq!(
            site().id(),
            format!(
                "/subscriptions/{SUB}/resourceGroups/shop-rg/providers/Microsoft.Web/sites/shop-api"
            )
        );
        assert!(
            site()
                .path(Some("staging"))
                .ends_with("/sites/shop-api/slots/staging")
        );
        for bad in [
            "",
            "/subscriptions/x/resourceGroups/rg/providers/Microsoft.Web/sites/a",
            &format!(
                "/subscriptions/{SUB}/resourceGroups/rg/providers/Microsoft.Web/sites/a/slots/b"
            ),
            &format!("/subscriptions/{SUB}/resourceGroups/rg/providers/Microsoft.Sql/servers/a"),
            &format!("/subscriptions/{SUB}/resourceGroups/r?g/providers/Microsoft.Web/sites/a"),
            &format!("/subscriptions/{SUB}/resourceGroups/rg/providers/Microsoft.Web/sites/a b"),
            &format!("/subscriptions/{SUB}/resourceGroups/rg/providers/Microsoft.Web/sites/-a"),
            &format!("subscriptions/{SUB}/resourceGroups/rg/providers/Microsoft.Web/sites/a/"),
        ] {
            assert_eq!(parse_site_id(bad), None, "{bad}");
        }
        assert!(is_slot_name("staging-2"));
        assert!(!is_slot_name("../x") && !is_slot_name("") && !is_slot_name("a/b"));
    }

    #[test]
    fn reads_the_hint_from_azure_config() {
        let text = "[core]\noutput = json\n[defaults]\ngroup = shop-rg\nsku = B1\nweb = shop-api\n";
        assert_eq!(
            parse_defaults(text),
            Hint {
                group: Some("shop-rg".into()),
                web: Some("shop-api".into())
            }
        );
        assert_eq!(parse_defaults("[core]\nweb = x\n"), Hint::default());

        let dir = tempfile::tempdir().unwrap();
        assert_eq!(local_hint(dir.path(), 1 << 20), None);
        std::fs::create_dir(dir.path().join(".azure")).unwrap();
        std::fs::write(dir.path().join(".azure/config"), text).unwrap();
        assert_eq!(
            local_hint(dir.path(), 1 << 20).unwrap().web.as_deref(),
            Some("shop-api")
        );
    }

    #[test]
    fn parses_field_values() {
        assert_eq!(parse_value(Ty::Bool, "Yes"), Ok(json!(true)));
        assert_eq!(parse_value(Ty::Bool, "0"), Ok(json!(false)));
        assert!(parse_value(Ty::Bool, "maybe").is_err());
        assert_eq!(parse_value(Ty::Count, "3"), Ok(json!(3)));
        assert!(parse_value(Ty::Count, "0").is_err());
        assert_eq!(parse_value(Ty::Choice(TLS), "1.2"), Ok(json!("1.2")));
        assert_eq!(
            parse_value(Ty::Choice(FTPS), "ftpsonly"),
            Ok(json!("FtpsOnly"))
        );
        assert!(parse_value(Ty::Choice(TLS), "2.0").is_err());
        assert_eq!(parse_value(Ty::Path, "/healthz"), Ok(json!("/healthz")));
        assert!(parse_value(Ty::Path, "healthz").is_err());
        assert!(parse_value(Ty::Text, "  ").is_err());
    }

    #[test]
    fn catalog_ids_are_unique_and_exposed() {
        let all = fields();
        let ids: HashSet<_> = all.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(ids.len(), all.len());
        let pw = all.iter().find(|f| f.id == "registryPassword").unwrap();
        assert!(pw.secret);
        assert_eq!(
            pw.app_setting.as_deref(),
            Some("DOCKER_REGISTRY_SERVER_PASSWORD")
        );
        let image = all.iter().find(|f| f.id == "containerImage").unwrap();
        let stack = all.iter().find(|f| f.id == "runtimeStack").unwrap();
        assert_eq!(image.target, stack.target, "both write linuxFxVersion");
    }

    #[test]
    fn validates_setting_names() {
        for ok in ["API_KEY", "Logging:LogLevel", "app.name", "a-b"] {
            assert!(is_valid_setting_name(ok), "{ok}");
        }
        for bad in ["", "A B", "A=B", "a/b", &"x".repeat(257)] {
            assert!(!is_valid_setting_name(bad), "{bad}");
        }
    }

    /// Records calls; fails any whose joined args contain a `fail_on` entry.
    #[derive(Default)]
    struct FakeAz {
        calls: Mutex<Vec<(Vec<String>, Option<String>)>>,
        fail_on: Vec<&'static str>,
        stderr: &'static str,
        /// First entry whose key is in the joined args wins.
        stdout: Vec<(&'static str, &'static str)>,
    }

    impl Az for FakeAz {
        fn run(&self, args: &[String], stdin: Option<&str>) -> Result<String> {
            let joined = args.join(" ");
            self.calls
                .lock()
                .unwrap()
                .push((args.to_vec(), stdin.map(str::to_string)));
            if self.fail_on.iter().any(|f| joined.contains(f)) {
                return Err(az_error(self.stderr));
            }
            Ok(self
                .stdout
                .iter()
                .find(|(k, _)| joined.contains(k))
                .map_or("", |(_, v)| v)
                .to_string())
        }
    }

    impl FakeAz {
        /// Bodies sent to `uri`s containing `part` with `method`.
        fn bodies(&self, method: &str, part: &str) -> Vec<Value> {
            self.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|(a, _)| a.get(2).is_some_and(|m| m == method))
                .filter(|(a, _)| a.get(4).is_some_and(|u| u.contains(part)))
                .filter_map(|(_, b)| b.as_deref().map(|b| serde_json::from_str(b).unwrap()))
                .collect()
        }
    }

    fn vars() -> Vec<(String, String)> {
        vec![
            ("API_KEY".into(), "s3cr3t-value".into()),
            ("DB".into(), "Server=x;Password=hunter2".into()),
            (
                "ConnectionStrings__Main".into(),
                "Server=y;Password=pw2".into(),
            ),
            ("EMPTY".into(), "".into()),
            ("START".into(), "node server.js".into()),
            ("ALWAYS_ON".into(), "true".into()),
            ("IMAGE".into(), "acme.azurecr.io/shop:1.2".into()),
            ("REG_PW".into(), "registry-pw".into()),
            ("REPO".into(), "https://github.com/acme/shop".into()),
            ("BRANCH".into(), "main".into()),
        ]
    }

    fn app(key: &str) -> PushItem {
        PushItem {
            key: key.into(),
            dest: Dest::AppSetting,
            name: None,
            field: None,
            conn_type: None,
            slot_setting: false,
        }
    }

    fn fld(key: &str, id: &str) -> PushItem {
        PushItem {
            dest: Dest::Field,
            field: Some(id.into()),
            ..app(key)
        }
    }

    const EXISTING_APP: &str = r#"{"properties":{"EXISTING":"keep-me","API_KEY":"old"}}"#;

    #[test]
    fn push_merges_app_settings_and_sends_values_only_on_stdin() {
        let az = FakeAz {
            stdout: vec![("appsettings/list", EXISTING_APP)],
            ..Default::default()
        };
        let items = [
            app("API_KEY"),
            app("EMPTY"),
            fld("REG_PW", "registryPassword"),
            app("NOT_IN_FILE"),
            PushItem {
                name: Some("bad name".into()),
                ..app("API_KEY")
            },
        ];
        let results = push(&az, &site(), Some("staging"), &vars(), &items).unwrap();
        let ok: Vec<_> = results.iter().map(|r| r.error.is_none()).collect();
        assert_eq!(ok, [true, true, true, false, false]);

        let puts = az.bodies("put", "/slots/staging/config/appsettings");
        assert_eq!(puts.len(), 1, "one request for all app settings");
        assert_eq!(
            puts[0]["properties"],
            json!({
                "EXISTING": "keep-me",
                "API_KEY": "s3cr3t-value",
                "EMPTY": "",
                "DOCKER_REGISTRY_SERVER_PASSWORD": "registry-pw",
            })
        );
        for (a, _) in az.calls.lock().unwrap().iter() {
            let joined = a.join(" ");
            for (_, v) in vars().iter().filter(|(_, v)| !v.is_empty()) {
                assert!(!joined.contains(v.as_str()), "{joined}");
            }
            assert!(!joined.contains("keep-me"));
        }
    }

    #[test]
    fn push_sets_connection_strings_and_slot_settings() {
        let az = FakeAz {
            stdout: vec![
                (
                    "connectionstrings/list",
                    r#"{"properties":{"Other":{"value":"v","type":"Custom"}}}"#,
                ),
                (
                    "slotConfigNames",
                    r#"{"properties":{"appSettingNames":["X"],"connectionStringNames":null,"azureStorageConfigNames":["s"]}}"#,
                ),
                ("appsettings/list", EXISTING_APP),
            ],
            ..Default::default()
        };
        let items = [
            PushItem {
                dest: Dest::ConnectionString,
                conn_type: Some("sqlazure".into()),
                slot_setting: true,
                ..app("DB")
            },
            PushItem {
                dest: Dest::ConnectionString,
                name: Some("Main".into()),
                ..app("ConnectionStrings__Main")
            },
            PushItem {
                slot_setting: true,
                ..app("API_KEY")
            },
            PushItem {
                dest: Dest::ConnectionString,
                conn_type: Some("Oracle".into()),
                ..app("DB")
            },
        ];
        let results = push(&az, &site(), Some("staging"), &vars(), &items).unwrap();
        assert!(
            results[..3].iter().all(|r| r.error.is_none()),
            "{results:?}"
        );
        assert!(results[3].error.as_deref().unwrap().contains("type"));

        let conn = &az.bodies("put", "/config/connectionstrings")[0]["properties"];
        assert_eq!(conn["Other"], json!({"value": "v", "type": "Custom"}));
        assert_eq!(
            conn["DB"],
            json!({"value": "Server=x;Password=hunter2", "type": "SQLAzure"})
        );
        assert_eq!(conn["Main"]["type"], "Custom");

        // Slot settings live on the production site and are merged, not replaced.
        let sticky = az.bodies("put", "/sites/shop-api/config/slotConfigNames");
        assert_eq!(sticky.len(), 1);
        assert_eq!(
            sticky[0]["properties"]["appSettingNames"],
            json!(["X", "API_KEY"])
        );
        assert_eq!(
            sticky[0]["properties"]["connectionStringNames"],
            json!(["DB"])
        );
        assert_eq!(
            sticky[0]["properties"]["azureStorageConfigNames"],
            json!(["s"])
        );
    }

    #[test]
    fn push_patches_site_config_and_checks_containers_need_linux() {
        let az = FakeAz {
            stdout: vec![("--method get", r#"{"kind":"app,linux"}"#)],
            ..Default::default()
        };
        let items = [
            fld("START", "startupCommand"),
            fld("ALWAYS_ON", "alwaysOn"),
            fld("IMAGE", "containerImage"),
            fld("START", "alwaysOn"),
            fld("API_KEY", "nope"),
        ];
        let results = push(&az, &site(), None, &vars(), &items).unwrap();
        let ok: Vec<_> = results.iter().map(|r| r.error.is_none()).collect();
        // The 4th reuses alwaysOn: the duplicate is refused before its value is even checked.
        assert_eq!(ok, [true, true, true, false, false]);
        let patch = az.bodies("patch", "/config/web");
        assert_eq!(
            patch[0]["properties"],
            json!({
                "appCommandLine": "node server.js",
                "alwaysOn": true,
                "linuxFxVersion": "DOCKER|acme.azurecr.io/shop:1.2",
            })
        );

        let windows = FakeAz {
            stdout: vec![("--method get", r#"{"kind":"app"}"#)],
            ..Default::default()
        };
        let results = push(
            &windows,
            &site(),
            None,
            &vars(),
            &[
                fld("IMAGE", "containerImage"),
                fld("START", "startupCommand"),
            ],
        )
        .unwrap();
        assert!(results[0].error.as_deref().unwrap().contains("Linux"));
        assert!(results[1].error.is_none());
    }

    #[test]
    fn duplicate_targets_are_refused() {
        let az = FakeAz::default();
        let results = push(
            &az,
            &site(),
            None,
            &vars(),
            &[
                fld("START", "runtimeStack"),
                fld("IMAGE", "containerImage"),
                fld("REG_PW", "registryPassword"),
                PushItem {
                    name: Some("DOCKER_REGISTRY_SERVER_PASSWORD".into()),
                    ..app("API_KEY")
                },
            ],
        )
        .unwrap();
        let ok: Vec<_> = results.iter().map(|r| r.error.is_none()).collect();
        assert_eq!(ok, [true, false, true, false]);
    }

    #[test]
    fn push_merges_source_control() {
        let az = FakeAz {
            stdout: vec![(
                "sourcecontrols",
                r#"{"properties":{"repoUrl":"https://old","branch":"dev","isManualIntegration":false}}"#,
            )],
            ..Default::default()
        };
        let results = push(&az, &site(), None, &vars(), &[fld("BRANCH", "branch")]).unwrap();
        assert!(results[0].error.is_none());
        assert_eq!(
            az.bodies("put", "/sourcecontrols/web")[0]["properties"],
            json!({"repoUrl": "https://old", "branch": "main", "isManualIntegration": false})
        );

        // No source yet: a branch alone isn't enough.
        let none = FakeAz {
            fail_on: vec!["--method get"],
            stderr: "(ResourceNotFound) The Resource was not found.",
            ..Default::default()
        };
        let results = push(&none, &site(), None, &vars(), &[fld("BRANCH", "branch")]).unwrap();
        assert!(
            results[0]
                .error
                .as_deref()
                .unwrap()
                .contains("repository URL")
        );
        let results = push(
            &none,
            &site(),
            None,
            &vars(),
            &[fld("REPO", "repoUrl"), fld("BRANCH", "branch")],
        )
        .unwrap();
        assert!(results.iter().all(|r| r.error.is_none()));
        assert_eq!(
            none.bodies("put", "/sourcecontrols/web")[0]["properties"],
            json!({"repoUrl": "https://github.com/acme/shop", "branch": "main", "isManualIntegration": true})
        );
    }

    #[test]
    fn without_an_az_login_push_and_inspect_stop() {
        let az = FakeAz {
            fail_on: vec!["rest", "account"],
            stderr: "ERROR: AADSTS700082: The refresh token has expired. Please run 'az login' to setup account.",
            ..Default::default()
        };
        let err = push(&az, &site(), None, &vars(), &[app("API_KEY"), app("DB")]).unwrap_err();
        assert!(err.to_string().starts_with("AZ_AUTH: "), "{err}");
        assert!(err.to_string().contains("az login"));
        assert_eq!(
            az.calls.lock().unwrap().len(),
            1,
            "stops at the first failure"
        );
        assert!(matches!(inspect(&az, &site(), None), Err(Error::AzAuth(_))));
        assert!(matches!(account(&az), Err(Error::AzAuth(_))));

        let az = FakeAz {
            fail_on: vec!["--method put"],
            stderr: "(AuthorizationFailed) The client 'x' does not have authorization to perform action",
            ..Default::default()
        };
        let results = push(&az, &site(), None, &vars(), &[app("API_KEY")]).unwrap();
        assert!(
            results[0]
                .error
                .as_deref()
                .unwrap()
                .contains("Website Contributor")
        );
    }

    #[test]
    fn classifies_az_failures() {
        let auth = |s: &str| matches!(az_error(s), Error::AzAuth(_));
        assert!(auth("ERROR: Please run 'az login' to setup account."));
        assert!(auth(
            "AADSTS50076: Due to a configuration change made by your administrator"
        ));
        assert!(auth(
            "Interactive authentication is needed. Please run:\naz login"
        ));
        assert!(!auth("(ResourceNotFound) The Resource 'x' was not found."));
        assert!(matches!(az_error(""), Error::Az(m) if m == "az failed"));
    }

    #[test]
    fn account_lists_enabled_subscriptions_default_first() {
        let az = FakeAz {
            stdout: vec![
                (
                    "account show",
                    r#"{"id":"x","user":{"name":"dev@contoso.com","type":"user"}}"#,
                ),
                (
                    "account list",
                    r#"[
                    {"id":"11111111-1111-1111-1111-111111111111","name":"B sub","isDefault":false,"state":"Enabled"},
                    {"id":"22222222-2222-2222-2222-222222222222","name":"Old","isDefault":false,"state":"Disabled"},
                    {"id":"33333333-3333-3333-3333-333333333333","name":"Z sub","isDefault":true,"state":"Enabled"}
                ]"#,
                ),
            ],
            ..Default::default()
        };
        let acct = account(&az).unwrap();
        assert_eq!(acct.user, "dev@contoso.com");
        let names: Vec<_> = acct.subscriptions.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["Z sub", "B sub"]);
        // Signed out but with output: still AZ_AUTH.
        let empty = FakeAz {
            stdout: vec![("account show", "{}")],
            ..Default::default()
        };
        assert!(matches!(account(&empty), Err(Error::AzAuth(_))));
    }

    #[test]
    fn lists_sites_and_slots() {
        let az = FakeAz {
            stdout: vec![
                (
                    "resource list",
                    r#"[
                    {"id":"/subscriptions/0b1f6471-1bf0-4dda-aec3-111122223333/resourceGroups/shop-rg/providers/Microsoft.Web/sites/shop-web","name":"shop-web","resourceGroup":"shop-rg","kind":"app,linux","location":"westeurope"},
                    {"id":"/subscriptions/0b1f6471-1bf0-4dda-aec3-111122223333/resourceGroups/shop-rg/providers/Microsoft.Web/sites/api","name":"api","resourceGroup":"shop-rg","kind":"functionapp","location":"westeurope"},
                    {"id":"/weird","name":"x"}
                ]"#,
                ),
                (
                    "/slots",
                    r#"{"value":[{"name":"shop-api/staging"},{"name":"shop-api/canary"}]}"#,
                ),
            ],
            ..Default::default()
        };
        let sites = list_sites(&az, SUB).unwrap();
        let names: Vec<_> = sites.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["api", "shop-web"]);
        assert!(list_sites(&az, "not-a-guid; rm -rf").is_err());
        assert_eq!(list_slots(&az, &site()).unwrap(), ["canary", "staging"]);
    }

    #[test]
    fn inspect_returns_names_only() {
        let az = FakeAz {
            fail_on: vec!["connectionstrings/list"],
            stderr: "(Conflict) something odd",
            stdout: vec![
                ("appsettings/list", EXISTING_APP),
                (
                    "slotConfigNames",
                    r#"{"properties":{"appSettingNames":["EXISTING"]}}"#,
                ),
                ("--method get", r#"{"kind":"app,linux"}"#),
            ],
            ..Default::default()
        };
        let state = inspect(&az, &site(), Some("staging")).unwrap();
        assert!(state.linux);
        assert_eq!(state.app_settings, ["API_KEY", "EXISTING"]);
        assert_eq!(state.sticky_app_settings, ["EXISTING"]);
        assert_eq!(state.warnings.len(), 1);
        let json = serde_json::to_string(&state).unwrap();
        assert!(!json.contains("keep-me") && !json.contains("old"), "{json}");
    }

    #[test]
    fn portal_urls_are_built_in_rust() {
        assert_eq!(
            portal_url(&site(), Some("staging"), "deploymentCenter").unwrap(),
            format!(
                "https://portal.azure.com/#resource/subscriptions/{SUB}/resourceGroups/shop-rg/providers/Microsoft.Web/sites/shop-api/slots/staging/vstscd"
            )
        );
        assert!(portal_url(&site(), None, "https://evil.example").is_err());
    }
}
