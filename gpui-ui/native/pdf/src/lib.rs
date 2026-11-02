//! zn_pdf: a small C ABI over hayro (pure-Rust PDF rasterizer) for `bun:ffi`, used by the GPUI reader spike.
//!
//! Model: every open document owns one worker thread. The worker owns the parsed `Pdf` and hayro's `RenderCache` (which
//! is `!Send`, so it must live on one thread). The JS side never blocks on rasterization unless it asks to:
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
//!   zpdf_clear_cache(doc), zpdf_close(doc), zpdf_last_error(), zpdf_version()
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
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use hayro::hayro_interpret::font::{Glyph, GlyphRun};
use hayro::hayro_interpret::hayro_cmap::BfString;
use hayro::hayro_interpret::{
    BlendMode, ClipPath, Context, Device, DrawMode, DrawProps, Image, ImageDrawProps, InterpreterCache,
    InterpreterSettings, SoftMask, TransformExt, interpret_page,
};
use hayro::hayro_syntax::Pdf;
use hayro::kurbo::{Affine, BezPath, Point, Rect, Shape};
use hayro::vello_cpu::color::palette::css::WHITE;
use hayro::{PixmapSettings, RenderCache, RenderSettings, render};

/// Largest rendered side in device pixels; bigger requests are scaled down (hayro's context is u16 anyway).
const MAX_SIDE: f32 = 16384.0;

// ---------------------------------------------------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------------------------------------------------

static LAST_ERROR: Mutex<Option<CString>> = Mutex::new(None);

fn set_error(msg: impl Into<String>) {
    let s = msg.into().replace('\0', " ");
    *LAST_ERROR.lock().unwrap() = CString::new(s).ok();
}

/// The last error message (valid until the next error). Never null.
#[unsafe(no_mangle)]
pub extern "C" fn zpdf_last_error() -> *const c_char {
    static EMPTY: &CStr = c"";
    match LAST_ERROR.lock().unwrap().as_ref() {
        // The CString lives in the static until it is replaced; JS copies it straight away.
        Some(c) => c.as_ptr(),
        None => EMPTY.as_ptr(),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn zpdf_version() -> *const c_char {
    c"zn_pdf 0.1.0 (hayro 0.8)".as_ptr()
}

// ---------------------------------------------------------------------------------------------------------------------
// jobs
// ---------------------------------------------------------------------------------------------------------------------

pub struct Job {
    /// 0 pending, 1 done, -1 failed, -2 cancelled before it ran
    state: AtomicI32,
    cancelled: AtomicBool,
    width: AtomicU32,
    height: AtomicU32,
    micros: AtomicU64,
    data: OnceLock<Vec<u8>>,
    done: (Mutex<bool>, Condvar),
}

impl Job {
    fn new() -> Arc<Job> {
        Arc::new(Job {
            state: AtomicI32::new(0),
            cancelled: AtomicBool::new(false),
            width: AtomicU32::new(0),
            height: AtomicU32::new(0),
            micros: AtomicU64::new(0),
            data: OnceLock::new(),
            done: (Mutex::new(false), Condvar::new()),
        })
    }
    fn finish(&self, state: i32) {
        self.state.store(state, Ordering::Release);
        *self.done.0.lock().unwrap() = true;
        self.done.1.notify_all();
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// document + worker thread
// ---------------------------------------------------------------------------------------------------------------------

enum Cmd {
    Render(Arc<Job>, usize, f32),
    Text(Arc<Job>, usize),
    ClearCache,
    Quit,
}

pub struct Doc {
    tx: Sender<Cmd>,
    join: Option<JoinHandle<()>>,
    dims: Vec<(f32, f32)>,
}

/// Where a document's bytes come from.
enum Source {
    Path(String),
    Bytes(Vec<u8>),
}

fn worker(src: Source, ready: Sender<Result<Vec<(f32, f32)>, String>>, rx: mpsc::Receiver<Cmd>) {
    let (bytes, what) = match src {
        Source::Path(path) => match std::fs::read(&path) {
            Ok(b) => (b, path),
            Err(e) => {
                let _ = ready.send(Err(format!("read {path}: {e}")));
                return;
            }
        },
        Source::Bytes(b) => (b, "<memory>".to_string()),
    };
    let pdf = match Pdf::new(Arc::new(bytes)) {
        Ok(p) => p,
        Err(e) => {
            let _ = ready.send(Err(format!("parse {what}: {e:?}")));
            return;
        }
    };
    let pages = pdf.pages();
    let dims: Vec<(f32, f32)> = pages.iter().map(|p| p.render_dimensions()).collect();
    let _ = ready.send(Ok(dims));
    drop(ready);

    let settings = InterpreterSettings::default();
    let render_settings = RenderSettings::default();
    let mut cache = RenderCache::new();

    while let Ok(cmd) = rx.recv() {
        match cmd {
            Cmd::Quit => break,
            Cmd::ClearCache => cache = RenderCache::new(),
            Cmd::Render(job, _, _) | Cmd::Text(job, _) if job.cancelled.load(Ordering::Acquire) => job.finish(-2),
            Cmd::Render(job, idx, scale) => {
                let t0 = Instant::now();
                let out = catch_unwind(AssertUnwindSafe(|| {
                    let page = pages.get(idx)?;
                    let (pw, ph) = page.render_dimensions();
                    let scale = clamp_scale(pw, ph, scale);
                    let pm = render(
                        page,
                        &cache,
                        &settings,
                        &render_settings,
                        &PixmapSettings { x_scale: scale, y_scale: scale, bg_color: WHITE },
                    );
                    let (w, h) = (pm.width() as u32, pm.height() as u32);
                    // premultiplied RGBA over opaque white == straight RGBA with alpha 255; swap R/B for BGRA.
                    let mut pm = pm;
                    let mut buf = pm.data_as_u8_slice_mut().to_vec();
                    for px in buf.chunks_exact_mut(4) {
                        px.swap(0, 2);
                        px[3] = 255;
                    }
                    Some((w, h, buf))
                }));
                match out {
                    Ok(Some((w, h, buf))) => {
                        job.width.store(w, Ordering::Relaxed);
                        job.height.store(h, Ordering::Relaxed);
                        job.micros.store(t0.elapsed().as_micros() as u64, Ordering::Relaxed);
                        let _ = job.data.set(buf);
                        job.finish(1);
                    }
                    Ok(None) => {
                        set_error(format!("no page {idx}"));
                        job.finish(-1);
                    }
                    Err(_) => {
                        // A panic inside hayro leaves the cache in an unknown state: start clean.
                        cache = RenderCache::new();
                        set_error(format!("render page {idx} panicked"));
                        job.finish(-1);
                    }
                }
            }
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
    // `cache` borrows `pdf`; it is dropped first (reverse declaration order), then `pdf`.
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
    let (tx, rx) = mpsc::channel();
    let (ready_tx, ready_rx) = mpsc::channel();
    let join = match std::thread::Builder::new()
        .name("zn-pdf".into())
        .stack_size(32 * 1024 * 1024)
        .spawn(move || worker(src, ready_tx, rx))
    {
        Ok(j) => j,
        Err(e) => {
            set_error(format!("spawn: {e}"));
            return std::ptr::null_mut();
        }
    };
    match ready_rx.recv() {
        Ok(Ok(dims)) => Box::into_raw(Box::new(Doc { tx, join: Some(join), dims })),
        Ok(Err(e)) => {
            set_error(e);
            let _ = join.join();
            std::ptr::null_mut()
        }
        Err(_) => {
            set_error("worker died while opening (panic in parser)");
            let _ = join.join();
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

/// Writes `[width, height]` in PDF points (page rotation applied). Returns 0, or -1 for a bad page.
///
/// # Safety
/// `out` must point to two `f32`s.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_page_size(doc: *const Doc, page: i32, out: *mut f32) -> i32 {
    let Some(d) = (unsafe { doc.as_ref() }) else { return -1 };
    let Some(&(w, h)) = usize::try_from(page).ok().and_then(|i| d.dims.get(i)) else { return -1 };
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
    let s = clamp_scale(w, h, scale);
    unsafe {
        *out = ((w * s) as u16) as u32;
        *out.add(1) = ((h * s) as u16) as u32;
    }
    0
}

/// Drop hayro's per-document caches (parsed fonts, glyph cache, decoded images). Memory goes back to the allocator.
///
/// # Safety
/// `doc` must be valid.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_clear_cache(doc: *const Doc) {
    if let Some(d) = unsafe { doc.as_ref() } {
        let _ = d.tx.send(Cmd::ClearCache);
    }
}

/// Close the document: stops the worker (after queued work) and frees everything. Jobs already returned stay valid.
///
/// # Safety
/// `doc` must come from `zpdf_open`; it is invalid afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_close(doc: *mut Doc) {
    if doc.is_null() {
        return;
    }
    let mut d = unsafe { Box::from_raw(doc) };
    let _ = d.tx.send(Cmd::Quit);
    if let Some(j) = d.join.take() {
        let _ = j.join();
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
    let Some(d) = (unsafe { doc.as_ref() }) else { return std::ptr::null() };
    let Ok(idx) = usize::try_from(page) else { return std::ptr::null() };
    if idx >= d.dims.len() {
        set_error(format!("page {page} out of range"));
        return std::ptr::null();
    }
    let job = Job::new();
    if d.tx.send(Cmd::Render(job.clone(), idx, scale)).is_err() {
        set_error("worker is gone");
        return std::ptr::null();
    }
    Arc::into_raw(job)
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
    let guard = j.done.0.lock().unwrap();
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
    let job = Job::new();
    if d.tx.send(Cmd::Text(job.clone(), idx)).is_err() {
        set_error("worker is gone");
        return std::ptr::null();
    }
    Arc::into_raw(job)
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
    out.push_str(&format!("{{\"pw\":{pw:.2},\"ph\":{ph:.2},\"words\":["));
    let mut first = true;
    for w in &words {
        let x = (w.x0 / pw).clamp(0.0, 1.0);
        let y = (w.y0 / ph).clamp(0.0, 1.0);
        let ww = ((w.x1 - w.x0) / pw).clamp(0.0, 1.0);
        let hh = ((w.y1 - w.y0) / ph).clamp(0.0, 1.0);
        if !first {
            out.push(',');
        }
        first = false;
        out.push_str("{\"t\":\"");
        json_escape(&w.text, &mut out);
        out.push_str(&format!("\",\"x\":{x:.5},\"y\":{y:.5},\"w\":{ww:.5},\"h\":{hh:.5},\"l\":{}}}", w.line));
    }
    out.push_str("]}");
    out
}
