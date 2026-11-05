// Client for /api/io/* plus the import/export workflows (menus, dialogs). Export writes the file into a folder chosen with the
// native folder picker (GPUIX has no save-file dialog yet); import reads the chosen files here and posts their text.
import { createSignal } from "solid-js";
import { basename, dirname, join } from "node:path";
import { get, post } from "../http";
import { pickPaths, readClipboardText } from "../platform";
import { persisted } from "../prefs";
import { refresh, setView } from "../shared";
import { errMsg, plural, stripExt } from "../text";
import { toast } from "../../ui";
import { autoAttachPdfs, autoTag } from "../../settings/generalPrefs";
import { findFullText } from "../fulltext/jobs";
import { translateApi } from "../translate/client";
import { isUnrecognisedFormat } from "../translate/logic";
import { BBT_EXPORT_FORMATS, type BbtExportFormat } from "../bbt/formats";

export type ExportFormat = "bibtex" | "biblatex" | "ris" | "csljson" | "csv" | "rdf" | "mods" | BbtExportFormat;

export const EXPORT_FORMATS: { id: ExportFormat; label: string; hint: string }[] = [
	{ id: "bibtex", label: "BibTeX", hint: ".bib, for LaTeX" },
	{ id: "biblatex", label: "BibLaTeX", hint: ".bib, for biblatex" },
	{ id: "ris", label: "RIS", hint: ".ris, EndNote / Mendeley / Zotero" },
	{ id: "csljson", label: "CSL JSON", hint: ".json, for citation processors" },
	{ id: "csv", label: "CSV", hint: ".csv, spreadsheet columns as Zotero" },
	{ id: "rdf", label: "Zotero RDF", hint: ".rdf, items, notes and attachment files" },
	{ id: "mods", label: "MODS", hint: ".xml, library catalogue format" },
	...BBT_EXPORT_FORMATS,
];

export interface ExportResult { filename: string; contentType: string; text: string; count: number; path?: string; files?: number }
export interface ImportResult {
	created: number; skipped: number; errors: string[]; collectionKey: string | null; format: string;
	collections?: number; attachments?: number; itemKeys?: string[];
}

export interface MendeleyDatabase {
	path: string;
	account: string;
	sizeBytes: number;
	modified: string;
	encrypted: boolean;
	inUse: boolean;
}
export interface MendeleyResult extends ImportResult {
	format: "mendeley";
	collections: number;
	attachments: number;
	missingFiles: number;
}

export const ioApi = {
	export: (b: { keys?: string[]; collectionKey?: string; format: ExportFormat; includeNotes?: boolean; dir?: string }) =>
		post<ExportResult>("/api/io/export", b),
	import: (b: { text: string; format?: string; collectionName?: string | null; collectionKey?: string; autoTag?: boolean; basePath?: string }) =>
		post<ImportResult>("/api/io/import", b),
	mendeley: {
		list: () => get<{ databases: MendeleyDatabase[]; available: boolean }>("/api/io/mendeley"),
		import: (b: { path?: string; collectionName?: string | null; collectionKey?: string; linkFiles?: boolean }) =>
			post<MendeleyResult>("/api/io/mendeley", b),
	},
};

/** Defaults remembered between exports and edited in Settings > Export. */
export const [exportFormat, setExportFormat] = persisted<ExportFormat>("features.io.format", "bibtex", (v) => (EXPORT_FORMATS.some((f) => f.id === v) ? (v as ExportFormat) : undefined));
export const [exportNotes, setExportNotes] = persisted<boolean>("features.io.notes", false, (v) => (typeof v === "boolean" ? v : undefined));

export type ExportTarget =
	| { kind: "items"; keys: string[] }
	| { kind: "collection"; collectionKey: string; name: string };

const fail = (what: string, e: unknown) => toast(what, { kind: "error", description: errMsg(e) });
const [lastDir, setLastDir] = createSignal<string | undefined>(undefined);
export { lastDir };

/** Write text to a file in a folder the user picks. Resolves the written path, or null when cancelled. */
export async function saveTextToFolder(filename: string, text: string): Promise<string | null> {
	const dir = (await pickPaths({ directories: true, prompt: "Save here" }))?.[0];
	if (!dir) return null;
	const path = join(dir, filename);
	await Bun.write(path, text);
	setLastDir(dir);
	return path;
}

export async function runExport(target: ExportTarget, format: ExportFormat, includeNotes: boolean): Promise<boolean> {
	try {
		const scope = target.kind === "items" ? { keys: target.keys } : { collectionKey: target.collectionKey };
		// Zotero RDF also carries attachment files, so the core writes the file and copies them into the folder
		if (format === "rdf") {
			const dir = (await pickPaths({ directories: true, prompt: "Save here" }))?.[0];
			if (!dir) return false;
			const r = await ioApi.export({ ...scope, format, includeNotes, dir });
			setLastDir(dir);
			toast(`Exported ${plural(r.count, "item")}`, { description: r.files ? `${r.path} (+${plural(r.files, "file")})` : r.path });
			return true;
		}
		const r = await ioApi.export({ ...scope, format, includeNotes });
		const path = await saveTextToFolder(r.filename, r.text);
		if (!path) return false;
		toast(`Exported ${plural(r.count, "item")}`, { kind: "success", description: path });
		return true;
	} catch (e) {
		fail("Export failed", e);
		return false;
	}
}

/** Import text (a file's contents or the clipboard). The new collection is named after the file. */
export async function runImport(text: string, collectionName: string, collectionKey?: string, basePath?: string): Promise<ImportResult | null> {
	toast("Importing…", { durationMs: 2500 });
	try {
		const body = {
			text,
			format: "auto",
			collectionName: collectionKey ? null : collectionName,
			collectionKey: collectionKey || undefined,
			autoTag: autoTag(),
			basePath,
		};
		// auto-detect failed: let the Zotero translators try (keeps the original error when they cannot read it either)
		const r = await ioApi.import(body).catch(async (e) => {
			if (!isUnrecognisedFormat(errMsg(e))) throw e;
			try { return await translateApi.import({ text, collectionName: body.collectionName, collectionKey: body.collectionKey }); } catch { throw e; }
		});
		refresh();
		const parts = [`Imported ${plural(r.created, "item")}`];
		if (r.skipped) parts.push(`${r.skipped} already in the library`);
		if (r.attachments) parts.push(plural(r.attachments, "attachment"));
		const description = r.errors.length
			? `${plural(r.errors.length, "problem")}: ${r.errors[0]}`
			: r.collectionKey ? `Added to the collection "${collectionName}"` : undefined;
		if (r.errors.length && r.created === 0 && r.skipped === 0) toast("Nothing imported", { kind: "error", description });
		else toast(parts.join(", "), { kind: r.errors.length ? "info" : "success", description, durationMs: r.errors.length ? 10_000 : 5000 });
		if (r.collectionKey && r.created > 0 && !collectionKey) setView({ kind: "collection", key: r.collectionKey });
		if (r.created > 0 && autoAttachPdfs() && r.itemKeys?.length) {
			findFullText(r.itemKeys);
		}
		return r;
	} catch (e) {
		fail("Import failed", e);
		return null;
	}
}

/** Tools > Import…: pick files, read them, send the text. The folder rides along for RDF attachment files. */
export async function pickAndImport(): Promise<void> {
	const paths = await pickPaths({ files: true, multiple: true, prompt: "Import (BibTeX, RIS, CSL JSON, CSV, EndNote XML, RDF, MODS)" });
	if (!paths) return;
	for (const p of paths) {
		let text: string;
		try { text = await Bun.file(p).text(); } catch (e) { fail(`Could not read ${basename(p)}`, e); continue; }
		await runImport(text, stripExt(basename(p)), undefined, dirname(p));
	}
}

export async function importFromClipboard(): Promise<void> {
	let text = "";
	try { text = await readClipboardText(); } catch (e) { return void fail("Could not read the clipboard", e); }
	if (!text.trim()) return void toast("The clipboard is empty", { kind: "info" });
	await runImport(text, `Clipboard import ${new Date().toISOString().slice(0, 10)}`);
}

/** Tools > Import from Mendeley…: reads a Mendeley Desktop library (never the online Reference Manager). */
export async function importFromMendeley(path: string): Promise<boolean> {
	toast("Importing from Mendeley…", { durationMs: 2500 });
	try {
		const r = await ioApi.mendeley.import({ path, collectionName: "Mendeley" });
		refresh();
		const parts = [`Imported ${plural(r.created, "item")}`];
		if (r.skipped) parts.push(`${r.skipped} already in the library`);
		if (r.collections) parts.push(plural(r.collections, "collection"));
		if (r.attachments) parts.push(plural(r.attachments, "attachment"));
		if (r.missingFiles) parts.push(`${plural(r.missingFiles, "file")} not found on disk`);
		const description = r.errors.length ? `${plural(r.errors.length, "problem")}: ${r.errors[0]}` : "Added to the collection \"Mendeley\"";
		toast(parts.join(", "), { kind: r.errors.length ? "info" : "success", description, durationMs: r.errors.length ? 10_000 : 6000 });
		if (r.collectionKey) setView({ kind: "collection", key: r.collectionKey });
		return true;
	} catch (e) {
		fail("Mendeley import failed", e);
		return false;
	}
}
