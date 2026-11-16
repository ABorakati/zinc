// Bun Worker entry: shims the few browser globals pdf.js touches at load time, then loads
// Zotero's built document-worker bundle (vendor/document-worker/build/worker.js), which
// installs its own self.onmessage handler. Posts {ready:true} once it is listening.
declare const self: any;

const g = globalThis as any;
if (typeof g.DOMMatrix === "undefined") {
	// Minimal affine matrix; text extraction never renders, it only needs the class to exist.
	g.DOMMatrix = class DOMMatrix {
		a = 1;
		b = 0;
		c = 0;
		d = 1;
		e = 0;
		f = 0;
		constructor(init?: number[]) {
			if (Array.isArray(init) && init.length >= 6) [this.a, this.b, this.c, this.d, this.e, this.f] = init as number[];
		}
		multiplySelf() {
			return this;
		}
		preMultiplySelf() {
			return this;
		}
		translate() {
			return this;
		}
		scale() {
			return this;
		}
		invertSelf() {
			return this;
		}
	};
}
if (typeof g.Path2D === "undefined") g.Path2D = class Path2D {};
if (typeof g.ImageData === "undefined") g.ImageData = class ImageData {};

// pdf.js sniffs Node via process.versions (and then expects a PDFJSDev build global). The
// bundle is the web build, so present as a non-Node (NW.js-like) environment.
try {
	(process.versions as any).nw = "1";
} catch {}

// ZN_DOCWORKER_DIR is set by configureExtractPool when the app ships its own copy of the build.
const dir = process.env.ZN_DOCWORKER_DIR;
const workerPath = dir
	? new URL("worker.js", "file:///" + dir.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/*$/, "/")).href
	: new URL("../../../vendor/document-worker/build/worker.js", import.meta.url).href;
await import(workerPath);
self.postMessage({ ready: true });
