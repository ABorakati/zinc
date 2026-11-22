//! Stubs for every `wasi:*` import, like plugin-host/src/wasi-stubs.ts: no environment, no files, no sockets, no blocking.
//! What a Rust (wasm32-wasip2) or QuickJS guest needs to start (random seed, clock, stderr for a panic message) gets harmless
//! values; everything else traps with a clear message. Resources (streams, pollables, ...) are host-dynamic handles with a small rep.
use crate::state::St;
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

/// Fast, non-cryptographic randomness for `wasi:random/insecure*`.
fn rand_u64() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u8(1);
    h.finish()
}

/// `n` random bytes. `secure` (`wasi:random/random`, which guests use for keys, tokens and nonces) comes from the operating
/// system's CSPRNG; the insecure interface keeps the fast path.
fn random_bytes(secure: bool, n: usize) -> Result<Vec<u8>> {
    if secure {
        let mut v = vec![0u8; n];
        crate::crypto::fill_random(&mut v)?;
        return Ok(v);
    }
    let mut v = Vec::with_capacity(n);
    while v.len() < n {
        v.extend_from_slice(&rand_u64().to_le_bytes());
    }
    v.truncate(n);
    Ok(v)
}

fn random_u64(secure: bool) -> Result<u64> {
    if secure {
        let mut b = [0u8; 8];
        crate::crypto::fill_random(&mut b)?;
        return Ok(u64::from_le_bytes(b));
    }
    Ok(rand_u64())
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

/// The longest unfinished line kept per stream. A guest that never writes a newline gets its text cut into lines of this size.
const MAX_STDIO_LINE: usize = 64 * 1024;

/// Adds what a guest wrote to `buf` (the unfinished line) and pushes every finished line to `out`. Linear in `chunk`, and `buf`
/// never grows beyond `MAX_STDIO_LINE` bytes.
fn split_stdio(buf: &mut String, chunk: &str, out: &mut Vec<String>) {
    fn append(buf: &mut String, mut seg: &str, out: &mut Vec<String>) {
        while buf.len() + seg.len() > MAX_STDIO_LINE {
            let mut cut = MAX_STDIO_LINE - buf.len();
            while !seg.is_char_boundary(cut) {
                cut -= 1;
            }
            buf.push_str(&seg[..cut]);
            out.push(std::mem::take(buf));
            seg = &seg[cut..];
        }
        buf.push_str(seg);
    }
    let mut rest = chunk;
    while let Some(i) = rest.find('\n') {
        append(buf, &rest[..i], out);
        out.push(std::mem::take(buf));
        rest = &rest[i + 1..];
    }
    append(buf, rest, out);
}

fn emit_stdio(st: &St, stderr: bool, lines: Vec<String>) {
    let Some(host) = st.host.upgrade() else { return };
    let (stream, level) = if stderr { ("stderr", "warn") } else { ("stdout", "info") };
    for l in lines {
        // Through the log manager, so a flood of lines is rate limited and cut like any other plugin log.
        host.logs.write(&st.id, level, &format!("[{stream}] {}", l.trim_end_matches('\r')));
    }
}

fn sink(cx: &mut StoreContextMut<'_, St>, rep: u32, bytes: &[u8]) {
    let stderr = rep == STDERR;
    let mut lines = Vec::new();
    {
        let d = cx.data_mut();
        let buf = if stderr { &mut d.stderr_buf } else { &mut d.stdout_buf };
        split_stdio(buf, &String::from_utf8_lossy(bytes), &mut lines);
    }
    emit_stdio(cx.data(), stderr, lines);
}

pub fn flush_stdio(st: &mut St) {
    for stderr in [false, true] {
        let rem = std::mem::take(if stderr { &mut st.stderr_buf } else { &mut st.stdout_buf });
        let l = rem.trim_end_matches(['\r', '\n']);
        if !l.is_empty() {
            emit_stdio(st, stderr, vec![l.to_string()]);
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
            let v = random_bytes(iface == "wasi:random/random", n)?;
            r0(results, Val::List(v.into_iter().map(Val::U8).collect()));
        }
        ("wasi:random/random" | "wasi:random/insecure", "get-random-u64" | "get-insecure-random-u64") => {
            r0(results, Val::U64(random_u64(iface == "wasi:random/random")?))
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn run(chunks: &[&str]) -> (Vec<String>, String) {
        let (mut buf, mut out) = (String::new(), Vec::new());
        for c in chunks {
            split_stdio(&mut buf, c, &mut out);
        }
        (out, buf)
    }

    #[test]
    fn lines_are_split_and_the_unfinished_one_is_kept() {
        let (lines, rest) = run(&["one\ntw", "o\n\nthree"]);
        assert_eq!(lines, ["one", "two", ""]);
        assert_eq!(rest, "three");
    }

    #[test]
    fn a_stream_without_newlines_is_cut_into_bounded_lines() {
        let chunk = "x".repeat(1 << 20);
        let (lines, rest) = run(&[&chunk, &chunk]);
        assert!(lines.iter().all(|l| l.len() <= MAX_STDIO_LINE));
        assert!(rest.len() <= MAX_STDIO_LINE);
        assert_eq!(lines.iter().map(String::len).sum::<usize>() + rest.len(), 2 << 20);
    }

    #[test]
    fn many_small_writes_never_grow_the_buffer_past_the_cap() {
        let (mut buf, mut out) = (String::new(), Vec::new());
        for _ in 0..200_000 {
            split_stdio(&mut buf, "ab", &mut out);
            assert!(buf.len() <= MAX_STDIO_LINE);
        }
        assert_eq!(out.iter().map(String::len).sum::<usize>() + buf.len(), 400_000);
    }

    #[test]
    fn a_cut_never_splits_a_character() {
        let text = "\u{e9}\u{4e2d}\u{1f600}".repeat(40_000);
        let (lines, rest) = run(&[&text]);
        let joined: String = lines.concat() + &rest;
        assert_eq!(joined, text);
        assert!(lines.iter().all(|l| l.len() <= MAX_STDIO_LINE));
    }

    #[test]
    fn the_secure_interface_gives_the_asked_number_of_bytes() {
        assert_eq!(random_bytes(true, 0).unwrap().len(), 0);
        let a = random_bytes(true, 64).unwrap();
        let b = random_bytes(true, 64).unwrap();
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
        assert_ne!(random_u64(true).unwrap(), random_u64(true).unwrap());
        assert_eq!(random_bytes(false, 33).unwrap().len(), 33);
    }
}
