// Loads DocStructure from Zotero's document worker (the engine behind Reading Mode), the GPUI counterpart of
// reader-next/src/structure/load.ts. Runs the worker in a Bun Worker (worker.ts), decodes the SDT pack with Zotero's own
// reader (vendor/reader/structured-document-text, read-only) and converts it (convert.ts). The converted structure is cached
// on disk per attachment (ZN_STRUCT_CACHE or <tmp>/zn-gpui[-uid]/structure, a folder only this user can open), so a re-open is instant.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";
import { privateDir } from "../privateTemp";
import { CONVERTER_VERSION, convertSdt, type Sdt } from "./convert";
import { fingerprint, latestPerAttachment } from "./memo";
import type { DocStructure } from "./types";
import { DocumentWorker, ROOT } from "./worker";

const SDT_DIR = join(ROOT, "vendor", "reader", "structured-document-text", "src");

/** The structure cache folder, or null when there is no folder this user alone controls (then nothing is cached on disk). */
export function structureCacheDir(): string | null {
	const chosen = process.env.ZN_STRUCT_CACHE;
	if (chosen) return chosen;
	// the shared temp folder (/tmp on Linux) holds one folder per user, created private; one that is someone else's is not used
	const base = privateDir(join(tmpdir(), `zn-gpui${process.getuid ? `-${process.getuid()}` : ""}`));
	return base && privateDir(join(base, "structure"));
}

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

// `id`: the size and content fingerprint of the PDF (a rotated or page-deleted file keeps its key but not its structure)
const fileOf = (dir: string, key: string, id: string, lib: PackLib) =>
	join(dir, `${key}.${id}.c${CONVERTER_VERSION}.p${lib.packVersion}.s${lib.schemaVersion}.json`);

function cacheRead(file: string | null): DocStructure | null {
	if (!file) return null;
	try {
		return JSON.parse(readFileSync(file, "utf8")) as DocStructure;
	} catch {
		return null;
	}
}
function cacheWrite(key: string, dir: string | null, file: string | null, doc: DocStructure): void {
	if (!dir || !file) return;
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		for (const f of readdirSync(dir)) if (f.startsWith(`${key}.`)) rmSync(join(dir, f), { force: true }); // stale contents / versions
		writeFileSync(file, JSON.stringify(doc), { mode: 0o600 });
	} catch (e) {
		console.warn("[structure] cache write failed:", (e as Error).message);
	}
}

let worker: DocumentWorker | null = null;
/** The worker to use: a fresh one when the last one died or never started (it never recovers by itself). */
function usableWorker(): DocumentWorker {
	if (worker && !worker.usable) {
		worker.terminate();
		worker = null;
	}
	return (worker ??= new DocumentWorker());
}
const remember = latestPerAttachment<DocStructure>();
const listeners = new Map<string, Set<(pct: number) => void>>();

async function build(key: string, pdf: Uint8Array, id: string): Promise<DocStructure> {
	const emit = (pct: number) => {
		for (const f of listeners.get(key) ?? []) f(pct);
	};
	emit(0);
	const lib = await pack();
	const dir = structureCacheDir();
	const file = dir && fileOf(dir, key, id, lib);
	const hit = cacheRead(file);
	if (hit) {
		emit(100);
		return hit;
	}

	const buf = pdf.slice().buffer as ArrayBuffer; // the worker takes (detaches) its copy
	const result = await usableWorker().query<{ buf?: ArrayBuffer }>(
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
	cacheWrite(key, dir, file, doc);
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
	// the structure of the file as it is NOW: the same attachment with other bytes (rotated, pages deleted) is built again
	const id = fingerprint(pdfBytes);
	return remember(attachmentKey, id, () =>
		build(attachmentKey, pdfBytes, id).finally(() => {
			listeners.delete(attachmentKey);
		}),
	);
}

/** Stop the document worker thread (the next load starts a fresh one). */
export function shutdownStructureWorker(): void {
	worker?.terminate();
	worker = null;
}
