//! Self-contained Rust WASM fixture for `plugin-host-wasmtime`:
//! - `events.on-timer(code, kind)` runs the benchmark modes (1=log.write, 2=prefs.get, 3=spin, 4=alloc N MiB, 5=OOM, 6=debug-enabled)
//!   and records native timer callbacks when `TRACE_TIMERS` is enabled.
//! - `events.on-locale-changed(cmd)` executes protocol & native-family test commands and logs `RESULT:<tag>:...`.
wit_bindgen::generate!({
    world: "hello",
    path: "wit",
    generate_all,
});

use exports::zinc::plugin::events::Guest as Events;
use exports::zinc::plugin::lifecycle::{Guest as Lifecycle, Hook, PluginData, Reason};
use std::sync::atomic::{AtomicBool, Ordering};
use zinc::plugin::app;
use zinc::plugin::attachments::{self, FileWriter, ImportBytesRequest};
use zinc::plugin::l10n::{self, DateStyle};
use zinc::plugin::log::{self, LogLevel};
use zinc::plugin::net::{self, CookieMode, HttpRequest, RedirectMode};
use zinc::plugin::prefs;
use zinc::plugin::timers::{self, TimerKind};
use zinc::plugin::types::{Error, L10nArg, L10nRef, NameL10nArg, PrefValue};
use zinc::plugin::util::{self, HashAlgorithm};

static TRACE_TIMERS: AtomicBool = AtomicBool::new(false);

struct Plugin;

fn info(msg: &str) {
    log::write(LogLevel::Info, msg);
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(&mut s, "{b:02x}");
    }
    s
}

fn fmt_pref(v: Option<PrefValue>) -> String {
    match v {
        None => "none".into(),
        Some(PrefValue::Flag(b)) => format!("flag:{b}"),
        Some(PrefValue::Integer(n)) => format!("int:{n}"),
        Some(PrefValue::Text(s)) => format!("text:{s}"),
    }
}

fn fmt_err(e: Error) -> String {
    match e {
        Error::NotFound(s) => format!("not-found:{s}"),
        Error::InvalidArgument(s) => format!("invalid-argument:{s}"),
        Error::PermissionDenied(s) => format!("permission-denied:{s}"),
        Error::ReadOnly(s) => format!("read-only:{s}"),
        Error::Conflict(s) => format!("conflict:{s}"),
        Error::LimitExceeded(s) => format!("limit-exceeded:{s}"),
        Error::Timeout => "timeout".into(),
        Error::Cancelled => "cancelled".into(),
        Error::Unavailable(s) => format!("unavailable:{s}"),
        Error::Internal(s) => format!("internal:{s}"),
    }
}

impl Lifecycle for Plugin {
    fn install(_d: PluginData, _w: Reason) -> Result<(), Error> {
        Ok(())
    }

    fn startup(data: PluginData, _why: Reason) -> Result<(), Error> {
        info(&format!("bench-guest startup {} {}", data.id, data.version));
        Ok(())
    }

    fn shutdown(_d: PluginData, _w: Reason) -> Result<(), Error> {
        info("bench-guest shutdown");
        Ok(())
    }

    fn uninstall(_d: PluginData, _w: Reason) -> Result<(), Error> {
        Ok(())
    }

    fn main_window_load(_d: PluginData, _w: u32) -> Result<(), Error> {
        Ok(())
    }

    fn main_window_unload(_d: PluginData, _w: u32) -> Result<(), Error> {
        Ok(())
    }
}

impl Events for Plugin {
    fn on_pref_changed(_s: u32, _scope: prefs::PrefScope, _name: String, _v: Option<PrefValue>) {}

    fn on_timer(code: u32, kind: TimerKind) {
        if code < 1_000_000 {
            if TRACE_TIMERS.load(Ordering::Relaxed) && code > 0 {
                let k = match kind {
                    TimerKind::Timeout => "timeout",
                    TimerKind::Interval => "interval",
                    TimerKind::Idle => "idle",
                };
                info(&format!("RESULT:timer-fired:{code}:{k}"));
            }
            return;
        }

        let mode = code / 1_000_000;
        let n = code % 1_000_000;
        match mode {
            1 => {
                for _ in 0..n {
                    log::write(LogLevel::Info, "bench log line");
                }
            }
            2 => {
                for _ in 0..n {
                    std::hint::black_box(prefs::get("greeting"));
                }
            }
            3 => {
                let mut acc = 1u64;
                loop {
                    acc = acc.wrapping_mul(6364136223846793005).wrapping_add(1);
                    std::hint::black_box(acc);
                }
            }
            4 => {
                let bytes = (n as usize) * 1024 * 1024;
                let mut v = vec![1u8; bytes];
                for slot in v.iter_mut().step_by(4096) {
                    *slot = 2;
                }
                std::hint::black_box(&v);
            }
            5 => {
                let mut chunks: Vec<Vec<u8>> = Vec::new();
                loop {
                    let mut c = vec![1u8; 1024 * 1024];
                    c[0] = 2;
                    chunks.push(c);
                    std::hint::black_box(&chunks);
                }
            }
            6 => {
                for _ in 0..n {
                    std::hint::black_box(log::debug_enabled());
                }
            }
            _ => {}
        }
    }

    fn on_plugin_event(_p: String, _h: Hook, _r: Reason) {}

    fn on_locale_changed(cmd: String) {
        let mut parts = cmd.split('\n');
        let Some(op) = parts.next() else { return };

        match op {
            "trace-timers:on" => TRACE_TIMERS.store(true, Ordering::Relaxed),
            "trace-timers:off" => TRACE_TIMERS.store(false, Ordering::Relaxed),

            "log-suite" => {
                let dbg = log::debug_enabled();
                log::write(LogLevel::Debug, "dbg-msg");
                log::write(LogLevel::Info, "info-msg");
                log::write(LogLevel::Error, "err-from-write");
                log::write_error("boom-msg", Some("at guest.rs:42"));
                log::write_error("nostack-msg", None);
                let huge = "é".repeat(5000); // 10,000 UTF-8 bytes
                log::write(LogLevel::Info, &huge);
                info(&format!("RESULT:log-suite:dbg={dbg}"));
            }

            "log-burst" => {
                let n: usize = parts.next().and_then(|s| s.parse().ok()).unwrap_or(100);
                for i in 0..n {
                    log::write(LogLevel::Info, &format!("burst-{i}"));
                }
            }

            "prefs-suite" => {
                let g = fmt_pref(prefs::get("greeting"));
                let c = fmt_pref(prefs::get("count"));
                let e = fmt_pref(prefs::get("enabled"));
                let sec = fmt_pref(prefs::get("apiKey"));
                let hu_g = prefs::has_user_value("greeting");
                let hu_s = prefs::has_user_value("starts");
                let all = prefs::get_all(None)
                    .into_iter()
                    .map(|p| format!("{}:{}:{}", p.key, fmt_pref(Some(p.value)), p.user_set))
                    .collect::<Vec<_>>()
                    .join(",");
                let pref_u = prefs::get_all(Some("u."))
                    .into_iter()
                    .map(|p| p.key)
                    .collect::<Vec<_>>()
                    .join(",");
                let app_theme = match prefs::get_app("ui.theme.mode") {
                    Ok(v) => format!("ok:{}", fmt_pref(v)),
                    Err(er) => format!("err:{}", fmt_err(er)),
                };
                let app_bad = match prefs::get_app("not.allowed") {
                    Ok(v) => format!("ok:{}", fmt_pref(v)),
                    Err(er) => format!("err:{}", fmt_err(er)),
                };
                info(&format!(
                    "RESULT:prefs:g={g}|c={c}|e={e}|sec={sec}|hug={hu_g}|hus={hu_s}|all={all}|u={pref_u}|theme={app_theme}|bad={app_bad}"
                ));
            }

            "prefs-mutate" => {
                let key = parts.next().unwrap_or("greeting");
                let val = parts.next().unwrap_or("mutated");
                let set_res = match prefs::set(key, &PrefValue::Text(val.to_string())) {
                    Ok(()) => "ok".into(),
                    Err(e) => fmt_err(e),
                };
                let after = fmt_pref(prefs::get(key));
                info(&format!("RESULT:prefs-mutate:{set_res}|after={after}"));
            }

            "timers-clock" => {
                let t1 = timers::now();
                let m1 = timers::monotonic_ms();
                timers::sleep(30);
                let m2 = timers::monotonic_ms();
                info(&format!("RESULT:clock:now={t1}|dm={}", m2.saturating_sub(m1)));
            }

            "timers-schedule" => {
                let kind = parts.next().unwrap_or("timeout");
                let ms: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(20);
                let r = match kind {
                    "interval" => timers::set_interval(ms),
                    "idle" => timers::request_idle(ms),
                    _ => timers::set_timeout(ms),
                };
                match r {
                    Ok(id) => info(&format!("RESULT:timer-id:ok:{id}")),
                    Err(e) => info(&format!("RESULT:timer-id:err:{}", fmt_err(e))),
                }
            }

            "timers-clear-one" => {
                let id: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
                timers::clear(id);
                info(&format!("RESULT:timer-cleared:{id}"));
            }

            "timers-fill-64" => {
                let mut ok_count = 0u32;
                let mut err_tag = String::new();
                for _ in 0..65 {
                    match timers::set_timeout(60_000) {
                        Ok(_) => ok_count += 1,
                        Err(e) => err_tag = fmt_err(e),
                    }
                }
                info(&format!("RESULT:timers-64:ok={ok_count}|err={err_tag}"));
            }

            "l10n-suite" => {
                let loc = l10n::locale();
                let plocs = l10n::plugin_locales().join(",");
                let hm_hello = l10n::has_message("hello");
                let hm_attr = l10n::has_message("button.tooltip");
                let hm_nope = l10n::has_message("nope");
                let hello = l10n::format(&L10nRef {
                    id: "hello".into(),
                    args: vec![NameL10nArg {
                        name: "name".into(),
                        value: L10nArg::Text("Ada".into()),
                    }],
                    fallback: None,
                });
                let many = l10n::format_many(&[
                    L10nRef {
                        id: "items".into(),
                        args: vec![NameL10nArg {
                            name: "count".into(),
                            value: L10nArg::Integer(0),
                        }],
                        fallback: None,
                    },
                    L10nRef {
                        id: "items".into(),
                        args: vec![NameL10nArg {
                            name: "count".into(),
                            value: L10nArg::Integer(1),
                        }],
                        fallback: None,
                    },
                    L10nRef {
                        id: "items".into(),
                        args: vec![NameL10nArg {
                            name: "count".into(),
                            value: L10nArg::Integer(5),
                        }],
                        fallback: None,
                    },
                    L10nRef {
                        id: "about".into(),
                        args: vec![],
                        fallback: None,
                    },
                    L10nRef {
                        id: "button.tooltip".into(),
                        args: vec![],
                        fallback: None,
                    },
                ])
                .join(" / ");
                let miss1 = l10n::format(&L10nRef {
                    id: "missing-msg".into(),
                    args: vec![],
                    fallback: Some("Fallback Text".into()),
                });
                let miss2 = l10n::format(&L10nRef {
                    id: "missing-msg".into(),
                    args: vec![],
                    fallback: None,
                });
                let num2 = l10n::format_number(1234.5, Some(2));
                let num_def = l10n::format_number(42.0, None);
                let dt0 = l10n::format_date(0, DateStyle::Short, false);
                info(&format!(
                    "RESULT:l10n:loc={loc}|plocs={plocs}|hm={hm_hello},{hm_attr},{hm_nope}|hello={hello}|many={many}|miss1={miss1}|miss2={miss2}|num2={num2}|numd={num_def}|dt0={dt0}"
                ));
            }

            "l10n-disk" => {
                let d = l10n::format(&L10nRef {
                    id: "disk-only".into(),
                    args: vec![],
                    fallback: None,
                });
                info(&format!("RESULT:l10n-disk:{d}"));
            }

            "app-suite" => {
                let inf = app::get_info();
                let ready = app::is_ui_ready();
                let wins = app::main_windows()
                    .into_iter()
                    .map(|w| w.to_string())
                    .collect::<Vec<_>>()
                    .join(",");
                let act = app::active_window()
                    .map(|w| w.to_string())
                    .unwrap_or_else(|| "none".into());
                info(&format!(
                    "RESULT:app:name={}|ver={}|loc={}|tz={}|dev={}|feat={}|ready={ready}|wins={wins}|act={act}",
                    inf.name,
                    inf.version,
                    inf.locale,
                    inf.time_zone,
                    inf.dev_build,
                    inf.features.join(",")
                ));
            }

            "app-wait-ui" => {
                info("RESULT:wait-ui:before");
                app::wait_ui_ready();
                info("RESULT:wait-ui:after");
            }

            "util-suite" => {
                let r0 = util::random_bytes(0);
                let r32 = util::random_bytes(32);
                let u1 = util::uuid_v4();
                let u2 = util::uuid_v4();
                let h_md5 = hex(&util::hash(HashAlgorithm::Md5, b"abc"));
                let h_sha1 = hex(&util::hash(HashAlgorithm::Sha1, b"abc"));
                let h_sha256 = hex(&util::hash(HashAlgorithm::Sha256, b"abc"));
                let h_sha512 = hex(&util::hash(HashAlgorithm::Sha512, b"abc"));
                let sv = format!(
                    "{},{},{}",
                    util::semver_compare("1.2.0", "1.10.0"),
                    util::semver_compare("2.0", "2.0.0"),
                    util::semver_compare("1.0.0", "1.0.0-rc.1")
                );
                let doi1 = util::clean_doi("see https://doi.org/10.1000/xyz123.").unwrap_or_default();
                let doi2 = util::clean_doi("none").is_none();
                let isbn10 = util::clean_isbn("ISBN 0-306-40615-2", false).unwrap_or_default();
                let isbn13 = util::clean_isbn("ISBN 0-306-40615-2", true).unwrap_or_default();
                let isbn_bad = util::clean_isbn("0-306-40615-3", false).is_none();
                let issn_ok = util::clean_issn("ISSN 0378-5955").unwrap_or_default();
                let issn_bad = util::clean_issn("0378-5954").is_none();
                let h2t = util::html_to_text("<p>a &amp; b</p><script>evil()</script><p>c<br/>d</p>").replace('\n', "\\n");
                let t2h_a = util::text_to_html("a < b\n\nc\nd", false);
                let t2h_b = util::text_to_html("a\nb", true);
                let cap1 = util::capitalize_title("the art of war and peace: a study in the details", false);
                let cap2 = util::capitalize_title("THE ART OF WAR", false);
                info(&format!(
                    "RESULT:util:r0={}|r32={}|r32_nonzero={}|u1={u1}|u_diff={}|md5={h_md5}|sha1={h_sha1}|sha256={h_sha256}|sha512={h_sha512}|sv={sv}|doi={doi1},{doi2}|isbn={isbn10},{isbn13},{isbn_bad}|issn={issn_ok},{issn_bad}|h2t={h2t}|t2ha={t2h_a}|t2hb={t2h_b}|cap1={cap1}|cap2={cap2}",
                    r0.len(),
                    r32.len(),
                    r32.iter().any(|&b| b != 0),
                    u1 != u2
                ));
            }

            "util-random-trap" => {
                let _ = util::random_bytes(65537);
            }

            "net-stream" => {
                let url = parts.next().unwrap_or("");
                let req = HttpRequest {
                    method: "GET".into(),
                    url: url.to_string(),
                    headers: vec![],
                    body: Some(vec![]), // exercises empty list<u8> inside record
                    timeout_ms: Some(5000),
                    success_codes: None,
                    redirect: RedirectMode::Follow,
                    credentials: None,
                    cookies: CookieMode::None,
                    retry: None,
                    bypass_cache: false,
                    max_response_bytes: None,
                    cancel_key: None,
                };
                match net::send_streamed(&req) {
                    Ok(res) => {
                        let status = res.status;
                        let mut collected = Vec::new();
                        let mut chunks = 0usize;
                        loop {
                            match res.body.read(5) {
                                Ok(Some(chunk)) => {
                                    chunks += 1;
                                    collected.extend_from_slice(&chunk);
                                }
                                Ok(None) => break,
                                Err(e) => {
                                    info(&format!("RESULT:net-stream:read-err:{e:?}"));
                                    return;
                                }
                            }
                        }
                        res.body.close();
                        drop(res); // deterministically invokes [resource-drop]body-reader
                        info(&format!(
                            "RESULT:net-stream:status={status}|chunks={chunks}|text={}",
                            String::from_utf8_lossy(&collected)
                        ));
                    }
                    Err(e) => info(&format!("RESULT:net-stream:err:{e:?}")),
                }
            }

            "net-stream-drop-early" => {
                let url = parts.next().unwrap_or("");
                let req = HttpRequest {
                    method: "GET".into(),
                    url: url.to_string(),
                    headers: vec![],
                    body: None,
                    timeout_ms: Some(5000),
                    success_codes: None,
                    redirect: RedirectMode::Follow,
                    credentials: None,
                    cookies: CookieMode::None,
                    retry: None,
                    bypass_cache: false,
                    max_response_bytes: None,
                    cancel_key: None,
                };
                if let Ok(res) = net::send_streamed(&req) {
                    let first = res.body.read(4).ok().flatten().unwrap_or_default();
                    drop(res); // drop WITHOUT close(): [resource-drop]body-reader aborts stream on host
                    info(&format!("RESULT:net-drop-early:first={}", String::from_utf8_lossy(&first)));
                }
            }

            "att-writer-finish" => {
                let filename = parts.next().unwrap_or("streamed.txt");
                let w = FileWriter::new(&ImportBytesRequest {
                    parent: None,
                    library: None,
                    filename: filename.to_string(),
                    content_type: Some("text/plain".into()),
                    title: Some("Streamed File".into()),
                    url: None,
                    collections: vec![],
                    data: vec![], // exercises empty list<u8> inside record
                });
                let r1 = w.append(b"hello ");
                let r2 = w.append(b""); // exercises empty list<u8> direct param
                let r3 = w.append(b"wasmtime!");
                match (r1, r2, r3) {
                    (Ok(()), Ok(()), Ok(())) => match w.finish() {
                        Ok(key) => {
                            drop(w);
                            // Also test reading empty slice & full bytes back!
                            let empty = attachments::read_file(&key, 0, 0).unwrap_or_default();
                            let full = attachments::read_file_all(&key, 1024).unwrap_or_default();
                            info(&format!(
                                "RESULT:att-writer:ok:{key}|empty_len={}|full={}",
                                empty.len(),
                                String::from_utf8_lossy(&full)
                            ));
                        }
                        Err(e) => info(&format!("RESULT:att-writer:finish-err:{}", fmt_err(e))),
                    },
                    _ => info("RESULT:att-writer:append-err"),
                }
            }

            "att-writer-drop" => {
                let filename = parts.next().unwrap_or("abandoned.txt");
                let w = FileWriter::new(&ImportBytesRequest {
                    parent: None,
                    library: None,
                    filename: filename.to_string(),
                    content_type: Some("text/plain".into()),
                    title: None,
                    url: None,
                    collections: vec![],
                    data: vec![],
                });
                let _ = w.append(b"uncommitted bytes");
                drop(w); // deterministically invokes [resource-drop]file-writer without finish()
                info("RESULT:att-writer-drop:done");
            }

            "forwarded-wait" => {
                let key = parts.next().unwrap_or("sync-key");
                let _ = prefs::set(key, &PrefValue::Text("held".into()));
                info("RESULT:forwarded-wait:done");
            }

            "html-to-text" => {
                let t = util::html_to_text(parts.next().unwrap_or(""));
                info(&format!("RESULT:html-to-text:{t}"));
            }

            "sleep" => {
                let ms: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
                timers::sleep(ms);
                info("RESULT:sleep:done");
            }

            "stdout-flood" => {
                use std::io::Write;
                let lines: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
                let kb: usize = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
                for i in 0..lines {
                    println!("flood line {i}");
                }
                // one long write that never ends in a newline
                print!("{}", "y".repeat(kb * 1024));
                let _ = std::io::stdout().flush();
                info("RESULT:stdout-flood:done");
            }

            "forwarded-loop" => {
                let n: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(1000);
                for _ in 0..n {
                    prefs::clear("tmp");
                }
                info("RESULT:forwarded-loop:done");
            }

            _ => {}
        }
    }

    fn on_permission_changed(_p: String, _g: bool) {}
}

export!(Plugin);
