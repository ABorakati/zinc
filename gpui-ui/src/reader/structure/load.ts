// Loads DocStructure from Zotero's document worker (the engine behind Reading Mode), the GPUI counterpart of
// reader-next/src/structure/load.ts. Runs the worker in a Bun Worker (worker.ts), decodes the SDT pack with Zotero's own
// reader (vendor/reader/structured-document-text, read-only) and converts it (convert.ts). The converted structure is cached
// on disk per attachment (ZN_STRUCT_CACHE or <tmp>/zn-gpui/structure), so a re-open is instant.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";
import { CONVERTER_VERSION, convertSdt, type Sdt } from "./convert";
import type { DocStructure } from "./types";
import { DocumentWorker, ROOT } from "./worker";

const SDT_DIR = join(ROOT, "vendor", "reader", "structured-document-text", "src");
const CACHE_DIR = process.env.ZN_STRUCT_CACHE ?? join(tmpdir(), "zn-gpui", "structure");

interface PackReader {
	materialize(): Promise<unknown>;
}
interface PackLib {
	open(bytes: Uint8Array): Promise<PackReader>;
	packVersion: unknown;
	schemaVersion: unknown;
}
let packLib: Promise<PackLib> | undefined;
function pack(): Promise<PackLib> {
	return (packLib ??= (async () => {
		const reader = (await import(pathToFileURL(join(SDT_DIR, "pack", "reader.js")).href)) as {
			openStructuredDocumentTextPack(b: Uint8Array, o: { inflate(b: Uint8Array): Uint8Array }): Promise<PackReader>;
		};
		const ver = (await import(pathToFileURL(join(SDT_DIR, "version.js")).href)) as {
			SDT_PACK_VERSION: unknown;
			SDT_SCHEMA_VERSION: unknown;
		};
		return {
			open: (bytes) => reader.openStructuredDocumentTextPack(bytes, { inflate: (b) => new Uint8Array(inflateRawSync(b)) }),
			packVersion: ver.SDT_PACK_VERSION,
			schemaVersion: ver.SDT_SCHEMA_VERSION,
		};
	})());
}

// The worker requires sourceHash to be a 32-char lowercase hex string (reader-host/src/host.js stableSourceHash).
const sourceHash = (key: string) =>
	/^[0-9a-f]{32}$/.test(key) ? key : createHash("sha256").update(`zotero-next:${key}`).digest("hex").slice(0, 32);

const fileOf = (key: string, size: number, lib: PackLib) =>
	join(CACHE_DIR, `${key}.${size}.c${CONVERTER_VERSION}.p${lib.packVersion}.s${lib.schemaVersion}.json`);

function cacheRead(file: string): DocStructure | null {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as DocStructure;
	} catch {
		return null;
	}
}
function cacheWrite(key: string, file: string, doc: DocStructure): void {
	try {
		mkdirSync(CACHE_DIR, { recursive: true });
		for (const f of readdirSync(CACHE_DIR)) if (f.startsWith(`${key}.`)) rmSync(join(CACHE_DIR, f), { force: true }); // stale sizes / versions
		writeFileSync(file, JSON.stringify(doc));
	} catch (e) {
		console.warn("[structure] cache write failed:", (e as Error).message);
	}
}

let worker: DocumentWorker | null = null;
const inflight = new Map<string, Promise<DocStructure>>();
const listeners = new Map<string, Set<(pct: number) => void>>();

async function build(key: string, pdf: Uint8Array): Promise<DocStructure> {
	const emit = (pct: number) => {
		for (const f of listeners.get(key) ?? []) f(pct);
	};
	emit(0);
	const lib = await pack();
	const file = fileOf(key, pdf.byteLength, lib);
	const hit = cacheRead(file);
	if (hit) {
		emit(100);
		return hit;
	}

	worker ??= new DocumentWorker();
	const buf = pdf.slice().buffer as ArrayBuffer; // the worker takes (detaches) its copy
	const result = await worker.query<{ buf?: ArrayBuffer }>(
		"getStructuredDocumentText",
		{ buf, contentType: "application/pdf", sourceHash: sourceHash(key), reportProgress: true },
		[buf],
		(p) => emit(Math.max(0, Math.min(95, p <= 1 ? p * 95 : p))),
	);
	if (!result?.buf) throw new Error("The document worker produced no structure");
	emit(96);
	const sdt = (await (await lib.open(new Uint8Array(result.buf))).materialize()) as Sdt;
	const doc = convertSdt(sdt);
	emit(100);
	cacheWrite(key, file, doc);
	return doc;
}

/**
 * DocStructure of an attachment's PDF. Concurrent callers for the same attachment (reflow + academic) share one run.
 * `onProgress` receives 0..100.
 */
export function loadStructure(attachmentKey: string, pdfBytes: Uint8Array, onProgress?: (pct: number) => void): Promise<DocStructure> {
	if (onProgress) {
		let set = listeners.get(attachmentKey);
		if (!set) listeners.set(attachmentKey, (set = new Set()));
		set.add(onProgress);
	}
	let p = inflight.get(attachmentKey);
	if (!p) {
		p = build(attachmentKey, pdfBytes).finally(() => {
			listeners.delete(attachmentKey);
		});
		inflight.set(attachmentKey, p);
		p.catch(() => inflight.delete(attachmentKey)); // keep successes; drop failures so a retry can happen
	}
	return p;
}

/** Stop the document worker thread (the next load starts a fresh one). */
export function shutdownStructureWorker(): void {
	worker?.terminate();
	worker = null;
}
