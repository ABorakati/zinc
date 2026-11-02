// bun:ffi bindings for native/pdf (zn_pdf.dll: hayro rasterizer + text layer). See native/pdf/src/lib.rs for the ABI.
//
// Rendering is asynchronous on the Rust side (one worker thread per document); renderAsync() polls the job so the JS thread
// (and with it GPUIX's event loop) is never blocked by a rasterization. The returned Rendered.pixels is a Buffer that
// aliases Rust memory (zero copy): hand it to setImagePixels(..., { format: "bgra" }) and then call release().
import { CString, dlopen, FFIType, ptr, toBuffer } from "bun:ffi";
import { existsSync } from "node:fs";
import { join } from "node:path";

const { ptr: P, i32: I32, u32: U32, f32: F32, u64: U64, cstring } = FFIType;
const usize = FFIType.u64; // 64-bit only (Windows x64)

function findDll(): string {
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
const sym = () => (lib ??= open()).symbols;

export const nativeVersion = (): string => String(sym().zpdf_version());
const lastError = (): string => String(sym().zpdf_last_error());

/** One word of a page's text layer; x/y/w/h are fractions (0..1) of the page, origin top-left; l = line index. */
export interface TextWord { t: string; x: number; y: number; w: number; h: number; l: number }
export interface TextLayer { pw: number; ph: number; words: TextWord[] }

export interface Rendered {
	width: number;
	height: number;
	/** BGRA8, opaque. Aliases native memory: valid until release(). */
	pixels: Buffer;
	/** rasterization time inside the worker, ms */
	renderMs: number;
	release(): void;
}

export interface RenderTask { promise: Promise<Rendered | null>; cancel(): void }

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

	/**
	 * Queue a rasterization. `promise` resolves when the worker is done (polled every few ms, so the JS thread is never
	 * blocked), or with null if cancel() got there before the worker started the job.
	 */
	render(page: number, scale: number): RenderTask {
		const s = sym();
		const job = s.zpdf_render_begin(this.h() as never, page, scale);
		if (!job) throw new Error(`render_begin failed: ${lastError()}`);
		return { promise: this.finish(job, page), cancel: () => s.zpdf_job_cancel(job as never) };
	}

	renderAsync(page: number, scale: number): Promise<Rendered | null> { return this.render(page, scale).promise; }

	private async poll(job: number | bigint): Promise<number> {
		const s = sym();
		let spins = 0;
		for (;;) {
			const st = s.zpdf_job_poll(job as never);
			if (st !== 0) return st;
			await (spins++ < 6 ? Bun.sleep(1) : Bun.sleep(4)); // tight at first (fast pages), then back off
		}
	}

	private async finish(job: number | bigint, page: number): Promise<Rendered | null> {
		const st = await this.poll(job);
		if (st === 1) return this.collect(job);
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
		return this.collect(job);
	}

	private collect(job: number | bigint): Rendered {
		const s = sym();
		const wh = new Uint32Array(2);
		s.zpdf_job_size(job as never, ptr(wh));
		const len = Number(s.zpdf_job_len(job as never));
		const data = s.zpdf_job_data(job as never);
		const pixels = toBuffer(data as never, 0, len);
		let freed = false;
		return {
			width: wh[0]!, height: wh[1]!, pixels,
			renderMs: Number(s.zpdf_job_micros(job as never)) / 1000,
			release: () => { if (!freed) { freed = true; s.zpdf_job_free(job as never); } },
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
