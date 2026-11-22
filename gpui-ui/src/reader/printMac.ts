// Printing on macOS: PDFKit prints the PDF file (PDFDocument printOperationForPrintInfo:scalingMode:autoRotate:), with the standard
// print panel (printer, pages, copies, "Save as PDF"). runOperation is modal: it runs AppKit's loop for the panel and returns when the
// user has printed or cancelled, so the app waits meanwhile, like any Mac app showing a print panel. Windows prints through PDFium into
// the printer (native/pdf/src/print.rs), Linux through GTK's dialog (printGtk.ts).
import { CString } from "bun:ffi";
import { writeFileSync } from "node:fs";
import { nsString, objc, type Id } from "../shell/objc";
import { writePrivateTemp } from "./privateTemp";

const PDFKIT = "/System/Library/Frameworks/PDFKit.framework/PDFKit";
const kPDFPrintPageScaleToFit = 1;

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
	const tmp = writePrivateTemp(bytes);
	try {
		return run(tmp.file);
	} finally {
		tmp.remove(); // the job is spooled when runOperation returns
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

/** The names of the printers macOS knows. */
function printerNames(): string[] {
	const r = objc();
	if (!r) return [];
	const { send: s, sel } = r;
	const list = s.m0(r.cls("NSPrinter"), sel("printerNames"));
	const n = Number(s.m0(list, sel("count")) ?? 0);
	const out: string[] = [];
	for (let i = 0; i < n; i++) {
		const name = s.m0(s.mu(list, sel("objectAtIndex:"), i), sel("UTF8String"));
		if (name) out.push(new CString(name as never).toString());
	}
	return out;
}

/**
 * Print without a panel: to `printer` or the default one; or, with `output`, the PDF (already cut to the wanted pages by the caller) is
 * written to that file. A file needs no print system: a "save" print job still needs a printer, and with none macOS fails the job
 * and shows an alert nobody can dismiss in a test run (the macOS CI smoke run hung there).
 */
export function printWithMacNoPanel(bytes: Uint8Array, o: { title: string; printer?: string; output?: string }): string {
	if (o.output) {
		writeFileSync(o.output, bytes);
		return "file";
	}
	const printers = printerNames();
	if (!printers.length) throw new Error("there is no printer");
	if (o.printer && !printers.includes(o.printer)) throw new Error(`there is no printer "${o.printer}"`);
	return withFile(bytes, (file) => {
		const r = objc()!;
		const { send: s, sel } = r;
		const { op, info } = operation(file);
		if (o.printer) s.m1(info, sel("setPrinter:"), s.m1(r.cls("NSPrinter"), sel("printerWithName:"), nsString(o.printer)));
		s.mi(op, sel("setShowsPrintPanel:"), 0);
		s.mi(op, sel("setShowsProgressPanel:"), 0);
		s.m1(op, sel("setJobTitle:"), nsString(o.title || "PDF"));
		if (!s.b0(op, sel("runOperation"))) throw new Error("the print job failed");
		return o.printer || "the default printer";
	});
}

/** Tests: PDFKit can open `bytes` and build a print operation for it (nothing is printed). */
export function canPrepareMacPrint(bytes: Uint8Array): boolean {
	return withFile(bytes, (file) => !!operation(file).op);
}
