// Printing on macOS: PDFKit prints the PDF file (PDFDocument printOperationForPrintInfo:scalingMode:autoRotate:), with the standard
// print panel (printer, pages, copies, "Save as PDF"). runOperation is modal: it runs AppKit's loop for the panel and returns when the
// user has printed or cancelled, so the app waits meanwhile, like any Mac app showing a print panel. Windows prints through PDFium into
// the printer (native/pdf/src/print.rs), Linux through GTK's dialog (printGtk.ts).
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nsString, objc, type Id } from "../shell/objc";

const PDFKIT = "/System/Library/Frameworks/PDFKit.framework/PDFKit";
const kPDFPrintPageScaleToFit = 1;
let seq = 0;

/** The print operation for the PDF in `file`, or an error why there is none. */
function operation(file: string): { op: Id; info: Id } {
	const r = objc();
	if (!r) throw new Error("printing on macOS needs the Objective-C runtime");
	if (!r.load(PDFKIT) || !r.cls("PDFDocument")) throw new Error("PDFKit could not be loaded");
	const { send: s, sel } = r;
	const url = s.m1(r.cls("NSURL"), sel("fileURLWithPath:"), nsString(file));
	const doc = s.m1(s.m0(r.cls("PDFDocument"), sel("alloc")), sel("initWithURL:"), url);
	if (!doc) throw new Error("PDFKit could not open the document");
	s.m0(doc, sel("autorelease"));
	// a copy, so a "save to file" job does not change the shared settings the next print panel starts from
	const info = s.m0(s.m0(r.cls("NSPrintInfo"), sel("sharedPrintInfo")), sel("copy"));
	s.m0(info, sel("autorelease"));
	const op = s.mpii(doc, sel("printOperationForPrintInfo:scalingMode:autoRotate:"), info, kPDFPrintPageScaleToFit, 1);
	if (!op) throw new Error("PDFKit could not prepare the print job");
	return { op, info };
}

function withFile<T>(bytes: Uint8Array, run: (file: string) => T): T {
	const file = join(tmpdir(), `zinc-print-${process.pid}-${++seq}.pdf`);
	writeFileSync(file, bytes);
	try {
		return run(file);
	} finally {
		// the job is spooled when runOperation returns
		try { rmSync(file, { force: true }); } catch { /* still open */ }
	}
}

/** Show the print panel for the PDF in `bytes` and print it: "printed", or "cancelled" when the panel was cancelled. */
export function printWithMacPanel(bytes: Uint8Array, title: string): "printed" | "cancelled" {
	return withFile(bytes, (file) => {
		const r = objc()!;
		const { op } = operation(file);
		r.send.mi(op, r.sel("setShowsPrintPanel:"), 1);
		r.send.mi(op, r.sel("setShowsProgressPanel:"), 1);
		r.send.m1(op, r.sel("setJobTitle:"), nsString(title || "PDF"));
		return r.send.b0(op, r.sel("runOperation")) ? "printed" : "cancelled";
	});
}

/**
 * Print without a panel: to the default printer, or into the PDF file `output` when given (an NSPrintSaveJob, which is how the macOS
 * CI job tests the print path). The caller has already cut the PDF to the wanted pages.
 */
export function printWithMacNoPanel(bytes: Uint8Array, o: { title: string; printer?: string; output?: string }): string {
	return withFile(bytes, (file) => {
		const r = objc()!;
		const { send: s, sel } = r;
		const { op, info } = operation(file);
		if (o.printer && !o.output) {
			const printer = s.m1(r.cls("NSPrinter"), sel("printerWithName:"), nsString(o.printer));
			if (!printer) throw new Error(`there is no printer "${o.printer}"`);
			s.m1(info, sel("setPrinter:"), printer);
		}
		if (o.output) {
			const dict = s.m0(info, sel("dictionary"));
			const disposition = r.sym("NSPrintJobDisposition"), saveJob = r.sym("NSPrintSaveJob"), savingUrl = r.sym("NSPrintJobSavingURL");
			if (!dict || !disposition || !saveJob || !savingUrl) throw new Error("the print-to-file settings are not available");
			s.m2(dict, sel("setObject:forKey:"), saveJob, disposition);
			s.m2(dict, sel("setObject:forKey:"), s.m1(r.cls("NSURL"), sel("fileURLWithPath:"), nsString(o.output)), savingUrl);
		}
		s.mi(op, sel("setShowsPrintPanel:"), 0);
		s.mi(op, sel("setShowsProgressPanel:"), 0);
		s.m1(op, sel("setJobTitle:"), nsString(o.title || "PDF"));
		if (!s.b0(op, sel("runOperation"))) throw new Error("the print job failed");
		return o.output ? "file" : o.printer || "the default printer";
	});
}
