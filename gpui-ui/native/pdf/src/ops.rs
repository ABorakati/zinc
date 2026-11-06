//! Page editing and printing (zn_pdf 0.5), both on PDFium (src/pdfium.rs `OwnedDoc`: a parse of its own, not the reader's).
//!
//!   zpdf_page_rotation(doc, i) -> degrees        the page's own /Rotate (0, 90, 180, 270), -1 for a bad page
//!   zpdf_edit_begin(data, len, rot_pages, rot_turns, n_rot, del_pages, n_del) -> job
//!        rotate pages (quarter turns clockwise added to their /Rotate) and delete pages of the PDF in data[..len] (copied), on a
//!        thread of its own; the job's data is the whole new PDF (FPDF_SaveAsCopy, not incremental)
//!   zpdf_print_begin(data, len, title, current) -> job
//!        the system print dialog (PrintDlgEx: printer, pages, copies) owned by this process's window, then every chosen page drawn
//!        by PDFium straight into the printer's device context (FPDF_RenderPage: vector output, no bitmaps), fitted to the printable
//!        area and turned when its orientation differs from the paper's; the job's data is JSON
//!        {"result":"printed"|"cancelled","pages":n,"printer":"..."}. `current` is the 1-based page for "Current page" (0: none)
//!   zpdf_print_to_begin(data, len, title, printer, output, first, last) -> job
//!        the same without a dialog: pages first..last (1-based, 0 = to the end) on `printer` (null: the default one), into the file
//!        `output` when given (with "Microsoft Print to PDF": a PDF, which is how the print path is tested)
//!
//! Jobs are the same objects as the render jobs (poll / data / len / free).

use std::ffi::{CStr, c_char, c_void};
use std::sync::Arc;
use std::time::Instant;

use crate::pdfium::OwnedDoc;
use crate::{Doc, Job, set_error};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

unsafe fn cstr(p: *const c_char) -> Option<String> {
    if p.is_null() { None } else { Some(unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned()) }
}

unsafe fn ints(p: *const i32, n: i32) -> Vec<i32> {
    if p.is_null() || n <= 0 { Vec::new() } else { unsafe { std::slice::from_raw_parts(p, n as usize) }.to_vec() }
}

/// The page's own /Rotate in degrees (0, 90, 180, 270), or -1 for a bad page.
///
/// # Safety
/// `doc` must be valid.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_page_rotation(doc: *const Doc, page: i32) -> i32 {
    let Some(d) = (unsafe { doc.as_ref() }) else { return -1 };
    usize::try_from(page).ok().and_then(|i| d.rots.get(i)).map_or(-1, |&r| r as i32)
}

/// Run `f` on a thread of its own; its bytes become the job's data (state 1), its error the last error (state -1).
pub(crate) fn spawn_job(f: impl FnOnce() -> Result<Vec<u8>, String> + Send + 'static) -> *const Job {
    let job = Job::new(0.0);
    let j = job.clone();
    let t0 = Instant::now();
    let spawned = std::thread::Builder::new().name("zn-pdf-ops".into()).stack_size(16 * 1024 * 1024).spawn(move || {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
            Ok(Ok(bytes)) => {
                j.width.store(bytes.len() as u32, std::sync::atomic::Ordering::Relaxed);
                j.micros.store(t0.elapsed().as_micros() as u64, std::sync::atomic::Ordering::Relaxed);
                let _ = j.data.set(bytes);
                j.finish(1);
            }
            Ok(Err(e)) => {
                set_error(e);
                j.finish(-1);
            }
            Err(_) => {
                set_error("the page operation panicked");
                j.finish(-1);
            }
        }
    });
    if let Err(e) = spawned {
        set_error(format!("spawn: {e}"));
        return std::ptr::null();
    }
    Arc::into_raw(job)
}

/// Rotate and delete pages; the job's data is the new PDF. `rot_turns[k]` quarter turns clockwise are added to page `rot_pages[k]`
/// (0-based); `del_pages` (0-based, of the original document) are deleted afterwards. At least one page must remain.
///
/// # Safety
/// `data` must point to `len` bytes, the arrays to `n_rot` / `n_del` i32s.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_edit_begin(data: *const u8, len: usize, rot_pages: *const i32, rot_turns: *const i32, n_rot: i32, del_pages: *const i32, n_del: i32) -> *const Job {
    if data.is_null() || len == 0 {
        set_error("empty pdf buffer");
        return std::ptr::null();
    }
    let bytes = Arc::new(unsafe { std::slice::from_raw_parts(data, len) }.to_vec());
    let pages = unsafe { ints(rot_pages, n_rot) };
    let turns = unsafe { ints(rot_turns, n_rot) };
    let del = unsafe { ints(del_pages, n_del) };
    if pages.iter().chain(del.iter()).any(|&p| p < 0) {
        set_error("negative page index");
        return std::ptr::null();
    }
    let rotate: Vec<(usize, i32)> = pages.iter().zip(turns.iter()).map(|(&p, &q)| (p as usize, q)).collect();
    let del: Vec<usize> = del.into_iter().map(|p| p as usize).collect();
    spawn_job(move || OwnedDoc::open(bytes)?.edit(&rotate, &del))
}

// ---------------------------------------------------------------------------------------------------------------------
// printing
// ---------------------------------------------------------------------------------------------------------------------

#[repr(C)]
struct PrintPageRange {
    from: u32,
    to: u32,
}

/// PRINTDLGEXW (x64 layout: natural alignment, 136 bytes)
#[repr(C)]
struct PrintDlgExW {
    struct_size: u32,
    owner: isize,
    dev_mode: isize,
    dev_names: isize,
    dc: isize,
    flags: u32,
    flags2: u32,
    exclusion_flags: u32,
    n_page_ranges: u32,
    n_max_page_ranges: u32,
    page_ranges: *mut PrintPageRange,
    min_page: u32,
    max_page: u32,
    copies: u32,
    instance: isize,
    print_template_name: *const u16,
    callback: *mut c_void,
    n_property_pages: u32,
    property_pages: *mut isize,
    start_page: u32,
    result_action: u32,
}

#[repr(C)]
struct DocInfoW {
    cb_size: i32,
    doc_name: *const u16,
    output: *const u16,
    datatype: *const u16,
    fw_type: u32,
}

#[link(name = "comdlg32")]
unsafe extern "system" {
    fn PrintDlgExW(pd: *mut PrintDlgExW) -> i32;
}
#[link(name = "gdi32")]
unsafe extern "system" {
    fn CreateDCW(driver: *const u16, device: *const u16, port: *const u16, devmode: *const c_void) -> isize;
    fn DeleteDC(dc: isize) -> i32;
    fn StartDocW(dc: isize, di: *const DocInfoW) -> i32;
    fn EndDoc(dc: isize) -> i32;
    fn AbortDoc(dc: isize) -> i32;
    fn StartPage(dc: isize) -> i32;
    fn EndPage(dc: isize) -> i32;
    fn GetDeviceCaps(dc: isize, index: i32) -> i32;
}
#[link(name = "user32")]
unsafe extern "system" {
    fn EnumWindows(cb: unsafe extern "system" fn(isize, isize) -> i32, lparam: isize) -> i32;
    fn GetWindowThreadProcessId(hwnd: isize, pid: *mut u32) -> u32;
    fn IsWindowVisible(hwnd: isize) -> i32;
    fn GetWindow(hwnd: isize, cmd: u32) -> isize;
    fn GetForegroundWindow() -> isize;
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GlobalFree(h: isize) -> isize;
    fn GlobalLock(h: isize) -> *mut c_void;
    fn GlobalUnlock(h: isize) -> i32;
    fn GetCurrentProcessId() -> u32;
}
#[link(name = "ole32")]
unsafe extern "system" {
    fn CoInitializeEx(reserved: *mut c_void, coinit: u32) -> i32;
    fn CoUninitialize();
}
#[link(name = "winspool")]
unsafe extern "system" {
    fn GetDefaultPrinterW(buf: *mut u16, size: *mut u32) -> i32;
}

const PD_NOSELECTION: u32 = 0x4;
const PD_PAGENUMS: u32 = 0x2;
const PD_RETURNDC: u32 = 0x100;
const PD_USEDEVMODECOPIESANDCOLLATE: u32 = 0x40000;
const PD_CURRENTPAGE: u32 = 0x400000;
const PD_NOCURRENTPAGE: u32 = 0x800000;
const START_PAGE_GENERAL: u32 = 0xFFFF_FFFF;
const PD_RESULT_PRINT: u32 = 1;
const HORZRES: i32 = 8;
const VERTRES: i32 = 10;
const GW_OWNER: u32 = 4;

/// A visible top-level window of this process to own the dialog: the foreground one when it is ours, else the first found.
fn own_window() -> isize {
    unsafe extern "system" fn cb(hwnd: isize, lparam: isize) -> i32 {
        let out = unsafe { &mut *(lparam as *mut Vec<isize>) };
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        if pid == unsafe { GetCurrentProcessId() } && unsafe { IsWindowVisible(hwnd) } != 0 && unsafe { GetWindow(hwnd, GW_OWNER) } == 0 {
            out.push(hwnd);
        }
        1
    }
    let mut found: Vec<isize> = Vec::new();
    unsafe { EnumWindows(cb, &mut found as *mut Vec<isize> as isize) };
    let fg = unsafe { GetForegroundWindow() };
    if found.contains(&fg) { fg } else { found.first().copied().unwrap_or(0) }
}

/// The device name in a DEVNAMES block (the printer the dialog chose).
fn device_name(dev_names: isize) -> String {
    if dev_names == 0 {
        return String::new();
    }
    unsafe {
        let p = GlobalLock(dev_names) as *const u16;
        if p.is_null() {
            return String::new();
        }
        // DEVNAMES: wDriverOffset, wDeviceOffset, wOutputOffset, wDefault (offsets in characters from the start)
        let off = *p.add(1) as usize;
        let s = p.add(off);
        let mut n = 0;
        while n < 512 && *s.add(n) != 0 {
            n += 1;
        }
        let name = String::from_utf16_lossy(std::slice::from_raw_parts(s, n));
        GlobalUnlock(dev_names);
        name
    }
}

fn json_str(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

/// Every page of `pages` (0-based), `copies` times, into the printer device context `dc`: fitted to the printable area, centred,
/// a quarter turn when the page's orientation is not the paper's. `output`: print into this file instead of the printer.
fn print_pages(doc: &OwnedDoc, dc: isize, title: &str, output: Option<&str>, pages: &[usize], copies: u32) -> Result<usize, String> {
    let title_w = wide(if title.is_empty() { "Document" } else { title });
    let out_w = output.map(wide);
    let di = DocInfoW {
        cb_size: std::mem::size_of::<DocInfoW>() as i32,
        doc_name: title_w.as_ptr(),
        output: out_w.as_ref().map_or(std::ptr::null(), |v| v.as_ptr()),
        datatype: std::ptr::null(),
        fw_type: 0,
    };
    if unsafe { StartDocW(dc, &di) } <= 0 {
        return Err("the printer did not accept the document".into());
    }
    let (pw, ph) = unsafe { (GetDeviceCaps(dc, HORZRES), GetDeviceCaps(dc, VERTRES)) };
    if pw <= 0 || ph <= 0 {
        unsafe { AbortDoc(dc) };
        return Err("the printer reported no printable area".into());
    }
    let mut printed = 0;
    for _ in 0..copies.max(1) {
        for &p in pages {
            if unsafe { StartPage(dc) } <= 0 {
                unsafe { AbortDoc(dc) };
                return Err(format!("the printer stopped at page {}", p + 1));
            }
            let (w, h) = doc.page_size(p);
            let turn = (w > h) != (pw > ph) && (w - h).abs() > 1.0;
            let (bw, bh) = if turn { (h, w) } else { (w, h) };
            let s = (pw as f32 / bw).min(ph as f32 / bh);
            let (dw, dh) = (((bw * s).floor() as i32).max(1), ((bh * s).floor() as i32).max(1));
            let r = doc.render_dc(dc, p, (pw - dw) / 2, (ph - dh) / 2, dw, dh, turn);
            let ended = unsafe { EndPage(dc) } > 0;
            if let Err(e) = r {
                unsafe { AbortDoc(dc) };
                return Err(e);
            }
            if !ended {
                unsafe { AbortDoc(dc) };
                return Err(format!("the printer stopped after page {}", p + 1));
            }
            printed += 1;
        }
    }
    if unsafe { EndDoc(dc) } <= 0 {
        return Err("the printer did not finish the document".into());
    }
    Ok(printed)
}

fn result_json(result: &str, pages: usize, printer: &str) -> Vec<u8> {
    format!("{{\"result\":{},\"pages\":{pages},\"printer\":{}}}", json_str(result), json_str(printer)).into_bytes()
}

/// The pages chosen in the dialog (0-based), clamped to the document.
fn chosen_pages(flags: u32, ranges: &[PrintPageRange], current: usize, n: usize) -> Vec<usize> {
    if flags & PD_CURRENTPAGE != 0 && current >= 1 && current <= n {
        return vec![current - 1];
    }
    if flags & PD_PAGENUMS != 0 {
        let mut v = Vec::new();
        for r in ranges {
            let (a, b) = (r.from.max(1) as usize, (r.to as usize).min(n));
            for p in a..=b {
                v.push(p - 1);
            }
        }
        return v;
    }
    (0..n).collect()
}

fn print_with_dialog(bytes: Arc<Vec<u8>>, title: String, current: usize) -> Result<Vec<u8>, String> {
    let doc = OwnedDoc::open(bytes)?;
    let n = doc.page_count();
    if n == 0 {
        return Err("the document has no pages".into());
    }
    let owner = own_window();
    if owner == 0 {
        return Err("there is no window to show the print dialog over".into());
    }
    // COINIT_APARTMENTTHREADED: the dialog is a COM client (property sheet + callbacks)
    let com = unsafe { CoInitializeEx(std::ptr::null_mut(), 0x2) };
    let mut ranges: Vec<PrintPageRange> = (0..16).map(|_| PrintPageRange { from: 0, to: 0 }).collect();
    let mut pd = PrintDlgExW {
        struct_size: std::mem::size_of::<PrintDlgExW>() as u32,
        owner,
        dev_mode: 0,
        dev_names: 0,
        dc: 0,
        flags: PD_RETURNDC | PD_NOSELECTION | PD_USEDEVMODECOPIESANDCOLLATE | if current == 0 { PD_NOCURRENTPAGE } else { 0 },
        flags2: 0,
        exclusion_flags: 0,
        n_page_ranges: 0,
        n_max_page_ranges: ranges.len() as u32,
        page_ranges: ranges.as_mut_ptr(),
        min_page: 1,
        max_page: n as u32,
        copies: 1,
        instance: 0,
        print_template_name: std::ptr::null(),
        callback: std::ptr::null_mut(),
        n_property_pages: 0,
        property_pages: std::ptr::null_mut(),
        start_page: START_PAGE_GENERAL,
        result_action: 0,
    };
    let hr = unsafe { PrintDlgExW(&mut pd) };
    let out = if hr != 0 {
        Err(format!("the print dialog could not be shown (0x{:08x})", hr as u32))
    } else if pd.result_action != PD_RESULT_PRINT {
        Ok(result_json("cancelled", 0, ""))
    } else if pd.dc == 0 {
        Err("the print dialog returned no printer".into())
    } else {
        let printer = device_name(pd.dev_names);
        let used = &ranges[..(pd.n_page_ranges as usize).min(ranges.len())];
        let pages = chosen_pages(pd.flags, used, current, n);
        print_pages(&doc, pd.dc, &title, None, &pages, pd.copies).map(|k| result_json("printed", k, &printer))
    };
    unsafe {
        if pd.dc != 0 {
            DeleteDC(pd.dc);
        }
        if pd.dev_mode != 0 {
            GlobalFree(pd.dev_mode);
        }
        if pd.dev_names != 0 {
            GlobalFree(pd.dev_names);
        }
        if com >= 0 {
            CoUninitialize();
        }
    }
    out
}

/// Show the system print dialog over this process's window and print what it chose; the job's data is JSON (see the module docs).
///
/// # Safety
/// `data` must point to `len` bytes, `title` must be null or a NUL-terminated UTF-8 string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_print_begin(data: *const u8, len: usize, title: *const c_char, current: i32) -> *const Job {
    if data.is_null() || len == 0 {
        set_error("empty pdf buffer");
        return std::ptr::null();
    }
    let bytes = Arc::new(unsafe { std::slice::from_raw_parts(data, len) }.to_vec());
    let title = unsafe { cstr(title) }.unwrap_or_default();
    let current = current.max(0) as usize;
    spawn_job(move || print_with_dialog(bytes, title, current))
}

fn default_printer() -> Option<String> {
    let mut n = 0u32;
    unsafe { GetDefaultPrinterW(std::ptr::null_mut(), &mut n) };
    if n == 0 {
        return None;
    }
    let mut buf = vec![0u16; n as usize];
    if unsafe { GetDefaultPrinterW(buf.as_mut_ptr(), &mut n) } == 0 {
        return None;
    }
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    Some(String::from_utf16_lossy(&buf[..end]))
}

/// Print pages `first..=last` (1-based; `last` 0 = to the end) on `printer` (null: the default printer) without a dialog, into the
/// file `output` when it is given.
///
/// # Safety
/// `data` must point to `len` bytes; the strings must be null or NUL-terminated UTF-8.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zpdf_print_to_begin(data: *const u8, len: usize, title: *const c_char, printer: *const c_char, output: *const c_char, first: i32, last: i32) -> *const Job {
    if data.is_null() || len == 0 {
        set_error("empty pdf buffer");
        return std::ptr::null();
    }
    let bytes = Arc::new(unsafe { std::slice::from_raw_parts(data, len) }.to_vec());
    let title = unsafe { cstr(title) }.unwrap_or_default();
    let printer = unsafe { cstr(printer) };
    let output = unsafe { cstr(output) };
    spawn_job(move || {
        let doc = OwnedDoc::open(bytes)?;
        let n = doc.page_count();
        let name = printer.or_else(default_printer).ok_or("there is no printer")?;
        let a = (first.max(1) as usize).min(n.max(1));
        let b = if last <= 0 { n } else { (last as usize).min(n) };
        let pages: Vec<usize> = (a..=b).map(|p| p - 1).collect();
        let wname = wide(&name);
        let dc = unsafe { CreateDCW(wide("WINSPOOL").as_ptr(), wname.as_ptr(), std::ptr::null(), std::ptr::null()) };
        if dc == 0 {
            return Err(format!("cannot open the printer \"{name}\""));
        }
        let r = print_pages(&doc, dc, &title, output.as_deref(), &pages, 1);
        unsafe { DeleteDC(dc) };
        r.map(|k| result_json("printed", k, &name))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[link(name = "user32")]
    unsafe extern "system" {
        fn CreateWindowExW(ex: u32, class: *const u16, title: *const u16, style: u32, x: i32, y: i32, w: i32, h: i32, parent: isize, menu: isize, inst: isize, param: *const c_void) -> isize;
        fn DestroyWindow(hwnd: isize) -> i32;
    }
    const PD_RETURNDEFAULT: u32 = 0x400;

    #[test]
    fn printdlgex_layout() {
        assert_eq!(std::mem::size_of::<PrintDlgExW>(), 136);
        assert_eq!(std::mem::size_of::<DocInfoW>(), 40);
    }

    /// A hidden window to own the dialog.
    fn hidden_window() -> isize {
        let h = unsafe { CreateWindowExW(0, wide("STATIC").as_ptr(), wide("zn-print-test").as_ptr(), 0, 0, 0, 100, 100, 0, 0, 0, std::ptr::null()) };
        assert_ne!(h, 0);
        h
    }

    /// PrintDlgEx with PD_RETURNDEFAULT: the default printer's DC comes back without the dialog being shown, so the call checks the
    /// struct layout (comdlg32 checks lStructSize) and the owner window. Returns the printer's name and printable area.
    fn return_default(owner: isize) -> Result<(String, i32, i32), String> {
        let com = unsafe { CoInitializeEx(std::ptr::null_mut(), 0x2) };
        let mut ranges: Vec<PrintPageRange> = (0..4).map(|_| PrintPageRange { from: 0, to: 0 }).collect();
        let mut pd = PrintDlgExW {
            struct_size: std::mem::size_of::<PrintDlgExW>() as u32,
            owner,
            dev_mode: 0,
            dev_names: 0,
            dc: 0,
            flags: PD_RETURNDEFAULT | PD_RETURNDC,
            flags2: 0,
            exclusion_flags: 0,
            n_page_ranges: 0,
            n_max_page_ranges: ranges.len() as u32,
            page_ranges: ranges.as_mut_ptr(),
            min_page: 1,
            max_page: 1,
            copies: 1,
            instance: 0,
            print_template_name: std::ptr::null(),
            callback: std::ptr::null_mut(),
            n_property_pages: 0,
            property_pages: std::ptr::null_mut(),
            start_page: START_PAGE_GENERAL,
            result_action: 0,
        };
        let hr = unsafe { PrintDlgExW(&mut pd) };
        let out = if hr != 0 {
            Err(format!("PrintDlgExW failed: 0x{:08x}", hr as u32))
        } else if pd.dc == 0 {
            Err("no device context".into())
        } else {
            let (w, h) = unsafe { (GetDeviceCaps(pd.dc, HORZRES), GetDeviceCaps(pd.dc, VERTRES)) };
            Ok((device_name(pd.dev_names), w, h))
        };
        unsafe {
            if pd.dc != 0 {
                DeleteDC(pd.dc);
            }
            if pd.dev_mode != 0 {
                GlobalFree(pd.dev_mode);
            }
            if pd.dev_names != 0 {
                GlobalFree(pd.dev_names);
            }
            if com >= 0 {
                CoUninitialize();
            }
        }
        out
    }

    /// `cargo test --release -- --ignored` (needs a default printer, e.g. Microsoft Print to PDF; shows nothing on screen)
    #[test]
    #[ignore]
    fn printdlgex_owner_on_this_thread() {
        let w = hidden_window();
        let r = return_default(w);
        unsafe { DestroyWindow(w) };
        let (name, pw, ph) = r.unwrap();
        eprintln!("default printer: {name}, printable area {pw}x{ph} device px");
        assert!(!name.is_empty() && pw > 0 && ph > 0);
    }

    /// The app's case: the window belongs to the UI thread, the dialog runs on a thread of its own.
    #[test]
    #[ignore]
    fn printdlgex_owner_on_another_thread() {
        let (tx, rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
        let ui = std::thread::spawn(move || {
            let w = hidden_window();
            tx.send(w).unwrap();
            let _ = done_rx.recv();
            unsafe { DestroyWindow(w) };
        });
        let w = rx.recv().unwrap();
        let r = std::thread::spawn(move || return_default(w)).join().unwrap();
        done_tx.send(()).unwrap();
        ui.join().unwrap();
        let (name, pw, ph) = r.unwrap();
        assert!(!name.is_empty() && pw > 0 && ph > 0);
    }
}
