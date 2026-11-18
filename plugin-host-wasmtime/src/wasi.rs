//! Stubs for every `wasi:*` import, like plugin-host/src/wasi-stubs.ts: no environment, no files, no sockets, no blocking.
//! What a Rust (wasm32-wasip2) or QuickJS guest needs to start (random seed, clock, stderr for a panic message) gets harmless
//! values; everything else traps with a clear message. Resources (streams, pollables, ...) are host-dynamic handles with a small rep.
use crate::state::St;
use serde_json::json;
use std::sync::OnceLock;
use std::time::Instant;
use wasmtime::component::{ResourceDynamic, Val};
use wasmtime::{bail, format_err as anyhow, Result, StoreContextMut};

const STDIN: u32 = 1;
const STDOUT: u32 = 2;
const STDERR: u32 = 3;

fn denied(what: &str) -> wasmtime::Error {
    anyhow!("WASI is not available to Zinc plugins ({what}). Use the zinc:plugin interfaces.")
}

fn rand_u64() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u8(1);
    h.finish()
}

fn mono_ns() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_nanos() as u64 + 1_000_000
}

fn mk_res(cx: &mut StoreContextMut<'_, St>, key: &str, rep: u32) -> Result<Val> {
    let id = *cx
        .data()
        .res_ids
        .get(key)
        .ok_or_else(|| anyhow!("component does not import resource {key}"))?;
    Ok(Val::Resource(ResourceDynamic::new_own(rep, id).try_into_resource_any(&mut *cx)?))
}

fn sink(cx: &mut StoreContextMut<'_, St>, rep: u32, bytes: &[u8]) {
    let id = cx.data().id.clone();
    let buf = if rep == STDERR { &mut cx.data_mut().stderr_buf } else { &mut cx.data_mut().stdout_buf };
    buf.push_str(&String::from_utf8_lossy(bytes));
    let mut lines = Vec::new();
    while let Some(i) = buf.find('\n') {
        let line: String = buf.drain(..=i).collect();
        lines.push(line.trim_end_matches(['\r', '\n']).to_string());
    }
    for l in lines {
        let stream = if rep == STDERR { "stderr" } else { "stdout" };
        let level = if rep == STDERR { "warn" } else { "info" };
        cx.data().send(json!({"t":"log","plugin":id,"level":level,"message":format!("[{stream}] {l}")}));
    }
}

pub fn flush_stdio(st: &mut St) {
    if !st.stdout_buf.is_empty() {
        let rem = std::mem::take(&mut st.stdout_buf);
        let l = rem.trim_end_matches(['\r', '\n']);
        if !l.is_empty() {
            st.send(json!({"t":"log","plugin":st.id,"level":"info","message":format!("[stdout] {l}")}));
        }
    }
    if !st.stderr_buf.is_empty() {
        let rem = std::mem::take(&mut st.stderr_buf);
        let l = rem.trim_end_matches(['\r', '\n']);
        if !l.is_empty() {
            st.send(json!({"t":"log","plugin":st.id,"level":"warn","message":format!("[stderr] {l}")}));
        }
    }
}

pub fn call(cx: &mut StoreContextMut<'_, St>, iface: &str, name: &str, params: &[Val], results: &mut [Val]) -> Result<()> {
    // Every borrowed handle in the arguments must be released before returning, or the call traps.
    let mut reps: Vec<u32> = Vec::new();
    for p in params {
        if let Val::Resource(ra) = p {
            reps.push(ResourceDynamic::try_from_resource_any(*ra, &mut *cx)?.rep());
        }
    }
    let r0 = |results: &mut [Val], v: Val| {
        if let Some(r) = results.first_mut() {
            *r = v;
        }
    };
    match (iface, name) {
        ("wasi:cli/environment", "get-environment" | "get-arguments") => r0(results, Val::List(vec![])),
        ("wasi:cli/environment", "initial-cwd") => r0(results, Val::Option(None)),
        ("wasi:cli/exit", _) => bail!(denied("the plugin called exit")),
        ("wasi:cli/stdin", "get-stdin") => r0(results, mk_res(cx, "wasi:io/streams#input-stream", STDIN)?),
        ("wasi:cli/stdout", "get-stdout") => r0(results, mk_res(cx, "wasi:io/streams#output-stream", STDOUT)?),
        ("wasi:cli/stderr", "get-stderr") => r0(results, mk_res(cx, "wasi:io/streams#output-stream", STDERR)?),
        ("wasi:cli/terminal-stdin" | "wasi:cli/terminal-stdout" | "wasi:cli/terminal-stderr", _) => r0(results, Val::Option(None)),
        ("wasi:clocks/monotonic-clock", "now") => r0(results, Val::U64(mono_ns())),
        ("wasi:clocks/monotonic-clock", "resolution") => r0(results, Val::U64(1000)),
        ("wasi:clocks/wall-clock", "now") => {
            let d = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
            r0(
                results,
                Val::Record(vec![("seconds".into(), Val::U64(d.as_secs())), ("nanoseconds".into(), Val::U32(d.subsec_nanos()))]),
            );
        }
        ("wasi:clocks/wall-clock", "resolution") => {
            r0(results, Val::Record(vec![("seconds".into(), Val::U64(0)), ("nanoseconds".into(), Val::U32(1_000_000))]))
        }
        ("wasi:random/random" | "wasi:random/insecure", "get-random-bytes" | "get-insecure-random-bytes") => {
            let n = match params.first() {
                Some(Val::U64(n)) => (*n).min(1 << 20) as usize,
                _ => 0,
            };
            let mut v = Vec::with_capacity(n);
            while v.len() < n {
                v.extend_from_slice(&rand_u64().to_le_bytes());
            }
            v.truncate(n);
            r0(results, Val::List(v.into_iter().map(Val::U8).collect()));
        }
        ("wasi:random/random" | "wasi:random/insecure", "get-random-u64" | "get-insecure-random-u64") => r0(results, Val::U64(rand_u64())),
        ("wasi:random/insecure-seed", "insecure-seed") => r0(results, Val::Tuple(vec![Val::U64(rand_u64()), Val::U64(rand_u64())])),
        ("wasi:filesystem/preopens", "get-directories") => r0(results, Val::List(vec![])),
        ("wasi:filesystem/types", "filesystem-error-code") => r0(results, Val::Option(None)),
        ("wasi:io/error", "[method]error.to-debug-string") => r0(results, Val::String("error".into())),
        ("wasi:io/streams", n) if n.starts_with("[method]output-stream.") => match &n["[method]output-stream.".len()..] {
            "check-write" => r0(results, Val::Result(Ok(Some(Box::new(Val::U64(65536)))))),
            "write" | "blocking-write-and-flush" => {
                let rep = *reps.first().ok_or_else(|| anyhow!("expected a resource as first argument"))?;
                if let Some(Val::List(items)) = params.get(1) {
                    let bytes: Vec<u8> = items.iter().filter_map(|v| if let Val::U8(b) = v { Some(*b) } else { None }).collect();
                    sink(cx, rep, &bytes);
                }
                r0(results, Val::Result(Ok(None)));
            }
            "flush" | "blocking-flush" | "write-zeroes" | "blocking-write-zeroes-and-flush" => r0(results, Val::Result(Ok(None))),
            "subscribe" => r0(results, mk_res(cx, "wasi:io/poll#pollable", 10)?),
            other => bail!(denied(&format!("output-stream.{other}"))),
        },
        ("wasi:io/streams", n) if n.starts_with("[method]input-stream.") => match &n["[method]input-stream.".len()..] {
            "read" | "blocking-read" => r0(results, Val::Result(Ok(Some(Box::new(Val::List(vec![])))))),
            "skip" | "blocking-skip" => r0(results, Val::Result(Ok(Some(Box::new(Val::U64(0)))))),
            "subscribe" => r0(results, mk_res(cx, "wasi:io/poll#pollable", 10)?),
            other => bail!(denied(&format!("input-stream.{other}"))),
        },
        (i, n) => bail!(denied(&format!("{i}#{n}"))),
    }
    Ok(())
}
