//! OLE drag source (Windows): drag text out of the GPUI window into other apps, as Zotero's Quick Copy does.
//!
//! GPUI has no OLE drag-and-drop source, so this runs `DoDragDrop` itself with a minimal `IDataObject` that offers two formats:
//! `CF_UNICODETEXT` and "HTML Format" (CF_HTML). The JS side builds the CF_HTML document (offsets and all), this file only hands
//! the bytes over. The modal drag loop runs on the thread of the window the mouse went down in.
//!
//!   zn_drag_available() -> 2
//!   zn_drag_begin(hwnd, text, text_len, html, html_len) -> job   (null: see zpdf_last_error)
//!        text = UTF-8 plain text; html = the complete CF_HTML document as bytes (may be empty: text only). Both are copied.
//!        The drag runs on the thread that owns hwnd (see below); the job (zpdf_job_poll / _data / _free) ends when the button is
//!        released, with JSON {"result":"dropped"|"cancelled"}. The left button must be down when this is called.
//!
//! No crates: the few Win32/COM calls are declared by hand, like src/pdfium.rs does for PDFium.
#![allow(unsafe_op_in_unsafe_fn, non_snake_case, clippy::missing_safety_doc)]

use std::ffi::c_void;
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicU32, Ordering};

type Hresult = i32;
const S_OK: Hresult = 0;
const E_NOINTERFACE: Hresult = 0x8000_4002_u32 as i32;
const E_NOTIMPL: Hresult = 0x8000_4001_u32 as i32;
const E_POINTER: Hresult = 0x8000_4003_u32 as i32;
const E_OUTOFMEMORY: Hresult = 0x8007_000E_u32 as i32;
const DV_E_FORMATETC: Hresult = 0x8004_0064_u32 as i32;
const DV_E_TYMED: Hresult = 0x8004_0069_u32 as i32;
const DV_E_DVASPECT: Hresult = 0x8004_0065_u32 as i32;
const OLE_E_ADVISENOTSUPPORTED: Hresult = 0x8004_0003_u32 as i32;
const DRAGDROP_S_DROP: Hresult = 0x0004_0100;
const DRAGDROP_S_CANCEL: Hresult = 0x0004_0101;
const DRAGDROP_S_USEDEFAULTCURSORS: Hresult = 0x0004_0102;

const CF_UNICODETEXT: u16 = 13;
const DVASPECT_CONTENT: u32 = 1;
const TYMED_HGLOBAL: u32 = 1;
const DATADIR_GET: u32 = 1;
pub const DROPEFFECT_COPY: u32 = 1;
const MK_LBUTTON: u32 = 1;
const GMEM_MOVEABLE: u32 = 2;

#[repr(C)]
#[derive(Clone, Copy, PartialEq)]
pub struct Guid {
    d1: u32,
    d2: u16,
    d3: u16,
    d4: [u8; 8],
}
const fn guid(d1: u32, d2: u16, d3: u16, d4: [u8; 8]) -> Guid {
    Guid { d1, d2, d3, d4 }
}
const IID_IUNKNOWN: Guid = guid(0, 0, 0, [0xC0, 0, 0, 0, 0, 0, 0, 0x46]);
const IID_IDATAOBJECT: Guid = guid(0x10e, 0, 0, [0xC0, 0, 0, 0, 0, 0, 0, 0x46]);
const IID_IDROPSOURCE: Guid = guid(0x121, 0, 0, [0xC0, 0, 0, 0, 0, 0, 0, 0x46]);

#[repr(C)]
#[derive(Clone, Copy)]
pub struct FormatEtc {
    cf_format: u16,
    ptd: *mut c_void,
    aspect: u32,
    lindex: i32,
    tymed: u32,
}

#[repr(C)]
pub struct StgMedium {
    tymed: u32,
    h_global: *mut c_void,
    punk_for_release: *mut c_void,
}

#[link(name = "ole32")]
unsafe extern "system" {
    fn OleInitialize(reserved: *mut c_void) -> Hresult;
    fn OleUninitialize();
    fn DoDragDrop(data: *mut c_void, source: *mut c_void, ok_effects: u32, effect: *mut u32) -> Hresult;
}
#[link(name = "user32")]
unsafe extern "system" {
    fn RegisterClipboardFormatW(name: *const u16) -> u32;
}
#[link(name = "shell32")]
unsafe extern "system" {
    fn SHCreateStdEnumFmtEtc(count: u32, formats: *const FormatEtc, out: *mut *mut c_void) -> Hresult;
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GlobalAlloc(flags: u32, bytes: usize) -> *mut c_void;
    fn GlobalLock(mem: *mut c_void) -> *mut c_void;
    fn GlobalUnlock(mem: *mut c_void) -> i32;
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

/// A new moveable HGLOBAL holding `bytes` (the receiver frees it through the STGMEDIUM).
unsafe fn global_with(bytes: &[u8]) -> Option<*mut c_void> {
    let mem = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1));
    if mem.is_null() {
        return None;
    }
    let dst = GlobalLock(mem);
    if dst.is_null() {
        return None;
    }
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), dst as *mut u8, bytes.len());
    GlobalUnlock(mem);
    Some(mem)
}

// ---------------------------------------------------------------------------------------------------------------------
// IDataObject

#[repr(C)]
pub struct DataObjectVtbl {
    query_interface: unsafe extern "system" fn(*mut DataObject, *const Guid, *mut *mut c_void) -> Hresult,
    add_ref: unsafe extern "system" fn(*mut DataObject) -> u32,
    release: unsafe extern "system" fn(*mut DataObject) -> u32,
    get_data: unsafe extern "system" fn(*mut DataObject, *const FormatEtc, *mut StgMedium) -> Hresult,
    get_data_here: unsafe extern "system" fn(*mut DataObject, *const FormatEtc, *mut StgMedium) -> Hresult,
    query_get_data: unsafe extern "system" fn(*mut DataObject, *const FormatEtc) -> Hresult,
    get_canonical_format_etc: unsafe extern "system" fn(*mut DataObject, *const FormatEtc, *mut FormatEtc) -> Hresult,
    set_data: unsafe extern "system" fn(*mut DataObject, *const FormatEtc, *mut StgMedium, i32) -> Hresult,
    enum_format_etc: unsafe extern "system" fn(*mut DataObject, u32, *mut *mut c_void) -> Hresult,
    d_advise: unsafe extern "system" fn(*mut DataObject, *const FormatEtc, u32, *mut c_void, *mut u32) -> Hresult,
    d_unadvise: unsafe extern "system" fn(*mut DataObject, u32) -> Hresult,
    enum_d_advise: unsafe extern "system" fn(*mut DataObject, *mut *mut c_void) -> Hresult,
}

#[repr(C)]
pub struct DataObject {
    vtbl: *const DataObjectVtbl,
    refs: AtomicU32,
    /// UTF-16 text with the terminating NUL
    text: Vec<u8>,
    /// the CF_HTML document with a terminating NUL; empty = no HTML offered
    html: Vec<u8>,
    html_fmt: u16,
}

static DATA_VTBL: DataObjectVtbl = DataObjectVtbl {
    query_interface: do_query_interface,
    add_ref: do_add_ref,
    release: do_release,
    get_data: do_get_data,
    get_data_here: do_get_data_here,
    query_get_data: do_query_get_data,
    get_canonical_format_etc: do_get_canonical,
    set_data: do_set_data,
    enum_format_etc: do_enum_format_etc,
    d_advise: do_d_advise,
    d_unadvise: do_d_unadvise,
    enum_d_advise: do_enum_d_advise,
};

impl DataObject {
    /// A data object with one reference. `html` is the whole CF_HTML document (empty: text only).
    pub unsafe fn create(text: &str, html: &[u8]) -> *mut DataObject {
        let mut t: Vec<u8> = Vec::with_capacity(text.len() * 2 + 2);
        for u in text.encode_utf16().chain(Some(0)) {
            t.extend_from_slice(&u.to_le_bytes());
        }
        let mut h = html.to_vec();
        if !h.is_empty() {
            h.push(0);
        }
        let html_fmt = RegisterClipboardFormatW(wide("HTML Format").as_ptr()) as u16;
        Box::into_raw(Box::new(DataObject { vtbl: &DATA_VTBL, refs: AtomicU32::new(1), text: t, html: h, html_fmt }))
    }

    fn formats(&self) -> Vec<FormatEtc> {
        let f = |cf| FormatEtc { cf_format: cf, ptd: null_mut(), aspect: DVASPECT_CONTENT, lindex: -1, tymed: TYMED_HGLOBAL };
        let mut v = vec![f(CF_UNICODETEXT)];
        if !self.html.is_empty() {
            v.push(f(self.html_fmt));
        }
        v
    }

    /// Which payload does this request ask for? Err = the COM error to return.
    fn payload(&self, fe: &FormatEtc) -> Result<&[u8], Hresult> {
        if fe.aspect != DVASPECT_CONTENT {
            return Err(DV_E_DVASPECT);
        }
        let known = fe.cf_format == CF_UNICODETEXT || (!self.html.is_empty() && fe.cf_format == self.html_fmt);
        if !known {
            return Err(DV_E_FORMATETC);
        }
        if fe.tymed & TYMED_HGLOBAL == 0 {
            return Err(DV_E_TYMED);
        }
        Ok(if fe.cf_format == CF_UNICODETEXT { &self.text } else { &self.html })
    }
}

unsafe extern "system" fn do_query_interface(this: *mut DataObject, iid: *const Guid, out: *mut *mut c_void) -> Hresult {
    if iid.is_null() || out.is_null() {
        return E_POINTER;
    }
    if *iid == IID_IUNKNOWN || *iid == IID_IDATAOBJECT {
        do_add_ref(this);
        *out = this as *mut c_void;
        S_OK
    } else {
        *out = null_mut();
        E_NOINTERFACE
    }
}
unsafe extern "system" fn do_add_ref(this: *mut DataObject) -> u32 {
    (*this).refs.fetch_add(1, Ordering::AcqRel) + 1
}
unsafe extern "system" fn do_release(this: *mut DataObject) -> u32 {
    let n = (*this).refs.fetch_sub(1, Ordering::AcqRel) - 1;
    if n == 0 {
        drop(Box::from_raw(this));
    }
    n
}
unsafe extern "system" fn do_get_data(this: *mut DataObject, fe: *const FormatEtc, medium: *mut StgMedium) -> Hresult {
    if fe.is_null() || medium.is_null() {
        return E_POINTER;
    }
    let bytes = match (*this).payload(&*fe) {
        Ok(b) => b,
        Err(e) => return e,
    };
    match global_with(bytes) {
        Some(h) => {
            *medium = StgMedium { tymed: TYMED_HGLOBAL, h_global: h, punk_for_release: null_mut() };
            S_OK
        }
        None => E_OUTOFMEMORY,
    }
}
unsafe extern "system" fn do_get_data_here(_: *mut DataObject, _: *const FormatEtc, _: *mut StgMedium) -> Hresult {
    E_NOTIMPL
}
unsafe extern "system" fn do_query_get_data(this: *mut DataObject, fe: *const FormatEtc) -> Hresult {
    if fe.is_null() {
        return E_POINTER;
    }
    match (*this).payload(&*fe) {
        Ok(_) => S_OK,
        Err(e) => e,
    }
}
unsafe extern "system" fn do_get_canonical(_: *mut DataObject, _: *const FormatEtc, out: *mut FormatEtc) -> Hresult {
    if !out.is_null() {
        (*out).ptd = null_mut();
    }
    0x0004_0130 // DATA_S_SAMEFORMATETC
}
unsafe extern "system" fn do_set_data(_: *mut DataObject, _: *const FormatEtc, _: *mut StgMedium, _: i32) -> Hresult {
    E_NOTIMPL
}
unsafe extern "system" fn do_enum_format_etc(this: *mut DataObject, dir: u32, out: *mut *mut c_void) -> Hresult {
    if out.is_null() {
        return E_POINTER;
    }
    if dir != DATADIR_GET {
        return E_NOTIMPL;
    }
    let f = (*this).formats();
    SHCreateStdEnumFmtEtc(f.len() as u32, f.as_ptr(), out)
}
unsafe extern "system" fn do_d_advise(_: *mut DataObject, _: *const FormatEtc, _: u32, _: *mut c_void, _: *mut u32) -> Hresult {
    OLE_E_ADVISENOTSUPPORTED
}
unsafe extern "system" fn do_d_unadvise(_: *mut DataObject, _: u32) -> Hresult {
    OLE_E_ADVISENOTSUPPORTED
}
unsafe extern "system" fn do_enum_d_advise(_: *mut DataObject, _: *mut *mut c_void) -> Hresult {
    OLE_E_ADVISENOTSUPPORTED
}

// ---------------------------------------------------------------------------------------------------------------------
// IDropSource

/// How the source decides to end the drag. `Real` follows the mouse button and Escape; `Auto` (tests) drops after that many polls
/// without looking at the button, so a test can drive a drag with the pointer moved by SetCursorPos alone.
#[derive(Clone, Copy)]
pub enum SourceMode {
    Real,
    Auto(u32),
}

#[repr(C)]
pub struct DropSourceVtbl {
    query_interface: unsafe extern "system" fn(*mut DropSource, *const Guid, *mut *mut c_void) -> Hresult,
    add_ref: unsafe extern "system" fn(*mut DropSource) -> u32,
    release: unsafe extern "system" fn(*mut DropSource) -> u32,
    query_continue_drag: unsafe extern "system" fn(*mut DropSource, i32, u32) -> Hresult,
    give_feedback: unsafe extern "system" fn(*mut DropSource, u32) -> Hresult,
}

#[repr(C)]
pub struct DropSource {
    vtbl: *const DropSourceVtbl,
    refs: AtomicU32,
    mode: SourceMode,
    polls: AtomicU32,
}

static SOURCE_VTBL: DropSourceVtbl = DropSourceVtbl {
    query_interface: ds_query_interface,
    add_ref: ds_add_ref,
    release: ds_release,
    query_continue_drag: ds_query_continue_drag,
    give_feedback: ds_give_feedback,
};

impl DropSource {
    pub unsafe fn create(mode: SourceMode) -> *mut DropSource {
        Box::into_raw(Box::new(DropSource { vtbl: &SOURCE_VTBL, refs: AtomicU32::new(1), mode, polls: AtomicU32::new(0) }))
    }
}

unsafe extern "system" fn ds_query_interface(this: *mut DropSource, iid: *const Guid, out: *mut *mut c_void) -> Hresult {
    if iid.is_null() || out.is_null() {
        return E_POINTER;
    }
    if *iid == IID_IUNKNOWN || *iid == IID_IDROPSOURCE {
        ds_add_ref(this);
        *out = this as *mut c_void;
        S_OK
    } else {
        *out = null_mut();
        E_NOINTERFACE
    }
}
unsafe extern "system" fn ds_add_ref(this: *mut DropSource) -> u32 {
    (*this).refs.fetch_add(1, Ordering::AcqRel) + 1
}
unsafe extern "system" fn ds_release(this: *mut DropSource) -> u32 {
    let n = (*this).refs.fetch_sub(1, Ordering::AcqRel) - 1;
    if n == 0 {
        drop(Box::from_raw(this));
    }
    n
}
unsafe extern "system" fn ds_query_continue_drag(this: *mut DropSource, escape: i32, key_state: u32) -> Hresult {
    if escape != 0 {
        return DRAGDROP_S_CANCEL;
    }
    match (*this).mode {
        SourceMode::Real => {
            if key_state & MK_LBUTTON == 0 {
                DRAGDROP_S_DROP
            } else {
                S_OK
            }
        }
        SourceMode::Auto(after) => {
            if (*this).polls.fetch_add(1, Ordering::Relaxed) + 1 >= after {
                DRAGDROP_S_DROP
            } else {
                S_OK
            }
        }
    }
}
unsafe extern "system" fn ds_give_feedback(_: *mut DropSource, _: u32) -> Hresult {
    DRAGDROP_S_USEDEFAULTCURSORS
}

// ---------------------------------------------------------------------------------------------------------------------
// the drag itself

/// Run the modal drag on the calling thread (OLE is initialised here as an STA); true when the target accepted a drop.
pub unsafe fn run_drag(text: &str, html: &[u8], mode: SourceMode) -> Result<bool, String> {
    let init = OleInitialize(null_mut());
    if init < 0 {
        return Err(format!("OleInitialize failed (0x{:08X}); the window's thread is not an STA", init as u32));
    }
    let data = DataObject::create(text, html);
    let source = DropSource::create(mode);
    let mut effect = 0u32;
    let hr = DoDragDrop(data as *mut c_void, source as *mut c_void, DROPEFFECT_COPY, &mut effect);
    do_release(data);
    ds_release(source);
    OleUninitialize();
    match hr {
        DRAGDROP_S_DROP => Ok(effect != 0),
        DRAGDROP_S_CANCEL => Ok(false),
        e => Err(format!("DoDragDrop failed (0x{:08X})", e as u32)),
    }
}

// OLE only sees the pointer on the thread that owns the window the button went down in (tested: from a worker thread the drag
// hangs), and GPUI's window lives on a thread of its own, not the JS thread. So the drag is posted to that thread: the window is
// subclassed (SetWindowLongPtrW works across threads of one process), a private window message carries the request, and the
// subclass proc runs DoDragDrop on the window's thread. JS is never blocked: the job is polled like every other zn_pdf job.

#[link(name = "user32")]
unsafe extern "system" {
    fn RegisterWindowMessageW(name: *const u16) -> u32;
    fn SetWindowLongPtrW(hwnd: isize, index: i32, value: isize) -> isize;
    fn CallWindowProcW(prev: isize, hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize;
    fn PostMessageW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> i32;
    fn IsWindow(hwnd: isize) -> i32;
}
const GWLP_WNDPROC: i32 = -4;
const WM_NCDESTROY: u32 = 0x0082;

struct Request {
    text: String,
    html: Vec<u8>,
    mode: SourceMode,
    job: std::sync::Arc<crate::Job>,
}

fn drag_message() -> u32 {
    static MSG: std::sync::OnceLock<u32> = std::sync::OnceLock::new();
    *MSG.get_or_init(|| unsafe { RegisterWindowMessageW(wide("ZN_DRAG_RUN").as_ptr()) })
}

/// Original window procedures of the subclassed windows (hwnd -> proc), so the subclass is installed once per window.
fn originals() -> &'static std::sync::Mutex<std::collections::HashMap<isize, isize>> {
    static M: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<isize, isize>>> = std::sync::OnceLock::new();
    M.get_or_init(Default::default)
}

/// Lock ignoring poison: these run inside a window procedure, where a panic would abort the process.
fn relock<T>(m: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Drags posted to a window and not started yet, oldest first. The posted message carries nothing: the window's queue does, so a request
/// can never be mistaken for another one, and when the window dies before the message is dispatched (the system discards it) the
/// requests are still here to be finished.
fn pending() -> &'static std::sync::Mutex<std::collections::HashMap<isize, std::collections::VecDeque<Request>>> {
    static M: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<isize, std::collections::VecDeque<Request>>>> = std::sync::OnceLock::new();
    M.get_or_init(Default::default)
}

/// The window is gone: every drag still waiting for it fails (JS is polling those jobs).
fn fail_pending(hwnd: isize) {
    let waiting = relock(pending()).remove(&hwnd).unwrap_or_default();
    for req in waiting {
        crate::set_error("the window was closed before the drag started");
        req.job.finish(-1);
    }
}

unsafe extern "system" fn subclass_proc(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize {
    if msg == drag_message() {
        let Some(req) = relock(pending()).get_mut(&hwnd).and_then(|q| q.pop_front()) else { return 0 };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_drag(&req.text, &req.html, req.mode)));
        match result {
            Ok(Ok(dropped)) => {
                let json = format!("{{\"result\":\"{}\"}}", if dropped { "dropped" } else { "cancelled" }).into_bytes();
                let _ = req.job.data.set(json);
                req.job.finish(1);
            }
            Ok(Err(e)) => {
                crate::set_error(e);
                req.job.finish(-1);
            }
            Err(_) => {
                crate::set_error("the drag panicked");
                req.job.finish(-1);
            }
        }
        return 0;
    }
    let prev = relock(originals()).get(&hwnd).copied().unwrap_or(0);
    let r = CallWindowProcW(prev, hwnd, msg, wparam, lparam);
    if msg == WM_NCDESTROY {
        relock(originals()).remove(&hwnd);
        fail_pending(hwnd);
    }
    r
}

/// Subclass `hwnd` once. Err when the window is gone or the call fails.
unsafe fn ensure_subclass(hwnd: isize) -> Result<(), String> {
    if IsWindow(hwnd) == 0 {
        return Err("the window does not exist".into());
    }
    let mut map = relock(originals());
    if map.contains_key(&hwnd) {
        return Ok(());
    }
    let prev = SetWindowLongPtrW(hwnd, GWLP_WNDPROC, subclass_proc as usize as isize);
    if prev == 0 {
        return Err("SetWindowLongPtrW(GWLP_WNDPROC) failed".into());
    }
    map.insert(hwnd, prev);
    Ok(())
}

/// Post the drag to `hwnd`'s own thread; the job's data is JSON {"result":"dropped"|"cancelled"}.
pub unsafe fn start_on(hwnd: isize, text: String, html: Vec<u8>, mode: SourceMode) -> *const crate::Job {
    if let Err(e) = ensure_subclass(hwnd) {
        crate::set_error(e);
        return std::ptr::null();
    }
    let job = crate::Job::new(0.0);
    relock(pending()).entry(hwnd).or_default().push_back(Request { text, html, mode, job: job.clone() });
    if PostMessageW(hwnd, drag_message(), 0, 0) == 0 {
        if let Some(q) = relock(pending()).get_mut(&hwnd) {
            q.retain(|r| !std::sync::Arc::ptr_eq(&r.job, &job));
        }
        crate::set_error("PostMessageW failed");
        return std::ptr::null();
    }
    // closed between ensure_subclass and the post: WM_NCDESTROY may have run before the request was queued
    if IsWindow(hwnd) == 0 {
        fail_pending(hwnd);
    }
    std::sync::Arc::into_raw(job)
}

#[unsafe(no_mangle)]
pub extern "C" fn zn_drag_available() -> i32 {
    2
}

/// Start an OS drag of `text` (UTF-8) and, when `html_len > 0`, the CF_HTML document in `html`, on the thread that owns `hwnd`
/// (the window the left button went down in; it must still be down). Returns a job (zpdf_job_poll / zpdf_job_free) whose data is
/// JSON {"result":"dropped"|"cancelled"}, or null (zpdf_last_error). Does not block.
///
/// # Safety
/// `text` / `html` must be valid for the given lengths (or null with length 0); `hwnd` a window of this process.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zn_drag_begin(hwnd: isize, text: *const u8, text_len: usize, html: *const u8, html_len: usize) -> *const crate::Job {
    let slice = |p: *const u8, n: usize| -> Vec<u8> { if p.is_null() || n == 0 { Vec::new() } else { std::slice::from_raw_parts(p, n).to_vec() } };
    let t = String::from_utf8_lossy(&slice(text, text_len)).into_owned();
    start_on(hwnd, t, slice(html, html_len), SourceMode::Real)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    #[repr(C)]
    struct Msg {
        hwnd: *mut c_void,
        message: u32,
        wparam: usize,
        lparam: isize,
        time: u32,
        x: i32,
        y: i32,
        private: u32,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Pt {
        x: i32,
        y: i32,
    }

    #[repr(C)]
    struct MouseInput {
        dx: i32,
        dy: i32,
        data: u32,
        flags: u32,
        time: u32,
        extra: usize,
    }
    #[repr(C)]
    struct Input {
        kind: u32,
        mouse: MouseInput,
    }
    /// A one-pixel relative pointer move (queues a real WM_MOUSEMOVE; SetCursorPos alone does not): no button is touched.
    unsafe fn mouse(dx: i32, flags: u32) {
        let i = Input { kind: 0, mouse: MouseInput { dx, dy: 0, data: 0, flags, time: 0, extra: 0 } };
        SendInput(1, &i, std::mem::size_of::<Input>() as i32);
    }
    unsafe fn jiggle(dx: i32) {
        mouse(dx, 1 /* MOUSEEVENTF_MOVE */);
    }
    /// Releases the left button however the test ends.
    struct ButtonGuard;
    impl Drop for ButtonGuard {
        fn drop(&mut self) {
            unsafe { mouse(0, 4 /* LEFTUP */) };
        }
    }

    #[link(name = "ole32")]
    unsafe extern "system" {
        fn RegisterDragDrop(hwnd: isize, target: *mut c_void) -> Hresult;
        fn RevokeDragDrop(hwnd: isize) -> Hresult;
    }
    #[link(name = "user32")]
    unsafe extern "system" {
        fn CreateWindowExW(ex: u32, class: *const u16, title: *const u16, style: u32, x: i32, y: i32, w: i32, h: i32, parent: isize, menu: isize, inst: isize, param: *const c_void) -> isize;
        fn DestroyWindow(hwnd: isize) -> i32;
        fn PeekMessageW(msg: *mut Msg, hwnd: *mut c_void, min: u32, max: u32, remove: u32) -> i32;
        fn TranslateMessage(msg: *const Msg) -> i32;
        fn DispatchMessageW(msg: *const Msg) -> isize;
        fn SetCursorPos(x: i32, y: i32) -> i32;
        fn GetCursorPos(p: *mut Pt) -> i32;
        fn SendInput(n: u32, inputs: *const Input, size: i32) -> u32;
    }

    fn payload_of(obj: *mut DataObject, cf: u16) -> Result<Vec<u8>, Hresult> {
        unsafe {
            let fe = FormatEtc { cf_format: cf, ptd: null_mut(), aspect: DVASPECT_CONTENT, lindex: -1, tymed: TYMED_HGLOBAL };
            let mut sm = StgMedium { tymed: 0, h_global: null_mut(), punk_for_release: null_mut() };
            let hr = ((*(*obj).vtbl).get_data)(obj, &fe, &mut sm);
            if hr != S_OK {
                return Err(hr);
            }
            assert_eq!(sm.tymed, TYMED_HGLOBAL);
            let p = GlobalLock(sm.h_global) as *const u8;
            // GlobalSize is not declared: the payloads end in a NUL, so read up to the document's own terminator
            let want = if cf == CF_UNICODETEXT { (*obj).text.len() } else { (*obj).html.len() };
            let v = std::slice::from_raw_parts(p, want).to_vec();
            GlobalUnlock(sm.h_global);
            Ok(v)
        }
    }

    const HTML: &str = "Version:0.9\r\nStartHTML:0000000000\r\n<html><body><!--StartFragment--><i>x</i>\u{e9}<!--EndFragment--></body></html>";

    #[test]
    fn data_object_offers_unicode_text_and_html_format() {
        unsafe {
            let obj = DataObject::create("Smith J (2020) \u{201c}T\u{201d} \u{1F4DA}", HTML.as_bytes());
            let hf = (*obj).html_fmt;
            assert!(hf >= 0xC000, "registered clipboard formats are 0xC000+");

            let t = payload_of(obj, CF_UNICODETEXT).unwrap();
            let u16s: Vec<u16> = t.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            assert_eq!(*u16s.last().unwrap(), 0, "NUL terminated");
            assert_eq!(String::from_utf16(&u16s[..u16s.len() - 1]).unwrap(), "Smith J (2020) \u{201c}T\u{201d} \u{1F4DA}");

            let h = payload_of(obj, hf).unwrap();
            assert_eq!(&h[..h.len() - 1], HTML.as_bytes());
            assert_eq!(*h.last().unwrap(), 0);

            // unsupported formats / media / aspects
            assert_eq!(payload_of(obj, 2 /* CF_BITMAP */).err(), Some(DV_E_FORMATETC));
            let fe = FormatEtc { cf_format: CF_UNICODETEXT, ptd: null_mut(), aspect: DVASPECT_CONTENT, lindex: -1, tymed: 2 /* TYMED_GDI */ };
            assert_eq!(((*(*obj).vtbl).query_get_data)(obj, &fe), DV_E_TYMED);
            let fe = FormatEtc { tymed: TYMED_HGLOBAL, ..fe };
            assert_eq!(((*(*obj).vtbl).query_get_data)(obj, &fe), S_OK);

            // QueryInterface / refcounts
            let mut out = null_mut();
            assert_eq!(((*(*obj).vtbl).query_interface)(obj, &IID_IDATAOBJECT, &mut out), S_OK);
            assert_eq!(((*(*obj).vtbl).release)(obj), 1);
            assert_eq!(((*(*obj).vtbl).query_interface)(obj, &IID_IDROPSOURCE, &mut out), E_NOINTERFACE);

            // the enumerator lists both formats
            let mut en: *mut c_void = null_mut();
            assert_eq!(((*(*obj).vtbl).enum_format_etc)(obj, DATADIR_GET, &mut en), S_OK);
            #[repr(C)]
            struct EnumVtbl {
                _qi: usize,
                _ar: usize,
                release: unsafe extern "system" fn(*mut c_void) -> u32,
                next: unsafe extern "system" fn(*mut c_void, u32, *mut FormatEtc, *mut u32) -> Hresult,
            }
            let ev = *(en as *const *const EnumVtbl);
            let mut got = [FormatEtc { cf_format: 0, ptd: null_mut(), aspect: 0, lindex: 0, tymed: 0 }; 4];
            let mut n = 0u32;
            ((*ev).next)(en, 4, got.as_mut_ptr(), &mut n);
            assert_eq!(n, 2);
            assert_eq!((got[0].cf_format, got[1].cf_format), (CF_UNICODETEXT, hf));
            ((*ev).release)(en);

            // text-only object offers no HTML
            let plain = DataObject::create("x", b"");
            assert!(payload_of(plain, (*plain).html_fmt).is_err());
            do_release(plain);

            assert_eq!(do_release(obj), 0);
        }
    }

    #[test]
    fn drop_source_follows_button_and_escape() {
        unsafe {
            let s = DropSource::create(SourceMode::Real);
            let q = (*(*s).vtbl).query_continue_drag;
            assert_eq!(q(s, 0, MK_LBUTTON), S_OK);
            assert_eq!(q(s, 0, 0), DRAGDROP_S_DROP);
            assert_eq!(q(s, 1, MK_LBUTTON), DRAGDROP_S_CANCEL);
            assert_eq!(((*(*s).vtbl).give_feedback)(s, 0),DRAGDROP_S_USEDEFAULTCURSORS);
            ds_release(s);
        }
    }

    // ---- a real DoDragDrop into a drop target of our own

    #[repr(C)]
    struct TargetVtbl {
        query_interface: unsafe extern "system" fn(*mut Target, *const Guid, *mut *mut c_void) -> Hresult,
        add_ref: unsafe extern "system" fn(*mut Target) -> u32,
        release: unsafe extern "system" fn(*mut Target) -> u32,
        drag_enter: unsafe extern "system" fn(*mut Target, *mut DataObject, u32, Pt, *mut u32) -> Hresult,
        drag_over: unsafe extern "system" fn(*mut Target, u32, Pt, *mut u32) -> Hresult,
        drag_leave: unsafe extern "system" fn(*mut Target) -> Hresult,
        drop: unsafe extern "system" fn(*mut Target, *mut DataObject, u32, Pt, *mut u32) -> Hresult,
    }
    #[repr(C)]
    struct Target {
        vtbl: *const TargetVtbl,
    }
    static GOT: Mutex<Option<(Vec<u8>, Vec<u8>)>> = Mutex::new(None);
    static ENTERS: AtomicU32 = AtomicU32::new(0);

    unsafe extern "system" fn t_qi(this: *mut Target, iid: *const Guid, out: *mut *mut c_void) -> Hresult {
        const IID_IDROPTARGET: Guid = guid(0x122, 0, 0, [0xC0, 0, 0, 0, 0, 0, 0, 0x46]);
        if *iid == IID_IUNKNOWN || *iid == IID_IDROPTARGET {
            *out = this as *mut c_void;
            S_OK
        } else {
            *out = null_mut();
            E_NOINTERFACE
        }
    }
    unsafe extern "system" fn t_ref(_: *mut Target) -> u32 {
        1
    }
    unsafe extern "system" fn t_enter(_: *mut Target, _: *mut DataObject, _: u32, _: Pt, effect: *mut u32) -> Hresult {
        ENTERS.fetch_add(1, Ordering::SeqCst);
        *effect = DROPEFFECT_COPY;
        S_OK
    }
    unsafe extern "system" fn t_over(_: *mut Target, _: u32, _: Pt, effect: *mut u32) -> Hresult {
        *effect = DROPEFFECT_COPY;
        S_OK
    }
    unsafe extern "system" fn t_leave(_: *mut Target) -> Hresult {
        S_OK
    }
    unsafe extern "system" fn t_drop(_: *mut Target, data: *mut DataObject, _: u32, _: Pt, effect: *mut u32) -> Hresult {
        // read both formats through the IDataObject OLE handed to the target
        let hf = RegisterClipboardFormatW(wide("HTML Format").as_ptr()) as u16;
        let fetch = |cf: u16| -> Vec<u8> {
            let fe = FormatEtc { cf_format: cf, ptd: null_mut(), aspect: DVASPECT_CONTENT, lindex: -1, tymed: TYMED_HGLOBAL };
            let mut sm = StgMedium { tymed: 0, h_global: null_mut(), punk_for_release: null_mut() };
            if ((*(*data).vtbl).get_data)(data, &fe, &mut sm) != S_OK {
                return Vec::new();
            }
            #[link(name = "kernel32")]
            unsafe extern "system" {
                fn GlobalSize(mem: *mut c_void) -> usize;
            }
            let n = GlobalSize(sm.h_global);
            let p = GlobalLock(sm.h_global) as *const u8;
            let v = std::slice::from_raw_parts(p, n).to_vec();
            GlobalUnlock(sm.h_global);
            v
        };
        *GOT.lock().unwrap() = Some((fetch(CF_UNICODETEXT), fetch(hf)));
        *effect = DROPEFFECT_COPY;
        S_OK
    }
    static TARGET_VTBL: TargetVtbl = TargetVtbl { query_interface: t_qi, add_ref: t_ref, release: t_ref, drag_enter: t_enter, drag_over: t_over, drag_leave: t_leave, drop: t_drop };

    /// A window on a thread of its own with a message pump (like GPUI's); optionally a drop target. Returns its hwnd and a stopper.
    fn window_thread(x: i32, y: i32, target: bool) -> (isize, std::sync::Arc<std::sync::atomic::AtomicBool>, std::thread::JoinHandle<()>) {
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let s2 = stop.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let h = std::thread::spawn(move || unsafe {
            assert!(OleInitialize(null_mut()) >= 0);
            const WS_POPUP: u32 = 0x8000_0000;
            const WS_VISIBLE: u32 = 0x1000_0000;
            const EX_TOPMOST_TOOL_NOACTIVATE: u32 = 0x8 | 0x80 | 0x0800_0000;
            let hwnd = CreateWindowExW(EX_TOPMOST_TOOL_NOACTIVATE, wide("BUTTON").as_ptr(), wide("zn drag test").as_ptr(), WS_POPUP | WS_VISIBLE, x, y, 160, 160, 0, 0, 0, null());
            assert!(hwnd != 0, "test window");
            let mut tgt = Target { vtbl: &TARGET_VTBL };
            if target {
                assert_eq!(RegisterDragDrop(hwnd, &mut tgt as *mut Target as *mut c_void), S_OK);
            }
            tx.send(hwnd).unwrap();
            let mut m: Msg = std::mem::zeroed();
            while !s2.load(Ordering::SeqCst) {
                while PeekMessageW(&mut m, null_mut(), 0, 0, 1) != 0 {
                    TranslateMessage(&m);
                    DispatchMessageW(&m);
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            if target {
                RevokeDragDrop(hwnd);
            }
            DestroyWindow(hwnd);
            OleUninitialize();
        });
        (rx.recv().unwrap(), stop, h)
    }

    /// The caller is a plain thread with no window; the source window (where the button goes down) and the drop target live on two
    /// OTHER threads. Moves the pointer for under a second, presses and releases the left button over the test windows only, and
    /// restores the cursor. Run with: cargo test --release -- --ignored
    #[test]
    #[ignore = "moves the mouse pointer and presses the left button over its own test windows for about a second"]
    fn cross_thread_dodragdrop_into_own_drop_target() {
        unsafe {
            let (src, stop_src, h_src) = window_thread(100, 100, false);
            let (_dst, stop_dst, h_dst) = window_thread(300, 300, true);
            std::thread::sleep(Duration::from_millis(100));

            let mut saved = Pt { x: 0, y: 0 };
            GetCursorPos(&mut saved);
            SetCursorPos(180, 180); // over the source window
            let guard = ButtonGuard;
            mouse(0, 2 /* LEFTDOWN */);
            std::thread::sleep(Duration::from_millis(80));

            let text = "Doe J. A test \u{201c}drop\u{201d} \u{e9}";
            let html = "Version:0.9\r\nStartHTML:0000000000\r\n<html><body><!--StartFragment--><i>x</i><!--EndFragment--></body></html>";
            let job = start_on(src, text.to_string(), html.as_bytes().to_vec(), SourceMode::Real);
            assert!(!job.is_null(), "job started");

            // drag over to the target window, then release
            let t0 = Instant::now();
            while t0.elapsed() < Duration::from_millis(700) {
                if t0.elapsed() > Duration::from_millis(150) {
                    SetCursorPos(380, 380);
                }
                jiggle(if t0.elapsed().as_millis() / 10 % 2 == 0 { 1 } else { -1 });
                std::thread::sleep(Duration::from_millis(8));
            }
            mouse(0, 4); // release: the drop
            let w0 = Instant::now();
            while crate::zpdf_job_poll(job) == 0 && w0.elapsed() < Duration::from_secs(5) {
                std::thread::sleep(Duration::from_millis(5));
            }
            let state = crate::zpdf_job_poll(job);
            drop(guard);
            SetCursorPos(saved.x, saved.y);
            let json = if state == 1 { String::from_utf8_lossy(std::slice::from_raw_parts(crate::zpdf_job_data(job), crate::zpdf_job_len(job) as usize)).into_owned() } else { String::new() };
            crate::zpdf_job_free(job);
            stop_src.store(true, Ordering::SeqCst);
            stop_dst.store(true, Ordering::SeqCst);
            if state != 0 {
                h_src.join().unwrap(); // (a source thread still inside DoDragDrop would never see the stop flag)
            }
            h_dst.join().unwrap();

            assert_eq!(state, 1, "the drag job finished");
            assert_eq!(json, "{\"result\":\"dropped\"}");
            assert!(ENTERS.load(Ordering::SeqCst) >= 1, "target saw DragEnter");
            let (t, h) = GOT.lock().unwrap().take().expect("target received a drop");
            let u16s: Vec<u16> = t.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            assert_eq!(String::from_utf16(&u16s[..u16s.len() - 1]).unwrap(), text);
            assert_eq!(&h[..h.len() - 1], html.as_bytes());
        }
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn SendMessageW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize;
    }

    #[test]
    fn subclass_is_installed_once_chains_to_the_original_and_refuses_a_dead_window() {
        unsafe {
            let (w, stop, h) = window_thread(900, 100, false); // away from the windows of the pointer test, which runs in parallel
            assert!(ensure_subclass(w).is_ok());
            let n = originals().lock().unwrap().len();
            assert!(ensure_subclass(w).is_ok());
            assert_eq!(originals().lock().unwrap().len(), n, "no second subclass");
            // ordinary messages still reach the original procedure: WM_GETTEXTLENGTH of "zn drag test" (cross-thread SendMessage)
            assert_eq!(SendMessageW(w, 0x000E, 0, 0), 12);
            stop.store(true, Ordering::SeqCst);
            h.join().unwrap();
            assert!(originals().lock().unwrap().get(&w).is_none(), "WM_NCDESTROY removed the entry");
            assert!(start_on(w, "c".into(), Vec::new(), SourceMode::Real).is_null(), "window is gone");
        }
    }

    /// The drag message is posted, the window is destroyed before its thread pumps it (the system then drops the message): the job
    /// must still be finished (failed), else JS polls it for good. The thread never pumps, so no drag runs.
    #[test]
    fn a_drag_posted_to_a_window_that_dies_first_is_finished_as_failed() {
        unsafe {
            let (tx, rx) = std::sync::mpsc::channel();
            let (go_tx, go_rx) = std::sync::mpsc::channel::<()>();
            let h = std::thread::spawn(move || {
                let hwnd = CreateWindowExW(0, wide("BUTTON").as_ptr(), wide("zn drag dies").as_ptr(), 0x8000_0000, 1200, 100, 50, 50, 0, 0, 0, null());
                assert!(hwnd != 0, "test window");
                tx.send(hwnd).unwrap();
                go_rx.recv().unwrap();
                DestroyWindow(hwnd);
            });
            let w = rx.recv().unwrap();
            let job = start_on(w, "text".into(), Vec::new(), SourceMode::Auto(1));
            assert!(!job.is_null());
            assert_eq!(crate::zpdf_job_poll(job), 0, "waiting for its window");
            go_tx.send(()).unwrap();
            h.join().unwrap();
            assert_eq!(crate::zpdf_job_poll(job), -1, "the window died: the job failed instead of waiting for ever");
            crate::zpdf_job_free(job);
            assert!(relock(pending()).get(&w).is_none_or(|q| q.is_empty()), "nothing left queued for the dead window");
        }
    }
}
