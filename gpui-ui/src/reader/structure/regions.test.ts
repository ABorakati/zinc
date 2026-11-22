// bun test src/reader/structure/regions.test.ts -- crops of a page: the document opened for them is given back when nobody asks for a while.
// (Needs the zn_pdf library: skipped when it is not built.)
process.env.ZN_REGIONS_IDLE_MS = "80";
import { describe, expect, test } from "bun:test";
import { findDll } from "../pdf";
import type { ReaderContext } from "../plugins";
const { closeRegions, openRegionDocs, renderRegion } = await import("./regions"); // after the env var: the idle time is read when the module loads

/** A one-page PDF (200 x 100 pt) with a black square at the lower left. */
function tinyPdf(): Uint8Array {
	const content = "0 0 0 rg 10 10 40 40 re f";
	const objs = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R >>",
		`<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
	];
	let out = "%PDF-1.4\n";
	const offs: number[] = [];
	objs.forEach((o, i) => {
		offs.push(out.length);
		out += `${i + 1} 0 obj\n${o}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new Uint8Array(Buffer.from(out, "latin1"));
}

const hasDll = (() => {
	try {
		findDll();
		return true;
	} catch {
		return false;
	}
})();
const ctxOf = (key: string) => ({ attachmentKey: key, pdfBytes: async () => tinyPdf() }) as unknown as ReaderContext;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe.skipIf(!hasDll)("renderRegion's document", () => {
	test("is closed when nothing has asked for a crop for a while, and opened again on demand", async () => {
		const ctx = ctxOf("IDLE0001");
		const a = await renderRegion(ctx, 0, [0, 0, 100, 100], 100);
		expect(a).not.toBeNull();
		expect(openRegionDocs()).toBe(1);
		await sleep(400);
		expect(openRegionDocs()).toBe(0);
		const b = await renderRegion(ctx, 0, [0, 0, 100, 100], 100);
		expect(b).not.toBeNull();
		expect(Buffer.from(b!.pixels).equals(Buffer.from(a!.pixels))).toBe(true);
		closeRegions("IDLE0001");
		expect(openRegionDocs()).toBe(0);
	});

	test("keeps a document that is being used", async () => {
		const ctx = ctxOf("IDLE0002");
		for (let i = 0; i < 6; i++) {
			await renderRegion(ctx, 0, [i * 10, 0, i * 10 + 60, 100], 100); // a new crop each time: the clock restarts
			await sleep(30);
		}
		expect(openRegionDocs()).toBe(1);
		closeRegions("IDLE0002");
	});
});
