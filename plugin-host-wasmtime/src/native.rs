//! Native Rust implementations of the 6 chatty `zinc:plugin/*` import families:
//! `log`, `prefs` (read-only cache subset), `timers`, `l10n`, `app`, and `util`.
use crate::crypto;
use crate::fluent::{self, FluentArg, FormatCtx, Resource};
use crate::host::{now_epoch, Host, TIMEOUT_MARK, UNLOADED_MARK};
use crate::state::{Out, St};
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::watch;
use tokio::task::AbortHandle;
use wasmtime::component::Val;
use wasmtime::{bail, format_err as anyhow, Result, StoreContextMut};

pub const NATIVE_FAMILIES: &[&str] = &["log", "prefs", "timers", "l10n", "app", "util"];

pub const APP_PREF_ALLOWLIST: &[&str] = &[
    "ui.locale",
    "ui.theme.mode",
    "ui.theme.palette",
    "shell.reader.zoom",
    "shell.reader.sidebar",
    "shell.reader.pages",
    "shell.reader.scrollMode",
    "shell.reader.spreadMode",
    "general.attachPdfs",
    "general.autoTag",
    "extensions.zotero.autoRenameFiles",
    "export.quickCopy.setting",
];

/// Returns true ONLY for `(short_iface, kebab_fn)` pairs that have a native Rust implementation.
/// Notably `prefs.set`, `set-many`, `clear`, `reset`, `observe`, `unobserve` return `false` so they
/// are always forwarded to Zinc even when `"prefs"` is enabled in `--native` / `init.native`.
pub fn has_native_impl(short_iface: &str, fname: &str) -> bool {
    match short_iface {
        "log" => matches!(fname, "write" | "write-error" | "debug-enabled"),
        "prefs" => matches!(fname, "get" | "get-all" | "has-user-value" | "get-app"),
        "timers" => matches!(
            fname,
            "now" | "monotonic-ms" | "sleep" | "set-timeout" | "set-interval" | "request-idle" | "clear"
        ),
        "l10n" => matches!(
            fname,
            "format" | "format-many" | "has-message" | "locale" | "plugin-locales" | "format-date" | "format-number"
        ),
        "app" => matches!(fname, "get-info" | "is-ui-ready" | "wait-ui-ready" | "main-windows" | "active-window"),
        "util" => matches!(
            fname,
            "random-bytes"
                | "uuid-v4"
                | "hash"
                | "semver-compare"
                | "clean-doi"
                | "clean-isbn"
                | "clean-issn"
                | "html-to-text"
                | "text-to-html"
                | "capitalize-title"
        ),
        _ => false,
    }
}

pub fn epoch_ms_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn monotonic_ms_now() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

fn wit_err(tag: &str, msg: impl Into<String>) -> Val {
    Val::Result(Err(Some(Box::new(Val::Variant(tag.to_string(), Some(Box::new(Val::String(msg.into()))))))))
}

// =====================================================================================================================
// 1. LOG (`zinc:plugin/log`)
// =====================================================================================================================

const MAX_LOG_LINE_BYTES: usize = 8 * 1024;
const MAX_LOG_LINES_PER_SEC: u32 = 200;
const LOG_BATCH_FLUSH_SIZE: usize = 64;

fn truncate_log_line(s: &str) -> String {
    if s.len() <= MAX_LOG_LINE_BYTES {
        return s.to_string();
    }
    let mut end = MAX_LOG_LINE_BYTES;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}... [truncated]", &s[..end])
}

struct LogInner {
    entries: Vec<Value>,
    rate: HashMap<String, (Instant, u32)>,
    dropped: HashMap<String, u64>,
}

pub struct LogManager {
    pub debug_enabled: AtomicBool,
    out: Out,
    inner: Mutex<LogInner>,
}

impl LogManager {
    pub fn new(out: Out) -> Self {
        Self {
            debug_enabled: AtomicBool::new(false),
            out,
            inner: Mutex::new(LogInner {
                entries: Vec::new(),
                rate: HashMap::new(),
                dropped: HashMap::new(),
            }),
        }
    }

    pub fn set_debug_enabled(&self, enabled: bool) {
        self.debug_enabled.store(enabled, Ordering::Relaxed);
    }

    fn accept_rate(inner: &mut LogInner, plugin: &str) -> bool {
        let now = Instant::now();
        let entry = inner.rate.entry(plugin.to_string()).or_insert((now, 0));
        if now.duration_since(entry.0) >= Duration::from_secs(1) {
            *entry = (now, 0);
        }
        entry.1 += 1;
        if entry.1 > MAX_LOG_LINES_PER_SEC {
            *inner.dropped.entry(plugin.to_string()).or_insert(0) += 1;
            return false;
        }
        true
    }

    pub fn write(&self, plugin: &str, raw_level: &str, message: &str) {
        let level = match raw_level {
            "error" | "warn" | "info" | "debug" => raw_level,
            _ => "info",
        };
        if level == "debug" && !self.debug_enabled.load(Ordering::Relaxed) {
            return;
        }
        let mut to_flush = None;
        {
            let mut inner = self.inner.lock().unwrap();
            if !Self::accept_rate(&mut inner, plugin) {
                return;
            }
            let text = truncate_log_line(message);
            let mut obj = Map::new();
            obj.insert("plugin".into(), Value::String(plugin.to_string()));
            obj.insert("level".into(), Value::String(level.to_string()));
            obj.insert("message".into(), Value::String(text));
            if level == "error" {
                obj.insert("isError".into(), Value::Bool(true));
            }
            if let Some(d) = inner.dropped.remove(plugin) {
                if d > 0 {
                    obj.insert("dropped".into(), json!(d));
                }
            }
            inner.entries.push(Value::Object(obj));
            if inner.entries.len() >= LOG_BATCH_FLUSH_SIZE {
                to_flush = Some(std::mem::take(&mut inner.entries));
            }
        }
        if let Some(batch) = to_flush {
            self.out.send(json!({ "t": "log-batch", "entries": batch }));
        }
    }

    pub fn write_error(&self, plugin: &str, message: &str, stack: Option<&str>) {
        let mut to_flush = None;
        {
            let mut inner = self.inner.lock().unwrap();
            if !Self::accept_rate(&mut inner, plugin) {
                return;
            }
            let combined = match stack {
                Some(st) if !st.is_empty() => format!("{message}\n{st}"),
                _ => message.to_string(),
            };
            let text = truncate_log_line(&combined);
            let mut obj = Map::new();
            obj.insert("plugin".into(), Value::String(plugin.to_string()));
            obj.insert("level".into(), Value::String("error".into()));
            obj.insert("message".into(), Value::String(text));
            obj.insert("isError".into(), Value::Bool(true));
            if let Some(st) = stack {
                obj.insert("stack".into(), Value::String(truncate_log_line(st)));
            }
            if let Some(d) = inner.dropped.remove(plugin) {
                if d > 0 {
                    obj.insert("dropped".into(), json!(d));
                }
            }
            inner.entries.push(Value::Object(obj));
            if inner.entries.len() >= LOG_BATCH_FLUSH_SIZE {
                to_flush = Some(std::mem::take(&mut inner.entries));
            }
        }
        if let Some(batch) = to_flush {
            self.out.send(json!({ "t": "log-batch", "entries": batch }));
        }
    }

    pub fn flush(&self) {
        let batch = {
            let mut inner = self.inner.lock().unwrap();
            if inner.entries.is_empty() {
                None
            } else {
                Some(std::mem::take(&mut inner.entries))
            }
        };
        if let Some(entries) = batch {
            self.out.send(json!({ "t": "log-batch", "entries": entries }));
        }
    }

    pub fn clear_plugin(&self, plugin: &str) {
        let mut inner = self.inner.lock().unwrap();
        inner.rate.remove(plugin);
        inner.dropped.remove(plugin);
    }
}

// =====================================================================================================================
// 2. PREFS (`zinc:plugin/prefs` read subset)
// =====================================================================================================================

#[derive(Clone, Debug, PartialEq)]
pub enum PrefVal {
    Flag(bool),
    Int(i32),
    Text(String),
}

impl PrefVal {
    pub fn from_json(v: &Value) -> Option<Self> {
        match v {
            Value::Bool(b) => Some(Self::Flag(*b)),
            Value::Number(n) => {
                let i = n.as_i64()?;
                if i >= i32::MIN as i64 && i <= i32::MAX as i64 {
                    Some(Self::Int(i as i32))
                } else {
                    None
                }
            }
            Value::String(s) => Some(Self::Text(s.clone())),
            Value::Object(o) => match (o.get("tag").and_then(Value::as_str), o.get("val")) {
                (Some("flag"), Some(Value::Bool(b))) => Some(Self::Flag(*b)),
                (Some("integer"), Some(Value::Number(n))) => n.as_i64().map(|i| Self::Int(i as i32)),
                (Some("text"), Some(Value::String(s))) => Some(Self::Text(s.clone())),
                _ => None,
            },
            _ => None,
        }
    }

    pub fn to_val(&self) -> Val {
        match self {
            Self::Flag(b) => Val::Variant("flag".into(), Some(Box::new(Val::Bool(*b)))),
            Self::Int(n) => Val::Variant("integer".into(), Some(Box::new(Val::S32(*n)))),
            Self::Text(s) => Val::Variant("text".into(), Some(Box::new(Val::String(s.clone())))),
        }
    }
}

#[derive(Default)]
struct PluginPrefs {
    defaults: HashMap<String, PrefVal>,
    user: HashMap<String, PrefVal>,
    secrets: HashSet<String>,
}

#[derive(Default)]
struct PrefsInner {
    plugins: HashMap<String, PluginPrefs>,
    app_prefs: HashMap<String, PrefVal>,
}

#[derive(Default)]
pub struct PrefsManager {
    inner: Mutex<PrefsInner>,
}

fn parse_pref_map(obj: &Map<String, Value>) -> HashMap<String, PrefVal> {
    let mut out = HashMap::with_capacity(obj.len());
    for (k, v) in obj {
        if let Some(pv) = PrefVal::from_json(v) {
            out.insert(k.clone(), pv);
        }
    }
    out
}

impl PrefsManager {
    pub fn on_load(&self, plugin: &str, manifest: &Value, spec_prefs: Option<&Value>) {
        let mut inner = self.inner.lock().unwrap();
        let entry = inner.plugins.entry(plugin.to_string()).or_default();
        if let Some(def_obj) = manifest.get("default_prefs").and_then(Value::as_object) {
            entry.defaults = parse_pref_map(def_obj);
        }
        if let Some(p) = spec_prefs.and_then(Value::as_object) {
            if let Some(d) = p.get("defaults").and_then(Value::as_object) {
                entry.defaults = parse_pref_map(d);
            }
            if let Some(u) = p.get("user").and_then(Value::as_object) {
                entry.user = parse_pref_map(u);
            }
            if let Some(s) = p.get("secrets").and_then(Value::as_array) {
                entry.secrets = s.iter().filter_map(Value::as_str).map(str::to_string).collect();
            }
        }
    }

    pub fn on_push(&self, msg: &Value) {
        let mut inner = self.inner.lock().unwrap();
        // Every `appPrefs` push is the whole set of allowlisted settings that currently have a value, so a setting left out
        // has been cleared and must not stay readable.
        if let Some(app_obj) = msg.get("appPrefs").and_then(Value::as_object) {
            inner.app_prefs = parse_pref_map(app_obj);
        }
        if let Some(pid) = msg.get("plugin").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            let entry = inner.plugins.entry(pid.to_string()).or_default();
            if let Some(d) = msg.get("defaults").and_then(Value::as_object) {
                entry.defaults = parse_pref_map(d);
            }
            if let Some(u) = msg.get("user").and_then(Value::as_object) {
                entry.user = parse_pref_map(u);
            }
            if let Some(s) = msg.get("secrets").and_then(Value::as_array) {
                entry.secrets = s.iter().filter_map(Value::as_str).map(str::to_string).collect();
            }
        }
    }

    pub fn remove_plugin(&self, plugin: &str) {
        self.inner.lock().unwrap().plugins.remove(plugin);
    }

    pub fn get(&self, plugin: &str, key: &str) -> Option<PrefVal> {
        let inner = self.inner.lock().unwrap();
        let p = inner.plugins.get(plugin)?;
        if p.secrets.contains(key) {
            return None;
        }
        p.user.get(key).or_else(|| p.defaults.get(key)).cloned()
    }

    pub fn has_user_value(&self, plugin: &str, key: &str) -> bool {
        let inner = self.inner.lock().unwrap();
        inner
            .plugins
            .get(plugin)
            .is_some_and(|p| !p.secrets.contains(key) && p.user.contains_key(key))
    }

    pub fn get_all(&self, plugin: &str, prefix: Option<&str>) -> Vec<Val> {
        let inner = self.inner.lock().unwrap();
        let Some(p) = inner.plugins.get(plugin) else {
            return Vec::new();
        };
        let mut keys: BTreeSet<&str> = BTreeSet::new();
        for k in p.defaults.keys().chain(p.user.keys()) {
            if !p.secrets.contains(k) && prefix.is_none_or(|pfx| k.starts_with(pfx)) {
                keys.insert(k.as_str());
            }
        }
        let mut out = Vec::with_capacity(keys.len());
        for k in keys {
            let (val, user_set) = match p.user.get(k) {
                Some(v) => (v, true),
                None => (&p.defaults[k], false),
            };
            out.push(Val::Record(vec![
                ("key".into(), Val::String(k.to_string())),
                ("value".into(), val.to_val()),
                ("user-set".into(), Val::Bool(user_set)),
            ]));
        }
        out
    }

    pub fn get_app(&self, key: &str, has_perm: bool) -> Val {
        if !has_perm {
            return wit_err("permission-denied", "prefs.app-read");
        }
        if !APP_PREF_ALLOWLIST.contains(&key) {
            return wit_err("not-found", format!("\"{key}\" is not a Zinc setting that plugins can read"));
        }
        let inner = self.inner.lock().unwrap();
        let opt = inner.app_prefs.get(key).map(|pv| Box::new(pv.to_val()));
        Val::Result(Ok(Some(Box::new(Val::Option(opt)))))
    }
}

// =====================================================================================================================
// 3. APP (`zinc:plugin/app`)
// =====================================================================================================================

#[derive(Clone, Debug)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub api_version: String,
    pub zotero_version: String,
    pub platform: String,
    pub arch: String,
    pub locale: String,
    pub time_zone: String,
    pub dev_build: bool,
    pub features: Vec<String>,
}

impl Default for AppInfo {
    fn default() -> Self {
        let platform = match std::env::consts::OS {
            "windows" => "windows",
            "macos" => "macos",
            _ => "linux",
        };
        let arch = if std::env::consts::ARCH == "aarch64" { "aarch64" } else { "x86_64" };
        Self {
            name: "Zinc".into(),
            version: "0.1.0".into(),
            api_version: "0.1.0".into(),
            zotero_version: "10.0.0".into(),
            platform: platform.into(),
            arch: arch.into(),
            locale: "en-US".into(),
            time_zone: "UTC".into(),
            dev_build: false,
            features: Vec::new(),
        }
    }
}

impl AppInfo {
    pub fn to_val(&self) -> Val {
        let platform = match self.platform.as_str() {
            "windows" | "macos" | "linux" => self.platform.clone(),
            _ => "linux".into(),
        };
        Val::Record(vec![
            ("name".into(), Val::String(self.name.clone())),
            ("version".into(), Val::String(self.version.clone())),
            ("api-version".into(), Val::String(self.api_version.clone())),
            ("zotero-version".into(), Val::String(self.zotero_version.clone())),
            ("platform".into(), Val::Enum(platform)),
            ("arch".into(), Val::String(self.arch.clone())),
            ("locale".into(), Val::String(self.locale.clone())),
            ("time-zone".into(), Val::String(self.time_zone.clone())),
            ("dev-build".into(), Val::Bool(self.dev_build)),
            (
                "features".into(),
                Val::List(self.features.iter().cloned().map(Val::String).collect()),
            ),
        ])
    }
}

struct AppInner {
    info: AppInfo,
    main_windows: Vec<u32>,
    active_window: Option<u32>,
}

pub struct AppManager {
    inner: Mutex<AppInner>,
    pub windows_hidden: AtomicBool,
    ui_ready_tx: watch::Sender<bool>,
    ui_ready_rx: watch::Receiver<bool>,
}

impl Default for AppManager {
    fn default() -> Self {
        let (ui_ready_tx, ui_ready_rx) = watch::channel(true);
        Self {
            inner: Mutex::new(AppInner {
                info: AppInfo::default(),
                main_windows: Vec::new(),
                active_window: None,
            }),
            windows_hidden: AtomicBool::new(false),
            ui_ready_tx,
            ui_ready_rx,
        }
    }
}

impl AppManager {
    pub fn on_push(&self, msg: &Value, l10n: &L10nManager) {
        let mut sync_locale: Option<String> = None;
        let mut sync_tz: Option<String> = None;
        {
            let mut inner = self.inner.lock().unwrap();
            if let Some(info) = msg.get("info").and_then(Value::as_object) {
                if let Some(s) = info.get("name").and_then(Value::as_str) {
                    inner.info.name = s.to_string();
                }
                if let Some(s) = info.get("version").and_then(Value::as_str) {
                    inner.info.version = s.to_string();
                }
                if let Some(s) = info.get("apiVersion").or_else(|| info.get("api-version")).and_then(Value::as_str) {
                    inner.info.api_version = s.to_string();
                }
                if let Some(s) = info.get("zoteroVersion").or_else(|| info.get("zotero-version")).and_then(Value::as_str) {
                    inner.info.zotero_version = s.to_string();
                }
                if let Some(s) = info.get("platform").and_then(Value::as_str) {
                    inner.info.platform = s.to_string();
                }
                if let Some(s) = info.get("arch").and_then(Value::as_str) {
                    inner.info.arch = s.to_string();
                }
                if let Some(s) = info.get("locale").and_then(Value::as_str) {
                    inner.info.locale = s.to_string();
                    sync_locale = Some(s.to_string());
                }
                if let Some(s) = info.get("timeZone").or_else(|| info.get("time-zone")).and_then(Value::as_str) {
                    inner.info.time_zone = s.to_string();
                    sync_tz = Some(s.to_string());
                }
                if let Some(b) = info.get("devBuild").or_else(|| info.get("dev-build")).and_then(Value::as_bool) {
                    inner.info.dev_build = b;
                }
                if let Some(arr) = info.get("features").and_then(Value::as_array) {
                    inner.info.features = arr.iter().filter_map(Value::as_str).map(str::to_string).collect();
                }
            }
            if let Some(mw) = msg.get("mainWindows").and_then(Value::as_array) {
                inner.main_windows = mw.iter().filter_map(|v| v.as_u64().map(|n| n as u32)).collect();
            }
            if let Some(aw) = msg.get("activeWindow") {
                inner.active_window = aw.as_u64().map(|n| n as u32);
            }
        }
        if let Some(r) = msg.get("isUiReady").and_then(Value::as_bool) {
            let _ = self.ui_ready_tx.send(r);
        }
        if let Some(wh) = msg.get("windowsHidden").and_then(Value::as_bool) {
            self.windows_hidden.store(wh, Ordering::Relaxed);
        }
        if sync_locale.is_some() || sync_tz.is_some() {
            l10n.sync_global(sync_locale.as_deref(), sync_tz.as_deref());
        }
    }

    pub fn sync_locale_tz(&self, locale: Option<&str>, tz: Option<&str>) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(l) = locale {
            inner.info.locale = l.to_string();
        }
        if let Some(t) = tz {
            inner.info.time_zone = t.to_string();
        }
    }

    pub fn get_info_val(&self) -> Val {
        self.inner.lock().unwrap().info.to_val()
    }

    pub fn is_ui_ready(&self) -> bool {
        *self.ui_ready_rx.borrow()
    }

    pub fn ui_ready_receiver(&self) -> watch::Receiver<bool> {
        self.ui_ready_rx.clone()
    }

    pub fn main_windows_val(&self) -> Val {
        let inner = self.inner.lock().unwrap();
        Val::List(inner.main_windows.iter().copied().map(Val::U32).collect())
    }

    pub fn active_window_val(&self) -> Val {
        let inner = self.inner.lock().unwrap();
        Val::Option(inner.active_window.map(|w| Box::new(Val::U32(w))))
    }
}

// =====================================================================================================================
// 4. L10N (`zinc:plugin/l10n`)
// =====================================================================================================================

#[derive(Clone)]
struct Bundle {
    tag: String,
    res: Resource,
}

struct PluginL10n {
    dir: PathBuf,
    locales_dir: String,
    default_locale: Option<String>,
    available_hint: Option<Vec<String>>,
    bundles: Option<Vec<Bundle>>,
    warned: HashSet<String>,
}

struct L10nInner {
    locale: String,
    time_zone: String,
    plugins: HashMap<String, PluginL10n>,
}

pub struct L10nManager {
    inner: Mutex<L10nInner>,
}

impl Default for L10nManager {
    fn default() -> Self {
        Self {
            inner: Mutex::new(L10nInner {
                locale: "en-US".into(),
                time_zone: "UTC".into(),
                plugins: HashMap::new(),
            }),
        }
    }
}

/// A folder name taken from a plugin manifest (`locales.dir`): relative, made of plain names only. No drive, root, UNC or
/// stream syntax and no `..`, so joining it onto the package folder stays inside the package.
fn is_plain_relative_path(p: &str) -> bool {
    !p.is_empty()
        && !p.contains(['\0', ':'])
        && !p.starts_with(['/', '\\'])
        && p.split(['/', '\\']).all(|seg| seg != "..")
}

/// A locale tag: BCP 47 shaped, like `en`, `pt-BR` or `zh-Hans-CN`. It becomes one folder name, so it can hold no separator.
fn is_locale_tag(tag: &str) -> bool {
    let mut parts = tag.split('-');
    let Some(lang) = parts.next() else { return false };
    (2..=8).contains(&lang.len())
        && lang.bytes().all(|b| b.is_ascii_alphabetic())
        && parts.all(|p| (1..=8).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_alphanumeric()))
}

/// Reads `<dir>/<locales_dir>/<tag>/*.ftl` for every tag (`available`, or every folder found). A `locales_dir` or tag that is
/// not a plain name, or that resolves (links included) outside the package folder, is refused with a warning and nothing under
/// it is opened.
fn read_bundles(dir: &std::path::Path, locales_dir: &str, available: Option<&[String]>, warn: &mut dyn FnMut(String)) -> Vec<Bundle> {
    if !is_plain_relative_path(locales_dir) {
        warn(format!("[l10n] locales.dir {locales_dir:?} must be a relative folder inside the package; no strings were loaded"));
        return Vec::new();
    }
    let Ok(root) = dir.canonicalize() else { return Vec::new() };
    let Ok(base) = dir.join(locales_dir).canonicalize() else { return Vec::new() };
    if !base.starts_with(&root) {
        warn(format!("[l10n] locales.dir {locales_dir:?} leads outside the package; no strings were loaded"));
        return Vec::new();
    }
    let tags: Vec<String> = match available {
        Some(avail) => avail.to_vec(),
        None => match std::fs::read_dir(&base) {
            Ok(rd) => {
                let mut v: Vec<String> = rd
                    .filter_map(|e| e.ok())
                    .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                    .filter_map(|e| e.file_name().into_string().ok())
                    .collect();
                v.sort();
                v
            }
            Err(_) => Vec::new(),
        },
    };
    let mut all = Vec::new();
    for tag in tags {
        if !is_locale_tag(&tag) {
            warn(format!("[l10n] {tag:?} is not a locale tag and was skipped"));
            continue;
        }
        let Ok(d) = base.join(&tag).canonicalize() else { continue };
        if !d.starts_with(&base) || !d.is_dir() {
            continue;
        }
        let mut files: Vec<PathBuf> = std::fs::read_dir(&d)
            .ok()
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok().map(|x| x.path()))
            .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("ftl"))
            .collect();
        files.sort();
        let mut merged = Resource::default();
        for f in files {
            // A link to a file elsewhere is not read.
            if !f.canonicalize().is_ok_and(|c| c.starts_with(&d)) {
                continue;
            }
            if let Ok(src) = std::fs::read_to_string(&f) {
                let r = fluent::parse_fluent(&src);
                let fname = f.file_name().and_then(|s| s.to_str()).unwrap_or("?.ftl");
                for err in &r.errors {
                    warn(format!("[l10n] {tag}/{fname}: {err}"));
                }
                merged.messages.extend(r.messages);
                merged.terms.extend(r.terms);
            }
        }
        all.push(Bundle { tag, res: merged });
    }
    all
}

impl L10nManager {
    pub fn sync_global(&self, locale: Option<&str>, tz: Option<&str>) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(l) = locale {
            inner.locale = l.to_string();
        }
        if let Some(t) = tz {
            inner.time_zone = t.to_string();
        }
    }

    fn parse_pushed_bundles(arr: &[Value], plugin: &str, logs: &LogManager) -> Vec<Bundle> {
        let mut out = Vec::with_capacity(arr.len());
        for item in arr {
            let Some(tag) = item.get("tag").and_then(Value::as_str) else { continue };
            let ftl = item.get("ftl").and_then(Value::as_str).unwrap_or("");
            let res = fluent::parse_fluent(ftl);
            for err in &res.errors {
                logs.write(plugin, "warn", &format!("[l10n] {tag}: {err}"));
            }
            out.push(Bundle { tag: tag.to_string(), res });
        }
        out
    }

    pub fn on_load(&self, plugin: &str, dir: &std::path::Path, manifest: &Value, spec_l10n: Option<&Value>, logs: &LogManager) {
        let locales = manifest.get("locales");
        let mut default_locale = locales.and_then(|l| l.get("default")).and_then(Value::as_str).map(str::to_string);
        let locales_dir = locales
            .and_then(|l| l.get("dir"))
            .and_then(Value::as_str)
            .unwrap_or("locale")
            .to_string();
        let available_hint = locales.and_then(|l| l.get("available")).and_then(Value::as_array).map(|arr| {
            arr.iter().filter_map(Value::as_str).map(str::to_string).collect::<Vec<_>>()
        });
        let mut bundles = None;
        if let Some(lobj) = spec_l10n.and_then(Value::as_object) {
            if let Some(dl) = lobj.get("defaultLocale").and_then(Value::as_str) {
                default_locale = Some(dl.to_string());
            }
            if let Some(arr) = lobj.get("bundles").and_then(Value::as_array) {
                bundles = Some(Self::parse_pushed_bundles(arr, plugin, logs));
            }
        }
        let mut inner = self.inner.lock().unwrap();
        inner.plugins.insert(
            plugin.to_string(),
            PluginL10n {
                dir: dir.to_path_buf(),
                locales_dir,
                default_locale,
                available_hint,
                bundles,
                warned: HashSet::new(),
            },
        );
    }

    pub fn on_push(&self, msg: &Value, app: &AppManager, logs: &LogManager) {
        let loc = msg.get("locale").and_then(Value::as_str).map(str::to_string);
        let tz = msg.get("timeZone").and_then(Value::as_str).map(str::to_string);
        if loc.is_some() || tz.is_some() {
            app.sync_locale_tz(loc.as_deref(), tz.as_deref());
        }
        let parsed = match (msg.get("plugin").and_then(Value::as_str), msg.get("bundles").and_then(Value::as_array)) {
            (Some(pid), Some(arr)) if !pid.is_empty() => Some(Self::parse_pushed_bundles(arr, pid, logs)),
            _ => None,
        };
        let mut inner = self.inner.lock().unwrap();
        if let Some(l) = loc {
            inner.locale = l;
        }
        if let Some(t) = tz {
            inner.time_zone = t;
        }
        if let Some(pid) = msg.get("plugin").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            let entry = inner.plugins.entry(pid.to_string()).or_insert_with(|| PluginL10n {
                dir: PathBuf::from("."),
                locales_dir: "locale".into(),
                default_locale: None,
                available_hint: None,
                bundles: None,
                warned: HashSet::new(),
            });
            if let Some(dl) = msg.get("defaultLocale").and_then(Value::as_str) {
                entry.default_locale = Some(dl.to_string());
            }
            if let Some(b) = parsed {
                entry.bundles = Some(b);
            }
            entry.warned.clear();
        }
    }

    pub fn remove_plugin(&self, plugin: &str) {
        self.inner.lock().unwrap().plugins.remove(plugin);
    }

    fn ensure_bundles(entry: &mut PluginL10n, plugin: &str, logs: &LogManager) {
        if entry.bundles.is_some() {
            return;
        }
        let all = read_bundles(&entry.dir, &entry.locales_dir, entry.available_hint.as_deref(), &mut |msg| {
            logs.write(plugin, "warn", &msg)
        });
        entry.bundles = Some(all);
    }

    pub fn locale(&self) -> String {
        self.inner.lock().unwrap().locale.clone()
    }

    pub fn plugin_locales(&self, plugin: &str, logs: &LogManager) -> Vec<String> {
        let mut inner = self.inner.lock().unwrap();
        let Some(entry) = inner.plugins.get_mut(plugin) else {
            return Vec::new();
        };
        Self::ensure_bundles(entry, plugin, logs);
        entry.bundles.as_ref().map(|bs| bs.iter().map(|b| b.tag.clone()).collect()).unwrap_or_default()
    }

    pub fn has_message(&self, plugin: &str, id: &str, logs: &LogManager) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let Some(entry) = inner.plugins.get_mut(plugin) else {
            return false;
        };
        Self::ensure_bundles(entry, plugin, logs);
        let (base, attr) = match id.find('.') {
            Some(dot) => (&id[..dot], Some(&id[dot + 1..])),
            None => (id, None),
        };
        entry.bundles.as_ref().is_some_and(|bs| {
            bs.iter().any(|b| {
                b.res.messages.get(base).is_some_and(|m| match attr {
                    Some(a) => m.attrs.contains_key(a),
                    None => m.value.is_some(),
                })
            })
        })
    }

    pub fn format_one(
        &self,
        plugin: &str,
        id: &str,
        args: &HashMap<String, FluentArg>,
        fallback: Option<&str>,
        logs: &LogManager,
    ) -> String {
        let mut warnings: Vec<String> = Vec::new();
        let result = {
            let mut inner = self.inner.lock().unwrap();
            let locale = inner.locale.clone();
            let tz = inner.time_zone.clone();
            let mut found: Option<String> = None;
            if let Some(entry) = inner.plugins.get_mut(plugin) {
                Self::ensure_bundles(entry, plugin, logs);
                if let Some(bundles) = entry.bundles.clone() {
                    let avail: Vec<String> = bundles.iter().map(|b| b.tag.clone()).collect();
                    let chain = fluent::locale_chain(&avail, &locale, entry.default_locale.as_deref());
                    for tag in chain {
                        if let Some(bundle) = bundles.iter().find(|b| b.tag == tag) {
                            let mut errs = Vec::new();
                            let mut on_err = |e: String| errs.push(format!("{tag}: {id}: {e}"));
                            let mut fctx = FormatCtx {
                                locale: &tag,
                                time_zone: Some(&tz),
                                messages: &bundle.res.messages,
                                terms: &bundle.res.terms,
                                on_error: &mut on_err,
                            };
                            let text = fluent::format_message(&mut fctx, id, args);
                            for msg in errs {
                                if entry.warned.insert(msg.clone()) {
                                    warnings.push(msg);
                                }
                            }
                            if let Some(t) = text {
                                found = Some(t);
                                break;
                            }
                        }
                    }
                }
                if found.is_none() {
                    let msg = format!("missing message \"{id}\"");
                    if entry.warned.insert(msg.clone()) {
                        warnings.push(msg);
                    }
                }
            } else {
                warnings.push(format!("missing message \"{id}\""));
            }
            found.unwrap_or_else(|| fallback.unwrap_or(id).to_string())
        };
        for w in warnings {
            logs.write(plugin, "warn", &format!("[l10n] {w}"));
        }
        result
    }

    pub fn format_date(&self, when_ms: u64, style: &str, with_time: bool) -> String {
        let (locale, tz) = {
            let inner = self.inner.lock().unwrap();
            (inner.locale.clone(), inner.time_zone.clone())
        };
        fluent::format_date_locale(&locale, when_ms as i64, style, with_time, Some(&tz))
    }

    pub fn format_number(&self, value: f64, fraction_digits: Option<u8>) -> String {
        let locale = self.inner.lock().unwrap().locale.clone();
        fluent::format_number_simple(&locale, value, fraction_digits)
    }
}

fn parse_l10n_ref(v: &Val) -> Result<(String, HashMap<String, FluentArg>, Option<String>)> {
    let Val::Record(fields) = v else { bail!("expected l10n-ref record") };
    let mut id = String::new();
    let mut args = HashMap::new();
    let mut fallback = None;
    for (k, fv) in fields {
        match k.as_str() {
            "id" => {
                if let Val::String(s) = fv {
                    id = s.clone();
                }
            }
            "fallback" => {
                if let Val::Option(Some(inner)) = fv {
                    if let Val::String(s) = inner.as_ref() {
                        fallback = Some(s.clone());
                    }
                }
            }
            "args" => {
                if let Val::List(items) = fv {
                    for item in items {
                        if let Val::Record(af) = item {
                            let mut aname = String::new();
                            let mut aval: Option<FluentArg> = None;
                            for (ak, av) in af {
                                if ak == "name" {
                                    if let Val::String(s) = av {
                                        aname = s.clone();
                                    }
                                } else if ak == "value" {
                                    if let Val::Variant(tag, Some(payload)) = av {
                                        aval = match (tag.as_str(), payload.as_ref()) {
                                            ("text", Val::String(s)) => Some(FluentArg::Text(s.clone())),
                                            ("integer", Val::S64(n)) => Some(FluentArg::Number(*n as f64)),
                                            ("number", Val::Float64(n)) => Some(FluentArg::Number(*n)),
                                            ("date", Val::U64(ms)) => Some(FluentArg::Date(*ms as i64)),
                                            _ => None,
                                        };
                                    }
                                }
                            }
                            if !aname.is_empty() {
                                if let Some(a) = aval {
                                    args.insert(aname, a);
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    Ok((id, args, fallback))
}

// =====================================================================================================================
// 5. TIMERS (`zinc:plugin/timers`)
// =====================================================================================================================

const MAX_TIMERS_PER_PLUGIN: usize = 64;
const MIN_INTERVAL_MS: u64 = 10;
const IDLE_DELAY_MS: u64 = 50;

struct TimerEntry {
    ms: u64,
    cancelled: AtomicBool,
    busy: AtomicBool,
    abort: Mutex<Option<AbortHandle>>,
}

#[derive(Default)]
struct PluginTimers {
    next_id: u32,
    entries: HashMap<u32, Arc<TimerEntry>>,
}

pub struct TimerManager {
    out: Out,
    plugins: Mutex<HashMap<String, PluginTimers>>,
}

struct BusyReset(Arc<TimerEntry>);
impl Drop for BusyReset {
    fn drop(&mut self) {
        self.0.busy.store(false, Ordering::Release);
    }
}

impl TimerManager {
    pub fn new(out: Out) -> Self {
        Self {
            out,
            plugins: Mutex::new(HashMap::new()),
        }
    }

    fn compute_delay(kind: &str, ms: u64, hidden: bool) -> Duration {
        let mut d = if kind == "idle" { ms.min(IDLE_DELAY_MS) } else { ms };
        if kind == "interval" {
            d = d.max(MIN_INTERVAL_MS);
        }
        if hidden && d < 1000 {
            d = 1000;
        }
        Duration::from_millis(d)
    }

    pub fn add(self: &Arc<Self>, host: &Arc<Host>, plugin: &str, kind: &'static str, ms: u32) -> std::result::Result<u32, String> {
        let entry = Arc::new(TimerEntry {
            ms: ms as u64,
            cancelled: AtomicBool::new(false),
            busy: AtomicBool::new(false),
            abort: Mutex::new(None),
        });
        let (id, count) = {
            let mut map = self.plugins.lock().unwrap();
            let pt = map.entry(plugin.to_string()).or_default();
            if pt.entries.len() >= MAX_TIMERS_PER_PLUGIN {
                return Err(format!("at most {MAX_TIMERS_PER_PLUGIN} timers per plugin"));
            }
            pt.next_id += 1;
            let id = pt.next_id;
            pt.entries.insert(id, entry.clone());
            (id, pt.entries.len())
        };
        self.out.send(json!({ "t": "timers-count", "plugin": plugin, "count": count }));

        let tm = self.clone();
        let host_weak = Arc::downgrade(host);
        let pid = plugin.to_string();
        let entry_task = entry.clone();
        let jh = tokio::spawn(async move {
            if kind == "interval" {
                loop {
                    let hidden = host_weak.upgrade().is_some_and(|h| h.app.windows_hidden.load(Ordering::Relaxed));
                    tokio::time::sleep(Self::compute_delay(kind, entry_task.ms, hidden)).await;
                    if entry_task.cancelled.load(Ordering::Acquire) {
                        break;
                    }
                    let Some(h) = host_weak.upgrade() else { break };
                    {
                        let map = tm.plugins.lock().unwrap();
                        let still_live = map
                            .get(&pid)
                            .and_then(|pt| pt.entries.get(&id))
                            .is_some_and(|e| Arc::ptr_eq(e, &entry_task));
                        if !still_live {
                            break;
                        }
                    }
                    if entry_task.busy.swap(true, Ordering::AcqRel) {
                        continue; // skip interval tick while previous tick is still running
                    }
                    let pid_call = pid.clone();
                    let entry_guard = entry_task.clone();
                    tokio::spawn(async move {
                        let _reset = BusyReset(entry_guard);
                        let _ = h
                            .call_contained(pid_call, "events".into(), "on-timer".into(), vec![json!(id), json!(kind)], None, None, false)
                            .await;
                    });
                }
            } else {
                let hidden = host_weak.upgrade().is_some_and(|h| h.app.windows_hidden.load(Ordering::Relaxed));
                tokio::time::sleep(Self::compute_delay(kind, entry_task.ms, hidden)).await;
                if entry_task.cancelled.load(Ordering::Acquire) {
                    return;
                }
                let Some(h) = host_weak.upgrade() else { return };
                let new_count = {
                    let mut map = tm.plugins.lock().unwrap();
                    let Some(pt) = map.get_mut(&pid) else { return };
                    let matched = pt.entries.get(&id).is_some_and(|e| Arc::ptr_eq(e, &entry_task));
                    if !matched {
                        return;
                    }
                    pt.entries.remove(&id);
                    pt.entries.len()
                };
                tm.out.send(json!({ "t": "timers-count", "plugin": pid, "count": new_count }));
                let _ = h
                    .call_contained(pid, "events".into(), "on-timer".into(), vec![json!(id), json!(kind)], None, None, false)
                    .await;
            }
        });
        *entry.abort.lock().unwrap() = Some(jh.abort_handle());
        Ok(id)
    }

    pub fn clear(&self, plugin: &str, id: u32) {
        let removed = {
            let mut map = self.plugins.lock().unwrap();
            let Some(pt) = map.get_mut(plugin) else { return };
            let Some(entry) = pt.entries.remove(&id) else { return };
            (entry, pt.entries.len())
        };
        removed.0.cancelled.store(true, Ordering::Release);
        if let Some(ah) = removed.0.abort.lock().unwrap().take() {
            ah.abort();
        }
        self.out.send(json!({ "t": "timers-count", "plugin": plugin, "count": removed.1 }));
    }

    pub fn clear_plugin(&self, plugin: &str, always_emit: bool) {
        let entries = {
            let mut map = self.plugins.lock().unwrap();
            map.remove(plugin).map(|pt| pt.entries)
        };
        let had_active = entries.as_ref().is_some_and(|e| !e.is_empty());
        if let Some(es) = entries {
            for (_, e) in es {
                e.cancelled.store(true, Ordering::Release);
                if let Some(ah) = e.abort.lock().unwrap().take() {
                    ah.abort();
                }
            }
        }
        if always_emit || had_active {
            self.out.send(json!({ "t": "timers-count", "plugin": plugin, "count": 0 }));
        }
    }

    pub fn clear_all(&self, known_plugins: &[String]) {
        let drained: HashMap<String, PluginTimers> = {
            let mut map = self.plugins.lock().unwrap();
            std::mem::take(&mut *map)
        };
        let mut notified = HashSet::new();
        for (pid, pt) in drained {
            for (_, e) in pt.entries {
                e.cancelled.store(true, Ordering::Release);
                if let Some(ah) = e.abort.lock().unwrap().take() {
                    ah.abort();
                }
            }
            self.out.send(json!({ "t": "timers-count", "plugin": pid, "count": 0 }));
            notified.insert(pid);
        }
        for pid in known_plugins {
            if !notified.contains(pid) {
                self.out.send(json!({ "t": "timers-count", "plugin": pid, "count": 0 }));
            }
        }
    }

    pub fn count(&self, plugin: &str) -> usize {
        self.plugins.lock().unwrap().get(plugin).map_or(0, |pt| pt.entries.len())
    }
}

// =====================================================================================================================
// 6. UTIL (`zinc:plugin/util`)
// =====================================================================================================================

pub fn semver_compare(a: &str, b: &str) -> i32 {
    fn parse_ver(v: &str) -> (Vec<i64>, Vec<String>) {
        let trimmed = v.trim();
        let no_v = trimmed
            .strip_prefix('v')
            .or_else(|| trimmed.strip_prefix('V'))
            .unwrap_or(trimmed);
        let no_build = no_v.split('+').next().unwrap_or("");
        let (core, pre) = match no_build.find('-') {
            Some(d) => (
                &no_build[..d],
                no_build[d + 1..].split('.').map(str::to_string).collect::<Vec<_>>(),
            ),
            None => (no_build, Vec::new()),
        };
        let mut nums: Vec<i64> = core
            .split('.')
            .map(|p| {
                if !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit()) {
                    p.parse::<i64>().unwrap_or(0)
                } else {
                    0
                }
            })
            .collect();
        while nums.len() < 3 {
            nums.push(0);
        }
        (nums, pre)
    }

    let (xn, xp) = parse_ver(a);
    let (yn, yp) = parse_ver(b);
    let n = xn.len().max(yn.len());
    for i in 0..n {
        let d = xn.get(i).copied().unwrap_or(0) - yn.get(i).copied().unwrap_or(0);
        if d != 0 {
            return if d < 0 { -1 } else { 1 };
        }
    }
    if xp.is_empty() && yp.is_empty() {
        return 0;
    }
    if xp.is_empty() {
        return 1;
    }
    if yp.is_empty() {
        return -1;
    }
    let m = xp.len().max(yp.len());
    for i in 0..m {
        let (Some(p), Some(q)) = (xp.get(i), yp.get(i)) else {
            return if xp.get(i).is_none() { -1 } else { 1 };
        };
        let pn = !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit());
        let qn = !q.is_empty() && q.bytes().all(|c| c.is_ascii_digit());
        if pn && qn {
            let pv = p.parse::<u128>().unwrap_or(0);
            let qv = q.parse::<u128>().unwrap_or(0);
            if pv != qv {
                return if pv < qv { -1 } else { 1 };
            }
        } else if pn != qn {
            return if pn { -1 } else { 1 };
        } else if p != q {
            return if p < q { -1 } else { 1 };
        }
    }
    0
}

pub fn clean_doi(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i + 3 <= bytes.len() {
        if bytes[i] == b'1' && bytes[i + 1] == b'0' {
            let mut j = i + 2;
            let prefix_ok = if bytes.get(j) == Some(&b'.') {
                j += 1;
                let d0 = j;
                while j < bytes.len() && bytes[j].is_ascii_digit() {
                    j += 1;
                }
                j - d0 >= 4 && bytes.get(j) == Some(&b'/')
            } else {
                bytes.get(j) == Some(&b'/')
            };
            if prefix_ok {
                j += 1; // past '/'
                let rest = &text[j..];
                let end_ws = rest.find(char::is_whitespace).unwrap_or(rest.len());
                let body = rest[..end_ws].trim_end_matches(['.', ',']);
                if !body.is_empty() {
                    return Some(text[i..j + body.len()].to_string());
                }
            }
        }
        i += 1;
    }
    None
}

fn isbn10_ok(s: &[u8]) -> bool {
    let mut sum: u32 = 0;
    for (i, &c) in s.iter().take(10).enumerate() {
        let d = if c == b'X' || c == b'x' { 10 } else { (c - b'0') as u32 };
        sum += d * (10 - i as u32);
    }
    sum.is_multiple_of(11)
}

fn isbn13_check(s12: &[u8]) -> u8 {
    let mut sum: u32 = 0;
    for (i, &c) in s12.iter().take(12).enumerate() {
        let d = (c - b'0') as u32;
        sum += d * if i % 2 == 1 { 3 } else { 1 };
    }
    b'0' + ((10 - (sum % 10)) % 10) as u8
}

pub fn clean_isbn(text: &str, to_isbn13: bool) -> Option<String> {
    let mut t = String::with_capacity(text.len());
    for ch in text.chars() {
        if matches!(ch, '\u{2010}'..='\u{2015}' | '\u{2212}' | '-') || ch.is_whitespace() {
            continue;
        }
        t.push(ch);
    }
    let b = t.as_bytes();
    let is_isbn_tail = |c: u8| c.is_ascii_digit() || c == b'X' || c == b'x';

    let mut found: Option<String> = None;
    for i in 0..b.len() {
        if i > 0 && b[i - 1].is_ascii_digit() {
            continue;
        }
        // Try 13-digit 97[89][0-9]{10}
        if i + 13 <= b.len()
            && b[i] == b'9'
            && b[i + 1] == b'7'
            && (b[i + 2] == b'8' || b[i + 2] == b'9')
            && b[i + 3..i + 13].iter().all(|c| c.is_ascii_digit())
            && !b.get(i + 13).copied().is_some_and(is_isbn_tail)
        {
            found = Some(t[i..i + 13].to_ascii_uppercase());
            break;
        }
        // Try 10-digit [0-9]{9}[0-9Xx]
        if i + 10 <= b.len()
            && b[i..i + 9].iter().all(|c| c.is_ascii_digit())
            && is_isbn_tail(b[i + 9])
            && !b.get(i + 10).copied().is_some_and(is_isbn_tail)
        {
            found = Some(t[i..i + 10].to_ascii_uppercase());
            break;
        }
    }

    let isbn = found?;
    let ib = isbn.as_bytes();
    if ib.len() == 10 {
        if !isbn10_ok(ib) {
            return None;
        }
        if !to_isbn13 {
            return Some(isbn);
        }
        let mut s13 = String::with_capacity(13);
        s13.push_str("978");
        s13.push_str(&isbn[..9]);
        s13.push(isbn13_check(s13.as_bytes()) as char);
        return Some(s13);
    }
    if isbn13_check(&ib[..12]) != ib[12] {
        return None;
    }
    Some(isbn)
}

pub fn clean_issn(text: &str) -> Option<String> {
    let b = text.as_bytes();
    let is_issn_tail = |c: u8| c.is_ascii_digit() || c == b'X' || c == b'x';

    let mut raw: Option<Vec<u8>> = None;
    for i in 0..b.len() {
        if i > 0 && b[i - 1].is_ascii_digit() {
            continue;
        }
        if i + 4 > b.len() || !b[i..i + 4].iter().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let j = if b.get(i + 4) == Some(&b'-') { i + 5 } else { i + 4 };
        if j + 4 <= b.len()
            && b[j..j + 3].iter().all(|c| c.is_ascii_digit())
            && is_issn_tail(b[j + 3])
            && !b.get(j + 4).copied().is_some_and(is_issn_tail)
        {
            let mut r = Vec::with_capacity(8);
            r.extend_from_slice(&b[i..i + 4]);
            r.extend_from_slice(&b[j..j + 4]);
            for ch in &mut r {
                *ch = ch.to_ascii_uppercase();
            }
            raw = Some(r);
            break;
        }
    }

    let r = raw?;
    let mut sum: u32 = 0;
    for (idx, &c) in r.iter().take(7).enumerate() {
        sum += (c - b'0') as u32 * (8 - idx as u32);
    }
    let check = (11 - (sum % 11)) % 11;
    let want = if check == 10 { b'X' } else { b'0' + check as u8 };
    if r[7] == want {
        Some(format!("{}-{}", std::str::from_utf8(&r[..4]).unwrap(), std::str::from_utf8(&r[4..]).unwrap()))
    } else {
        None
    }
}

fn strip_tag_blocks_ci(input: &str, tag: &str) -> String {
    let open_pat = format!("<{tag}");
    let close_pat = format!("</{tag}>");
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        let rest = &input[i..];
        if rest.len() >= open_pat.len()
            && rest.is_char_boundary(open_pat.len())
            && rest[..open_pat.len()].eq_ignore_ascii_case(&open_pat)
            && rest.as_bytes().get(open_pat.len()).is_some_and(|c| c.is_ascii_whitespace() || *c == b'>' || *c == b'/')
        {
            let after_open = i + open_pat.len();
            let mut close_pos = None;
            let mut j = after_open;
            while j + close_pat.len() <= input.len() {
                if input.is_char_boundary(j)
                    && input.is_char_boundary(j + close_pat.len())
                    && input[j..j + close_pat.len()].eq_ignore_ascii_case(&close_pat)
                {
                    close_pos = Some(j + close_pat.len());
                    break;
                }
                j += 1;
            }
            if let Some(end) = close_pos {
                i = end;
                continue;
            }
        }
        let ch = rest.chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn decode_entity(ent: &str) -> Option<String> {
    if let Some(num) = ent.strip_prefix('#') {
        let cp = if let Some(hex) = num.strip_prefix('x').or_else(|| num.strip_prefix('X')) {
            u32::from_str_radix(hex, 16).ok()?
        } else {
            num.parse::<u32>().ok()?
        };
        if (1..=0x10ffff).contains(&cp) {
            return char::from_u32(cp).map(|c| c.to_string());
        }
        return None;
    }
    let val = match ent.to_ascii_lowercase().as_str() {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "nbsp" => "\u{00a0}",
        "ndash" => "\u{2013}",
        "mdash" => "\u{2014}",
        "hellip" => "\u{2026}",
        "lsquo" => "\u{2018}",
        "rsquo" => "\u{2019}",
        "ldquo" => "\u{201c}",
        "rdquo" => "\u{201d}",
        "copy" => "\u{00a9}",
        _ => return None,
    };
    Some(val.to_string())
}

pub fn html_to_text(html: &str) -> String {
    let s1 = strip_tag_blocks_ci(html, "script");
    let s2 = strip_tag_blocks_ci(&s1, "style");

    // Process tags cleanly in a single pass
    let mut no_tags = String::with_capacity(s2.len());
    let mut i = 0;
    while i < s2.len() {
        let rest = &s2[i..];
        if rest.starts_with('<') {
            if let Some(gt) = rest.find('>') {
                let inside = rest[1..gt].trim();
                let lower = inside.to_ascii_lowercase();
                if lower == "br" || lower.strip_prefix("br").is_some_and(|r| r.trim_start().is_empty() || r.trim() == "/") {
                    no_tags.push('\n');
                } else if let Some(closed) = lower.strip_prefix('/') {
                    let tname = closed.trim();
                    if matches!(
                        tname,
                        "p" | "div" | "li" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "tr" | "blockquote" | "pre" | "ul" | "ol" | "table"
                    ) {
                        no_tags.push('\n');
                    }
                }
                i += gt + 1;
                continue;
            }
        }
        let ch = rest.chars().next().unwrap();
        no_tags.push(ch);
        i += ch.len_utf8();
    }

    // Decode entities
    let mut decoded = String::with_capacity(no_tags.len());
    let mut j = 0;
    while j < no_tags.len() {
        let rest = &no_tags[j..];
        if rest.starts_with('&') {
            // The entity name may start in the first 16 bytes; a character that straddles byte 16 must not be cut.
            let mut semi = None;
            for (k, ch) in rest.char_indices().take_while(|(k, _)| *k < 16).skip(1) {
                if ch == ';' {
                    semi = Some(k);
                    break;
                }
                if !(ch.is_ascii_alphanumeric() || (k == 1 && ch == '#')) {
                    break;
                }
            }
            if let Some(end) = semi {
                let ent = &rest[1..end];
                if !ent.is_empty() {
                    if let Some(rep) = decode_entity(ent) {
                        decoded.push_str(&rep);
                        j += end + 1;
                        continue;
                    }
                }
            }
        }
        let ch = rest.chars().next().unwrap();
        decoded.push(ch);
        j += ch.len_utf8();
    }

    // Strip `[ \t]+\n` -> `\n` and `\n{3,}` -> `\n\n`, then trim.
    let mut lines_cleaned = String::with_capacity(decoded.len());
    for (idx, part) in decoded.split('\n').enumerate() {
        if idx > 0 {
            lines_cleaned.push('\n');
        }
        lines_cleaned.push_str(part.trim_end_matches([' ', '\t']));
    }
    let mut collapsed = String::with_capacity(lines_cleaned.len());
    let mut nl_run = 0usize;
    for ch in lines_cleaned.chars() {
        if ch == '\n' {
            nl_run += 1;
            if nl_run <= 2 {
                collapsed.push('\n');
            }
        } else {
            nl_run = 0;
            collapsed.push(ch);
        }
    }
    collapsed.trim().to_string()
}

fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            c => out.push(c),
        }
    }
    out
}

pub fn text_to_html(text: &str, single_newline: bool) -> String {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let escaped = escape_html(normalized.trim());
    if escaped.is_empty() {
        return String::new();
    }
    let mut out = String::new();
    if single_newline {
        for p in escaped.split('\n').filter(|s| !s.is_empty()) {
            out.push_str("<p>");
            out.push_str(p);
            out.push_str("</p>");
        }
    } else {
        // Split on 2+ consecutive newlines
        let mut paras: Vec<String> = Vec::new();
        let mut cur = String::new();
        let mut nl_count = 0usize;
        for ch in escaped.chars() {
            if ch == '\n' {
                nl_count += 1;
            } else {
                if nl_count >= 2 {
                    paras.push(std::mem::take(&mut cur));
                } else if nl_count == 1 {
                    cur.push_str("<br />");
                }
                nl_count = 0;
                cur.push(ch);
            }
        }
        if !cur.is_empty() {
            paras.push(cur);
        }
        for p in paras {
            out.push_str("<p>");
            out.push_str(&p);
            out.push_str("</p>");
        }
    }
    out
}

fn strip_first_non_ascii_lower(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut state = 0u8; // 0 = before run, 1 = in first run, 2 = after first run
    for ch in s.chars() {
        let is_az = ch.is_ascii_lowercase();
        match state {
            0 if !is_az => state = 1,
            0 => out.push(ch),
            1 if !is_az => {}
            1 => {
                state = 2;
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out
}

pub fn capitalize_title(title: &str, _force: bool) -> String {
    const SKIP: &[&str] = &[
        "a", "an", "and", "as", "at", "but", "by", "down", "for", "from", "in", "into", "nor", "of", "on", "onto",
        "or", "over", "so", "the", "till", "to", "up", "via", "with", "yet",
    ];
    let all_upper = title.to_uppercase() == title;

    // Collapse runs of whitespace to single ASCII space after trimming
    let mut ws_norm = String::with_capacity(title.len());
    let mut in_ws = false;
    for ch in title.trim().chars() {
        if ch.is_whitespace() {
            if !in_ws {
                ws_norm.push(' ');
                in_ws = true;
            }
        } else {
            in_ws = false;
            ws_norm.push(ch);
        }
    }
    if ws_norm.is_empty() {
        return String::new();
    }

    let is_sep = |c: char| matches!(c, ' ' | '\u{00a0}' | '\u{2013}' | '\u{2014}' | '-');
    let mut words: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut cur_sep: Option<bool> = None;
    for ch in ws_norm.chars() {
        let sep = is_sep(ch);
        if cur_sep == Some(sep) {
            cur.push(ch);
        } else {
            if !cur.is_empty() {
                words.push(std::mem::take(&mut cur));
            }
            cur.push(ch);
            cur_sep = Some(sep);
        }
    }
    if !cur.is_empty() {
        words.push(cur);
    }

    let last = words.len() - 1;
    let mut prev: Option<usize> = None;
    for i in 0..=last {
        if words[i].is_empty() || words[i].chars().all(is_sep) {
            continue;
        }
        let lower = words[i].to_lowercase();
        if all_upper || words[i] == lower {
            let after_colon = prev.is_some_and(|p| words[p].ends_with(':'));
            let stripped = strip_first_non_ascii_lower(&lower);
            if SKIP.contains(&stripped.as_str()) && i != 0 && i != last && !after_colon {
                words[i] = lower;
            } else {
                let mut chars = words[i].chars();
                let mut cap = String::new();
                if let Some(first) = chars.next() {
                    cap.extend(first.to_uppercase());
                    cap.push_str(&chars.as_str().to_lowercase());
                }
                words[i] = cap;
            }
        }
        prev = Some(i);
    }
    words.concat()
}

// =====================================================================================================================
// Dispatcher
// =====================================================================================================================

/// Runs a native wait (a sleep, the wait for the UI) with the call's CPU deadline paused. The time counts against the call's
/// allowance for such waits (`max_paused_ms`), a sleep that cannot fit is refused at once, and the wait ends when the plugin is
/// unloaded.
async fn paused_wait<F: std::future::Future<Output = ()>>(cx: &mut StoreContextMut<'_, St>, want_ms: Option<u64>, fut: F) -> Result<()> {
    let (cpu_left, cancel, allowance) = {
        let d = cx.data();
        (d.deadline_epoch.saturating_sub(now_epoch()), d.cancel.clone(), d.max_paused_ms.saturating_sub(d.paused_ms))
    };
    if want_ms.is_some_and(|ms| ms > allowance) {
        bail!("{TIMEOUT_MARK}: the call used up its allowance for sleeping and waiting");
    }
    let t0 = Instant::now();
    let outcome = tokio::select! {
        _ = fut => Ok(()),
        _ = cancel.cancelled() => Err(anyhow!("{UNLOADED_MARK}: the plugin was unloaded while it waited")),
        _ = tokio::time::sleep(Duration::from_millis(allowance)) => Err(anyhow!("{TIMEOUT_MARK}: the call used up its allowance for sleeping and waiting")),
    };
    let d = cx.data_mut();
    d.paused_ms = d.paused_ms.saturating_add(t0.elapsed().as_millis() as u64);
    d.deadline_epoch = now_epoch() + cpu_left;
    outcome
}

pub async fn call(
    mut cx: StoreContextMut<'_, St>,
    short_iface: &str,
    fname: &str,
    params: &[Val],
    results: &mut [Val],
) -> Result<()> {
    cx.data().native_calls.fetch_add(1, Ordering::Relaxed);
    let Some(host) = cx.data().host.upgrade() else {
        bail!("host dropped");
    };
    let plugin = cx.data().id.clone();

    match (short_iface, fname) {
        // ---- log ----------------------------------------------------------------------------------------------------
        ("log", "debug-enabled") => {
            results[0] = Val::Bool(host.logs.debug_enabled.load(Ordering::Relaxed));
        }
        ("log", "write") => {
            let (Some(Val::Enum(level)), Some(Val::String(msg))) = (params.first(), params.get(1)) else {
                bail!("log.write: bad arguments");
            };
            host.logs.write(&plugin, level, msg);
        }
        ("log", "write-error") => {
            let Some(Val::String(msg)) = params.first() else {
                bail!("log.write-error: bad arguments");
            };
            let stack = match params.get(1) {
                Some(Val::Option(Some(inner))) => match inner.as_ref() {
                    Val::String(s) => Some(s.as_str()),
                    _ => None,
                },
                _ => None,
            };
            host.logs.write_error(&plugin, msg, stack);
        }

        // ---- prefs --------------------------------------------------------------------------------------------------
        ("prefs", "get") => {
            let Some(Val::String(key)) = params.first() else { bail!("prefs.get: bad arguments") };
            results[0] = Val::Option(host.prefs.get(&plugin, key).map(|pv| Box::new(pv.to_val())));
        }
        ("prefs", "has-user-value") => {
            let Some(Val::String(key)) = params.first() else { bail!("prefs.has-user-value: bad arguments") };
            results[0] = Val::Bool(host.prefs.has_user_value(&plugin, key));
        }
        ("prefs", "get-all") => {
            let prefix = match params.first() {
                Some(Val::Option(Some(inner))) => match inner.as_ref() {
                    Val::String(s) => Some(s.as_str()),
                    _ => None,
                },
                _ => None,
            };
            results[0] = Val::List(host.prefs.get_all(&plugin, prefix));
        }
        ("prefs", "get-app") => {
            let Some(Val::String(key)) = params.first() else { bail!("prefs.get-app: bad arguments") };
            let has_perm = cx.data().grants.read().unwrap().capabilities.contains("prefs.app-read");
            results[0] = host.prefs.get_app(key, has_perm);
        }

        // ---- timers -------------------------------------------------------------------------------------------------
        ("timers", "now") => {
            results[0] = Val::U64(epoch_ms_now());
        }
        ("timers", "monotonic-ms") => {
            results[0] = Val::U64(monotonic_ms_now());
        }
        ("timers", "sleep") => {
            let Some(Val::U32(ms)) = params.first() else { bail!("timers.sleep: bad arguments") };
            let ms = (*ms as u64).min(3_600_000);
            paused_wait(&mut cx, Some(ms), tokio::time::sleep(Duration::from_millis(ms))).await?;
        }
        ("timers", "set-timeout") => {
            let Some(Val::U32(ms)) = params.first() else { bail!("timers.set-timeout: bad arguments") };
            results[0] = match host.timers.add(&host, &plugin, "timeout", *ms) {
                Ok(id) => Val::Result(Ok(Some(Box::new(Val::U32(id))))),
                Err(msg) => wit_err("limit-exceeded", msg),
            };
        }
        ("timers", "set-interval") => {
            let Some(Val::U32(ms)) = params.first() else { bail!("timers.set-interval: bad arguments") };
            results[0] = match host.timers.add(&host, &plugin, "interval", *ms) {
                Ok(id) => Val::Result(Ok(Some(Box::new(Val::U32(id))))),
                Err(msg) => wit_err("limit-exceeded", msg),
            };
        }
        ("timers", "request-idle") => {
            let Some(Val::U32(ms)) = params.first() else { bail!("timers.request-idle: bad arguments") };
            results[0] = match host.timers.add(&host, &plugin, "idle", *ms) {
                Ok(id) => Val::Result(Ok(Some(Box::new(Val::U32(id))))),
                Err(msg) => wit_err("limit-exceeded", msg),
            };
        }
        ("timers", "clear") => {
            let Some(Val::U32(id)) = params.first() else { bail!("timers.clear: bad arguments") };
            host.timers.clear(&plugin, *id);
        }

        // ---- l10n ---------------------------------------------------------------------------------------------------
        ("l10n", "format") => {
            let r = params.first().ok_or_else(|| anyhow!("l10n.format: missing argument"))?;
            let (id, args, fb) = parse_l10n_ref(r)?;
            results[0] = Val::String(host.l10n.format_one(&plugin, &id, &args, fb.as_deref(), &host.logs));
        }
        ("l10n", "format-many") => {
            let Some(Val::List(items)) = params.first() else { bail!("l10n.format-many: bad arguments") };
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                let (id, args, fb) = parse_l10n_ref(item)?;
                out.push(Val::String(host.l10n.format_one(&plugin, &id, &args, fb.as_deref(), &host.logs)));
            }
            results[0] = Val::List(out);
        }
        ("l10n", "has-message") => {
            let Some(Val::String(id)) = params.first() else { bail!("l10n.has-message: bad arguments") };
            results[0] = Val::Bool(host.l10n.has_message(&plugin, id, &host.logs));
        }
        ("l10n", "locale") => {
            results[0] = Val::String(host.l10n.locale());
        }
        ("l10n", "plugin-locales") => {
            let locs = host.l10n.plugin_locales(&plugin, &host.logs);
            results[0] = Val::List(locs.into_iter().map(Val::String).collect());
        }
        ("l10n", "format-date") => {
            let (Some(Val::U64(when)), Some(Val::Enum(style)), Some(Val::Bool(with_time))) =
                (params.first(), params.get(1), params.get(2))
            else {
                bail!("l10n.format-date: bad arguments");
            };
            results[0] = Val::String(host.l10n.format_date(*when, style, *with_time));
        }
        ("l10n", "format-number") => {
            let val = match params.first() {
                Some(Val::Float64(f)) => *f,
                _ => bail!("l10n.format-number: bad arguments"),
            };
            let digits = match params.get(1) {
                Some(Val::Option(Some(inner))) => match inner.as_ref() {
                    Val::U8(d) => Some(*d),
                    _ => None,
                },
                _ => None,
            };
            results[0] = Val::String(host.l10n.format_number(val, digits));
        }

        // ---- app ----------------------------------------------------------------------------------------------------
        ("app", "get-info") => {
            results[0] = host.app.get_info_val();
        }
        ("app", "is-ui-ready") => {
            results[0] = Val::Bool(host.app.is_ui_ready());
        }
        ("app", "wait-ui-ready") => {
            let mut rx = host.app.ui_ready_receiver();
            if !*rx.borrow_and_update() {
                let ready = async {
                    while !*rx.borrow_and_update() {
                        if rx.changed().await.is_err() {
                            break;
                        }
                    }
                };
                paused_wait(&mut cx, None, ready).await?;
            }
        }
        ("app", "main-windows") => {
            results[0] = host.app.main_windows_val();
        }
        ("app", "active-window") => {
            results[0] = host.app.active_window_val();
        }

        // ---- util ---------------------------------------------------------------------------------------------------
        ("util", "random-bytes") => {
            let Some(Val::U32(count)) = params.first() else { bail!("util.random-bytes: bad arguments") };
            if *count > 65536 {
                bail!("random-bytes: at most 65536 bytes per call");
            }
            let mut buf = vec![0u8; *count as usize];
            crypto::fill_random(&mut buf)?;
            results[0] = Val::List(buf.into_iter().map(Val::U8).collect());
        }
        ("util", "uuid-v4") => {
            results[0] = Val::String(crypto::uuid_v4()?);
        }
        ("util", "hash") => {
            let (Some(Val::Enum(alg)), Some(Val::List(items))) = (params.first(), params.get(1)) else {
                bail!("util.hash: bad arguments");
            };
            let mut bytes = Vec::with_capacity(items.len());
            for item in items {
                if let Val::U8(b) = item {
                    bytes.push(*b);
                }
            }
            let digest = crypto::hash(alg, &bytes)?;
            results[0] = Val::List(digest.into_iter().map(Val::U8).collect());
        }
        ("util", "semver-compare") => {
            let (Some(Val::String(a)), Some(Val::String(b))) = (params.first(), params.get(1)) else {
                bail!("util.semver-compare: bad arguments");
            };
            results[0] = Val::S32(semver_compare(a, b));
        }
        ("util", "clean-doi") => {
            let Some(Val::String(t)) = params.first() else { bail!("util.clean-doi: bad arguments") };
            results[0] = Val::Option(clean_doi(t).map(|s| Box::new(Val::String(s))));
        }
        ("util", "clean-isbn") => {
            let (Some(Val::String(t)), Some(Val::Bool(to13))) = (params.first(), params.get(1)) else {
                bail!("util.clean-isbn: bad arguments");
            };
            results[0] = Val::Option(clean_isbn(t, *to13).map(|s| Box::new(Val::String(s))));
        }
        ("util", "clean-issn") => {
            let Some(Val::String(t)) = params.first() else { bail!("util.clean-issn: bad arguments") };
            results[0] = Val::Option(clean_issn(t).map(|s| Box::new(Val::String(s))));
        }
        ("util", "html-to-text") => {
            let Some(Val::String(h)) = params.first() else { bail!("util.html-to-text: bad arguments") };
            results[0] = Val::String(html_to_text(h));
        }
        ("util", "text-to-html") => {
            let (Some(Val::String(t)), Some(Val::Bool(single))) = (params.first(), params.get(1)) else {
                bail!("util.text-to-html: bad arguments");
            };
            results[0] = Val::String(text_to_html(t, *single));
        }
        ("util", "capitalize-title") => {
            let (Some(Val::String(t)), Some(Val::Bool(force))) = (params.first(), params.get(1)) else {
                bail!("util.capitalize-title: bad arguments");
            };
            results[0] = Val::String(capitalize_title(t, *force));
        }

        _ => bail!("{short_iface}#{fname} has no native implementation"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn html_to_text_survives_text_after_an_ampersand() {
        // "&" followed by 14 ASCII bytes and a two-byte character puts the character across byte 16
        let s = format!("&{}\u{e9} tail", "a".repeat(14));
        assert_eq!(html_to_text(&s), s);
        assert_eq!(html_to_text("AT&T pr\u{e9}sente"), "AT&T pr\u{e9}sente");
        assert_eq!(html_to_text("a &amp; b &lt;&#233;&#xe9;&gt;"), "a & b <\u{e9}\u{e9}>");
        // every position of a multi-byte character relative to the 16 byte window
        for pad in 0..20 {
            let s = format!("&{}\u{1f600}\u{4e2d};x", "b".repeat(pad));
            let _ = html_to_text(&s);
        }
    }

    #[test]
    fn html_to_text_keeps_entities_that_fit_the_window() {
        assert_eq!(html_to_text("&hellip;&nbsp;x"), "\u{2026}\u{a0}x");
        // 14 name bytes is the longest that is looked at; it is not a known entity, so it stays as written
        assert_eq!(html_to_text("&abcdefghijklmn;"), "&abcdefghijklmn;");
    }

    #[test]
    fn app_prefs_that_are_no_longer_set_are_forgotten() {
        let p = PrefsManager::default();
        let get = |k: &str| format!("{:?}", p.get_app(k, true));
        p.on_push(&json!({"appPrefs": {"ui.locale": "en", "general.autoTag": true}}));
        assert!(get("general.autoTag").contains("Flag") || get("general.autoTag").contains("flag"), "{}", get("general.autoTag"));
        p.on_push(&json!({"appPrefs": {"ui.locale": "fr"}}));
        assert!(get("ui.locale").contains("fr"));
        assert!(!get("general.autoTag").contains("flag"), "{}", get("general.autoTag"));
        assert!(get("general.autoTag").contains("None"));
        p.on_push(&json!({"appPrefs": {}}));
        assert!(get("ui.locale").contains("None"));
    }

    #[test]
    fn locale_names_are_plain() {
        for ok in ["locale", "locale/strings", "./locale", "i18n\\fr", "a.b"] {
            assert!(is_plain_relative_path(ok), "{ok}");
        }
        for bad in ["", "..", "../x", "a/../b", "a\\..\\b", "/abs", "\\\\server\\share", "C:\\x", "C:x", "//srv/x", "a\0b", "x:y"] {
            assert!(!is_plain_relative_path(bad), "{bad:?}");
        }
        for ok in ["en", "fr", "en-US", "pt-BR", "zh-Hans-CN", "es-419", "sr-Latn-RS"] {
            assert!(is_locale_tag(ok), "{ok}");
        }
        for bad in ["", "e", "..", "../en", "en/US", "en\\US", "en-", "-en", "en_US", "C:", "en-US-x y", "abcdefghi", "en--US", "e\u{301}n"] {
            assert!(!is_locale_tag(bad), "{bad:?}");
        }
    }

    /// A scratch package folder under the temp dir with `locale/<tag>/main.ftl` and a sibling `outside/en/main.ftl`.
    struct Pkg {
        root: PathBuf,
        files: Vec<PathBuf>,
        dirs: Vec<PathBuf>,
    }

    impl Pkg {
        fn new(name: &str) -> Self {
            let root = std::env::temp_dir().join(format!("zhw-l10n-{}-{name}", std::process::id()));
            let mut p = Pkg { root, files: vec![], dirs: vec![] };
            p.dir("");
            p.dir("pkg");
            p
        }
        fn dir(&mut self, rel: &str) -> PathBuf {
            let d = self.root.join(rel);
            let mut missing = vec![];
            let mut cur = d.clone();
            while !cur.exists() {
                missing.push(cur.clone());
                cur = cur.parent().unwrap().to_path_buf();
            }
            std::fs::create_dir_all(&d).unwrap();
            missing.reverse();
            self.dirs.extend(missing);
            d
        }
        fn file(&mut self, rel: &str, text: &str) {
            let f = self.root.join(rel);
            self.dir(Path::new(rel).parent().unwrap().to_str().unwrap());
            std::fs::write(&f, text).unwrap();
            self.files.push(f);
        }
        fn pkg(&self) -> PathBuf {
            self.root.join("pkg")
        }
    }

    impl Drop for Pkg {
        fn drop(&mut self) {
            for f in &self.files {
                let _ = std::fs::remove_file(f);
            }
            for d in self.dirs.iter().rev() {
                let _ = std::fs::remove_dir(d);
            }
        }
    }

    fn read(p: &Pkg, dir: &str, avail: Option<&[String]>) -> (Vec<String>, Vec<String>) {
        let mut warns = vec![];
        let b = read_bundles(&p.pkg(), dir, avail, &mut |m| warns.push(m));
        (b.into_iter().map(|b| format!("{}:{}", b.tag, b.res.messages.len())).collect(), warns)
    }

    #[test]
    fn the_locales_folder_inside_the_package_is_read() {
        let mut p = Pkg::new("ok");
        p.file("pkg/locale/en-US/main.ftl", "hello = Hello\nbye = Bye\n");
        p.file("pkg/locale/fr/main.ftl", "hello = Bonjour\n");
        p.file("pkg/locale/fr/notes.txt", "not a string file");
        assert_eq!(read(&p, "locale", None).0, ["en-US:2", "fr:1"]);
        let hint = vec!["fr".to_string()];
        assert_eq!(read(&p, "locale", Some(&hint)).0, ["fr:1"]);
        assert_eq!(read(&p, "./locale", None).0, ["en-US:2", "fr:1"]);
    }

    #[test]
    fn a_locales_folder_outside_the_package_is_refused() {
        let mut p = Pkg::new("dir");
        p.file("pkg/locale/en/main.ftl", "hello = Hello\n");
        p.file("outside/en/main.ftl", "stolen = Stolen\n");
        let abs = p.root.join("outside").to_string_lossy().into_owned();
        let unc = format!("\\\\?\\{abs}");
        for dir in ["../outside", "locale/../../outside", &abs, &unc, "\\\\localhost\\c$\\x", "C:", "/outside"] {
            let (got, warns) = read(&p, dir, None);
            assert!(got.is_empty(), "{dir}: {got:?}");
            assert_eq!(warns.len(), 1, "{dir}");
        }
    }

    #[test]
    fn a_tag_that_is_not_a_tag_is_skipped() {
        let mut p = Pkg::new("tag");
        p.file("pkg/locale/en/main.ftl", "hello = Hello\n");
        p.file("outside/main.ftl", "stolen = Stolen\n");
        p.file("pkg/outside.ftl", "stolen = Stolen\n");
        let hint: Vec<String> = ["..", "../../outside", "..\\..\\outside", "en", "C:\\", "", "locale"].iter().map(|s| s.to_string()).collect();
        let (got, warns) = read(&p, "locale", Some(&hint));
        assert_eq!(got, ["en:1"]);
        assert_eq!(warns.len(), 5);
    }

    #[test]
    fn a_folder_or_file_that_links_out_of_the_package_is_not_read() {
        let mut p = Pkg::new("link");
        p.file("pkg/locale/en/main.ftl", "hello = Hello\n");
        p.file("outside/main.ftl", "stolen = Stolen\n");
        p.dir("outside/fr");
        p.file("outside/fr/main.ftl", "stolen = Stolen\n");
        let link_dir = p.pkg().join("locale").join("fr");
        let link_file = p.pkg().join("locale").join("en").join("linked.ftl");
        // a junction needs no privilege; it is removed with `remove_dir`, which does not touch what it points to
        let made_dir = std::os::windows::fs::symlink_dir(p.root.join("outside").join("fr"), &link_dir).is_ok()
            || std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&link_dir)
                .arg(p.root.join("outside").join("fr"))
                .output()
                .is_ok_and(|o| o.status.success());
        let made_file = std::os::windows::fs::symlink_file(p.root.join("outside").join("main.ftl"), &link_file).is_ok();
        if !made_dir && !made_file {
            eprintln!("symbolic links are not allowed here: link cases not run");
            return;
        }
        if made_dir {
            p.dirs.push(link_dir);
        }
        if made_file {
            p.files.push(link_file);
        }
        let (got, _) = read(&p, "locale", None);
        // the folder link is skipped; the file link is not read, so `en` has only its own message
        assert!(!got.iter().any(|g| g.starts_with("fr:") && g != "fr:0"), "{got:?}");
        assert!(got.contains(&"en:1".to_string()), "{got:?}");
    }

    #[test]
    fn the_manager_loads_nothing_from_a_refused_folder() {
        let mut p = Pkg::new("mgr");
        p.file("outside/en/main.ftl", "stolen = Stolen\n");
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let logs = LogManager::new(Out(tx));
        let l = L10nManager::default();
        l.on_load("p@x", &p.pkg(), &json!({"locales": {"default": "en", "dir": "../outside"}}), None, &logs);
        assert!(l.plugin_locales("p@x", &logs).is_empty());
        assert!(!l.has_message("p@x", "stolen", &logs));
    }

    #[tokio::test]
    async fn sleeps_and_waits_count_against_the_allowance_and_end_on_unload() {
        use crate::host::testing::{add_slot, lock, test_host};
        use std::future::pending;
        use wasmtime::AsContextMut;
        let (host, _rx) = test_host();
        let slot = add_slot(&host, "p@x");
        let mut store = lock(&slot).await;
        store.data_mut().max_paused_ms = 300;
        store.data_mut().deadline_epoch = now_epoch() + 1000;
        let deadline_before = store.data().deadline_epoch;
        let mut cx = store.as_context_mut();

        // a sleep that fits is waited for, counted, and the CPU deadline is not used up meanwhile
        paused_wait(&mut cx, Some(100), tokio::time::sleep(Duration::from_millis(100))).await.unwrap();
        assert!(cx.data().paused_ms >= 90, "{}", cx.data().paused_ms);
        assert!(cx.data().deadline_epoch >= deadline_before);

        // one that cannot fit the rest is refused at once, as a timeout
        let t0 = Instant::now();
        let err = paused_wait(&mut cx, Some(250), tokio::time::sleep(Duration::from_secs(3600))).await.unwrap_err().to_string();
        assert!(err.contains(TIMEOUT_MARK), "{err}");
        assert!(t0.elapsed() < Duration::from_millis(80));

        // a wait of unknown length ends when the allowance is used up
        let err = paused_wait(&mut cx, None, pending::<()>()).await.unwrap_err().to_string();
        assert!(err.contains(TIMEOUT_MARK), "{err}");
        assert!(cx.data().paused_ms >= 290, "{}", cx.data().paused_ms);

        // and a wait ends when the plugin is unloaded
        cx.data_mut().max_paused_ms = 60_000;
        let cancel = cx.data().cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            cancel.set();
        });
        let t0 = Instant::now();
        let err = paused_wait(&mut cx, None, pending::<()>()).await.unwrap_err().to_string();
        assert!(err.contains(UNLOADED_MARK), "{err}");
        assert!(t0.elapsed() < Duration::from_secs(5));
    }
}
