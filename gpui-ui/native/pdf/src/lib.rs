//! zn_pdf: a small C ABI over hayro (pure-Rust PDF rasterizer) for `bun:ffi`, used by the GPUI reader spike.
//!
//! Model: every open document owns a small pool of worker threads (2 by default, `ZN_PDF_THREADS`). Each worker has its own parse of
//! the (shared) bytes and its own hayro `RenderCache` (`!Send`, so it lives on one thread). Jobs wait in ONE priority queue:
//! the worker that frees up takes the waiting job with the lowest priority value, and the JS side can re-prioritise
//! (`zpdf_job_prio`) or cancel (`zpdf_job_cancel`) a job while it waits, so the queue follows the scroll position.
//! The JS side never blocks on rasterization unless it asks to:
//!
//!   zpdf_open(path) -> doc          parse + measure every page (blocking, fast)
//!   zpdf_open_bytes(ptr, len) -> doc   same, from a PDF already in memory (copied; the caller keeps its buffer)
//!   zpdf_page_count(doc), zpdf_page_size(doc, i, f32[2] out)       page size in PDF points (rotation applied)
//!   zpdf_render_begin(doc, i, scale) -> job      queue a rasterization; scale = device px per point
//!   zpdf_job_poll(job) / zpdf_job_wait(job, ms)  0 pending, 1 done, -1 failed
//!   zpdf_job_size(job, u32[2] out), zpdf_job_data(job), zpdf_job_len(job), zpdf_job_micros(job)
//!   zpdf_job_free(job)                           (data pointer is valid until this call)
//!   zpdf_render_page(doc, i, scale, out, cap, u32[2] wh) -> bytes   blocking convenience that copies into `out`
//!   zpdf_text_layer(doc, i) -> char*  (JSON: page size + word rects normalised 0..1), free with zpdf_str_free
//!   zpdf_clear_cache(doc), zpdf_close(doc), zpdf_last_error(), zpdf_last_error_copy(buf, cap), zpdf_version()
//!        (zpdf_last_error's string is freed by the next error on any thread: callers that can race with a worker use the _copy one)
//!
//! v0.3: the worker pool + priorities: zpdf_render3(.., prio) (render2 plus a queue priority), zpdf_job_prio(job, prio), zpdf_pool_size(doc).
//!
//! v0.5: page editing and printing on PDFium (src/ops.rs): zpdf_page_rotation(doc, i), zpdf_edit_begin (rotate / delete pages ->
//! the new PDF), zpdf_print_begin (system print dialog), zpdf_print_to_begin (no dialog: a named printer / a file).
//!
//! v0.2 additions (the reader's memory + navigation work):
//!   zpdf_render_size2(doc, i, scale, rot, u32[2] out)            full bitmap size at a scale and an extra rotation (0/90/180/270 cw)
//!   zpdf_render2(doc, i, scale, rot, rx, ry, rw, rh, look, c0, c1) -> job
//!        like render_begin, but rotated, and optionally only the device-pixel region (rx, ry, rw, rh) of the full bitmap
//!        (rw = 0: everything), so a zoomed-in page is rendered in small tiles instead of one huge bitmap; `look` recolours the
//!        page while converting to BGRA (0 normal, 1 dark, 2 multiply by c0, 3 dark + screen onto c0, 4 duotone c0 -> c1)
//!   zpdf_outline_begin(doc) -> job (JSON), zpdf_links_begin(doc, i) -> job (JSON); see nav.rs
//!
//! v0.2 additions (the reader's memory + navigation work):
//!   zpdf_render_size2(doc, i, scale, rot, u32[2] out)            full bitmap size at a scale and an extra rotation (0/90/180/270 cw)
//!   zpdf_render2(doc, i, scale, rot, rx, ry, rw, rh, look, c0, c1) -> job
//!        like render_begin, but rotated, and optionally only the device-pixel region (rx, ry, rw, rh) of the full bitmap
//!        (rw = 0: everything), so a zoomed-in page is rendered in small tiles instead of one huge bitmap; `look` recolours the
//!        page while converting to BGRA (0 normal, 1 dark, 2 multiply by c0, 3 dark + screen onto c0, 4 duotone c0 -> c1)
//!   zpdf_outline_begin(doc) -> job (JSON), zpdf_links_begin(doc, i) -> job (JSON); see nav.rs
//!
//! Pixels are BGRA8 (GPUI's native order, so `setImagePixels(.., "bgra")` skips the swizzle), opaque, composited on white.
//!
//! Text layer: adapted from gpui-pdf (packetThrower/zorite, MIT, Copyright (c) packetThrower), `text.rs`: a custom hayro
//! `Device` that ignores everything except glyph runs, so the layer comes from one non-rasterizing interpret pass.
//! Differences: glyph rects are the font's em box (advance x [-0.2,0.8] em) instead of the ink bounding box, so a word's
//! rect has the line's height rather than the ragged height of its tallest letter, and glyphs are grouped into words here.

use std::collections::HashMap;
use std::ffi::{CStr, CString, c_char};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[cfg(windows)]
mod drag;
mod nav;
mod ops;
mod pdfium;
#[cfg(windows)]
mod print;

/// Dragging text out (Windows OLE, src/drag.rs) and printing (Windows GDI, src/print.rs) are Windows only. Elsewhere the same symbols
/// exist, so bun:ffi binds the library unchanged, and report that the feature is not there. (Linux prints without them: the app hands
/// the PDF to GTK's print dialog or to CUPS, gpui-ui/src/reader/printGtk.ts.)
#[cfg(not(windows))]
mod unsupported {
    use std::ffi::c_char;

    use crate::{Job, set_error};

    #[unsafe(no_mangle)]
    pub extern "C" fn zn_drag_available() -> i32 {
        0
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn zn_drag_begin(_hwnd: isize, _text: *const u8, _text_len: usize, _html: *const u8, _html_len: usize) -> *const Job {
        set_error("dragging out is only available on Windows");
        std::ptr::null()
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn zpdf_print_begin(_data: *const u8, _len: usize, _title: *const c_char, _current: i32) -> *const Job {
        set_error("printing is only available on Windows");
        std::ptr::null()
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn zpdf_print_to_begin(
        _data: *const u8,
        _len: usize,
        _title: *const c_char,
        _printer: *const c_char,
        _output: *const c_char,
        _first: i32,
        _last: i32,
    ) -> *const Job {
        set_error("printing is only available on Windows");
        std::ptr::null()
    }
}

use hayro::hayro_interpret::font::{Glyph, GlyphRun};
use hayro::hayro_interpret::hayro_cmap::BfString;
use hayro::hayro_interpret::{
    BlendMode, ClipPath, Context, Device, DrawMode, DrawProps, Image, ImageDrawProps, InterpreterCache,
    InterpreterSettings, SoftMask, TransformExt, interpret_page,
};
use hayro::hayro_syntax::Pdf;
use hayro::kurbo::{Affine, BezPath, Point, Rect, Shape};
use hayro::vello_cpu::color::palette::css::WHITE;
use hayro::vello_cpu::{RasterizerSettings, RenderContext, Resources, TargetInit};
use hayro::{RenderCache, RenderSettings, render_into};

/// Largest rendered side in device pixels; bigger requests are scaled down (hayro's context is u16 anyway).
const MAX_SIDE: f32 = 16384.0;

// ---------------------------------------------------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------------------------------------------------

static LAST_ERROR: Mutex<Option<CString>> = Mutex::new(None);

/// Lock `m`, ignoring poison. Every `extern "C"` entry point and worker goes through this: a panic that was caught elsewhere (the workers
/// run their jobs under `catch_unwind`) while a guard was held must not turn every later call into a panic, which aborts at the FFI border.
fn relock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn set_error(msg: impl Into<String>) {
    let s = msg.into().replace('\0', " ");
    *relock(&LAST_ERROR) = CString::new(s).ok();
}

/// The last error message (valid until the next error). Never null. Another thread's error replaces (and frees) the string at any time,
/// so a caller that cannot copy it at once must use `zpdf_last_error_copy` instead.
#[unsafe(no_mangle)]
pub extern "C" fn zpdf_last_error() -> *const c_char {
    static EMPTY: &CStr = c"";
    match relock(&LAST_ERROR).as_ref() {
        // The CString lives in the static until it is replaced; JS copies it straight away.
        Some(c) => c.as_ptr(),
        None => EMPTY.as_ptr(),
    }
}

/// Copy `msg` into `buf` as a NUL-terminated string (cut to fit) and return `msg`'s full length in bytes, without the NUL.
fn copy_message(msg: &[u8], buf: &mut [u8]) -> usize {
    if let Some(room) = buf.len().checked_sub(1) {
        let n = msg.len().min(room);
        buf[..n].copy_from_slice(&msg[..n]);
        buf[n] = 0;
    }
    msg.len()
}

/// The last error message copied into the caller's buffer (`cap` bytes, NUL-terminated, cut to fit) while the error is held under its
/// lock, so another thread's error cannot free it mid-copy. Returns the message's full length in bytes (without the NUL): a result
/// of `cap` or more means the text was cut. Empty message: 0 and `buf` holds "".
///
/// # Safety
/// `buf` must point to `cap` writable bytes (or be null).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_last_error_copy(buf: *mut u8, cap: usize) -> usize {
    let out: &mut [u8] = if buf.is_null() { &mut [] } else { unsafe { std::slice::from_raw_parts_mut(buf, cap) } };
    copy_message(relock(&LAST_ERROR).as_ref().map_or(&[][..], |c| c.to_bytes()), out)
}

#[unsafe(no_mangle)]
pub extern "C" fn zpdf_version() -> *const c_char {
    c"zn_pdf 0.5.0 (pdfium 8125 + hayro 0.8)".as_ptr()
}

// ---------------------------------------------------------------------------------------------------------------------
// jobs
// ---------------------------------------------------------------------------------------------------------------------

pub struct Job {
    /// 0 pending, 1 done, -1 failed, -2 cancelled before it ran
    state: AtomicI32,
    cancelled: AtomicBool,
    /// scheduling priority as f32 bits: the idle worker takes the queued job with the LOWEST value (ties: oldest first). The JS
    /// side changes it while the job waits (`zpdf_job_prio`), so the queue follows the viewport.
    prio: AtomicU32,
    width: AtomicU32,
    height: AtomicU32,
    micros: AtomicU64,
    created: Instant,
    data: OnceLock<Vec<u8>>,
    done: (Mutex<bool>, Condvar),
}

impl Job {
    fn new(prio: f32) -> Arc<Job> {
        Arc::new(Job {
            state: AtomicI32::new(0),
            cancelled: AtomicBool::new(false),
            prio: AtomicU32::new(prio.to_bits()),
            width: AtomicU32::new(0),
            height: AtomicU32::new(0),
            micros: AtomicU64::new(0),
            created: Instant::now(),
            data: OnceLock::new(),
            done: (Mutex::new(false), Condvar::new()),
        })
    }
    fn finish(&self, state: i32) {
        self.state.store(state, Ordering::Release);
        *relock(&self.done.0) = true;
        self.done.1.notify_all();
    }
    fn prio(&self) -> f32 {
        let p = f32::from_bits(self.prio.load(Ordering::Relaxed));
        if p.is_nan() { f32::MAX } else { p }
    }
}

/// Queue priorities of the non-render jobs (the reader's own bands: visible tiles < 1e6, margin ahead < 2e6, behind < 3e6; render2 / render_begin default to PRIO_BACKGROUND).
const PRIO_BACKGROUND: f32 = 4.0e6;
const PRIO_TEXT: f32 = 5.0e6;
const PRIO_LINKS: f32 = 5.5e6;
const PRIO_OUTLINE: f32 = 7.0e6;

// ---------------------------------------------------------------------------------------------------------------------
// document + worker thread
// ---------------------------------------------------------------------------------------------------------------------

/// One rasterization request. Region and size are in device pixels of the full (rotated, scaled) bitmap.
#[derive(Clone, Copy)]
struct RenderReq {
    page: usize,
    scale: f32,
    /// extra clockwise rotation: 0, 90, 180 or 270
    rot: u16,
    rx: u32,
    ry: u32,
    /// 0 = the whole page
    rw: u32,
    rh: u32,
    look: u32,
    c0: u32,
    c1: u32,
}

enum Cmd {
    Render(Arc<Job>, RenderReq),
    Text(Arc<Job>, usize),
    Outline(Arc<Job>),
    Links(Arc<Job>, usize),
}

impl Cmd {
    fn job(&self) -> &Arc<Job> {
        match self {
            Cmd::Render(j, _) | Cmd::Text(j, _) | Cmd::Outline(j) | Cmd::Links(j, _) => j,
        }
    }
}

/// What the document's worker threads share: one priority queue (the worker that frees up takes the most urgent job) and the
/// flags that ask them to drop their caches or stop.
struct Shared {
    queue: Mutex<Vec<Cmd>>,
    cv: Condvar,
    quit: AtomicBool,
    /// bumped by `zpdf_clear_cache`: every worker rebuilds its `RenderCache` when it sees a newer value
    cache_gen: AtomicU64,
    /// last render time (ms) of each page per rasteriser `[pdfium, hayro]`, 0 = not measured: which engine suits a page is learned
    perf: Mutex<HashMap<usize, [f32; 2]>>,
    /// decoded length of each page's content stream, measured on first use (a 30 MB stream is a dense vector figure)
    clen: Mutex<HashMap<usize, usize>>,
}

impl Shared {
    /// PDFium is the default. A page that took it long (a dense vector figure: path count, not pixels, is what costs) is tried with
    /// hayro, and whichever was quicker is used from then on.
    fn prefer_pdfium(&self, page: usize, content_len: impl FnOnce() -> usize) -> bool {
        if force_pdfium() {
            return true;
        }
        // measured outside the lock: a content stream that panics in the parser must not poison the table for every page
        let known = relock(&self.clen).get(&page).copied();
        let len = match known {
            Some(n) => n,
            None => {
                let n = content_len();
                *relock(&self.clen).entry(page).or_insert(n)
            }
        };
        // a page hayro panicked on goes to PDFium however heavy it is (see `note_render`)
        if len > HEAVY_CONTENT && relock(&self.perf).get(&page).is_none_or(|e| e[1] != f32::MAX) {
            return false;
        }
        match relock(&self.perf).get(&page) {
            Some(&[p, h]) if p > 0.0 && h > 0.0 => p <= h,
            Some(&[p, h]) if p > SLOW_PDFIUM_MS && h == 0.0 => false,
            _ => true,
        }
    }
    fn note(&self, page: usize, engine: usize, ms: f32) {
        relock(&self.perf).entry(page).or_insert([0.0; 2])[engine] = ms.max(0.01);
    }
    /// Learn from a finished render. `Drew`: the engine's time. `Panicked`: that engine cannot draw this page, so it is recorded as the
    /// slowest there could be and the other one is chosen from then on (recording the 0 ms the panic left behind as a time would make it
    /// look like the quickest). `NoPage` measured nothing.
    fn note_render(&self, page: usize, engine: usize, ms: f32, how: Rendered) {
        match how {
            Rendered::Drew => self.note(page, engine, ms),
            Rendered::Panicked => self.note(page, engine, f32::MAX),
            Rendered::NoPage => {}
        }
    }
}

/// How a render job ended, as far as the engine choice is concerned.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Rendered {
    Drew,
    Panicked,
    NoPage,
}

/// `ZN_PDF_BACKEND=pdfium`: no per-page engine choice, PDFium draws everything it can (A/B benchmarks).
fn force_pdfium() -> bool {
    static F: OnceLock<bool> = OnceLock::new();
    *F.get_or_init(|| std::env::var("ZN_PDF_BACKEND").is_ok_and(|v| v.eq_ignore_ascii_case("pdfium")))
}

static EPOCH: OnceLock<Instant> = OnceLock::new();
/// `ZN_PDF_TRACE=1`: one line per render job on stderr (when, which engine, how long it ran and waited)
fn trace() -> bool {
    static T: OnceLock<bool> = OnceLock::new();
    *T.get_or_init(|| {
        EPOCH.get_or_init(Instant::now);
        std::env::var("ZN_PDF_TRACE").is_ok_and(|v| v == "1")
    })
}

/// A page whose decoded content stream is longer than this (bytes) is drawn by hayro: PDFium needed 0.9-1.1 s for a 30 MB scatter-plot
/// page where hayro needed 0.36 s (ordinary pages: 5-60 KB, a figure-rich one 0.4 MB).
const HEAVY_CONTENT: usize = 2 << 20;

/// How long a render the screen is waiting for waits for PDFium's lock before hayro draws the page instead.
const URGENT_WAIT: Duration = Duration::from_millis(60);

/// A PDFium render slower than this makes the page a candidate for hayro.
const SLOW_PDFIUM_MS: f32 = 150.0;

pub struct Doc {
    shared: Arc<Shared>,
    joins: Vec<JoinHandle<()>>,
    dims: Vec<(f32, f32)>,
    /// each page's own /Rotate in degrees (0, 90, 180, 270), already part of `dims` and of every render
    rots: Vec<u16>,
    /// PDFium renders this document when set (else hayro)
    pdfium: Option<Arc<pdfium::PdfiumDoc>>,
}

/// Where a document's bytes come from.
enum Source {
    Path(String),
    Bytes(Vec<u8>),
}

/// Worker threads per document: `ZN_PDF_THREADS`, else 2 (a third one cost ~20-30 MB of per-thread caches and bought little). Each has its own parse of the (shared)
/// bytes and its own glyph / font / image caches, because `RenderCache` is `!Send`.
fn pool_size(pdfium: bool) -> usize {
    if let Some(n) = std::env::var("ZN_PDF_THREADS").ok().and_then(|v| v.parse::<usize>().ok()) {
        return n.clamp(1, 16);
    }
    // With PDFium (one job at a time) the others are hayro workers for what PDFium is too busy or too slow for, and for the text layer,
    // links and outline; they hold no render caches until they draw something.
    if pdfium { 3 } else { 2 }
}

/// Margin / background work yields to the UI and JS threads when the machine is busy; a job the screen is waiting for (the reader's
/// priority band 0: tiles that touch the viewport, and the previews of visible pages) runs at normal priority, else a loaded machine
/// (a build running next to the app) starves the render threads for hundreds of ms while the page they draw is already on screen.
#[cfg_attr(not(windows), allow(unused_variables))]
fn set_thread_priority(urgent: bool) {
    #[cfg(windows)]
    unsafe {
        unsafe extern "system" {
            fn GetCurrentThread() -> isize;
            fn SetThreadPriority(thread: isize, priority: i32) -> i32;
        }
        const THREAD_PRIORITY_BELOW_NORMAL: i32 = -1;
        const THREAD_PRIORITY_NORMAL: i32 = 0;
        SetThreadPriority(GetCurrentThread(), if urgent { THREAD_PRIORITY_NORMAL } else { THREAD_PRIORITY_BELOW_NORMAL });
    }
}

enum Wake {
    Job(Cmd),
    Clear,
    Quit,
}

/// Block until there is something to do: the queued job with the lowest priority value (cancelled ones are finished on the way).
fn wait_next(shared: &Shared, cgen: u64) -> Wake {
    let mut q = relock(&shared.queue);
    loop {
        if shared.quit.load(Ordering::Acquire) {
            return Wake::Quit;
        }
        if shared.cache_gen.load(Ordering::Acquire) != cgen {
            return Wake::Clear;
        }
        q.retain(|c| {
            let j = c.job();
            if j.cancelled.load(Ordering::Acquire) {
                j.finish(-2);
                false
            } else {
                true
            }
        });
        let mut best: Option<usize> = None;
        for (i, c) in q.iter().enumerate() {
            if best.is_none_or(|b| c.job().prio() < q[b].job().prio()) {
                best = Some(i);
            }
        }
        if let Some(i) = best {
            return Wake::Job(q.remove(i));
        }
        q = shared.cv.wait(q).unwrap_or_else(PoisonError::into_inner);
    }
}

/// What the first worker reports once it parsed the file: page sizes (points, rotation applied) and each page's /Rotate.
type Ready = Result<(Vec<(f32, f32)>, Vec<u16>), String>;

fn worker(bytes: Arc<Vec<u8>>, what: String, shared: Arc<Shared>, pdfium: Option<Arc<pdfium::PdfiumDoc>>, ready: Option<Sender<Ready>>) {
    set_thread_priority(false);
    let pdf = match Pdf::new(bytes) {
        Ok(p) => p,
        Err(e) => {
            if let Some(r) = ready {
                let _ = r.send(Err(format!("parse {what}: {e:?}")));
            }
            return;
        }
    };
    let pages = pdf.pages();
    // PDFium and hayro must agree on the page count, else PDFium is not used for this document. Its page sizes are the ones that
    // count: it draws the pages (the text layer and links are fractions of the page, so they do not care).
    let pdfium = pdfium.filter(|p| p.dims.len() == pages.len());
    if let Some(r) = ready {
        let dims: Vec<(f32, f32)> = match &pdfium {
            Some(p) => p.dims.clone(),
            None => pages.iter().map(|p| p.render_dimensions()).collect(),
        };
        let rots: Vec<u16> = pages
            .iter()
            .map(|p| match p.rotation() {
                hayro::hayro_syntax::page::Rotation::None => 0,
                hayro::hayro_syntax::page::Rotation::Horizontal => 90,
                hayro::hayro_syntax::page::Rotation::Flipped => 180,
                hayro::hayro_syntax::page::Rotation::FlippedHorizontal => 270,
            })
            .collect();
        let _ = r.send(Ok((dims, rots)));
    }

    let settings = InterpreterSettings::default();
    let render_settings = RenderSettings::default();
    let mut cache = RenderCache::new();
    let mut nav = nav::Nav::new(&pdf);
    let mut cgen = shared.cache_gen.load(Ordering::Acquire);

    loop {
        let cmd = match wait_next(&shared, cgen) {
            Wake::Quit => break,
            Wake::Clear => {
                cache = RenderCache::new();
                if let Some(p) = &pdfium {
                    p.clear();
                }
                cgen = shared.cache_gen.load(Ordering::Acquire);
                continue;
            }
            Wake::Job(c) => c,
        };
        match cmd {
            Cmd::Render(job, req) => {
                set_thread_priority(job.prio() < 5.0e5);
                let t0 = Instant::now();
                let mut engine = 1;
                // the ms the engine that drew the page needed (waiting for PDFium's lock is not part of it)
                let mut draw_ms = 0.0f32;
                // the engine running right now, so that a panic is charged to the one that caused it
                let mut running: Option<usize> = None;
                let out = catch_unwind(AssertUnwindSafe(|| {
                    let clen = || pages.get(req.page).and_then(|p| p.page_stream()).map_or(0, |s| s.len());
                    if let Some(p) = pdfium.as_ref().filter(|_| shared.prefer_pdfium(req.page, clen)) {
                        // PDFium runs one job at a time: a job that finds it busy waits for it (a page takes it 5-30 ms, hayro 2-4x that),
                        // the ones the screen is waiting for only so long, then hayro draws the page; thumbnails and the like wait as long as it takes.
                        let wait = if job.prio() < 5.0e5 { Some(URGENT_WAIT) } else { None };
                        running = Some(0);
                        if let Ok(Some((r, ms))) = render_pdfium(p, req.page, &req, wait) {
                            engine = 0;
                            draw_ms = ms;
                            return Some(r);
                        }
                    }
                    let page = pages.get(req.page)?;
                    let h0 = Instant::now();
                    running = Some(1);
                    let r = render_region(page, &cache, &settings, &render_settings, &req);
                    draw_ms = h0.elapsed().as_secs_f32() * 1000.0;
                    Some(r)
                }));
                if pdfium.is_some() {
                    match (&out, running) {
                        (Ok(Some(_)), _) => shared.note_render(req.page, engine, draw_ms, Rendered::Drew),
                        (Err(_), Some(e)) => shared.note_render(req.page, e, 0.0, Rendered::Panicked),
                        _ => shared.note_render(req.page, engine, draw_ms, Rendered::NoPage),
                    }
                }
                if trace() {
                    let (w0, h0) = (req.rw, req.rh);
                    let clen = pages.get(req.page).and_then(|p| p.page_stream()).map_or(0, |s| s.len());
                    eprintln!(
                        "[zpdf] t={:.0} page={} {}x{}+{}+{} scale={:.2} {} {:.1}ms prio={:.0} waited={:.1}ms content={}B",
                        EPOCH.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0, req.page, w0, h0, req.rx, req.ry, req.scale,
                        if engine == 0 { "pdfium" } else { "hayro" }, t0.elapsed().as_secs_f32() * 1000.0, job.prio(), t0.duration_since(job.created).as_secs_f32() * 1000.0, clen
                    );
                }
                match out {
                    Ok(Some((w, h, buf))) => {
                        job.width.store(w, Ordering::Relaxed);
                        job.height.store(h, Ordering::Relaxed);
                        job.micros.store(t0.elapsed().as_micros() as u64, Ordering::Relaxed);
                        let _ = job.data.set(buf);
                        job.finish(1);
                    }
                    Ok(None) => {
                        set_error(format!("no page {}", req.page));
                        job.finish(-1);
                    }
                    Err(_) => {
                        // A panic inside hayro leaves the cache in an unknown state: start clean.
                        cache = RenderCache::new();
                        set_error(format!("render page {} panicked", req.page));
                        job.finish(-1);
                    }
                }
            }
            Cmd::Outline(job) => match catch_unwind(AssertUnwindSafe(|| nav.outline_json())) {
                Ok(json) => {
                    let _ = job.data.set(json.into_bytes());
                    job.finish(1);
                }
                Err(_) => {
                    set_error("outline failed");
                    job.finish(-1);
                }
            },
            Cmd::Links(job, idx) => match catch_unwind(AssertUnwindSafe(|| nav.links_json(idx))) {
                Ok(json) => {
                    let _ = job.data.set(json.into_bytes());
                    job.finish(1);
                }
                Err(_) => {
                    set_error(format!("links of page {idx} failed"));
                    job.finish(-1);
                }
            },
            Cmd::Text(job, idx) => {
                let t0 = Instant::now();
                match catch_unwind(AssertUnwindSafe(|| pages.get(idx).map(|p| text_layer_json(p)))) {
                    Ok(Some(json)) => {
                        job.micros.store(t0.elapsed().as_micros() as u64, Ordering::Relaxed);
                        let _ = job.data.set(json.into_bytes());
                        job.finish(1);
                    }
                    _ => {
                        set_error(format!("text layer of page {idx} failed"));
                        job.finish(-1);
                    }
                }
            }
        }
    }
    // `cache` and `nav` borrow `pdf`; they are dropped first (reverse declaration order), then `pdf`.
}

/// Device-pixel geometry of a render request: the full bitmap is `fw` x `fh`, the part to produce is `(rx, ry, rw, rh)` of it.
struct Geo {
    fw: u32,
    fh: u32,
    rx: u32,
    ry: u32,
    rw: u32,
    rh: u32,
}

/// `pw` x `ph` is the page in points (page rotation applied); the request's extra rotation is applied here.
fn geometry(pw: f32, ph: f32, req: &RenderReq) -> Geo {
    let rot = req.rot % 360;
    let (bw, bh) = if rot % 180 == 0 { (pw, ph) } else { (ph, pw) };
    let scale = clamp_scale(bw, bh, req.scale);
    let (fw, fh) = (((bw * scale) as u16) as u32, ((bh * scale) as u16) as u32);
    let (fw, fh) = (fw.max(1), fh.max(1));
    let (rx, ry, rw, rh) = if req.rw == 0 || req.rh == 0 {
        (0, 0, fw, fh)
    } else {
        let rx = req.rx.min(fw - 1);
        let ry = req.ry.min(fh - 1);
        (rx, ry, req.rw.min(fw - rx), req.rh.min(fh - ry))
    };
    Geo { fw, fh, rx, ry, rw, rh }
}

/// Rasterize (a region of) a page with PDFium. Returns (w, h, BGRA bytes), None when PDFium cannot do this page.
/// `Err(())`: PDFium is busy and `wait` is false.
fn render_pdfium(doc: &pdfium::PdfiumDoc, page: usize, req: &RenderReq, wait: Option<Duration>) -> Result<Option<((u32, u32, Vec<u8>), f32)>, ()> {
    let Some(&(pw, ph)) = doc.dims.get(page) else { return Ok(None) };
    let g = geometry(pw, ph, req);
    let Some((mut buf, ms)) = doc.render(wait, page, g.fw, g.fh, req.rot / 90, g.rx, g.ry, g.rw, g.rh)? else { return Ok(None) };
    if req.look != 0 {
        // the recolouring below reads RGBA and writes BGRA: hand it RGBA
        for px in buf.chunks_exact_mut(4) {
            px.swap(0, 2);
        }
        to_bgra(&mut buf, req.look, req.c0, req.c1);
    }
    Ok(Some(((g.rw, g.rh, buf), ms)))
}

// Rasterize (a region of) a page with hayro. Returns (w, h, BGRA bytes).
fn render_region<'a>(
    page: &'a hayro::hayro_syntax::page::Page<'a>,
    cache: &RenderCache<'a>,
    settings: &InterpreterSettings,
    rs: &RenderSettings,
    req: &RenderReq,
) -> (u32, u32, Vec<u8>) {
    let (pw, ph) = page.render_dimensions();
    let rot = req.rot % 360;
    let g = geometry(pw, ph, req);
    let scale = clamp_scale(if rot % 180 == 0 { pw } else { ph }, if rot % 180 == 0 { ph } else { pw }, req.scale);
    let (rx, ry, rw, rh) = (g.rx, g.ry, g.rw, g.rh);
    let rotm = match rot {
        90 => Affine::new([0.0, 1.0, -1.0, 0.0, ph as f64, 0.0]),
        180 => Affine::new([-1.0, 0.0, 0.0, -1.0, pw as f64, ph as f64]),
        270 => Affine::new([0.0, -1.0, 1.0, 0.0, 0.0, pw as f64]),
        _ => Affine::IDENTITY,
    };
    let transform = Affine::translate((-(rx as f64), -(ry as f64))) * Affine::scale(scale as f64) * rotm * page.initial_transform(true).to_kurbo();
    let mut ctx = RenderContext::new(rw as u16, rh as u16);
    render_into(page, cache, settings, rs, &mut ctx, transform);
    ctx.flush();
    let mut pm = hayro::vello_cpu::Pixmap::new(ctx.width(), ctx.height());
    ctx.render_with(
        &mut pm,
        &mut Resources::default(),
        RasterizerSettings { target_init: TargetInit::Clear(WHITE), ..Default::default() },
    );
    drop(ctx);
    let (w, h) = (pm.width() as u32, pm.height() as u32);
    // premultiplied RGBA over opaque white == straight RGBA with alpha 255; the Vec is taken without a copy.
    let mut buf = pm.take_rgba8(hayro::vello_cpu::peniko::ImageAlphaType::AlphaPremultiplied);
    to_bgra(&mut buf, req.look, req.c0, req.c1);
    (w, h, buf)
}

/// RGBA (opaque) -> BGRA in place, recolouring on the way (see the `look` values in the module docs).
fn to_bgra(buf: &mut [u8], look: u32, c0: u32, c1: u32) {
    let rgb = |c: u32| [((c >> 16) & 255) as f32 / 255.0, ((c >> 8) & 255) as f32 / 255.0, (c & 255) as f32 / 255.0];
    let (k0, k1) = (rgb(c0), rgb(c1));
    // CSS `invert(a) hue-rotate(180deg)`: keeps hues, flips lightness
    let dark = |p: [f32; 3], a: f32| -> [f32; 3] {
        let inv = |c: f32| a * (1.0 - c) + (1.0 - a) * c;
        let (r, g, b) = (inv(p[0]), inv(p[1]), inv(p[2]));
        [
            (-0.574 * r + 1.430 * g + 0.144 * b).clamp(0.0, 1.0),
            (0.426 * r + 0.430 * g + 0.144 * b).clamp(0.0, 1.0),
            (0.426 * r + 1.430 * g - 0.856 * b).clamp(0.0, 1.0),
        ]
    };
    if look == 0 {
        for px in buf.chunks_exact_mut(4) {
            px.swap(0, 2);
            px[3] = 255;
        }
        return;
    }
    for px in buf.chunks_exact_mut(4) {
        let p = [px[0] as f32 / 255.0, px[1] as f32 / 255.0, px[2] as f32 / 255.0];
        let o = match look {
            1 => dark(p, 0.92),
            2 => [p[0] * k0[0], p[1] * k0[1], p[2] * k0[2]],
            3 => {
                let d = dark(p, 1.0);
                [1.0 - (1.0 - d[0]) * (1.0 - k0[0]), 1.0 - (1.0 - d[1]) * (1.0 - k0[1]), 1.0 - (1.0 - d[2]) * (1.0 - k0[2])]
            }
            _ => {
                let l = 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
                [k0[0] + (k1[0] - k0[0]) * l, k0[1] + (k1[1] - k0[1]) * l, k0[2] + (k1[2] - k0[2]) * l]
            }
        };
        px[0] = (o[2] * 255.0 + 0.5) as u8;
        px[1] = (o[1] * 255.0 + 0.5) as u8;
        px[2] = (o[0] * 255.0 + 0.5) as u8;
        px[3] = 255;
    }
}

fn clamp_scale(pw: f32, ph: f32, scale: f32) -> f32 {
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let side = pw.max(ph) * scale;
    if side > MAX_SIDE { scale * MAX_SIDE / side } else { scale }
}

// ---------------------------------------------------------------------------------------------------------------------
// C ABI: document
// ---------------------------------------------------------------------------------------------------------------------

/// Open a PDF by UTF-8 path. Null on failure (see `zpdf_last_error`).
///
/// # Safety
/// `path` must be a valid NUL-terminated string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_open(path: *const c_char) -> *mut Doc {
    if path.is_null() {
        set_error("null path");
        return std::ptr::null_mut();
    }
    let path = unsafe { CStr::from_ptr(path) }.to_string_lossy().into_owned();
    spawn_doc(Source::Path(path))
}

/// Open a PDF held in memory: `data[..len]` is copied, so the caller may free or reuse its buffer straight away.
/// Null on failure (see `zpdf_last_error`).
///
/// # Safety
/// `data` must point to `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_open_bytes(data: *const u8, len: usize) -> *mut Doc {
    if data.is_null() || len == 0 {
        set_error("empty pdf buffer");
        return std::ptr::null_mut();
    }
    spawn_doc(Source::Bytes(unsafe { std::slice::from_raw_parts(data, len) }.to_vec()))
}

fn spawn_doc(src: Source) -> *mut Doc {
    let (bytes, what) = match src {
        Source::Path(path) => match std::fs::read(&path) {
            Ok(b) => (b, path),
            Err(e) => {
                set_error(format!("read {path}: {e}"));
                return std::ptr::null_mut();
            }
        },
        Source::Bytes(b) => (b, "<memory>".to_string()),
    };
    let bytes = Arc::new(bytes);
    let shared = Arc::new(Shared { queue: Mutex::new(Vec::new()), cv: Condvar::new(), quit: AtomicBool::new(false), cache_gen: AtomicU64::new(0), perf: Mutex::new(HashMap::new()), clen: Mutex::new(HashMap::new()) });
    let (ready_tx, ready_rx) = mpsc::channel();
    let pdfium = match pdfium::PdfiumDoc::open(bytes.clone()) {
        Ok(d) => Some(Arc::new(d)),
        Err(e) => {
            set_error(e); // kept for diagnostics: the document renders with hayro
            None
        }
    };
    let spawn = |ready: Option<Sender<Ready>>| {
        let (b, w, sh, pd) = (bytes.clone(), what.clone(), shared.clone(), pdfium.clone());
        std::thread::Builder::new().name("zn-pdf".into()).stack_size(32 * 1024 * 1024).spawn(move || worker(b, w, sh, pd, ready))
    };
    let first = match spawn(Some(ready_tx)) {
        Ok(j) => j,
        Err(e) => {
            set_error(format!("spawn: {e}"));
            return std::ptr::null_mut();
        }
    };
    match ready_rx.recv() {
        Ok(Ok((dims, rots))) => {
            // PDFium and hayro must agree on the page count, else PDFium is not used for this document (the worker decided already)
            let pdfium_ok = pdfium.clone().filter(|p| p.dims.len() == dims.len());
            // the first worker parsed the file: the others (each parses on its own thread) join the pool without anyone waiting for them
            let mut joins = vec![first];
            for _ in 1..pool_size(pdfium_ok.is_some()) {
                if let Ok(j) = spawn(None) {
                    joins.push(j);
                }
            }
            Box::into_raw(Box::new(Doc { shared, joins, dims, rots, pdfium: pdfium_ok }))
        }
        Ok(Err(e)) => {
            set_error(e);
            let _ = first.join();
            std::ptr::null_mut()
        }
        Err(_) => {
            set_error("worker died while opening (panic in parser)");
            let _ = first.join();
            std::ptr::null_mut()
        }
    }
}

/// # Safety
/// `doc` must come from `zpdf_open` and not be closed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_page_count(doc: *const Doc) -> i32 {
    unsafe { doc.as_ref() }.map_or(-1, |d| d.dims.len() as i32)
}

/// 1 when PDFium renders this document, 0 when hayro does (pdfium.dll could not be loaded or opened the document differently).
///
/// # Safety
/// `doc` must be valid.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_backend(doc: *const Doc) -> i32 {
    unsafe { doc.as_ref() }.map_or(-1, |d| d.pdfium.is_some() as i32)
}

/// Why PDFium is not in use ("" when it is).
#[unsafe(no_mangle)]
pub extern "C" fn zpdf_pdfium_status() -> *const c_char {
    static MSG: OnceLock<CString> = OnceLock::new();
    MSG.get_or_init(|| CString::new(pdfium::unavailable().unwrap_or("")).unwrap_or_default()).as_ptr()
}

/// Number of worker threads the document was given.
///
/// # Safety
/// `doc` must be valid.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_pool_size(doc: *const Doc) -> i32 {
    unsafe { doc.as_ref() }.map_or(-1, |d| d.joins.len() as i32)
}

/// Writes `[width, height]` in PDF points (page rotation applied). Returns 0, or -1 for a bad page.
///
/// # Safety
/// `out` must point to two `f32`s.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_page_size(doc: *const Doc, page: i32, out: *mut f32) -> i32 {
    let Some(d) = (unsafe { doc.as_ref() }) else { return -1 };
    let Some(&(w, h)) = usize::try_from(page).ok().and_then(|i| d.dims.get(i)) else { return -1 };
    if out.is_null() {
        return -1;
    }
    unsafe {
        *out = w;
        *out.add(1) = h;
    }
    0
}

/// Pixel size a render at `scale` produces (same truncation as hayro). Writes `[w, h]`.
///
/// # Safety
/// `out` must point to two `u32`s.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_render_size(doc: *const Doc, page: i32, scale: f32, out: *mut u32) -> i32 {
    let Some(d) = (unsafe { doc.as_ref() }) else { return -1 };
    let Some(&(w, h)) = usize::try_from(page).ok().and_then(|i| d.dims.get(i)) else { return -1 };
    if out.is_null() {
        return -1;
    }
    let s = clamp_scale(w, h, scale);
    unsafe {
        *out = ((w * s) as u16) as u32;
        *out.add(1) = ((h * s) as u16) as u32;
    }
    0
}

//// Drop hayro's per-document caches (parsed fonts, glyph cache, decoded images) in every worker. Memory goes back to the allocator.
///
/// # Safety
/// `doc` must be valid.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_clear_cache(doc: *const Doc) {
    if let Some(d) = unsafe { doc.as_ref() } {
        d.shared.cache_gen.fetch_add(1, Ordering::AcqRel);
        let _q = relock(&d.shared.queue);
        d.shared.cv.notify_all();
    }
}

/// Close the document: queued jobs that did not start are cancelled (state -2), running ones finish, then the workers stop and
/// everything is freed. Jobs already returned stay valid.
///
/// # Safety
/// `doc` must come from `zpdf_open`; it is invalid afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_close(doc: *mut Doc) {
    if doc.is_null() {
        return;
    }
    let mut d = unsafe { Box::from_raw(doc) };
    d.shared.quit.store(true, Ordering::Release);
    {
        let _q = relock(&d.shared.queue);
        d.shared.cv.notify_all();
    }
    for j in d.joins.drain(..) {
        let _ = j.join();
    }
    for c in relock(&d.shared.queue).drain(..) {
        c.job().finish(-2);
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// C ABI: rendering
// ---------------------------------------------------------------------------------------------------------------------

/// Queue a rasterization of `page` at `scale` device pixels per point. Returns a job (free with `zpdf_job_free`).
///
/// # Safety
/// `doc` must be valid.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_render_begin(doc: *const Doc, page: i32, scale: f32) -> *const Job {
    unsafe { zpdf_render3(doc, page, scale, 0, 0, 0, 0, 0, 0, 0, 0, PRIO_BACKGROUND) }
}

/// Queue `cmd` and hand its job out.
fn submit(d: &Doc, cmd: Cmd) -> *const Job {
    let job = cmd.job().clone();
    if d.shared.quit.load(Ordering::Acquire) {
        set_error("worker is gone");
        return std::ptr::null();
    }
    relock(&d.shared.queue).push(cmd);
    d.shared.cv.notify_one();
    Arc::into_raw(job)
}

/// Like `zpdf_render_begin`, with an extra clockwise rotation (0/90/180/270) and an optional device-pixel region
/// `(rx, ry, rw, rh)` of the full bitmap (`rw` = 0: all of it), recoloured by `look` (see the module docs).
///
/// # Safety
/// `doc` must be valid.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_render2(doc: *const Doc, page: i32, scale: f32, rot: i32, rx: u32, ry: u32, rw: u32, rh: u32, look: u32, c0: u32, c1: u32) -> *const Job {
    unsafe { zpdf_render3(doc, page, scale, rot, rx, ry, rw, rh, look, c0, c1, PRIO_BACKGROUND) }
}

/// `zpdf_render2` with a queue priority: the idle worker takes the waiting job with the lowest `prio` (change it later with
/// `zpdf_job_prio`).
///
/// # Safety
/// `doc` must be valid.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_render3(doc: *const Doc, page: i32, scale: f32, rot: i32, rx: u32, ry: u32, rw: u32, rh: u32, look: u32, c0: u32, c1: u32, prio: f32) -> *const Job {
    let Some(d) = (unsafe { doc.as_ref() }) else { return std::ptr::null() };
    let Ok(idx) = usize::try_from(page) else { return std::ptr::null() };
    if idx >= d.dims.len() {
        set_error(format!("page {page} out of range"));
        return std::ptr::null();
    }
    let rot = (rot.rem_euclid(360) / 90 * 90) as u16;
    submit(d, Cmd::Render(Job::new(prio), RenderReq { page: idx, scale, rot, rx, ry, rw, rh, look, c0, c1 }))
}

/// Change the queue priority of a job that has not started (lower runs first). No effect once it runs.
///
/// # Safety
/// `job` must be valid.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_job_prio(job: *const Job, prio: f32) {
    if let Some(j) = unsafe { job.as_ref() } {
        j.prio.store(prio.to_bits(), Ordering::Relaxed);
    }
}


/// Full bitmap size `[w, h]` of a render at `scale` with an extra rotation.
///
/// # Safety
/// `out` must point to two `u32`s.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_render_size2(doc: *const Doc, page: i32, scale: f32, rot: i32, out: *mut u32) -> i32 {
    let Some(d) = (unsafe { doc.as_ref() }) else { return -1 };
    let Some(&(w, h)) = usize::try_from(page).ok().and_then(|i| d.dims.get(i)) else { return -1 };
    let (w, h) = if rot.rem_euclid(180) == 0 { (w, h) } else { (h, w) };
    if out.is_null() {
        return -1;
    }
    let s = clamp_scale(w, h, scale);
    unsafe {
        *out = ((w * s) as u16) as u32;
        *out.add(1) = ((h * s) as u16) as u32;
    }
    0
}

/// Queue the outline extraction. The job's data is JSON (see nav.rs).
///
/// # Safety
/// `doc` must be valid.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_outline_begin(doc: *const Doc) -> *const Job {
    let Some(d) = (unsafe { doc.as_ref() }) else { return std::ptr::null() };
    submit(d, Cmd::Outline(Job::new(PRIO_OUTLINE)))
}

/// Queue the link-annotation extraction of one page. The job's data is JSON (see nav.rs).
///
/// # Safety
/// `doc` must be valid.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_links_begin(doc: *const Doc, page: i32) -> *const Job {
    let Some(d) = (unsafe { doc.as_ref() }) else { return std::ptr::null() };
    let Ok(idx) = usize::try_from(page) else { return std::ptr::null() };
    if idx >= d.dims.len() {
        set_error(format!("page {page} out of range"));
        return std::ptr::null();
    }
    submit(d, Cmd::Links(Job::new(PRIO_LINKS), idx))
}

/// # Safety
/// `job` must come from `zpdf_render_begin` and not be freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_job_poll(job: *const Job) -> i32 {
    unsafe { job.as_ref() }.map_or(-1, |j| j.state.load(Ordering::Acquire))
}

/// Block up to `timeout_ms` for the job. Returns its state (0 = still pending).
///
/// # Safety
/// `job` must be valid.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_job_wait(job: *const Job, timeout_ms: u32) -> i32 {
    let Some(j) = (unsafe { job.as_ref() }) else { return -1 };
    let guard = relock(&j.done.0);
    let _ = j
        .done
        .1
        .wait_timeout_while(guard, Duration::from_millis(timeout_ms as u64), |done| !*done);
    j.state.load(Ordering::Acquire)
}

/// Writes `[w, h]` of a finished job.
///
/// # Safety
/// `out` must point to two `u32`s.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_job_size(job: *const Job, out: *mut u32) -> i32 {
    let Some(j) = (unsafe { job.as_ref() }) else { return -1 };
    if out.is_null() {
        return -1;
    }
    unsafe {
        *out = j.width.load(Ordering::Relaxed);
        *out.add(1) = j.height.load(Ordering::Relaxed);
    }
    0
}

/// Pointer to the finished job's BGRA pixels (w*h*4 bytes), valid until `zpdf_job_free`. Null if not done.
///
/// # Safety
/// `job` must be valid.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_job_data(job: *const Job) -> *const u8 {
    unsafe { job.as_ref() }.and_then(|j| j.data.get()).map_or(std::ptr::null(), |v| v.as_ptr())
}

/// # Safety
/// `job` must be valid.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_job_len(job: *const Job) -> usize {
    unsafe { job.as_ref() }.and_then(|j| j.data.get()).map_or(0, |v| v.len())
}

/// Rasterization time in microseconds, measured inside the worker (excludes queueing).
///
/// # Safety
/// `job` must be valid.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_job_micros(job: *const Job) -> u64 {
    unsafe { job.as_ref() }.map_or(0, |j| j.micros.load(Ordering::Relaxed))
}

/// # Safety
/// `job` must come from `zpdf_render_begin`; it is invalid afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_job_free(job: *const Job) {
    if !job.is_null() {
        drop(unsafe { Arc::from_raw(job) });
    }
}

/// Blocking render into the caller's buffer. Returns bytes written, or -1 (see `zpdf_last_error`), or -2 if `cap` is
/// too small. `wh` receives `[w, h]`.
///
/// # Safety
/// `out` must point to `cap` writable bytes, `wh` to two `u32`s.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_render_page(doc: *const Doc, page: i32, scale: f32, out: *mut u8, cap: usize, wh: *mut u32) -> i64 {
    if out.is_null() || wh.is_null() {
        set_error("null output pointer");
        return -1;
    }
    let job = unsafe { zpdf_render_begin(doc, page, scale) };
    if job.is_null() {
        return -1;
    }
    let state = unsafe { zpdf_job_wait(job, u32::MAX) };
    let res = if state != 1 {
        -1
    } else {
        let data = unsafe { zpdf_job_data(job) };
        let len = unsafe { zpdf_job_len(job) };
        unsafe { zpdf_job_size(job, wh) };
        if len > cap {
            -2
        } else {
            unsafe { std::ptr::copy_nonoverlapping(data, out, len) };
            len as i64
        }
    };
    unsafe { zpdf_job_free(job) };
    res
}

// ---------------------------------------------------------------------------------------------------------------------
// C ABI: text layer
// ---------------------------------------------------------------------------------------------------------------------

/// Queue a text-layer extraction of `page`. The job's data is UTF-8 JSON (no NUL):
/// `{"pw":612,"ph":792,"words":[{"t":"Hello","x":0.1,"y":0.2,"w":0.05,"h":0.012,"l":0}, ...]}`
/// with x/y/w/h normalised 0..1 of the page (top-left origin) and `l` a running line index.
///
/// # Safety
/// `doc` must be valid.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_text_begin(doc: *const Doc, page: i32) -> *const Job {
    let Some(d) = (unsafe { doc.as_ref() }) else { return std::ptr::null() };
    let Ok(idx) = usize::try_from(page) else { return std::ptr::null() };
    if idx >= d.dims.len() {
        set_error(format!("page {page} out of range"));
        return std::ptr::null();
    }
    submit(d, Cmd::Text(Job::new(PRIO_TEXT), idx))
}

/// Ask for a queued job to be skipped (no effect once it runs). Its state becomes -2.
///
/// # Safety
/// `job` must be valid.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_job_cancel(job: *const Job) {
    if let Some(j) = unsafe { job.as_ref() } {
        j.cancelled.store(true, Ordering::Release);
    }
}

/// Blocking text layer as a NUL-terminated JSON string (free with `zpdf_str_free`), or null on failure.
///
/// # Safety
/// `doc` must be valid.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_text_layer(doc: *const Doc, page: i32) -> *mut c_char {
    let job = unsafe { zpdf_text_begin(doc, page) };
    if job.is_null() {
        return std::ptr::null_mut();
    }
    let state = unsafe { zpdf_job_wait(job, u32::MAX) };
    let out = if state == 1 {
        let bytes = unsafe { job.as_ref() }.and_then(|j| j.data.get()).cloned().unwrap_or_default();
        CString::new(bytes).map_or(std::ptr::null_mut(), CString::into_raw)
    } else {
        std::ptr::null_mut()
    };
    unsafe { zpdf_job_free(job) };
    out
}

/// # Safety
/// `s` must come from `zpdf_text_layer`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_str_free(s: *mut c_char) {
    if !s.is_null() {
        drop(unsafe { CString::from_raw(s) });
    }
}

// --- text layer internals (adapted from gpui-pdf text.rs, MIT) -------------------------------------------------------

/// One glyph: its text and em-box in page points (top-left origin).
struct G {
    text: String,
    x0: f32,
    y0: f32,
    x1: f32,
    y1: f32,
    space: bool,
    /// the font's cache key (0 = unknown, e.g. Type3) and the glyph's advance in em; 0.0 when the font does not say
    font: u128,
    adv: f32,
    /// which text-showing operation (one `draw_glyph_run`) the glyph came from
    run: u32,
}

struct Collector {
    glyphs: Vec<G>,
    run: u32,
}

impl<'a> Device<'a> for Collector {
    fn draw_path(&mut self, _: &BezPath, _: DrawProps<'a>, _: &DrawMode) {}
    fn push_clip_path(&mut self, _: &ClipPath) {}
    fn push_transparency_group(&mut self, _: f32, _: Option<SoftMask<'a>>, _: BlendMode) {}
    fn draw_image(&mut self, _: Image<'a, '_>, _: ImageDrawProps<'a>) {}
    fn pop_clip(&mut self) {}
    fn pop_transparency_group(&mut self) {}

    // Invisible glyphs (OCR layers over scans) are recorded too: that is the searchable text of a scanned page.
    fn draw_glyph_run(&mut self, run: &GlyphRun<'_, 'a>, props: DrawProps<'a>, _mode: &DrawMode) {
        self.run += 1;
        for glyph in run.glyphs() {
            self.glyph(glyph, props.transform * glyph.transform());
        }
    }
}

const U: f64 = 1000.0; // hayro-font UNITS_PER_EM

impl Collector {
    fn glyph(&mut self, glyph: &Glyph<'_>, m: Affine) {
        let text = match glyph.as_unicode() {
            Some(BfString::Char(c)) => c.to_string(),
            Some(BfString::String(s)) => s,
            None => return,
        };
        let (font, raw_adv) = match glyph {
            Glyph::Outline(o) => (o.font_cache_key(), o.advance_width()),
            Glyph::Type3(_) => (0, None), // not public in hayro 0.8; falls back to a half-em box below
        };
        let adv = raw_adv.filter(|a| *a > 0.0).map(f64::from);
        let adv_em = adv.map_or(0.0, |a| (a / U) as f32);
        if text.chars().all(char::is_whitespace) {
            let p = m.translation();
            self.glyphs.push(G {
                text: " ".into(),
                x0: p.x as f32,
                y0: p.y as f32,
                x1: p.x as f32,
                y1: p.y as f32,
                space: true,
                font,
                adv: adv_em,
                run: self.run,
            });
            return;
        }
        // glyph space: x along the advance, y up, 1000 units per em. Em box: descender 0.2 em .. ascender 0.8 em.
        let (gx0, gx1) = match (adv, glyph) {
            (Some(a), _) => (0.0, a),
            (None, Glyph::Outline(o)) => {
                let b = o.outline().bounding_box();
                (b.x0, b.x1)
            }
            _ => (0.0, U * 0.5),
        };
        let corners = [
            m * Point::new(gx0, -0.2 * U),
            m * Point::new(gx1, -0.2 * U),
            m * Point::new(gx1, 0.8 * U),
            m * Point::new(gx0, 0.8 * U),
        ];
        let r = corners.iter().fold(
            Rect::new(f64::MAX, f64::MAX, f64::MIN, f64::MIN),
            |r, c| Rect::new(r.x0.min(c.x), r.y0.min(c.y), r.x1.max(c.x), r.y1.max(c.y)),
        );
        self.glyphs.push(G { text, x0: r.x0 as f32, y0: r.y0 as f32, x1: r.x1 as f32, y1: r.y1 as f32, space: false, font, adv: adv_em, run: self.run });
    }
}

fn json_escape(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
}

struct Word {
    text: String,
    x0: f32,
    y0: f32,
    x1: f32,
    y1: f32,
    line: u32,
}

fn median(v: &mut [f32]) -> Option<f32> {
    if v.is_empty() {
        return None;
    }
    v.sort_by(|a, b| a.total_cmp(b));
    Some(v[v.len() / 2])
}

/// Word-break threshold per font, in em: a fraction of that font's space width. The space width is what the font draws a
/// real space glyph with, else estimated from its median letter advance (a space is about 0.55 of that). A fixed
/// threshold fails both ways: justified lines squeeze the space to ~0.1 em (words glued) while monospace or wide fonts have
/// 0.3-0.6 em spaces (a tight fixed value splits nothing, a loose one glues). Unknown fonts (Type3) keep the old 0.12 em.
fn font_thresholds(glyphs: &[G]) -> HashMap<u128, f32> {
    let mut letters: HashMap<u128, Vec<f32>> = HashMap::new();
    let mut spaces: HashMap<u128, Vec<f32>> = HashMap::new();
    for g in glyphs.iter().filter(|g| g.font != 0 && g.adv > 0.0) {
        (if g.space { &mut spaces } else { &mut letters }).entry(g.font).or_default().push(g.adv);
    }
    let mut out = HashMap::new();
    for (font, mut l) in letters {
        let space = spaces.get_mut(&font).and_then(|s| median(s)).or_else(|| median(&mut l).map(|m| m * 0.55));
        if let Some(sp) = space {
            out.insert(font, (sp * 0.33).clamp(0.05, 0.25));
        }
    }
    out
}

/// Glyphs -> words: break on a space glyph, a new line, a backwards jump, or a gap wider than the font's word-break
/// threshold (PDFs often draw no space glyph at all: the gap is TJ spacing). Letter-spaced runs (headings) raise the threshold
/// by the run's median gap so that "T I T L E" does not shatter into letters.
fn group_words(glyphs: &[G]) -> Vec<Word> {
    const DEFAULT_THR: f32 = 0.12;
    let thr = font_thresholds(glyphs);

    // per run: median gap between consecutive same-line glyphs, in em (tracking / letter-spacing)
    let mut run_gaps: HashMap<u32, Vec<f32>> = HashMap::new();
    {
        let mut prev: Option<&G> = None;
        for g in glyphs {
            if g.space {
                prev = None;
                continue;
            }
            if let Some(p) = prev.filter(|p| p.run == g.run) {
                let lh = (g.y1 - g.y0).max(p.y1 - p.y0).max(0.5);
                if ((g.y0 + g.y1) / 2.0 - (p.y0 + p.y1) / 2.0).abs() <= lh * 0.6 && g.x0 >= p.x0 {
                    run_gaps.entry(g.run).or_default().push((g.x0 - p.x1) / lh);
                }
            }
            prev = Some(g);
        }
    }
    let tracking: HashMap<u32, f32> = run_gaps
        .into_iter()
        .filter_map(|(r, mut v)| (v.len() >= 4).then(|| median(&mut v).map(|m| (r, m))).flatten())
        .collect();

    let mut words: Vec<Word> = Vec::new();
    let mut cur: Option<Word> = None;
    let mut prev: Option<(f32, f32, f32, f32)> = None; // x0,y0,x1,y1 of previous real glyph
    let mut line = 0u32;
    for g in glyphs {
        if g.space {
            if let Some(w) = cur.take() {
                words.push(w);
            }
            continue;
        }
        let h = (g.y1 - g.y0).max(0.5);
        let mut brk = false;
        if let Some((px0, py0, px1, py1)) = prev {
            let ph_ = (py1 - py0).max(0.5);
            let lh = h.max(ph_);
            let new_line = ((g.y0 + g.y1) / 2.0 - (py0 + py1) / 2.0).abs() > lh * 0.6;
            let gap = g.x0 - px1;
            let base = thr.get(&g.font).copied().unwrap_or(DEFAULT_THR);
            let track = tracking.get(&g.run).copied().filter(|t| *t > base * 0.6).unwrap_or(0.0);
            if new_line {
                line += 1;
                brk = true;
            } else if gap > lh * (base + track) || g.x0 < px0 - lh * 0.1 {
                brk = true;
            }
        }
        if brk {
            if let Some(w) = cur.take() {
                words.push(w);
            }
        }
        match cur.as_mut() {
            Some(w) => {
                w.text.push_str(&g.text);
                w.x0 = w.x0.min(g.x0);
                w.y0 = w.y0.min(g.y0);
                w.x1 = w.x1.max(g.x1);
                w.y1 = w.y1.max(g.y1);
            }
            None => cur = Some(Word { text: g.text.clone(), x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1, line }),
        }
        prev = Some((g.x0, g.y0, g.x1, g.y1));
    }
    if let Some(w) = cur.take() {
        words.push(w);
    }
    words
}

fn text_layer_json(page: &hayro::hayro_syntax::page::Page<'_>) -> String {
    let (pw, ph) = page.render_dimensions();
    let initial = page.initial_transform(true).to_kurbo();
    let cache = InterpreterCache::new();
    let mut ctx = Context::new(initial, Rect::new(0.0, 0.0, pw as f64, ph as f64), &cache, page.xref(), InterpreterSettings::default());
    let mut col = Collector { glyphs: Vec::new(), run: 0 };
    interpret_page(page, &mut ctx, &mut col);

    let words = group_words(&col.glyphs);

    let mut out = String::with_capacity(64 + words.len() * 64);
    out.push_str(&format!("{{\"pw\":{:.2},\"ph\":{:.2},\"words\":[", finite(pw), finite(ph)));
    let mut first = true;
    for w in &words {
        if !first {
            out.push(',');
        }
        first = false;
        push_word_json(w, pw, ph, &mut out);
    }
    out.push_str("]}");
    out
}

/// `v` itself when it is a number, else 0: `{:.5}` prints NaN / inf as `NaN` / `inf`, which is not JSON.
fn finite(v: f32) -> f32 {
    if v.is_finite() { v } else { 0.0 }
}

/// A fraction of the page, 0..1 (NaN from a 0 / 0 page side or a glyph with no geometry becomes 0; `f32::clamp` passes NaN through).
fn unit(v: f32) -> f32 {
    if v.is_nan() { 0.0 } else { v.clamp(0.0, 1.0) }
}

fn push_word_json(w: &Word, pw: f32, ph: f32, out: &mut String) {
    let x = unit(w.x0 / pw);
    let y = unit(w.y0 / ph);
    let ww = unit((w.x1 - w.x0) / pw);
    let hh = unit((w.y1 - w.y0) / ph);
    out.push_str("{\"t\":\"");
    json_escape(&w.text, out);
    out.push_str(&format!("\",\"x\":{x:.5},\"y\":{y:.5},\"w\":{ww:.5},\"h\":{hh:.5},\"l\":{}}}", w.line));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shared() -> Shared {
        Shared {
            queue: Mutex::new(Vec::new()),
            cv: Condvar::new(),
            quit: AtomicBool::new(false),
            cache_gen: AtomicU64::new(0),
            perf: Mutex::new(HashMap::new()),
            clen: Mutex::new(HashMap::new()),
        }
    }

    #[test]
    fn copy_message_cuts_to_fit_and_reports_the_full_length() {
        let mut buf = [0xAAu8; 8];
        assert_eq!(copy_message(b"abc", &mut buf), 3);
        assert_eq!(&buf[..4], b"abc\0");
        assert_eq!(copy_message(b"0123456789", &mut buf), 10);
        assert_eq!(&buf, b"0123456\0");
        assert_eq!(copy_message(b"", &mut buf), 0);
        assert_eq!(buf[0], 0);
        let mut none: [u8; 0] = [];
        assert_eq!(copy_message(b"abc", &mut none), 3, "no room: nothing written, the length still comes back");
        let mut one = [0xAAu8; 1];
        assert_eq!(copy_message(b"abc", &mut one), 3);
        assert_eq!(one, [0]);
    }

    #[test]
    fn last_error_copy_is_a_terminated_copy_of_a_message() {
        set_error("something went wrong");
        let mut buf = [0xAAu8; 64];
        let n = unsafe { zpdf_last_error_copy(buf.as_mut_ptr(), buf.len()) };
        assert!(n < buf.len());
        assert_eq!(buf[n], 0, "NUL-terminated at the reported length");
        // (other tests set errors too, so only what one call returns is checked: its text and its length agree)
        assert_eq!(buf[..n].iter().position(|&b| b == 0), None, "no NUL inside the text");
        assert!(unsafe { zpdf_last_error_copy(std::ptr::null_mut(), 0) } < 1 << 16, "a null buffer is allowed: the length only");
    }

    #[test]
    fn locks_survive_a_panic_in_a_caught_job() {
        let sh = shared();
        // a content stream that panics while its length is measured, and a panic while the perf table is held
        assert!(catch_unwind(AssertUnwindSafe(|| sh.prefer_pdfium(0, || panic!("broken stream")))).is_err());
        assert!(catch_unwind(AssertUnwindSafe(|| {
            let _g = relock(&sh.perf);
            panic!("while noting");
        }))
        .is_err());
        assert!(catch_unwind(AssertUnwindSafe(|| {
            let _g = relock(&LAST_ERROR);
            panic!("while setting the error");
        }))
        .is_err());
        assert!(sh.prefer_pdfium(0, || 10), "later renders still choose an engine");
        sh.note(0, 0, 5.0);
        set_error("still works");
        assert!(sh.prefer_pdfium(1, || 10));
    }

    #[test]
    fn a_failed_engine_is_not_recorded_as_the_fastest() {
        let sh = shared();
        // PDFium was slow on page 3, so hayro was tried and panicked
        sh.note(3, 0, 200.0);
        assert!(!sh.prefer_pdfium(3, || 10), "hayro is tried first");
        sh.note_render(3, 1, 0.0, Rendered::Panicked);
        assert!(sh.prefer_pdfium(3, || 10), "a page hayro cannot draw goes back to PDFium");
        // and a page that is too heavy for PDFium still goes to PDFium once hayro failed on it
        assert!(!sh.prefer_pdfium(4, || HEAVY_CONTENT + 1));
        sh.note_render(4, 1, 0.0, Rendered::Panicked);
        assert!(sh.prefer_pdfium(4, || HEAVY_CONTENT + 1));
        // PDFium panicking on a page leaves hayro to draw it
        sh.note(5, 1, 30.0);
        sh.note_render(5, 0, 0.0, Rendered::Panicked);
        assert!(!sh.prefer_pdfium(5, || 10));
        // a missing page teaches nothing
        sh.note_render(6, 1, 0.0, Rendered::NoPage);
        assert!(sh.perf.lock().unwrap().get(&6).is_none());
    }

    #[test]
    fn text_layer_numbers_are_always_json_numbers() {
        let w = Word { text: "a\"b".into(), x0: f32::NAN, y0: 5.0, x1: f32::NAN, y1: f32::NAN, line: 2 };
        let mut s = String::new();
        push_word_json(&w, 0.0, 0.0, &mut s); // a page with no size: 0 / 0
        assert_eq!(s, r#"{"t":"a\"b","x":0.00000,"y":1.00000,"w":0.00000,"h":0.00000,"l":2}"#);
        for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let w = Word { text: "x".into(), x0: bad, y0: bad, x1: bad, y1: bad, line: 0 };
            let mut s = String::new();
            push_word_json(&w, bad, bad, &mut s);
            assert!(!s.contains("NaN") && !s.contains("inf"), "{s}");
        }
        assert_eq!((finite(f32::NAN), finite(f32::INFINITY), finite(612.0)), (0.0, 0.0, 612.0));
    }

    #[test]
    fn out_pointers_are_checked() {
        unsafe {
            assert_eq!(zpdf_render_page(std::ptr::null(), 0, 1.0, std::ptr::null_mut(), 0, std::ptr::null_mut()), -1);
            assert_eq!(zpdf_job_size(std::ptr::null(), std::ptr::null_mut()), -1);
            let job = Job::new(0.0);
            assert_eq!(zpdf_job_size(Arc::as_ptr(&job), std::ptr::null_mut()), -1, "a live job, no place to write its size");
        }
    }
}
