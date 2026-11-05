//! PDFium behind a dozen hand-declared C functions, loaded from pdfium.dll at run time (bblanchon/pdfium-binaries, BSD-3 / Apache-2.0,
//! pinned in vendor/pdfium; the dll ships next to zn_pdf.dll). No crate: the functions used are plain C and stable.
//!
//! PDFium is not thread-safe, so every call goes through ONE process-wide lock (`LOCK`, held for the whole of a job: parse the page,
//! render it). A document's workers (src/lib.rs) are still useful: text layers, links and the outline run on hayro in parallel with a
//! PDFium render. Pages stay loaded (parsed) in a small per-document LRU, so the tiles of one page - and a page that is scrolled back
//! to - do not parse its content again.
//!
//! Look-up order for the dll: `ZN_PDFIUM_DLL`, next to zn_pdf.dll, next to the exe, `vendor/pdfium/bin` of the source tree this was
//! built from. `ZN_PDF_BACKEND=hayro` turns PDFium off.

use std::ffi::{OsStr, c_char, c_int, c_void};
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError, TryLockError};
use std::time::{Duration, Instant};

type Ptr = *mut c_void;

unsafe extern "system" {
    fn LoadLibraryExW(name: *const u16, file: isize, flags: u32) -> isize;
    fn GetProcAddress(module: isize, name: *const u8) -> *const c_void;
    fn GetModuleHandleExW(flags: u32, addr: *const c_void, out: *mut isize) -> i32;
    fn GetModuleFileNameW(module: isize, buf: *mut u16, len: u32) -> u32;
}

#[repr(C)]
#[derive(Default)]
struct SizeF {
    w: f32,
    h: f32,
}

struct Api {
    destroy_doc: unsafe extern "C" fn(Ptr),
    page_count: unsafe extern "C" fn(Ptr) -> c_int,
    page_size: unsafe extern "C" fn(Ptr, c_int, *mut SizeF) -> c_int,
    load_page: unsafe extern "C" fn(Ptr, c_int) -> Ptr,
    close_page: unsafe extern "C" fn(Ptr),
    bitmap_create: unsafe extern "C" fn(c_int, c_int, c_int, *mut c_void, c_int) -> Ptr,
    bitmap_fill: unsafe extern "C" fn(Ptr, c_int, c_int, c_int, c_int, u32) -> c_int,
    bitmap_destroy: unsafe extern "C" fn(Ptr),
    render: unsafe extern "C" fn(Ptr, Ptr, c_int, c_int, c_int, c_int, c_int, c_int),
    load_mem: unsafe extern "C" fn(*const c_void, usize, *const c_char) -> Ptr,
    last_error: unsafe extern "C" fn() -> u64,
    /// page editing, saving and printing (src/ops.rs); None when this pdfium.dll lacks one of them (rendering still works)
    extra: Option<Extra>,
}

/// FPDF_FILEWRITE with the bytes collected behind it (PDFium hands the struct back to `WriteBlock`).
#[repr(C)]
struct FileWrite {
    version: c_int,
    write_block: unsafe extern "C" fn(*mut FileWrite, *const c_void, u32) -> c_int,
    buf: Vec<u8>,
}

unsafe extern "C" fn write_block(this: *mut FileWrite, data: *const c_void, size: u32) -> c_int {
    let Some(w) = (unsafe { this.as_mut() }) else { return 0 };
    if size > 0 && !data.is_null() {
        w.buf.extend_from_slice(unsafe { std::slice::from_raw_parts(data.cast::<u8>(), size as usize) });
    }
    1
}

struct Extra {
    get_rotation: unsafe extern "C" fn(Ptr) -> c_int,
    set_rotation: unsafe extern "C" fn(Ptr, c_int),
    delete_page: unsafe extern "C" fn(Ptr, c_int),
    save_as_copy: unsafe extern "C" fn(Ptr, *mut FileWrite, u32) -> c_int,
    /// FPDF_RenderPage: draws into a Windows device context (a printer's)
    render_dc: unsafe extern "C" fn(isize, Ptr, c_int, c_int, c_int, c_int, c_int, c_int),
}

static LOCK: Mutex<()> = Mutex::new(());

/// The process-wide PDFium lock. A panic inside a job (caught by the worker) must not wedge every later render: poison is ignored.
/// `wait`: how long to wait for it (None: as long as it takes); Err(()) when it stayed busy that long.
fn lock(wait: Option<Duration>) -> Result<MutexGuard<'static, ()>, ()> {
    let Some(wait) = wait else { return Ok(LOCK.lock().unwrap_or_else(PoisonError::into_inner)) };
    let deadline = Instant::now() + wait;
    loop {
        match LOCK.try_lock() {
            Ok(g) => return Ok(g),
            Err(TryLockError::Poisoned(p)) => return Ok(p.into_inner()),
            Err(TryLockError::WouldBlock) if Instant::now() < deadline => std::thread::sleep(Duration::from_micros(250)),
            Err(TryLockError::WouldBlock) => return Err(()),
        }
    }
}
static API: OnceLock<Result<Api, String>> = OnceLock::new();

fn wide(s: &OsStr) -> Vec<u16> {
    s.encode_wide().chain(Some(0)).collect()
}

/// Directory of zn_pdf.dll itself.
fn own_dir() -> Option<PathBuf> {
    unsafe {
        let mut h: isize = 0;
        // FROM_ADDRESS | UNCHANGED_REFCOUNT
        if GetModuleHandleExW(0x4 | 0x2, own_dir as *const c_void, &mut h) == 0 {
            return None;
        }
        let mut buf = [0u16; 1024];
        let n = GetModuleFileNameW(h, buf.as_mut_ptr(), buf.len() as u32) as usize;
        if n == 0 || n >= buf.len() {
            return None;
        }
        PathBuf::from(String::from_utf16_lossy(&buf[..n])).parent().map(|p| p.to_path_buf())
    }
}

fn candidates() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(p) = std::env::var_os("ZN_PDFIUM_DLL") {
        v.push(PathBuf::from(p));
    }
    if let Some(d) = own_dir() {
        v.push(d.join("pdfium.dll"));
    }
    if let Some(d) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())) {
        v.push(d.join("pdfium.dll"));
    }
    v.push(PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/vendor/pdfium/bin/pdfium.dll")));
    v
}

fn load() -> Result<Api, String> {
    if std::env::var("ZN_PDF_BACKEND").is_ok_and(|v| v.eq_ignore_ascii_case("hayro")) {
        return Err("disabled by ZN_PDF_BACKEND=hayro".into());
    }
    let mut tried = Vec::new();
    for path in candidates() {
        if !path.is_file() {
            tried.push(format!("{} (missing)", path.display()));
            continue;
        }
        // LOAD_WITH_ALTERED_SEARCH_PATH: dependencies are looked for next to the dll
        let m = unsafe { LoadLibraryExW(wide(path.as_os_str()).as_ptr(), 0, 0x8) };
        if m == 0 {
            tried.push(format!("{} (cannot load)", path.display()));
            continue;
        }
        macro_rules! f {
            ($n:literal) => {{
                let p = unsafe { GetProcAddress(m, concat!($n, "\0").as_ptr()) };
                if p.is_null() {
                    tried.push(format!("{} (no {})", path.display(), $n));
                    continue;
                }
                unsafe { std::mem::transmute(p) }
            }};
        }
        let init: unsafe extern "C" fn() = f!("FPDF_InitLibrary");
        let api = Api {
            destroy_doc: f!("FPDF_CloseDocument"),
            page_count: f!("FPDF_GetPageCount"),
            page_size: f!("FPDF_GetPageSizeByIndexF"),
            load_page: f!("FPDF_LoadPage"),
            close_page: f!("FPDF_ClosePage"),
            bitmap_create: f!("FPDFBitmap_CreateEx"),
            bitmap_fill: f!("FPDFBitmap_FillRect"),
            bitmap_destroy: f!("FPDFBitmap_Destroy"),
            render: f!("FPDF_RenderPageBitmap"),
            load_mem: f!("FPDF_LoadMemDocument64"),
            last_error: f!("FPDF_GetLastError"),
            extra: None,
        };
        macro_rules! opt {
            ($n:literal) => {{
                let p = unsafe { GetProcAddress(m, concat!($n, "\0").as_ptr()) };
                if p.is_null() { None } else { Some(unsafe { std::mem::transmute(p) }) }
            }};
        }
        let extra = (|| {
            Some(Extra {
                get_rotation: opt!("FPDFPage_GetRotation")?,
                set_rotation: opt!("FPDFPage_SetRotation")?,
                delete_page: opt!("FPDFPage_Delete")?,
                save_as_copy: opt!("FPDF_SaveAsCopy")?,
                render_dc: opt!("FPDF_RenderPage")?,
            })
        })();
        let api = Api { extra, ..api };
        unsafe { init() };
        return Ok(api);
    }
    Err(format!("pdfium.dll not found or unusable: {}", tried.join("; ")))
}

fn api() -> Result<&'static Api, &'static str> {
    API.get_or_init(load).as_ref().map_err(|e| e.as_str())
}

/// Why PDFium is not in use (None when it is available).
pub fn unavailable() -> Option<&'static str> {
    api().err()
}

const PAGE_CACHE: usize = 3;
/// FPDF_ANNOT (draw annotations' appearance) | FPDF_RENDER_LIMITEDIMAGECACHE (do not keep decoded images around)
const FLAGS: c_int = 0x01 | 0x200;
fn flags() -> c_int {
    static F: OnceLock<c_int> = OnceLock::new();
    *F.get_or_init(|| std::env::var("ZN_PDFIUM_FLAGS").ok().and_then(|v| v.parse().ok()).unwrap_or(FLAGS))
}
/// FPDFBitmap_BGRA
const BGRA: c_int = 4;

struct Inner {
    doc: Ptr,
    /// loaded pages, most recently used last
    pages: Vec<(usize, Ptr)>,
}

/// One open document. All use is serialised by `LOCK`, so the raw pointers may cross threads.
pub struct PdfiumDoc {
    api: &'static Api,
    inner: Mutex<Inner>,
    /// the buffer pdfium reads the document from (FPDF_LoadMemDocument64 does not copy it)
    _bytes: Arc<Vec<u8>>,
    /// page sizes in points, rotation applied
    pub dims: Vec<(f32, f32)>,
}

unsafe impl Send for PdfiumDoc {}
unsafe impl Sync for PdfiumDoc {}

impl PdfiumDoc {
    pub fn open(bytes: Arc<Vec<u8>>) -> Result<PdfiumDoc, String> {
        let api = api().map_err(str::to_string)?;
        let _g = lock(None).unwrap();
        let doc = unsafe { (api.load_mem)(bytes.as_ptr().cast(), bytes.len(), std::ptr::null()) };
        if doc.is_null() {
            return Err(format!("pdfium: cannot open the document (error {})", unsafe { (api.last_error)() }));
        }
        let n = unsafe { (api.page_count)(doc) }.max(0) as usize;
        let mut dims = Vec::with_capacity(n);
        for i in 0..n {
            let mut s = SizeF::default();
            if unsafe { (api.page_size)(doc, i as c_int, &mut s) } == 0 || !(s.w > 0.0 && s.h > 0.0) {
                s = SizeF { w: 612.0, h: 792.0 };
            }
            dims.push((s.w, s.h));
        }
        Ok(PdfiumDoc { api, inner: Mutex::new(Inner { doc, pages: Vec::new() }), _bytes: bytes, dims })
    }

    /// Render the device-pixel region `(rx, ry, rw, rh)` of the page drawn `fw` x `fh` px big and rotated `rot` (0..3 quarter turns
    /// clockwise) into a new BGRA buffer, opaque, on white, and the ms the drawing took (without the wait for the lock). `None` when the page cannot be loaded.
    ///
    /// PDFium runs one job at a time process-wide. A job that finds it busy for longer than `wait` returns `Err(())` (the caller renders
    /// it with hayro instead: a page that takes PDFium a second must not stall every other render); None waits as long as it takes.
    #[allow(clippy::too_many_arguments)]
    pub fn render(&self, wait: Option<Duration>, page: usize, fw: u32, fh: u32, rot: u16, rx: u32, ry: u32, rw: u32, rh: u32) -> Result<Option<(Vec<u8>, f32)>, ()> {
        let api = self.api;
        let _g = lock(wait)?;
        let t0 = Instant::now();
        Ok(self.render_locked(api, page, fw, fh, rot, rx, ry, rw, rh).map(|b| (b, t0.elapsed().as_secs_f32() * 1000.0)))
    }

    #[allow(clippy::too_many_arguments)]
    fn render_locked(&self, api: &Api, page: usize, fw: u32, fh: u32, rot: u16, rx: u32, ry: u32, rw: u32, rh: u32) -> Option<Vec<u8>> {
        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        let pg = match inner.pages.iter().position(|(i, _)| *i == page) {
            Some(k) => {
                let e = inner.pages.remove(k);
                inner.pages.push(e);
                e.1
            }
            None => {
                let p = unsafe { (api.load_page)(inner.doc, page as c_int) };
                if p.is_null() {
                    return None;
                }
                inner.pages.push((page, p));
                if inner.pages.len() > PAGE_CACHE {
                    let (_, old) = inner.pages.remove(0);
                    unsafe { (api.close_page)(old) };
                }
                p
            }
        };
        let stride = rw as usize * 4;
        let mut buf = vec![0u8; stride * rh as usize];
        unsafe {
            let bmp = (api.bitmap_create)(rw as c_int, rh as c_int, BGRA, buf.as_mut_ptr().cast(), stride as c_int);
            if bmp.is_null() {
                return None;
            }
            (api.bitmap_fill)(bmp, 0, 0, rw as c_int, rh as c_int, 0xFFFF_FFFF);
            (api.render)(bmp, pg, -(rx as c_int), -(ry as c_int), fw as c_int, fh as c_int, (rot % 4) as c_int, flags());
            (api.bitmap_destroy)(bmp);
        }
        Some(buf)
    }

    /// Drop the loaded pages (their parsed content streams).
    pub fn clear(&self) {
        let _g = lock(None).unwrap();
        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        for (_, p) in inner.pages.drain(..) {
            unsafe { (self.api.close_page)(p) };
        }
    }
}

impl Drop for PdfiumDoc {
    fn drop(&mut self) {
        let _g = lock(None).unwrap();
        let inner = self.inner.get_mut().unwrap_or_else(PoisonError::into_inner);
        for (_, p) in inner.pages.drain(..) {
            unsafe { (self.api.close_page)(p) };
        }
        unsafe { (self.api.destroy_doc)(inner.doc) };
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// editing and printing (src/ops.rs drives these)
// ---------------------------------------------------------------------------------------------------------------------

/// FPDF_NO_INCREMENTAL: the saved file is written anew (no update section appended to the old one)
const SAVE_FULL: u32 = 2;
/// FPDF_ANNOT | FPDF_PRINTING (annotation appearances, and the print variant of them)
const PRINT_FLAGS: c_int = 0x01 | 0x800;

fn extra_api() -> Result<(&'static Api, &'static Extra), String> {
    let api = api().map_err(|e| format!("PDFium is not available: {e}"))?;
    let ex = api.extra.as_ref().ok_or("this pdfium.dll has no page editing and printing functions")?;
    Ok((api, ex))
}

/// A document of its own (a separate parse of `bytes`, not the reader's), for one edit or one print job. Every call takes `LOCK`
/// for its own duration only, so the screen's renders go on between the pages of a print job.
pub struct OwnedDoc {
    api: &'static Api,
    ex: &'static Extra,
    doc: Ptr,
    _bytes: Arc<Vec<u8>>,
}

unsafe impl Send for OwnedDoc {}

impl OwnedDoc {
    pub fn open(bytes: Arc<Vec<u8>>) -> Result<OwnedDoc, String> {
        let (api, ex) = extra_api()?;
        let _g = lock(None).unwrap();
        let doc = unsafe { (api.load_mem)(bytes.as_ptr().cast(), bytes.len(), std::ptr::null()) };
        if doc.is_null() {
            let code = unsafe { (api.last_error)() };
            return Err(match code {
                4 => "the PDF is password-protected".to_string(),
                3 | 2 => "the file is not a valid PDF".to_string(),
                _ => format!("PDFium cannot open the document (error {code})"),
            });
        }
        Ok(OwnedDoc { api, ex, doc, _bytes: bytes })
    }

    pub fn page_count(&self) -> usize {
        let _g = lock(None).unwrap();
        unsafe { (self.api.page_count)(self.doc) }.max(0) as usize
    }

    /// Page size in points, the page's own rotation applied.
    pub fn page_size(&self, page: usize) -> (f32, f32) {
        let _g = lock(None).unwrap();
        let mut s = SizeF::default();
        if unsafe { (self.api.page_size)(self.doc, page as c_int, &mut s) } == 0 || !(s.w > 0.0 && s.h > 0.0) {
            return (612.0, 792.0);
        }
        (s.w, s.h)
    }

    /// Rotate pages (`rotate`: page index and quarter turns clockwise to add to its /Rotate), then delete pages (indexes of the
    /// original document), and return the whole document saved anew.
    pub fn edit(&self, rotate: &[(usize, i32)], delete: &[usize]) -> Result<Vec<u8>, String> {
        let _g = lock(None).unwrap();
        let (api, ex, doc) = (self.api, self.ex, self.doc);
        let n = unsafe { (api.page_count)(doc) }.max(0) as usize;
        for &(p, q) in rotate {
            if p >= n {
                return Err(format!("page {} does not exist (the document has {n} pages)", p + 1));
            }
            let pg = unsafe { (api.load_page)(doc, p as c_int) };
            if pg.is_null() {
                return Err(format!("PDFium cannot load page {}", p + 1));
            }
            unsafe {
                let r = ((ex.get_rotation)(pg) + q).rem_euclid(4);
                (ex.set_rotation)(pg, r);
                (api.close_page)(pg);
            }
        }
        let mut del = delete.to_vec();
        del.sort_unstable();
        del.dedup();
        if let Some(&p) = del.iter().find(|&&p| p >= n) {
            return Err(format!("page {} does not exist (the document has {n} pages)", p + 1));
        }
        if !del.is_empty() && del.len() >= n {
            return Err("at least one page must remain".into());
        }
        for &p in del.iter().rev() {
            unsafe { (ex.delete_page)(doc, p as c_int) };
        }
        let left = unsafe { (api.page_count)(doc) }.max(0) as usize;
        if left != n - del.len() {
            return Err(format!("PDFium left {left} pages instead of {}", n - del.len()));
        }
        let mut w = FileWrite { version: 1, write_block, buf: Vec::with_capacity(self._bytes.len() + 4096) };
        if unsafe { (ex.save_as_copy)(doc, &mut w, SAVE_FULL) } == 0 {
            return Err(format!("PDFium could not save the document (error {})", unsafe { (api.last_error)() }));
        }
        if w.buf.len() < 8 || !w.buf.starts_with(b"%PDF-") {
            return Err("PDFium saved something that is not a PDF".into());
        }
        Ok(std::mem::take(&mut w.buf))
    }

    /// Draw `page` into the device context `hdc` (a printer's) at the device-unit rect (x, y, w, h). `turn`: a quarter turn to fit
    /// the paper's orientation, anticlockwise (the usual landscape print, and what undoes a /Rotate of 90), clockwise for a page
    /// whose /Rotate is 270 (so a page turned by a rotation prints upright again).
    #[allow(clippy::too_many_arguments)]
    pub fn render_dc(&self, hdc: isize, page: usize, x: i32, y: i32, w: i32, h: i32, turn: bool) -> Result<(), String> {
        let _g = lock(None).unwrap();
        let pg = unsafe { (self.api.load_page)(self.doc, page as c_int) };
        if pg.is_null() {
            return Err(format!("PDFium cannot load page {}", page + 1));
        }
        unsafe {
            let rot = if !turn { 0 } else if (self.ex.get_rotation)(pg) == 3 { 1 } else { 3 };
            (self.ex.render_dc)(hdc, pg, x, y, w, h, rot, PRINT_FLAGS);
            (self.api.close_page)(pg);
        }
        Ok(())
    }
}

impl Drop for OwnedDoc {
    fn drop(&mut self) {
        let _g = lock(None).unwrap();
        unsafe { (self.api.destroy_doc)(self.doc) };
    }
}
