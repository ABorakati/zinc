// bun test src/reader/structure/load.test.ts -- loadStructure: the structure of the file as it is NOW, a worker that comes back, a private cache folder.
// The document worker and Zotero's pack reader are stand-ins in a temporary folder (ZN_ROOT): what is checked is the loader around them.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "zn-load-test-"));
const log = join(root, "requests.log");
const failFile = join(root, "fail-to-start");
const cache = join(root, "cache");
const put = (rel: string, text: string) => {
	mkdirSync(join(root, rel, ".."), { recursive: true });
	writeFileSync(join(root, rel), text);
};
put("vendor/document-worker/build/worker.js", "// not used: the entry below replaces it\n");
put(
	"vendor/reader/structured-document-text/src/pack/reader.js",
	"export async function openStructuredDocumentTextPack() { return { materialize: async () => ({ catalog: { pages: [] }, content: [] }) }; }\n",
);
put("vendor/reader/structured-document-text/src/version.js", "export const SDT_PACK_VERSION = 1;\nexport const SDT_SCHEMA_VERSION = 1;\n");
const entry = join(root, "fake-entry.ts");
writeFileSync(
	entry,
	`import { appendFileSync, existsSync } from "node:fs";
if (existsSync(${JSON.stringify(failFile)})) throw new Error("the worker cannot start");
self.onmessage = (ev: MessageEvent) => {
	const m = ev.data;
	if (m.action !== "getStructuredDocumentText") return;
	appendFileSync(${JSON.stringify(log)}, "request" + String.fromCharCode(10));
	postMessage({ responseID: m.id, data: { buf: new ArrayBuffer(8) } });
};
postMessage({ __ready: true });
`,
);
process.env.ZN_ROOT = root;
process.env.ZN_DOCWORKER_ENTRY = entry;
process.env.ZN_STRUCT_CACHE = cache;
writeFileSync(log, "");
const { loadStructure, shutdownStructureWorker, structureCacheDir } = await import("./load");
const requests = () => readFileSync(log, "utf8").split("\n").filter(Boolean).length;

afterAll(() => {
	shutdownStructureWorker();
	rmSync(root, { recursive: true, force: true });
});

const pdf = (fill: number) => new Uint8Array(5000).fill(fill); // same size, other content

describe("loadStructure", () => {
	test("a document worker that failed to start is replaced by a new one on the next load", async () => {
		writeFileSync(failFile, "");
		await expect(loadStructure("RECOVER1", pdf(1))).rejects.toThrow(/Document worker unavailable/);
		rmSync(failFile);
		const doc = await loadStructure("RECOVER1", pdf(1)); // the first run failed: it is not remembered
		expect(doc.blocks).toEqual([]);
		expect(requests()).toBe(1);
	});

	test("the same file is built once; the same attachment with other content (page edit) is built again", async () => {
		const before = requests();
		const a = await loadStructure("EDITED01", pdf(1));
		expect(requests()).toBe(before + 1);
		expect(await loadStructure("EDITED01", pdf(1))).toBe(a); // remembered
		expect(requests()).toBe(before + 1);
		await loadStructure("EDITED01", pdf(2)); // rotated / pages deleted: same key, same size, other bytes
		expect(requests()).toBe(before + 2);
		await loadStructure("EDITED01", pdf(2));
		expect(requests()).toBe(before + 2);
	});

	test("the disk cache is keyed by content too: a reopened edited file does not get the old structure back", () => {
		const names = readdirSync(cache).filter((f) => f.startsWith("EDITED01."));
		expect(names).toHaveLength(1); // the stale file of the first content was replaced
	});

	test("remembered results are bounded", async () => {
		const before = requests();
		for (let i = 0; i < 12; i++) await loadStructure(`MANY${String(i).padStart(4, "0")}`, pdf(7));
		expect(requests()).toBe(before + 12);
		await loadStructure("MANY0000", pdf(7)); // long forgotten: built again (from the disk cache, so no new request)
		expect(requests()).toBe(before + 12);
	});
});

describe("structureCacheDir", () => {
	test("ZN_STRUCT_CACHE is used as given", () => expect(structureCacheDir()).toBe(cache));

	test("without it: a folder under the temp folder, made private", () => {
		const chosen = process.env.ZN_STRUCT_CACHE;
		delete process.env.ZN_STRUCT_CACHE;
		try {
			const dir = structureCacheDir();
			expect(dir).not.toBeNull();
			expect(existsSync(dir!)).toBe(true);
			expect(dir!.startsWith(tmpdir())).toBe(true);
			if (process.platform !== "win32") expect(statSync(dir!).mode & 0o077).toBe(0);
		} finally {
			process.env.ZN_STRUCT_CACHE = chosen;
		}
	});
});
