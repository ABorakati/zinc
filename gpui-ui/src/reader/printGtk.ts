// Printing on Linux: GTK 4's print dialog (gtk_print_dialog_print_file, GTK 4.14+) prints the PDF file itself. The dialog is GTK's own
// (shell/linuxDisplay.ts turns the desktop portal off outside a sandbox: where it cannot show, the call hung), and the printer gets the
// PDF as a file: CUPS applies the chosen pages, copies and paper.
// On Windows printing goes through PDFium into the printer's device context (native/pdf/src/print.rs) instead.
//
// GTK runs on this (the JS) thread, as the web view's does (webview/x11.ts), so a timer iterates GLib's main context while the dialog is
// open; nothing blocks. The PDF is written to a temporary file for the dialog and removed a minute after the job was handed over.
import { CString, dlopen, FFIType, JSCallback, read } from "bun:ffi";
import { writeFileSync } from "node:fs";
import { writePrivateTemp } from "./privateTemp";

const { ptr: P, i32: I32 } = FFIType;
type Ptr = number | bigint | null;
interface Lib {
	gtk_init_check(): number;
	gtk_print_dialog_new(): Ptr;
	gtk_print_dialog_set_title(d: Ptr, t: Buffer): void;
	gtk_print_dialog_set_modal(d: Ptr, m: number): void;
	gtk_print_dialog_print_file(d: Ptr, parent: null, setup: null, file: Ptr, cancel: null, cb: unknown, data: null): void;
	gtk_print_dialog_print_file_finish(d: Ptr, result: Ptr, err: unknown): number;
	g_file_new_for_path(p: Buffer): Ptr;
	g_object_unref(o: Ptr): void;
	g_error_free(e: Ptr): void;
	g_main_context_iteration(ctx: null, block: number): number;
}

let lib: Lib | null | undefined;
let why = "";
function gtk(): Lib | null {
	if (lib !== undefined) return lib;
	try {
		const g = dlopen("libgtk-4.so.1", {
			gtk_init_check: { args: [], returns: I32 },
			gtk_print_dialog_new: { args: [], returns: P },
			gtk_print_dialog_set_title: { args: [P, P], returns: FFIType.void },
			gtk_print_dialog_set_modal: { args: [P, I32], returns: FFIType.void },
			gtk_print_dialog_print_file: { args: [P, P, P, P, P, FFIType.function, P], returns: FFIType.void },
			gtk_print_dialog_print_file_finish: { args: [P, P, P], returns: I32 },
		}).symbols;
		const gio = dlopen("libgio-2.0.so.0", { g_file_new_for_path: { args: [P], returns: P } }).symbols;
		const gobj = dlopen("libgobject-2.0.so.0", { g_object_unref: { args: [P], returns: FFIType.void } }).symbols;
		const glib = dlopen("libglib-2.0.so.0", {
			g_error_free: { args: [P], returns: FFIType.void },
			g_main_context_iteration: { args: [P, I32], returns: I32 },
		}).symbols;
		lib = { ...g, ...gio, ...gobj, ...glib } as unknown as Lib;
		if (!lib.gtk_init_check()) {
			why = "GTK could not start (no display?)";
			lib = null;
		}
	} catch (e) {
		why = `printing needs GTK 4.14 or newer (${e instanceof Error ? e.message : String(e)})`;
		lib = null;
	}
	return lib;
}

/** Why the GTK print dialog cannot be used here (empty when it can). */
export function gtkPrintUnavailable(): string {
	if (process.platform !== "linux") return "not Linux";
	return gtk() ? "" : why;
}

const cstr = (s: string) => Buffer.from(`${s}\0`);

/**
 * Show the print dialog for the PDF in `bytes` and print it. Resolves "printed" once the job was handed to the printing system, or
 * "cancelled" when the dialog was closed; rejects with GTK's message when printing failed.
 */
export function printWithGtkDialog(bytes: Uint8Array, title: string): Promise<"printed" | "cancelled"> {
	const g = gtk();
	if (!g) return Promise.reject(new Error(why || "the GTK print dialog is not available"));
	const tmp = writePrivateTemp(bytes);
	const gfile = g.g_file_new_for_path(cstr(tmp.file));
	const dialog = g.gtk_print_dialog_new();
	g.gtk_print_dialog_set_title(dialog, cstr(title || "Print"));
	g.gtk_print_dialog_set_modal(dialog, 1);
	return new Promise((resolve, reject) => {
		const pump = setInterval(() => {
			let n = 0;
			while (n++ < 50 && g.g_main_context_iteration(null, 0)) {
				/* dispatch */
			}
		}, 15);
		const errOut = new BigUint64Array(1);
		let cb: JSCallback | undefined = new JSCallback(
			(_source: Ptr, result: Ptr) => {
				const ok = g.gtk_print_dialog_print_file_finish(dialog, result, errOut);
				let message = "",
					code = 0;
				const err = errOut[0]!;
				if (!ok && err) {
					// GError { GQuark domain; gint code; gchar *message; }
					code = read.i32(Number(err) as never, 4);
					const m = read.ptr(Number(err) as never, 8);
					message = m ? new CString(m as never).toString() : "";
					g.g_error_free(Number(err));
				}
				clearInterval(pump);
				g.g_object_unref(dialog);
				g.g_object_unref(gfile);
				setTimeout(tmp.remove, 60_000);
				queueMicrotask(() => {
					cb?.close();
					cb = undefined;
				});
				// GtkDialogError: FAILED 0, CANCELLED 1, DISMISSED 2 (the user closed the dialog)
				if (ok) resolve("printed");
				else if (code === 1 || code === 2) resolve("cancelled");
				else reject(new Error(message || "printing failed"));
			},
			{ args: [P, P, P], returns: FFIType.void },
		);
		g.gtk_print_dialog_print_file(dialog, null, null, gfile, null, cb.ptr, null);
	});
}

/**
 * Print without a dialog on Linux: the PDF (already cut to the wanted pages) goes to CUPS with `lp` (`printer` or the default one), or
 * into the file `output` when given (the tests' "print to file").
 */
export async function printWithLp(bytes: Uint8Array, o: { title: string; printer?: string; output?: string }): Promise<string> {
	if (o.output) {
		writeFileSync(o.output, bytes);
		return "file";
	}
	const tmp = writePrivateTemp(bytes);
	try {
		const args = ["lp", ...(o.printer ? ["-d", o.printer] : []), "-t", o.title || "PDF", tmp.file];
		const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
		const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
		if ((await p.exited) !== 0) throw new Error(err.trim() || `lp failed (${p.exitCode})`);
		return o.printer || /request id is (\S+)-\d+/.exec(out)?.[1] || "the default printer";
	} finally {
		setTimeout(tmp.remove, 60_000);
	}
}
