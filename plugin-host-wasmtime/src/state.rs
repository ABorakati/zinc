//! Per-plugin store state, the stdout NDJSON writer, live permission grants, and the forwarder to the parent (Zinc) process.
use crate::host::Host;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
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

/// Most linear memories, tables and core instances one plugin store may create (wasmtime's own defaults are 10,000).
/// A component built by wit-component has one memory per core module and a handful of modules; 64 leaves room for that.
pub const MAX_MEMORIES: usize = 16;
pub const MAX_TABLES: usize = 32;
pub const MAX_INSTANCES: usize = 64;

/// Memory cap per plugin (wasmtime `ResourceLimiter`). `max_memory` and `max_table_elems` are totals over every memory and
/// table of the store, not per memory. `peak` is the largest memory total, readable from outside the store.
pub struct Limits {
    pub max_memory: usize,
    pub max_table_elems: usize,
    pub peak: Arc<AtomicUsize>,
    mem_total: usize,
    table_total: usize,
    /// Growth granted by the latest `*_growing` call, taken back when wasmtime reports that the growth then failed.
    last_mem_delta: usize,
    last_table_delta: usize,
}

impl Limits {
    pub fn new(max_memory: usize, max_table_elems: usize, peak: Arc<AtomicUsize>) -> Self {
        Self { max_memory, max_table_elems, peak, mem_total: 0, table_total: 0, last_mem_delta: 0, last_table_delta: 0 }
    }
}

impl ResourceLimiter for Limits {
    fn memory_growing(&mut self, current: usize, desired: usize, _maximum: Option<usize>) -> Result<bool> {
        let delta = desired.saturating_sub(current);
        let total = self.mem_total.saturating_add(delta);
        if total > self.max_memory {
            return Err(anyhow!(
                "plugin exceeded its memory limit ({} MiB): wanted {} MiB",
                self.max_memory >> 20,
                total >> 20
            ));
        }
        self.mem_total = total;
        self.last_mem_delta = delta;
        self.peak.fetch_max(total, Ordering::Relaxed);
        Ok(true)
    }
    fn memory_grow_failed(&mut self, _error: wasmtime::Error) -> Result<()> {
        self.mem_total = self.mem_total.saturating_sub(std::mem::take(&mut self.last_mem_delta));
        Ok(())
    }
    fn table_growing(&mut self, current: usize, desired: usize, _maximum: Option<usize>) -> Result<bool> {
        let delta = desired.saturating_sub(current);
        let total = self.table_total.saturating_add(delta);
        if total > self.max_table_elems {
            return Ok(false);
        }
        self.table_total = total;
        self.last_table_delta = delta;
        Ok(true)
    }
    fn table_grow_failed(&mut self, _error: wasmtime::Error) -> Result<()> {
        self.table_total = self.table_total.saturating_sub(std::mem::take(&mut self.last_table_delta));
        Ok(())
    }
    fn memories(&self) -> usize {
        MAX_MEMORIES
    }
    fn tables(&self) -> usize {
        MAX_TABLES
    }
    fn instances(&self) -> usize {
        MAX_INSTANCES
    }
}

/// Set when a plugin is unloaded so that its calls in flight (a sleep, a wait, a host import) end at once.
pub struct Cancel {
    flag: AtomicBool,
    notify: tokio::sync::Notify,
}

impl Cancel {
    pub fn new() -> Arc<Self> {
        Arc::new(Self { flag: AtomicBool::new(false), notify: tokio::sync::Notify::new() })
    }
    pub fn set(&self) {
        self.flag.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }
    pub fn is_set(&self) -> bool {
        self.flag.load(Ordering::Acquire)
    }
    /// Resolves once `set` was called (at once if it already was).
    pub async fn cancelled(&self) {
        let n = self.notify.notified();
        if self.is_set() {
            return;
        }
        n.await;
    }
}

pub struct St {
    pub id: String,
    pub cancel: Arc<Cancel>,
    /// Time in ms the current call has spent in native sleeps and waits (the CPU epoch deadline does not run meanwhile).
    pub paused_ms: u64,
    pub max_paused_ms: u64,
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

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: usize = 1 << 20;

    fn limits(max_mib: usize) -> Limits {
        Limits::new(max_mib * MIB, 1_000, Arc::new(AtomicUsize::new(0)))
    }

    #[test]
    fn memory_cap_is_a_total_over_all_memories() {
        let mut l = limits(256);
        // two memories of 200 MiB each: each is under the cap, together they are not
        assert!(l.memory_growing(0, 200 * MIB, None).unwrap());
        let err = l.memory_growing(0, 200 * MIB, None).unwrap_err().to_string();
        assert!(err.contains("memory limit"), "{err}");
        assert_eq!(l.peak.load(Ordering::Relaxed), 200 * MIB);
        // growing the first memory (current 200 MiB) by 56 MiB reaches the cap exactly
        assert!(l.memory_growing(200 * MIB, 256 * MIB, None).unwrap());
        assert!(l.memory_growing(256 * MIB, 257 * MIB, None).is_err());
    }

    #[test]
    fn a_growth_that_then_failed_is_taken_back() {
        let mut l = limits(256);
        assert!(l.memory_growing(0, 100 * MIB, None).unwrap());
        // allowed here, refused by the memory's own maximum: it must not count
        assert!(l.memory_growing(100 * MIB, 250 * MIB, None).unwrap());
        l.memory_grow_failed(wasmtime::format_err!("over the declared maximum")).unwrap();
        assert!(l.memory_growing(100 * MIB, 200 * MIB, None).unwrap());
    }

    #[test]
    fn table_cap_is_a_total_and_a_failed_growth_is_taken_back() {
        let mut l = limits(256);
        assert!(l.table_growing(0, 600, None).unwrap());
        assert!(!l.table_growing(0, 600, None).unwrap());
        assert!(l.table_growing(0, 400, None).unwrap());
        l.table_grow_failed(wasmtime::format_err!("over the declared maximum")).unwrap();
        assert!(l.table_growing(0, 400, None).unwrap());
    }

    #[test]
    fn counts_are_capped_far_below_the_wasmtime_defaults() {
        let l = limits(256);
        assert!(l.memories() <= 64 && l.tables() <= 64 && l.instances() <= 256);
        assert!(l.memories() >= 4 && l.tables() >= 4 && l.instances() >= 16);
    }

    #[tokio::test]
    async fn cancel_ends_a_wait_now_or_later() {
        let c = Cancel::new();
        let waiting = {
            let c = c.clone();
            tokio::spawn(async move { c.cancelled().await })
        };
        tokio::task::yield_now().await;
        assert!(!c.is_set());
        c.set();
        tokio::time::timeout(std::time::Duration::from_secs(5), waiting).await.expect("woken").unwrap();
        // already set: resolves at once
        tokio::time::timeout(std::time::Duration::from_secs(5), c.cancelled()).await.expect("already set");
    }
}
