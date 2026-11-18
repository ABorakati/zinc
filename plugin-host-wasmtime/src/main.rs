//! zhw: Native Wasmtime plugin host for Zinc (`protocol-ndjson.md`).
//!
//!   zhw version
//!   zhw precompile <plugin.wasm> [out.cwasm]
//!   zhw inspect <plugin.wasm>
//!   zhw run [--aot] [--max-memory-mb 256] [--max-import-calls 1000000] [--native log,prefs,timers,l10n,app,util]
mod conv;
mod crypto;
mod fluent;
mod host;
mod native;
mod state;
mod wasi;

use host::{Host, HostCfg};
use serde_json::{json, Value};
use state::{Out, Parent};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use wasmtime::error::Context;
use wasmtime::{format_err as anyhow, Result};

const WASMTIME_VERSION: &str = "50.0.2";

#[cfg(windows)]
pub fn rss_bytes() -> u64 {
    use windows_sys::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    unsafe {
        let mut c: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
        c.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        if GetProcessMemoryInfo(GetCurrentProcess(), &mut c, c.cb) != 0 {
            c.WorkingSetSize as u64
        } else {
            0
        }
    }
}

#[cfg(not(windows))]
pub fn rss_bytes() -> u64 {
    0
}

fn os_name() -> &'static str {
    match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "macos",
        "linux" => "linux",
        other => other,
    }
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("version") => {
            let version = env!("CARGO_PKG_VERSION");
            let os = os_name();
            let arch = std::env::consts::ARCH;
            let opt = host::opt_level_name();
            let cache_key = format!("zhw-{version}-wt{WASMTIME_VERSION}-{os}-{arch}-{opt}");
            println!(
                "{}",
                json!({
                    "version": version,
                    "wasmtime": WASMTIME_VERSION,
                    "os": os,
                    "arch": arch,
                    "opt": opt,
                    "cacheKey": cache_key,
                })
            );
            Ok(())
        }
        Some("precompile") => {
            let input = PathBuf::from(args.get(1).ok_or_else(|| anyhow!("usage: zhw precompile <plugin.wasm> [out.cwasm]"))?);
            let output = args.get(2).map(PathBuf::from).unwrap_or_else(|| input.with_extension("cwasm"));
            if let Some(parent) = output.parent() {
                if !parent.as_os_str().is_empty() {
                    std::fs::create_dir_all(parent)?;
                }
            }
            let engine = host::make_engine()?;
            let bytes = std::fs::read(&input).with_context(|| format!("read {}", input.display()))?;
            let t = Instant::now();
            let out = engine.precompile_component(&bytes).context("precompile")?;
            let ms = t.elapsed().as_secs_f64() * 1000.0;
            let tmp = PathBuf::from(format!("{}.tmp.{}", output.display(), std::process::id()));
            std::fs::write(&tmp, &out).with_context(|| format!("write {}", tmp.display()))?;
            if let Err(e) = std::fs::rename(&tmp, &output) {
                let _ = std::fs::remove_file(&tmp);
                return Err(e).with_context(|| format!("rename {} -> {}", tmp.display(), output.display()));
            }
            println!(
                "{}",
                json!({
                    "input": input,
                    "output": output,
                    "wasmBytes": bytes.len(),
                    "cwasmBytes": out.len(),
                    "precompileMs": ms,
                })
            );
            Ok(())
        }
        Some("inspect") => {
            let engine = host::make_engine()?;
            let comp = wasmtime::component::Component::from_file(
                &engine,
                args.get(1).ok_or_else(|| anyhow!("usage: zhw inspect <plugin.wasm>"))?,
            )?;
            let ct = comp.component_type();
            let list = |it: Vec<(&str, wasmtime::component::types::ComponentExtern<'_>)>| -> Vec<Value> {
                it.into_iter()
                    .map(|(n, e)| match e.ty {
                        wasmtime::component::types::ComponentItem::ComponentInstance(ci) => {
                            json!({"name":n,"functions":ci.exports(&engine).map(|(f,_)| f.to_string()).collect::<Vec<_>>()})
                        }
                        _ => json!({"name":n}),
                    })
                    .collect()
            };
            println!(
                "{}",
                json!({"imports":list(ct.imports(&engine).collect()),"exports":list(ct.exports(&engine).collect())})
            );
            Ok(())
        }
        Some("run") => {
            let rt = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .worker_threads(4)
                .build()?;
            rt.block_on(run(args))
        }
        _ => {
            eprintln!("usage: zhw version|precompile|inspect|run ...");
            std::process::exit(2);
        }
    }
}

async fn run(args: Vec<String>) -> Result<()> {
    let t_start = Instant::now();
    let _ = native::monotonic_ms_now();
    let engine = host::make_engine()?;
    host::start_ticker(&engine);

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let out = Out(tx);
    let writer_handle = tokio::spawn(async move {
        let mut so = tokio::io::stdout();
        while let Some(line) = rx.recv().await {
            if so.write_all(line.as_bytes()).await.is_err() {
                std::process::exit(0);
            }
            if rx.is_empty() {
                let _ = so.flush().await;
            }
        }
        let _ = so.flush().await;
    });

    let parent = Parent::new(out.clone());
    let cli_native: Vec<String> = arg(&args, "--native")
        .unwrap_or_else(|| "log,prefs,timers,l10n,app,util".into())
        .split(',')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    let cfg = Arc::new(HostCfg::new(
        args.iter().any(|a| a == "--aot"),
        arg(&args, "--max-memory-mb").and_then(|s| s.parse().ok()).unwrap_or(256),
        arg(&args, "--max-import-calls").and_then(|s| s.parse().ok()).unwrap_or(1_000_000),
        cli_native,
    ));
    let host = Host::new(engine, cfg, out.clone(), parent.clone());

    // Periodic 10 ms flush of buffered native log batches.
    {
        let logs = host.logs.clone();
        tokio::spawn(async move {
            let mut iv = tokio::time::interval(Duration::from_millis(10));
            iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                iv.tick().await;
                logs.flush();
            }
        });
    }

    let mut heartbeat_started = false;
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(m) = serde_json::from_str::<Value>(&line) else { continue };
        match m["t"].as_str().unwrap_or("") {
            "init" => {
                if let Some(mb) = m.get("maxMemoryMb").and_then(Value::as_u64) {
                    host.cfg.max_memory_mb.store(mb as usize, Ordering::Relaxed);
                }
                if let Some(max_ic) = m.get("maxImportCalls").and_then(Value::as_u64) {
                    host.cfg.max_import_calls.store(max_ic, Ordering::Relaxed);
                }
                if let Some(arr) = m.get("native").and_then(Value::as_array) {
                    host.cfg.set_native(arr.iter().filter_map(Value::as_str).map(str::to_string));
                }
                if let Some(dbg) = m.get("debugEnabled").and_then(Value::as_bool) {
                    host.logs.set_debug_enabled(dbg);
                }
                if let Some(app_obj) = m.get("app") {
                    if app_obj.is_object() {
                        host.app.on_push(app_obj, &host.l10n);
                    }
                }
                let interfaces = host.cfg.enabled_interfaces();
                out.send(json!({
                    "t": "ready",
                    "pid": std::process::id(),
                    "version": env!("CARGO_PKG_VERSION"),
                    "interfaces": interfaces,
                    "startupMs": t_start.elapsed().as_secs_f64() * 1000.0,
                }));
                if !heartbeat_started {
                    heartbeat_started = true;
                    let hb = m["heartbeatMs"].as_u64().unwrap_or(1000).max(50);
                    let hb_out = out.clone();
                    tokio::spawn(async move {
                        let mut iv = tokio::time::interval(Duration::from_millis(hb));
                        iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                        loop {
                            iv.tick().await;
                            hb_out.send(json!({
                                "t": "heartbeat",
                                "ts": native::epoch_ms_now(),
                            }));
                        }
                    });
                }
            }
            "load" => {
                let host = host.clone();
                let out = out.clone();
                tokio::spawn(async move {
                    let id = m["id"].clone();
                    let t = Instant::now();
                    let result = match host.load(&m["plugin"]).await {
                        Ok(i) => json!({
                            "ok": true,
                            "value": {
                                "compileMs": i.compile_ms,
                                "linkMs": i.link_ms,
                                "instantiateMs": i.instantiate_ms,
                                "totalMs": t.elapsed().as_secs_f64() * 1000.0,
                                "fromCwasm": i.from_cwasm,
                            }
                        }),
                        Err(e) => json!({
                            "ok": false,
                            "error": { "kind": "internal", "message": format!("load failed: {e:#}") }
                        }),
                    };
                    host.logs.flush();
                    out.send(json!({"t":"reply","id":id,"result":result}));
                });
            }
            "unload" => {
                host.unload(m["plugin"].as_str().unwrap_or(""));
                out.send(json!({"t":"reply","id":m["id"],"result":{"ok":true,"value":null}}));
            }
            "call" => {
                let host = host.clone();
                let out = out.clone();
                tokio::spawn(async move {
                    let args = m["args"].as_array().cloned().unwrap_or_default();
                    let result = host
                        .call_internal(
                            m["plugin"].as_str().unwrap_or(""),
                            m["iface"].as_str().unwrap_or(""),
                            m["fn"].as_str().unwrap_or(""),
                            &args,
                            m["timeoutMs"].as_u64(),
                            m["maxImportCalls"].as_u64(),
                            true,
                        )
                        .await;
                    out.send(json!({"t":"reply","id":m["id"],"result":result}));
                });
            }
            "import-reply" => parent.reply(m["id"].as_u64().unwrap_or(0), m["result"].clone()),
            "grants" => {
                if let Some(pid) = m.get("plugin").and_then(Value::as_str) {
                    host.update_grants(pid, &m["grants"]);
                }
            }
            "prefs" => host.prefs.on_push(&m),
            "l10n" => host.l10n.on_push(&m, &host.app, &host.logs),
            "app" => host.app.on_push(&m, &host.l10n),
            "log-config" => {
                if let Some(dbg) = m.get("debugEnabled").and_then(Value::as_bool) {
                    host.logs.set_debug_enabled(dbg);
                }
            }
            "timers-clear" => match m.get("plugin").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                Some(pid) => host.timers.clear_plugin(pid, true),
                None => host.timers.clear_all(&host.loaded_plugin_ids()),
            },
            "stats" => {
                host.logs.flush();
                out.send(json!({"t":"reply","id":m["id"],"result":{"ok":true,"value":host.stats()}}));
            }
            "exit" => {
                host.logs.flush();
                drop(host);
                drop(parent);
                drop(out);
                let _ = tokio::time::timeout(Duration::from_millis(200), writer_handle).await;
                std::process::exit(0);
            }
            _ => {}
        }
    }

    // stdin closed: flush pending output and exit 0.
    host.logs.flush();
    drop(host);
    drop(parent);
    drop(out);
    let _ = tokio::time::timeout(Duration::from_millis(200), writer_handle).await;
    std::process::exit(0);
}
