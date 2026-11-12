// web/pdf-engine.ts (PDFium WebAssembly, shared by the page and the render workers) on a small hand-built PDF.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { closeDoc, drawPage, initEngine, openDoc, pageText } from "./pdf-engine";

function twoPagePdf(): Uint8Array {
	const page = (n: number) => `BT /F1 24 Tf 72 700 Td (Fixture page ${n}) Tj ET`;
	const objs = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
		`<< /Length ${page(1).length} >>\nstream\n${page(1)}\nendstream`,
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
		`<< /Length ${page(2).length} >>\nstream\n${page(2)}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let out = "%PDF-1.4\n";
	const offs: number[] = [];
	objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
	const xref = out.length;
	out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(out);
}

test("open, sizes, render and text through the shared engine", async () => {
	await initEngine(readFileSync(join(import.meta.dir, "..", "node_modules", "@embedpdf", "pdfium", "dist", "pdfium.wasm")).buffer as ArrayBuffer);
	const h = openDoc(twoPagePdf());
	expect(h.pageCount).toBe(2);
	expect(h.sizes).toEqual([[612, 792], [595, 842]]);
	const d = drawPage(h, 0, 0.5, {});
	expect([d.width, d.height]).toEqual([306, 396]);
	expect(d.pixels.length).toBe(306 * 396 * 4);
	expect(d.pixels.some((v, i) => i % 4 !== 3 && v < 128)).toBe(true); // some dark text pixels
	const region = drawPage(h, 1, 1, { region: { x: 0, y: 0, w: 100, h: 50 }, rot: 90 });
	expect([region.width, region.height]).toEqual([100, 50]);
	const t = pageText(h, 1);
	expect(t.words.map((w) => w.t)).toEqual(["Fixture", "page", "2"]);
	expect(t.words[0]!.y).toBeGreaterThan(0.1);
	closeDoc(h);
	expect(h.doc).toBe(0);
});
