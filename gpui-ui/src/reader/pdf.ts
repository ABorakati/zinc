// bun:ffi bindings for native/pdf (zn_pdf.dll: PDFium rasteriser (hayro as the fallback) + hayro text layer / links / outline). See native/pdf/src/lib.rs for the ABI.
//
// Rendering is asynchronous on the Rust side (a small pool of worker threads per document over one priority queue); a job is
// polled (one shared 1-2 ms timer for all of them) so the JS thread (and with it GPUIX's event loop) is never blocked by a
// rasterization. The returned Rendered.pixels is a Buffer that aliases Rust memory (zero copy): hand it to
// setImagePixels(..., { format: "bgra" }) and then call release().
//
// Jobs carry a priority (lower runs first, see core/Page.tsx for the bands) that can be changed while the job waits
// (RenderTask.setPrio), and a job nobody wants any more can be cancelled (RenderTask.cancel) as long as no worker has started it.
import { CString, dlopen, FFIType, ptr, toBuffer } from "bun:ffi";
import { existsSync } from "node:fs";
import { join } from "node:path";

const { ptr: P, i32: I32, u32: U32, f32: F32, u64: U64, cstring } = FFIType;
const usize = FFIType.u64; // 64-bit only (Windows x64)

export function findDll(): string {
	const env = process.env.ZN_PDF_DLL;
	const cands = [
		env,
		process.env.CARGO_TARGET_DIR && join(process.env.CARGO_TARGET_DIR, "release", "zn_pdf.dll"),
		"C:/dev/cache/cargo-target/release/zn_pdf.dll",
		join(import.meta.dir, "../../native/pdf/target/release/zn_pdf.dll"),
	].filter(Boolean) as string[];
	for (const c of cands) if (existsSync(c)) return c;
	throw new Error(`zn_pdf.dll not found (tried ${cands.join(", ")}); build it: cd native/pdf && cargo build --release`);
}

let lib: ReturnType<typeof open> | undefined;
function open() {
	return dlopen(findDll(), {
		zpdf_open: { args: [P], returns: P },
		zpdf_open_bytes: { args: [P, usize], returns: P },
		zpdf_page_count: { args: [P], returns: I32 },
		zpdf_page_size: { args: [P, I32, P], returns: I32 },
		zpdf_render_size: { args: [P, I32, F32, P], returns: I32 },
		zpdf_render_size2: { args: [P, I32, F32, I32, P], returns: I32 },
		zpdf_render2: { args: [P, I32, F32, I32, U32, U32, U32, U32, U32, U32, U32], returns: P },
		zpdf_render3: { args: [P, I32, F32, I32, U32, U32, U32, U32, U32, U32, U32, F32], returns: P },
		zpdf_job_prio: { args: [P, F32], returns: FFIType.void },
		zpdf_pool_size: { args: [P], returns: I32 },
		zpdf_backend: { args: [P], returns: I32 },
		zpdf_pdfium_status: { args: [], returns: cstring },
		zpdf_outline_begin: { args: [P], returns: P },
		zpdf_links_begin: { args: [P, I32], returns: P },
		zpdf_render_begin: { args: [P, I32, F32], returns: P },
		zpdf_job_poll: { args: [P], returns: I32 },
		zpdf_job_wait: { args: [P, U32], returns: I32 },
		zpdf_job_size: { args: [P, P], returns: I32 },
		zpdf_job_data: { args: [P], returns: P },
		zpdf_job_len: { args: [P], returns: usize },
		zpdf_job_micros: { args: [P], returns: U64 },
		zpdf_job_free: { args: [P], returns: FFIType.void },
		zpdf_render_page: { args: [P, I32, F32, P, usize, P], returns: FFIType.i64 },
		zpdf_text_begin: { args: [P, I32], returns: P },
		zpdf_job_cancel: { args: [P], returns: FFIType.void },
		zpdf_text_layer: { args: [P, I32], returns: P },
		zpdf_str_free: { args: [P], returns: FFIType.void },
		zpdf_clear_cache: { args: [P], returns: FFIType.void },
		zpdf_close: { args: [P], returns: FFIType.void },
		zpdf_last_error: { args: [], returns: cstring },
		zpdf_version: { args: [], returns: cstring },
	});
}

// Page editing and printing (zn_pdf 0.5, src/ops.rs) are bound on their own, so an older zn_pdf.dll without them still renders.
let opsLib: ReturnType<typeof openOps> | null | undefined;
let opsError = "";
function openOps() {
	return dlopen(findDll(), {
		zpdf_page_rotation: { args: [P, I32], returns: I32 },
		zpdf_edit_begin: { args: [P, usize, P, P, I32, P, I32], returns: P },
		zpdf_print_begin: { args: [P, usize, P, I32], returns: P },
		zpdf_print_to_begin: { args: [P, usize, P, P, P, I32, I32], returns: P },
	});
}
function ops() {
	if (opsLib === undefined) {
		try { opsLib = openOps(); } catch (e) { opsLib = null; opsError = e instanceof Error ? e.message : String(e); }
	}
	return opsLib?.symbols ?? null;
}
/** Why page editing / printing cannot run (null when they can): the zn_pdf.dll in use predates them. */
export function pdfOpsUnavailable(): string | null {
	return ops() ? null : `this build of zn_pdf.dll cannot edit or print PDFs (${opsError || "missing functions"}); rebuild native/pdf`;
}

const cstr = (s: string) => Buffer.from(s + "\0", "utf8");

/** Wait for a job that runs on a thread of its own (edit, print), polling every `ms`; returns its data (copied) or throws its error. */
async function opJob(job: number | bigint | null, what: string, ms: number): Promise<Uint8Array> {
	const s = sym();
	if (!job) throw new Error(`${what}: ${lastError()}`);
	try {
		let st: number;
		while ((st = s.zpdf_job_poll(job as never)) === 0) await Bun.sleep(ms);
		if (st !== 1) throw new Error(lastError() || `${what} failed`);
		const len = Number(s.zpdf_job_len(job as never));
		return new Uint8Array(toBuffer(s.zpdf_job_data(job as never) as never, 0, len)).slice();
	} finally { s.zpdf_job_free(job as never); }
}

/** Page edits as Zotero makes them: rotations add quarter turns clockwise to a page's /Rotate (negative: anticlockwise); deletions are indexes of the original document. */
export interface PdfEdit { rotate?: { page: number; turns: number }[]; delete?: number[] }

/** Apply `e` to the PDF in `bytes` (PDFium, on a thread of its own) and return the whole new file (not an incremental update). */
export async function editPdf(bytes: Uint8Array, e: PdfEdit): Promise<Uint8Array> {
	const o = ops();
	if (!o) throw new Error(pdfOpsUnavailable()!);
	const rp = new Int32Array((e.rotate ?? []).map((r) => r.page)), rt = new Int32Array((e.rotate ?? []).map((r) => r.turns));
	const dp = new Int32Array(e.delete ?? []);
	const one = new Int32Array(1); // bun:ffi needs a real pointer even for an empty array
	const job = o.zpdf_edit_begin(ptr(bytes), bytes.byteLength, ptr(rp.length ? rp : one), ptr(rt.length ? rt : one), rp.length, ptr(dp.length ? dp : one), dp.length);
	return opJob(job as never, "editing the PDF", 5);
}

export interface PrintResult { result: "printed" | "cancelled"; pages: number; printer: string }

/** Show the system print dialog (owned by this app's window) and print the chosen pages through PDFium. `currentPage` (0-based) enables "Current page". */
export async function printPdf(bytes: Uint8Array, o: { title: string; currentPage?: number }): Promise<PrintResult> {
	const f = ops();
	if (!f) throw new Error(pdfOpsUnavailable()!);
	const job = f.zpdf_print_begin(ptr(bytes), bytes.byteLength, ptr(cstr(o.title)), o.currentPage === undefined ? 0 : o.currentPage + 1);
	return JSON.parse(Buffer.from(await opJob(job as never, "printing", 100)).toString("utf8")) as PrintResult;
}

/** Print without a dialog: pages first..last (1-based; last 0 = to the end) on `printer` (default printer when omitted), into the file `output` when given (tests: "Microsoft Print to PDF"). */
export async function printPdfTo(bytes: Uint8Array, o: { title: string; printer?: string; output?: string; first?: number; last?: number }): Promise<PrintResult> {
	const f = ops();
	if (!f) throw new Error(pdfOpsUnavailable()!);
	const job = f.zpdf_print_to_begin(ptr(bytes), bytes.byteLength, ptr(cstr(o.title)), o.printer ? ptr(cstr(o.printer)) : null, o.output ? ptr(cstr(o.output)) : null, o.first ?? 1, o.last ?? 0);
	return JSON.parse(Buffer.from(await opJob(job as never, "printing", 50)).toString("utf8")) as PrintResult;
}
const sym = () => (lib ??= open()).symbols;

export const nativeVersion = (): string => String(sym().zpdf_version());
/** Why PDFium is not in use (empty when it is): pdfium.dll missing / unloadable, or ZN_PDF_BACKEND=hayro. */
export const pdfiumStatus = (): string => String(sym().zpdf_pdfium_status());
const lastError = (): string => String(sym().zpdf_last_error());

/** One word of a page's text layer; x/y/w/h are fractions (0..1) of the page, origin top-left; l = line index. */
export interface TextWord { t: string; x: number; y: number; w: number; h: number; l: number }
export interface TextLayer { pw: number; ph: number; words: TextWord[] }

/** How the page is recoloured while it is rasterized (page appearance): 0 normal, 1 dark, 2 multiply by c0, 3 dark + screen onto c0, 4 duotone c0 (black) -> c1 (white). Colours are 0xRRGGBB. */
export interface Look { mode: 0 | 1 | 2 | 3 | 4; c0?: number; c1?: number }

/** Queue priority of work nobody is waiting for on screen (thumbnails, ...): behind every tile of the page list. */
export const PRIO_BACKGROUND = 4e6;

export interface RenderOpts {
	/** extra clockwise rotation in degrees (0 / 90 / 180 / 270) */
	rot?: number;
	/** only this part of the full bitmap, in device pixels (default: all of it) */
	region?: { x: number; y: number; w: number; h: number };
	look?: Look;
	/** queue priority, lower first (default PRIO_BACKGROUND) */
	prio?: number;
}

/** One bookmark: page is 0-based (-1 when it could not be resolved), y a fraction (0..1) of the page height, -1 when unknown. */
export interface OutlineEntry { t: string; l: number; p: number; y: number }
/** A link annotation: x/y/w/h are fractions of the page as rendered (unrotated view). */
export type PdfLink = { x: number; y: number; w: number; h: number } & ({ k: "page"; p: number; ty: number } | { k: "uri"; u: string });

export interface Rendered {
	width: number;
	height: number;
	/** BGRA8, opaque. Aliases native memory: valid until release(). */
	pixels: Buffer;
	/** rasterization time inside the worker, ms */
	renderMs: number;
	/** h rows of the bitmap from row y (BGRA, full width) as a view onto the same native memory: a page rendered once can be cut into band tiles without a copy */
	slice(y: number, h: number): Buffer;
	release(): void;
}

export interface RenderTask {
	promise: Promise<Rendered | null>;
	/** skip the job if no worker has started it (resolves null); harmless afterwards */
	cancel(): void;
	/** change the queue priority of a job that is still waiting; harmless afterwards */
	setPrio(prio: number): void;
}

// One timer polls every pending job (a scroll queues dozens): 1 ms while work is fresh, 2 ms after.
const watching = new Map<number | bigint, (state: number) => void>();
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let pollSpins = 0;
function pollTick(): void {
	pollTimer = undefined;
	const s = sym();
	for (const [job, done] of watching) {
		const st = s.zpdf_job_poll(job as never);
		if (st !== 0) { watching.delete(job); done(st); }
	}
	if (watching.size) pollTimer = setTimeout(pollTick, pollSpins++ < 8 ? 1 : 2);
}
/** resolves with the job's final state (1 done, -1 failed, -2 cancelled) */
function watch(job: number | bigint): Promise<number> {
	return new Promise((res) => {
		watching.set(job, res);
		pollSpins = 0;
		if (pollTimer === undefined) pollTimer = setTimeout(pollTick, 1);
	});
}

export class PdfDoc {
	readonly pageCount: number;
	/** page sizes in PDF points */
	readonly sizes: [number, number][];
	private handle: number | bigint | null;

	private constructor(handle: number | bigint, pageCount: number, sizes: [number, number][]) {
		this.handle = handle;
		this.pageCount = pageCount;
		this.sizes = sizes;
	}

	static open(path: string): PdfDoc {
		const h = sym().zpdf_open(ptr(Buffer.from(path + "\0", "utf8")));
		if (!h) throw new Error(`zpdf_open failed: ${lastError()}`);
		return PdfDoc.measure(h);
	}

	/** Open a PDF held in memory (the bytes are copied into the worker; the caller may drop its buffer afterwards). */
	static openBytes(data: Uint8Array): PdfDoc {
		const h = sym().zpdf_open_bytes(ptr(data), data.byteLength);
		if (!h) throw new Error(`zpdf_open_bytes failed: ${lastError()}`);
		return PdfDoc.measure(h);
	}

	private static measure(h: number | bigint): PdfDoc {
		const s = sym();
		const n = s.zpdf_page_count(h as never);
		const sizes: [number, number][] = [];
		const f = new Float32Array(2);
		for (let i = 0; i < n; i++) { s.zpdf_page_size(h as never, i, ptr(f)); sizes.push([f[0]!, f[1]!]); }
		return new PdfDoc(h as number, n, sizes);
	}

	private h(): number | bigint {
		if (this.handle == null) throw new Error("PdfDoc is closed");
		return this.handle;
	}

	/** Pixel size a render at `scale` yields. */
	renderSize(page: number, scale: number): [number, number] {
		const o = new Uint32Array(2);
		sym().zpdf_render_size(this.h() as never, page, scale, ptr(o));
		return [o[0]!, o[1]!];
	}

	/** Full bitmap size of a render at `scale` with an extra rotation. */
	renderSize2(page: number, scale: number, rot = 0): [number, number] {
		const o = new Uint32Array(2);
		sym().zpdf_render_size2(this.h() as never, page, scale, rot, ptr(o));
		return [o[0]!, o[1]!];
	}

	/** Like render(), rotated, recoloured and/or restricted to a region of the full bitmap (tiles). */
	render2(page: number, scale: number, o: RenderOpts = {}): RenderTask { return this.render3(page, scale, o); }

	/** render2 with a queue priority (o.prio, lower runs first) */
	render3(page: number, scale: number, o: RenderOpts = {}): RenderTask {
		const s = sym();
		const r = o.region, k = o.look;
		const job = s.zpdf_render3(this.h() as never, page, scale, o.rot ?? 0, r?.x ?? 0, r?.y ?? 0, r?.w ?? 0, r?.h ?? 0, k?.mode ?? 0, k?.c0 ?? 0, k?.c1 ?? 0, o.prio ?? PRIO_BACKGROUND);
		if (!job) throw new Error(`render_begin failed: ${lastError()}`);
		return this.task(job, page);
	}

	/** The page's own /Rotate in degrees (0 / 90 / 180 / 270), already part of `sizes` and of every render; 0 when the dll predates it. */
	pageRotation(page: number): number {
		const o = ops();
		return o ? Math.max(0, o.zpdf_page_rotation(this.h() as never, page)) : 0;
	}

	/** Which rasteriser draws this document: PDFium (pdfium.dll next to zn_pdf.dll) or hayro (the fallback). */
	backend(): "pdfium" | "hayro" { return sym().zpdf_backend(this.h() as never) === 1 ? "pdfium" : "hayro"; }

	/** Worker threads this document renders with. */
	poolSize(): number { return sym().zpdf_pool_size(this.h() as never); }

	/** cancel / setPrio must not touch a job that was freed (release() or a failed / cancelled finish) */
	private task(job: number | bigint, page: number): RenderTask {
		const s = sym();
		const ref = { freed: false };
		return {
			promise: this.finish(job, page, ref),
			cancel: () => { if (!ref.freed) s.zpdf_job_cancel(job as never); },
			setPrio: (p) => { if (!ref.freed) s.zpdf_job_prio(job as never, p); },
		};
	}

	/** Run a JSON-producing job (outline, links) on the worker. */
	private async jsonJob<T>(begin: () => number | bigint | null, what: string): Promise<T> {
		const s = sym();
		const job = begin();
		if (!job) throw new Error(`${what} failed: ${lastError()}`);
		const st = await this.poll(job);
		try {
			if (st !== 1) throw new Error(`${what} failed: ${lastError()}`);
			const len = Number(s.zpdf_job_len(job as never));
			return JSON.parse(toBuffer(s.zpdf_job_data(job as never) as never, 0, len).toString("utf8")) as T;
		} finally { s.zpdf_job_free(job as never); }
	}
	outlineAsync(): Promise<OutlineEntry[]> { return this.jsonJob(() => sym().zpdf_outline_begin(this.h() as never) as never, "outline"); }
	linksAsync(page: number): Promise<PdfLink[]> { return this.jsonJob(() => sym().zpdf_links_begin(this.h() as never, page) as never, `links of page ${page}`); }

	/**
	 * Queue a rasterization. `promise` resolves when the worker is done (polled every few ms, so the JS thread is never
	 * blocked), or with null if cancel() got there before the worker started the job.
	 */
	render(page: number, scale: number): RenderTask {
		const job = sym().zpdf_render_begin(this.h() as never, page, scale);
		if (!job) throw new Error(`render_begin failed: ${lastError()}`);
		return this.task(job, page);
	}

	renderAsync(page: number, scale: number): Promise<Rendered | null> { return this.render(page, scale).promise; }

	private async poll(job: number | bigint): Promise<number> {
		const st = sym().zpdf_job_poll(job as never);
		return st !== 0 ? st : watch(job);
	}

	private async finish(job: number | bigint, page: number, ref: { freed: boolean }): Promise<Rendered | null> {
		const st = await this.poll(job);
		if (st === 1) return this.collect(job, ref);
		ref.freed = true;
		sym().zpdf_job_free(job as never);
		if (st === -2) return null;
		throw new Error(`render page ${page} failed: ${lastError()}`);
	}

	/** Blocking render (bench / tests). */
	renderSync(page: number, scale: number): Rendered {
		const s = sym();
		const job = s.zpdf_render_begin(this.h() as never, page, scale);
		if (!job) throw new Error(`render_begin failed: ${lastError()}`);
		if (s.zpdf_job_wait(job, 0xffffffff) !== 1) { s.zpdf_job_free(job); throw new Error(`render page ${page} failed: ${lastError()}`); }
		return this.collect(job, { freed: false });
	}

	private collect(job: number | bigint, ref: { freed: boolean }): Rendered {
		const s = sym();
		const wh = new Uint32Array(2);
		s.zpdf_job_size(job as never, ptr(wh));
		const len = Number(s.zpdf_job_len(job as never));
		const data = s.zpdf_job_data(job as never);
		const pixels = toBuffer(data as never, 0, len);
		const width = wh[0]!, height = wh[1]!;
		return {
			width, height, pixels,
			renderMs: Number(s.zpdf_job_micros(job as never)) / 1000,
			slice: (y, h) => toBuffer(data as never, y * width * 4, Math.min(h, height - y) * width * 4),
			release: () => { if (!ref.freed) { ref.freed = true; s.zpdf_job_free(job as never); } },
		};
	}

	/** Text layer, extracted on the worker thread (queued behind pending renders). */
	async textLayerAsync(page: number): Promise<TextLayer> {
		const s = sym();
		const job = s.zpdf_text_begin(this.h() as never, page);
		if (!job) throw new Error(`text_begin failed: ${lastError()}`);
		const st = await this.poll(job);
		try {
			if (st !== 1) throw new Error(`text layer of page ${page} failed: ${lastError()}`);
			const len = Number(s.zpdf_job_len(job as never));
			return JSON.parse(toBuffer(s.zpdf_job_data(job as never) as never, 0, len).toString("utf8")) as TextLayer;
		} finally { s.zpdf_job_free(job as never); }
	}

	/** Blocking variant (waits for the worker's queue). */
	textLayer(page: number): TextLayer {
		const s = sym();
		const p = s.zpdf_text_layer(this.h() as never, page);
		if (!p) throw new Error(`text layer failed: ${lastError()}`);
		try { return JSON.parse(new CString(p as never).toString()) as TextLayer; }
		finally { s.zpdf_str_free(p as never); }
	}

	/** Drop hayro's per-document caches (fonts, glyphs, decoded images). */
	clearCache(): void { sym().zpdf_clear_cache(this.h() as never); }

	close(): void {
		if (this.handle != null) { sym().zpdf_close(this.handle as never); this.handle = null; }
	}
}
