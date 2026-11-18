//! Per-plugin store state, the stdout NDJSON writer, live permission grants, and the forwarder to the parent (Zinc) process.
use crate::host::Host;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock, Weak};
use tokio::sync::{mpsc, oneshot};
use wasmtime::{format_err as anyhow, ResourceLimiter, Result};

/// Lines to stdout (NDJSON). Cloneable.
#[derive(Clone)]
pub struct Out(pub mpsc::UnboundedSender<String>);

impl Out {
    pub fn send(&self, v: Value) {
        let mut s = v.to_string();
        s.push('\n');
        let _ = self.0.send(s);
    }
}

/// Live permission set of a loaded plugin, updated in-place via `load` and `{t: "grants"}`.
#[derive(Clone, Debug, Default)]
pub struct Grants {
    pub capabilities: HashSet<String>,
    #[allow(dead_code)]
    pub net_hosts: Vec<String>,
}

impl Grants {
    pub fn from_json(v: &Value) -> Self {
        let capabilities = v
            .get("capabilities")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default();
        let net_hosts = v
            .get("netHosts")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default();
        Self { capabilities, net_hosts }
    }
}

/// Memory cap per plugin (wasmtime `ResourceLimiter`). `peak` is readable from outside the store.
pub struct Limits {
    pub max_memory: usize,
    pub max_table_elems: usize,
    pub peak: Arc<AtomicUsize>,
}

impl ResourceLimiter for Limits {
    fn memory_growing(&mut self, _current: usize, desired: usize, _maximum: Option<usize>) -> Result<bool> {
        if desired > self.max_memory {
            return Err(anyhow!(
                "plugin exceeded its memory limit ({} MiB): wanted {} MiB",
                self.max_memory >> 20,
                desired >> 20
            ));
        }
        self.peak.fetch_max(desired, Ordering::Relaxed);
        Ok(true)
    }
    fn table_growing(&mut self, _current: usize, desired: usize, _maximum: Option<usize>) -> Result<bool> {
        Ok(desired <= self.max_table_elems)
    }
}

pub struct St {
    pub id: String,
    pub host: Weak<Host>,
    pub limits: Limits,
    pub out: Out,
    pub parent: Arc<Parent>,
    pub res_ids: Arc<HashMap<String, u32>>,
    pub next_rep: u32,
    /// Epoch at which the current call runs out of active CPU time. Forwarded imports and `timers.sleep` pause it.
    pub deadline_epoch: u64,
    pub waiting: u32,
    pub waiting_parent: Arc<AtomicU32>,
    pub grants: Arc<RwLock<Grants>>,
    pub import_calls: u64,
    pub max_import_calls: u64,
    pub stdout_buf: String,
    pub stderr_buf: String,
    pub native_calls: Arc<AtomicU64>,
    pub forwarded_calls: Arc<AtomicU64>,
}

impl St {
    pub fn send(&self, v: Value) {
        self.out.send(v);
    }
}

/// Forwards every non-native `zinc:plugin/*` import directly to the parent Zinc process over stdio NDJSON.
pub struct Parent {
    pub out: Out,
    next: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
}

impl Parent {
    pub fn new(out: Out) -> Arc<Self> {
        Arc::new(Self {
            out,
            next: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
        })
    }

    pub async fn import(&self, plugin: &str, iface: &str, f: &str, args: Vec<Value>) -> Value {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        self.out
            .send(json!({"t":"import","id":id,"plugin":plugin,"iface":iface,"fn":f,"args":args}));
        rx.await
            .unwrap_or_else(|_| json!({"ok":false,"error":{"kind":"host-restarting"}}))
    }

    pub fn reply(&self, id: u64, result: Value) {
        if let Some(tx) = self.pending.lock().unwrap().remove(&id) {
            let _ = tx.send(result);
        }
    }
}
