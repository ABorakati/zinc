// Pure helpers of the first-run screen: how the importer's progress reads, and how a found Zotero library is described.

/** What core/src/import/zotero.ts reports through onProgress. */
export interface ImportProgress { phase: string; done?: number; total?: number; message?: string }

/** A Zotero data folder as the screen shows it (core/src/files/zotero-locate.ts DataDirInfo, trimmed). */
export interface ZoteroFound {
	dir: string;
	hasDatabase: boolean;
	readable: boolean;
	itemCount: number | null;
	collectionCount: number | null;
	attachmentCount: number | null;
	/** Zotero is open right now (a copy of its database is read, so that is fine, but worth saying). */
	running?: boolean;
	error?: string;
}

const n = (v: number) => v.toLocaleString("en-GB");
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;

/** Where each importer phase sits on the bar (0..1): the items phase is the long one and fills most of it. */
const PHASE_START: Record<string, number> = { snapshot: 0, read: 0.12, write: 0.18, files: 0.2, items: 0.2, annotations: 0.9, fulltext: 0.94 };

/** Overall progress, 0..1. */
export function progressFraction(p: ImportProgress | null): number {
	if (!p) return 0;
	const start = PHASE_START[p.phase] ?? 0;
	if (p.phase === "items" && p.total) return start + 0.7 * Math.min(1, (p.done ?? 0) / p.total);
	return start;
}

/** One line for the progress panel. */
export function progressText(p: ImportProgress | null): string {
	if (!p) return "Starting…";
	switch (p.phase) {
		case "snapshot": return "Copying your Zotero database (Zotero itself is not changed)…";
		case "read": return "Reading your items…";
		case "write": return "Creating the new library…";
		case "files": return "Looking for attachment files that moved…";
		case "items": return p.total ? `Importing items: ${n(p.done ?? 0)} of ${n(p.total)}` : "Importing items…";
		case "annotations": return "Importing annotations…";
		case "fulltext": return "Importing full-text caches…";
		default: return p.message ?? "Working…";
	}
}

/** "12,419 items, 310 collections and 9,882 attachments" or why Zotero's database cannot be used. */
export function describeZotero(z: ZoteroFound | null): string {
	if (!z) return "Zotero was not found on this computer.";
	if (!z.hasDatabase) return "There is no Zotero library in that folder.";
	if (!z.readable) return z.error ?? "That Zotero library could not be read.";
	const parts = [plural(z.itemCount ?? 0, "item")];
	if (z.collectionCount) parts.push(plural(z.collectionCount, "collection"));
	if (z.attachmentCount) parts.push(plural(z.attachmentCount, "attachment"));
	const last = parts.pop()!;
	return parts.length ? `${parts.join(", ")} and ${last}` : last;
}

/** Can an import start from this folder? */
export const canImport = (z: ZoteroFound | null): boolean => !!z && z.hasDatabase && z.readable;
