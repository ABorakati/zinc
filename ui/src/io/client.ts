// Client for /api/io/* plus the import/export workflows (menus, dialogs).
// Mutating requests are JSON: the server's CSRF guard rejects other content types.
import { createSignal } from "solid-js";
import { toast } from "solid-sonner";
import { errMsg, fail } from "~/lib/actions";
import { store } from "~/store";

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

async function post<T>(path: string, body: unknown): Promise<T> {
	const res = await fetch("/api" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
	if (!res.ok) {
		let msg = res.statusText;
		try {
			msg = (await res.json()).error ?? msg;
		} catch {
			/* keep status text */
		}
		throw new Error(msg);
	}
	return (await res.json()) as T;
}

export const ioApi = {
	export: (b: { keys?: string[]; collectionKey?: string; format: ExportFormat; includeNotes?: boolean }) => post<ExportResult>("/io/export", b),
	import: (b: { text: string; format?: string; collectionName?: string | null; collectionKey?: string }) => post<ImportResult>("/io/import", b),
};

// ---------------------------------------------------------------- export dialog state

export type ExportTarget =
	| { kind: "items"; keys: string[] }
	| { kind: "collection"; collectionKey: string; name: string };
export const [exportTarget, setExportTarget] = createSignal<ExportTarget | null>(null);

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Hand text to the browser as a file download. */
export function downloadText(filename: string, text: string, contentType: string) {
	const url = URL.createObjectURL(new Blob([text], { type: contentType }));
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function runExport(target: ExportTarget, format: ExportFormat, includeNotes: boolean): Promise<boolean> {
	const id = toast.loading("Exporting…");
	try {
		const r = await ioApi.export({
			...(target.kind === "items" ? { keys: target.keys } : { collectionKey: target.collectionKey }),
			format,
			includeNotes,
		});
		downloadText(r.filename, r.text, r.contentType);
		toast.success(`Exported ${plural(r.count, "item")}`, { id, description: r.filename });
		return true;
	} catch (e) {
		toast.dismiss(id);
		fail("Export failed", e);
		return false;
	}
}

// ---------------------------------------------------------------- import

const stripExt = (name: string) => name.replace(/\.[^./\\]+$/, "");

/** Import text (a file's contents or the clipboard). The new collection is named after the file. */
export async function runImport(text: string, collectionName: string) {
	const id = toast.loading("Importing…");
	try {
		const r = await ioApi.import({ text, format: "auto", collectionName });
		store.bumpItems();
		store.refetchCollections();
		const parts = [`Imported ${plural(r.created, "item")}`];
		if (r.skipped) parts.push(`${r.skipped} already in the library`);
		const description = r.errors.length ? `${plural(r.errors.length, "problem")}: ${r.errors[0]}` : r.collectionKey ? `Added to the collection "${collectionName}"` : undefined;
		const opts = { id, description, duration: r.errors.length ? 10_000 : 5000 };
		if (r.errors.length && r.created === 0 && r.skipped === 0) toast.error("Nothing imported", opts);
		else if (r.errors.length) toast.warning(parts.join(", "), opts);
		else toast.success(parts.join(", "), opts);
		if (r.collectionKey && r.created > 0) store.setView({ kind: "collection", key: r.collectionKey });
	} catch (e) {
		toast.dismiss(id);
		fail("Import failed", e);
	}
}

/** Tools > Import…: pick a file, read it in the browser, send the text. */
export function pickAndImport() {
	const input = document.createElement("input");
	input.type = "file";
	input.accept = ".bib,.bibtex,.ris,.json,.nbib,.xml,.txt,.enw,text/plain,application/json,application/xml,text/xml";
	input.multiple = true;
	input.onchange = async () => {
		for (const file of [...(input.files ?? [])]) {
			try {
				await runImport(await file.text(), stripExt(file.name));
			} catch (e) {
				fail(`Could not read ${file.name}`, e);
			}
		}
	};
	input.click();
}

export async function importFromClipboard() {
	let text = "";
	try {
		text = await navigator.clipboard.readText();
	} catch (e) {
		return void fail("Could not read the clipboard", e);
	}
	if (!text.trim()) return void toast.info("The clipboard is empty");
	await runImport(text, `Clipboard import ${new Date().toISOString().slice(0, 10)}`);
}

export { errMsg };
