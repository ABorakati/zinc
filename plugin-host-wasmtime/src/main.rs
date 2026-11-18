//! zhw: Wasmtime plugin host spike for Zinc.
//!
//!   zhw precompile <plugin.wasm> [out.cwasm]     wasm component -> .cwasm (Engine::precompile_component)
//!   zhw inspect <plugin.wasm>                    list imports and exports
//!   zhw run [--bridge bridge.ts] [--bun bun] [--aot] [--max-memory-mb 256] [--native log.write,...]
//!                                                NDJSON protocol on stdio (same messages as plugin-host/src/protocol.ts)
//!
//! Wire encoding: one JSON object per line. Values use jco's JS shapes with two escapes for what JSON lacks:
//! `{"$big":"123"}` (u64/s64, BigInt) and `{"$bytes":"<base64>"}` (list<u8>, Uint8Array).
mod conv;
mod host;
mod state;
mod wasi;

use wasmtime::error::Context;
use wasmtime::{format_err as anyhow, Result};
use host::{Host, HostCfg};
use serde_json::{json, Value};
use state::{Bridge, Out, Parent};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

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

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("precompile") => {
            let input = PathBuf::from(args.get(1).ok_or_else(|| anyhow!("usage: zhw precompile <plugin.wasm> [out.cwasm]"))?);
            let output = args.get(2).map(PathBuf::from).unwrap_or_else(|| input.with_extension("cwasm"));
            let engine = host::make_engine()?;
            let bytes = std::fs::read(&input)?;
            let t = Instant::now();
            let out = engine.precompile_component(&bytes).context("precompile")?;
            let ms = t.elapsed().as_secs_f64() * 1000.0;
            std::fs::write(&output, &out)?;
            println!("{}", json!({"input":input,"output":output,"wasmBytes":bytes.len(),"cwasmBytes":out.len(),"precompileMs":ms}));
            Ok(())
        }
        Some("inspect") => {
            let engine = host::make_engine()?;
            let comp = wasmtime::component::Component::from_file(&engine, args.get(1).ok_or_else(|| anyhow!("usage: zhw inspect <plugin.wasm>"))?)?;
            let ct = comp.component_type();
            let list = |it: Vec<(&str, wasmtime::component::types::ComponentExtern<'_>)>| -> Vec<Value> {
                it.into_iter()
                    .map(|(n, e)| match e.ty {
                        wasmtime::component::types::ComponentItem::ComponentInstance(ci) => json!({"name":n,"functions":ci.exports(&engine).map(|(f,_)| f.to_string()).collect::<Vec<_>>()}),
                        _ => json!({"name":n}),
                    })
                    .collect()
            };
            println!("{}", json!({"imports":list(ct.imports(&engine).collect()),"exports":list(ct.exports(&engine).collect())}));
            Ok(())
        }
        Some("run") => {
            let rt = tokio::runtime::Builder::new_multi_thread().enable_all().worker_threads(4).build()?;
            rt.block_on(run(args))
        }
        _ => {
            eprintln!("usage: zhw precompile|inspect|run ...");
            std::process::exit(2);
        }
    }
}

async fn run(args: Vec<String>) -> Result<()> {
    let t_start = Instant::now();
    let engine = host::make_engine()?;
    host::start_ticker(&engine);
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let out = Out(tx);
    tokio::spawn(async move {
        let mut so = tokio::io::stdout();
        while let Some(line) = rx.recv().await {
            if so.write_all(line.as_bytes()).await.is_err() || so.write_all(b"\n").await.is_err() {
                std::process::exit(0);
            }
            if rx.is_empty() {
                let _ = so.flush().await;
            }
        }
    });
    let parent = Parent::new(out.clone());
    let bridge = match arg(&args, "--bridge") {
        Some(script) => Some(Bridge::spawn(&arg(&args, "--bun").unwrap_or_else(|| "bun".into()), &script, out.clone()).await?),
        None => None,
    };
    let native: HashSet<String> = arg(&args, "--native").unwrap_or_else(|| "log.write".into()).split(',').filter(|s| !s.is_empty()).map(str::to_string).collect();
    let cfg = Arc::new(HostCfg {
        max_memory_mb: arg(&args, "--max-memory-mb").and_then(|s| s.parse().ok()).unwrap_or(256),
        prefer_cwasm: args.iter().any(|a| a == "--aot"),
        native,
    });
    let host = Arc::new(Host { engine, cfg, out: out.clone(), bridge, parent: parent.clone(), slots: Default::default() });

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(m) = serde_json::from_str::<Value>(&line) else { continue };
        let host = host.clone();
        let out = out.clone();
        match m["t"].as_str().unwrap_or("") {
            "init" => {
                let mut interfaces = json!([]);
                let mut bridge_pid = Value::Null;
                if let Some(b) = &host.bridge {
                    match b.init(m["hostModules"].clone(), m["discover"] != false).await {
                        Ok(r) => {
                            interfaces = r["interfaces"].clone();
                            bridge_pid = r["pid"].clone();
                        }
                        Err(e) => out.send(json!({"t":"log","level":"error","message":format!("bridge init failed: {e:#}")})),
                    }
                }
                out.send(json!({"t":"ready","pid":std::process::id(),"interfaces":interfaces,"bridgePid":bridge_pid,"startupMs":t_start.elapsed().as_secs_f64()*1000.0}));
                let hb = m["heartbeatMs"].as_u64().unwrap_or(1000).max(50);
                tokio::spawn(async move {
                    let mut iv = tokio::time::interval(std::time::Duration::from_millis(hb));
                    loop {
                        iv.tick().await;
                        out.send(json!({"t":"heartbeat","ts":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)}));
                    }
                });
            }
            "load" => {
                tokio::spawn(async move {
                    let id = m["id"].clone();
                    let spec = &m["plugin"];
                    let pid = spec["id"].as_str().unwrap_or("").to_string();
                    let dir = PathBuf::from(spec["dir"].as_str().unwrap_or("."));
                    let wasm = spec["manifest"]["main"]["wasm"].as_str().unwrap_or("plugin.wasm").to_string();
                    if let Some(b) = &host.bridge {
                        b.notify(json!({"t":"plugin","spec":spec}));
                    }
                    let t = Instant::now();
                    let result = match host.load(&pid, &dir, &wasm).await {
                        Ok(i) => json!({"ok":true,"value":{"compileMs":i.compile_ms,"linkMs":i.link_ms,"instantiateMs":i.instantiate_ms,"totalMs":t.elapsed().as_secs_f64()*1000.0,"fromCwasm":i.from_cwasm}}),
                        Err(e) => json!({"ok":false,"error":{"kind":"internal","message":format!("load failed: {e:#}")}}),
                    };
                    out.send(json!({"t":"reply","id":id,"result":result}));
                });
            }
            "unload" => {
                host.unload(m["plugin"].as_str().unwrap_or(""));
                if let Some(b) = &host.bridge {
                    b.notify(json!({"t":"unplug","plugin":m["plugin"]}));
                }
                out.send(json!({"t":"reply","id":m["id"],"result":{"ok":true,"value":null}}));
            }
            "call" => {
                tokio::spawn(async move {
                    let args = m["args"].as_array().cloned().unwrap_or_default();
                    let result = host.call(m["plugin"].as_str().unwrap_or(""), m["iface"].as_str().unwrap_or(""), m["fn"].as_str().unwrap_or(""), &args, m["timeoutMs"].as_u64()).await;
                    out.send(json!({"t":"reply","id":m["id"],"result":result}));
                });
            }
            "import-reply" => parent.reply(m["id"].as_u64().unwrap_or(0), m["result"].clone()),
            "stats" => out.send(json!({"t":"reply","id":m["id"],"result":{"ok":true,"value":host.stats()}})),
            "grants" | "call-reply" => {}
            "exit" => {
                std::process::exit(0);
            }
            _ => {}
        }
    }
    // stdin closed: the parent is gone.
    Ok(())
}
