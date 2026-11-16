// Export of the browser library: one zip with library.sqlite (a consistent copy, made between two requests: the worker answers one at a
// time) and storage/<KEY>/<file> for every attachment folder in the durable file store. Runs in db-worker.ts (import-run.ts routes to it).
//
// In the copy, the attachment paths are rewritten from this browser's own /opfs/zinc/storage/<KEY>/<name> to "attachments:storage/<KEY>/<name>",
// Zinc's relative form, so they mean something outside the browser: unzip, keep library.sqlite and storage/ together, and set that
// folder as the attachment base folder. The browser import reads the same form back (import-run.ts relocateFiles uses KEY and file name).
import type { Database as CoreDb } from "bun:sqlite";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { strToU8, zipSync, type Zippable } from "fflate";
import { Database, forgetDatabase, registerDatabase } from "../sqlite";

const STORAGE = "/opfs/zinc/storage";
const PREFIX = `${STORAGE}/`;

export interface ExportSummary {
	items: number;
	collections: number;
	attachments: number;
	files: number;
	fileBytes: number;
	databaseBytes: number;
	serializeMs: number;
	zipMs: number;
	totalMs: number;
}

/** Every file under `dir` (paths relative to it, as the file store reports them, in the case they were written with). */
function walk(dir: string, rel = ""): string[] {
	const out: string[] = [];
	for (const e of readdirSync(`${dir}${rel}`, { withFileTypes: true }) as { name: string; isDirectory(): boolean }[]) {
		const r = `${rel}/${e.name}`;
		if (e.isDirectory()) out.push(...walk(dir, r));
		else out.push(r.slice(1));
	}
	return out;
}

export function exportLibraryZip(db: CoreDb): { bytes: Uint8Array; summary: ExportSummary } {
	// a consistent copy of the library: serialize() reads every page in one call; no write can interleave
	const t0 = performance.now();
	const image = (db as unknown as { serialize(): Uint8Array }).serialize();
	const serializeMs = Math.round(performance.now() - t0);
	const tmp = `/export/${Date.now()}.sqlite`;
	registerDatabase(tmp, image);
	const copy = new Database(tmp) as unknown as CoreDb;
	let database: Uint8Array;
	const counts = { items: 0, collections: 0, attachments: 0 };
	// the original-case names of the files the library points at (for a file store that predates case-preserving names)
	const names = new Map<string, string>();
	try {
		const rows = copy.query("SELECT item_key AS key, path FROM attachments WHERE path LIKE ?").all(`${PREFIX}%`) as {
			key: string;
			path: string;
		}[];
		for (const r of rows) names.set(r.path.slice(PREFIX.length).toLowerCase(), r.path.slice(PREFIX.length));
		const hasFlags = !!copy.query("SELECT 1 FROM sqlite_master WHERE name = 'sync_flags'").get();
		if (hasFlags) copy.exec("INSERT OR IGNORE INTO sync_flags(name) VALUES('suppress')");
		copy.query("UPDATE attachments SET path = 'attachments:storage/' || substr(path, ?) WHERE path LIKE ?").run(
			PREFIX.length + 1,
			`${PREFIX}%`,
		);
		if (hasFlags) copy.exec("DELETE FROM sync_flags WHERE name = 'suppress'");
		counts.items = (copy.query("SELECT count(*) AS n FROM items").get() as { n: number }).n;
		counts.collections = (copy.query("SELECT count(*) AS n FROM collections").get() as { n: number }).n;
		counts.attachments = (copy.query("SELECT count(*) AS n FROM attachments").get() as { n: number }).n;
		database = copy.serialize();
	} finally {
		copy.close();
		forgetDatabase(tmp);
	}

	const entries: Zippable = {};
	entries["library.sqlite"] = [database, { level: 6 }];
	let files = 0;
	let fileBytes = 0;
	if (existsSync(STORAGE) && statSync(STORAGE).isDirectory()) {
		const keys = new Map<string, string>(); // lower-case folder -> KEY as the rows spell it
		for (const orig of names.values()) {
			const k = orig.split("/")[0]!;
			keys.set(k.toLowerCase(), k);
		}
		for (const rel of walk(STORAGE)) {
			const lower = rel.toLowerCase();
			const key = rel.split("/")[0]!;
			// the file store keeps the case it was written with; a library from before that is all lower-case, so fall back to the rows' spelling
			const orig =
				rel !== lower
					? rel
					: (names.get(lower) ?? `${keys.get(key.toLowerCase()) ?? key.toUpperCase()}/${rel.slice(key.length + 1)}`);
			const bytes = readFileSync(`${STORAGE}/${rel}`) as Uint8Array;
			// attachments are mostly PDFs, EPUBs and images: already compressed
			entries[`storage/${orig}`] = [new Uint8Array(bytes), { level: 0 }];
			files++;
			fileBytes += bytes.length;
		}
	}
	entries["README.txt"] = strToU8(
		[
			"A Zinc library exported from the browser.",
			"",
			"library.sqlite   the library (items, collections, tags, notes, annotations).",
			"storage/         the attachment files, one folder per attachment: storage/<KEY>/<file>.",
			"",
			"Attachment paths in library.sqlite are relative (attachments:storage/<KEY>/<file>). To use the library in the Zinc desktop app, keep",
			"library.sqlite and storage/ in one folder and set that folder as the attachment base folder (Settings > Files and folders).",
			"To bring it back into a browser, use Import a Zotero or Zinc data folder on the welcome screen of an empty library.",
			"",
		].join("\n"),
	);
	const t1 = performance.now();
	const bytes = zipSync(entries);
	return {
		bytes,
		summary: {
			...counts,
			files,
			fileBytes,
			databaseBytes: database.length,
			serializeMs,
			zipMs: Math.round(performance.now() - t1),
			totalMs: Math.round(performance.now() - t0),
		},
	};
}
