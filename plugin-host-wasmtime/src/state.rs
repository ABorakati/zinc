//! Per-plugin store state, the stdout writer, the Bun bridge client and the forwarder to the parent (Zinc) process.
use wasmtime::error::Context;
use wasmtime::{format_err as anyhow, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};
use wasmtime::{Engine, ResourceLimiter};

/// Lines to stdout (NDJSON). Cloneable.
#[derive(Clone)]
pub struct Out(pub mpsc::UnboundedSender<String>);
impl Out {
    pub fn send(&self, v: Value) {
        let _ = self.0.send(v.to_string());
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
            return Err(anyhow!("plugin exceeded its memory limit ({} MiB): wanted {} MiB", self.max_memory >> 20, desired >> 20));
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
    pub engine: Engine,
    pub limits: Limits,
    pub out: Out,
    pub bridge: Option<Arc<Bridge>>,
    pub parent: Arc<Parent>,
    pub res_ids: Arc<HashMap<String, u32>>,
    pub next_rep: u32,
    /// Epoch at which the current call runs out of active time. Imports in flight extend it by the time they took.
    pub deadline_epoch: u64,
    pub waiting: u32,
    pub stdout_buf: String,
    pub stderr_buf: String,
    pub native_calls: Arc<AtomicU64>,
    pub bridged_calls: Arc<AtomicU64>,
}

impl St {
    pub fn send(&self, v: Value) {
        self.out.send(v);
    }
}

/// An import call that no bridge handler has is sent to the parent as an `import` message, as the Bun host does.
pub struct Parent {
    pub out: Out,
    next: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
}

impl Parent {
    pub fn new(out: Out) -> Arc<Self> {
        Arc::new(Self { out, next: AtomicU64::new(1), pending: Mutex::new(HashMap::new()) })
    }
    pub async fn import(&self, plugin: &str, iface: &str, f: &str, args: Vec<Value>) -> Value {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        self.out.send(json!({"t":"import","id":id,"plugin":plugin,"iface":iface,"fn":f,"args":args}));
        rx.await.unwrap_or_else(|_| json!({"ok":false,"error":{"kind":"host-restarting"}}))
    }
    pub fn reply(&self, id: u64, result: Value) {
        if let Some(tx) = self.pending.lock().unwrap().remove(&id) {
            let _ = tx.send(result);
        }
    }
}

/// Client of the small Bun process that runs the existing TypeScript handlers (bench/bridge.ts).
pub struct Bridge {
    tx: mpsc::UnboundedSender<String>,
    next: AtomicU64,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    ready: Mutex<Option<oneshot::Receiver<Value>>>,
    _child: tokio::process::Child,
}

impl Bridge {
    pub async fn spawn(bun: &str, script: &str, out: Out) -> Result<Arc<Self>> {
        let mut child = tokio::process::Command::new(bun)
            .arg(script)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .kill_on_drop(true)
            .spawn()?;
        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            while let Some(line) = rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err() || stdin.write_all(b"\n").await.is_err() {
                    break;
                }
                // flush only when the queue is drained: batches bursts
                if rx.is_empty() {
                    let _ = stdin.flush().await;
                }
            }
        });
        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>> = Arc::new(Mutex::new(HashMap::new()));
        let (ready_tx, ready_rx) = oneshot::channel();
        let p2 = pending.clone();
        tokio::spawn(async move {
            let mut ready_tx = Some(ready_tx);
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(m) = serde_json::from_str::<Value>(&line) else { continue };
                match m["t"].as_str() {
                    Some("ready") => {
                        if let Some(t) = ready_tx.take() {
                            let _ = t.send(m);
                        }
                    }
                    Some("reply") => {
                        if let Some(id) = m["id"].as_u64() {
                            if let Some(tx) = p2.lock().unwrap().remove(&id) {
                                let _ = tx.send(m["result"].clone());
                            }
                        }
                    }
                    Some("log") => out.send(m),
                    _ => {}
                }
            }
        });
        Ok(Arc::new(Self { tx, next: AtomicU64::new(1), pending, ready: Mutex::new(Some(ready_rx)), _child: child }))
    }

    pub fn notify(&self, v: Value) {
        let _ = self.tx.send(v.to_string());
    }

    pub async fn init(&self, host_modules: Value, discover: bool) -> Result<Value> {
        self.notify(json!({"t":"init","hostModules":host_modules,"discover":discover}));
        let rx = self.ready.lock().unwrap().take().ok_or_else(|| anyhow!("bridge already initialised"))?;
        Ok(rx.await?)
    }

    pub async fn call(&self, plugin: &str, iface: &str, f: &str, args: Vec<Value>) -> Value {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        self.notify(json!({"t":"call","id":id,"plugin":plugin,"iface":iface,"fn":f,"args":args}));
        rx.await.unwrap_or_else(|_| json!({"ok":false,"error":{"kind":"internal","message":"bridge process died"}}))
    }
}
