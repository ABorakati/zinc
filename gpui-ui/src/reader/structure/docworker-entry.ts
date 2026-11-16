// Entry script of the Bun Worker that hosts Zotero's document worker (vendor/document-worker/build/worker.js, the engine behind
// Zotero's Reading Mode). That bundle is a webpack UMD built for a browser Web Worker; Bun's Worker runs it with three shims:
//   * DOMMatrix / Path2D / ImageData: pdf.js touches them at load time (no rendering happens, only text extraction), minimal stubs.
//   * process.versions.nw: pdf.js decides "am I Node?" from `process`, takes a Node-only branch that needs a build-time global
//     (PDFJSDev) and fails; a browser worker has no `process`, so we make the check come out as "not Node".
//   * a ready handshake: Bun drops messages that arrive before the worker module (which awaits the import) has finished
//     evaluating, so the host waits for {__ready: true} before it posts the first request.
const g = globalThis as Record<string, unknown>;

class Matrix {
	a = 1;
	b = 0;
	c = 0;
	d = 1;
	e = 0;
	f = 0;
	is2D = true;
	constructor(init?: number[]) {
		if (Array.isArray(init) && init.length >= 6)
			[this.a, this.b, this.c, this.d, this.e, this.f] = init as [number, number, number, number, number, number];
	}
	private copy() {
		return new Matrix([this.a, this.b, this.c, this.d, this.e, this.f]);
	}
	multiplySelf(o: Matrix) {
		const { a, b, c, d, e, f } = this;
		this.a = a * o.a + c * o.b;
		this.b = b * o.a + d * o.b;
		this.c = a * o.c + c * o.d;
		this.d = b * o.c + d * o.d;
		this.e = a * o.e + c * o.f + e;
		this.f = b * o.e + d * o.f + f;
		return this;
	}
	multiply(o: Matrix) {
		return this.copy().multiplySelf(o);
	}
	translateSelf(tx = 0, ty = 0) {
		this.e += this.a * tx + this.c * ty;
		this.f += this.b * tx + this.d * ty;
		return this;
	}
	translate(tx = 0, ty = 0) {
		return this.copy().translateSelf(tx, ty);
	}
	scaleSelf(sx = 1, sy = sx) {
		this.a *= sx;
		this.b *= sx;
		this.c *= sy;
		this.d *= sy;
		return this;
	}
	scale(sx = 1, sy = sx) {
		return this.copy().scaleSelf(sx, sy);
	}
	invertSelf() {
		const det = this.a * this.d - this.b * this.c;
		if (!det) {
			this.a = this.b = this.c = this.d = this.e = this.f = NaN;
			return this;
		}
		const { a, b, c, d, e, f } = this;
		this.a = d / det;
		this.b = -b / det;
		this.c = -c / det;
		this.d = a / det;
		this.e = (c * f - d * e) / det;
		this.f = (b * e - a * f) / det;
		return this;
	}
	inverse() {
		return this.copy().invertSelf();
	}
	transformPoint(p: { x: number; y: number }) {
		return { x: this.a * p.x + this.c * p.y + this.e, y: this.b * p.x + this.d * p.y + this.f };
	}
}
g.DOMMatrix ??= Matrix;
g.Path2D ??= class Path2D {
	addPath() {}
	closePath() {}
	moveTo() {}
	lineTo() {}
	bezierCurveTo() {}
	rect() {}
};
g.ImageData ??= class ImageData {
	height: number;
	constructor(
		public data: Uint8ClampedArray,
		public width: number,
		h?: number,
	) {
		this.height = h ?? data.length / 4 / width;
	}
};
try {
	Object.defineProperty(process.versions, "nw", { value: "0", configurable: true });
} catch {
	/* read-only: pdf.js then fails loudly */
}

// <root>/vendor/document-worker/build/worker.js. Bun does not pass the parent's runtime env changes into a Worker, so ZN_ROOT set by
// packaged.ts may be missing here: the packaged app ships this file next to vendor/ (use that), the repo has it four levels down.
const beside = `${import.meta.dir}/vendor/document-worker/build/worker.js`;
const root = process.env.ZN_ROOT ?? ((await Bun.file(beside).exists()) ? import.meta.dir : `${import.meta.dir}/../../../..`);
await import(`${root}/vendor/document-worker/build/worker.js`);
(globalThis as unknown as { postMessage(m: unknown): void }).postMessage({ __ready: true });
