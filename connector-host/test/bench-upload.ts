// How long does a save take when a big PDF is uploading, and is the host usable meanwhile? (temp library only)
//   ZNH_EXE=<host exe> bun test/bench-upload.ts burst        extension as before: all 4 MiB chunks posted at once
//   ZNH_EXE=<host exe> bun test/bench-upload.ts interleaved  extension now: 1 MiB chunks, yielding between them
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../core/src/db";
import { HostClient } from "./client";

const mode = process.argv[2] === "interleaved" ? "interleaved" : "burst";
const dir = mkdtempSync(join(tmpdir(), "znh-bup-"));
const dbPath = join(dir, "library.sqlite");
openDb(dbPath).close(true);

const SIZE = 20 * 1024 * 1024;
const pdf = new Uint8Array(SIZE); // a dummy ~20 MB PDF
pdf.set(new TextEncoder().encode("%PDF-1.4\n"));
for (let i = 9; i < SIZE; i++) pdf[i] = (i * 31 + 7) & 0xff;
const item = (i: string) => ({
	id: i,
	itemType: "journalArticle",
	title: `Big PDF ${i}`,
	creators: [],
	date: "2024",
	DOI: `10.1/${i}`,
	url: `https://example.org/${i}`,
	tags: [],
	notes: [],
	attachments: [],
	seeAlso: [],
});
const ms = (t0: number) => (performance.now() - t0).toFixed(0).padStart(5) + " ms";

const c = new HostClient({ ZN_DB: dbPath });
await c.call("ping", { json: {} });
const T = performance.now();
const a = await c.call("saveItems", { json: { sessionID: "A", uri: "https://example.org/a", items: [item("a")] } });
console.log(`[${mode}] item A saved (saveItems answered)        ${ms(T)}  status ${a.status}`);

// the attachment upload starts; 5 ms later the user saves another tab and the page asks ping
const chunk = mode === "burst" ? 4 * 1024 * 1024 : 1024 * 1024;
const T1 = performance.now();
const upload = (async () => {
	await c.uploadBytes("pdfA", pdf, chunk, mode === "interleaved");
	const r = await c.call("saveAttachment", {
		uploadUid: "pdfA",
		headers: {
			"Content-Type": "application/pdf",
			"X-Metadata": JSON.stringify({
				id: "att",
				url: "https://example.org/a.pdf",
				contentType: "application/pdf",
				parentItemID: "a",
				title: "PDF",
			}),
		},
		query: "sessionID=A",
	});
	console.log(`[${mode}] attachment saved (20 MB), from upload start ${ms(T1)}  status ${r.status}`);
})();
await Bun.sleep(5);
const T2 = performance.now();
const ping = c.call("ping", { json: {} }).then(() => console.log(`[${mode}] ping issued 5 ms into the upload answered after ${ms(T2)}`));
const second = c
	.call("saveItems", { json: { sessionID: "B", uri: "https://example.org/b", items: [item("b")] } })
	.then((r) => console.log(`[${mode}] second save (item B) answered after       ${ms(T2)}  status ${r.status}`));
await Promise.all([upload, ping, second]);
await c.close();
rmSync(dir, { recursive: true, force: true });
