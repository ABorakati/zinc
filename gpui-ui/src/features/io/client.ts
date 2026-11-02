// Client for /api/io/* plus the import/export workflows (menus, dialogs). Export writes the file into a folder chosen with the
// native folder picker (GPUIX has no save-file dialog yet); import reads the chosen files here and posts their text.
import { createSignal } from "solid-js";
import { basename, join } from "node:path";
import { post } from "../http";
import { pickPaths, readClipboardText } from "../platform";
import { persisted } from "../prefs";
import { refresh, setView } from "../shared";
import { errMsg, plural, stripExt } from "../text";
import { toast } from "../../ui";

export type ExportFormat = "bibtex" | "biblatex" | "ris" | "csljson" | "csv";

export const EXPORT_FORMATS: { id: ExportFormat; label: string; hint: string }[] = [
	{ id: "bibtex", label: "BibTeX", hint: ".bib, for LaTeX" },
	{ id: "biblatex", label: "BibLaTeX", hint: ".bib, for biblatex" },
	{ id: "ris", label: "RIS", hint: ".ris, EndNote / Mendeley / Zotero" },
	{ id: "csljson", label: "CSL JSON", hint: ".json, for citation processors" },
	{ id: "csv", label: "CSV", hint: ".csv, spreadsheet columns as Zotero" },
];

export interface ExportResult { filename: string; contentType: string; text: string; count: number }
export interface ImportResult { created: number; skipped: number; errors: string[]; collectionKey: string | null; format: string }

export const ioApi = {
	export: (b: { keys?: string[]; collectionKey?: string; format: ExportFormat; includeNotes?: boolean }) => post<ExportResult>("/api/io/export", b),
	import: (b: { text: string; format?: string; collectionName?: string | null; collectionKey?: string }) => post<ImportResult>("/api/io/import", b),
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
		const r = await ioApi.export({
			...(target.kind === "items" ? { keys: target.keys } : { collectionKey: target.collectionKey }),
			format,
			includeNotes,
		});
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
export async function runImport(text: string, collectionName: string): Promise<void> {
	toast("Importing…", { durationMs: 2500 });
	try {
		const r = await ioApi.import({ text, format: "auto", collectionName });
		refresh();
		const parts = [`Imported ${plural(r.created, "item")}`];
		if (r.skipped) parts.push(`${r.skipped} already in the library`);
		const description = r.errors.length ? `${plural(r.errors.length, "problem")}: ${r.errors[0]}` : r.collectionKey ? `Added to the collection "${collectionName}"` : undefined;
		if (r.errors.length && r.created === 0 && r.skipped === 0) toast("Nothing imported", { kind: "error", description });
		else toast(parts.join(", "), { kind: r.errors.length ? "info" : "success", description, durationMs: r.errors.length ? 10_000 : 5000 });
		if (r.collectionKey && r.created > 0) setView({ kind: "collection", key: r.collectionKey });
	} catch (e) {
		fail("Import failed", e);
	}
}

/** Tools > Import…: pick files, read them, send the text. */
export async function pickAndImport(): Promise<void> {
	const paths = await pickPaths({ files: true, multiple: true, prompt: "Import" });
	if (!paths) return;
	for (const p of paths) {
		let text: string;
		try { text = await Bun.file(p).text(); } catch (e) { fail(`Could not read ${basename(p)}`, e); continue; }
		await runImport(text, stripExt(basename(p)));
	}
}

export async function importFromClipboard(): Promise<void> {
	let text = "";
	try { text = await readClipboardText(); } catch (e) { return void fail("Could not read the clipboard", e); }
	if (!text.trim()) return void toast("The clipboard is empty", { kind: "info" });
	await runImport(text, `Clipboard import ${new Date().toISOString().slice(0, 10)}`);
}
