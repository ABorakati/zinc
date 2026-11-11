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
//! Jobs are the same objects as the render jobs (poll / data / len / free). The two print functions live in src/print.rs (Windows);
//! elsewhere lib.rs exports stubs that fail with a message.

use std::sync::Arc;
use std::time::Instant;

use crate::pdfium::OwnedDoc;
use crate::{Doc, Job, set_error};

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

