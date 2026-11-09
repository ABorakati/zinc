// Client for /api/add/* plus the add-items workflows (shared by dialogs, menus and the retrieve panel).
// Files are added by absolute path (the core copies them into its storage), so nothing is read into this process.
import { dirname } from "node:path";
import { createSignal } from "solid-js";
import { get, post } from "../http";
import { getPref } from "../prefs";
import { pickPaths } from "../platform";
import { currentCollection, refresh, selectMany, selectOnly } from "../shared";
import { baseName, errMsg, plural, stripExt } from "../text";
import type { ItemDetail } from "../types";
import { toast } from "../../ui";
import { store } from "../../store";
import { focusTitle } from "../../itempane/focus";
import { autoAttachPdfs, autoTag, setAutoAttachPdfs, setAutoTag } from "../../settings/generalPrefs";
import { collectionAt } from "../../sidebar/Collections";
import { runImport } from "../io/client";
import { findFullText } from "../fulltext/jobs";

export { autoAttachPdfs, autoTag, setAutoAttachPdfs, setAutoTag };

export interface IdentifierResult {
	added: ItemDetail[];
	failed: { id: string; error: string }[];
	existing: { id: string; key: string }[];
}
export interface RetrieveResult {
	attachmentKey: string;
	status: "retrieved" | "existing" | "failed";
	itemKey?: string;
	error?: string;
}
export interface CreateParentResult {
	parent: ItemDetail;
	/** the attachment or note, now a child of the parent */
	item: ItemDetail;
}

/** The library on screen when it is a group (My Library is the core's default): new top-level items go there. */
const library = (): number | undefined => (store.libraryId() > 1 ? store.libraryId() : undefined);

export const addApi = {
	identifier: (text: string, collectionKey?: string, autoTag?: boolean) => post<IdentifierResult>("/api/add/identifier", { text, collectionKey, autoTag, library: library() }),
	file: (b: { name?: string; contentType?: string; path: string; mode?: "imported_file" | "linked_file"; parentKey?: string; collectionKey?: string }) =>
		post<ItemDetail>("/api/add/file", { name: "", library: library(), ...b }),
	link: (b: { url: string; title?: string; parentKey?: string; collectionKey?: string }) => post<ItemDetail>("/api/add/link", { library: library(), ...b }),
	retrieve: (attachmentKeys: string[], opts?: { rename?: boolean; autoTag?: boolean }) => post<{ results: RetrieveResult[]; items: ItemDetail[] }>("/api/add/retrieve-metadata", { attachmentKeys, ...opts }),
	createItem: (data: Record<string, unknown>) => post<ItemDetail>("/api/items", { data, library: data.parentItem ? undefined : library() }),
	duplicate: (key: string) => post<ItemDetail>(`/api/items/${encodeURIComponent(key)}/duplicate`, {}),
	createParent: (b: { itemKey: string; text?: string; itemType?: string }) => post<CreateParentResult>("/api/add/create-parent", b),
};

/** "Automatically retrieve metadata for PDFs" (Settings > General in the web UI; stored here until the settings page owns it). */
export const autoRetrieveMetadata = (): boolean => getPref("features.additems.autoRetrieve", true);

const fail = (what: string, e: unknown) => toast(what, { kind: "error", description: errMsg(e) });

// ---------------------------------------------------------------- workflows

export async function addByIdentifier(text: string): Promise<IdentifierResult | null> {
	toast("Looking up identifiers…", { durationMs: 2500 });
	try {
		const r = await addApi.identifier(text, currentCollection(), autoTag());
		refresh();
		const parts = [
			r.added.length ? `Added ${plural(r.added.length, "item")}` : "",
			r.existing.length ? `${r.existing.length} already in library` : "",
			r.failed.length ? `${r.failed.length} failed` : "",
		].filter(Boolean);
		const description = r.failed.map((f) => `${f.id}: ${f.error}`).join("\n") || undefined;
		if (r.added.length) toast(parts.join(", "), { kind: "success", description });
		else if (r.existing.length && !r.failed.length) toast(parts.join(", "), { kind: "info" });
		else toast(parts.join(", ") || "Nothing added", { kind: "error", description });
		if (r.added.length) selectOnly(r.added[0]!.data.key);
		else if (r.existing.length) selectOnly(r.existing[0]!.key);
		if (r.added.length && autoAttachPdfs()) {
			findFullText(r.added.map((item) => item.data.key));
		}
		return r;
	} catch (e) {
		fail("Could not add by identifier", e);
		return null;
	}
}

export async function createNewItem(itemType: string): Promise<void> {
	try {
		const coll = currentCollection();
		const d = await addApi.createItem({ itemType, ...(coll ? { collections: [coll] } : {}) });
		refresh();
		selectOnly(d.data.key);
	} catch (e) {
		fail("Could not create item", e);
	}
}

export async function createNote(parentKey?: string): Promise<void> {
	try {
		const coll = currentCollection();
		const d = await addApi.createItem({ itemType: "note", note: "", ...(parentKey ? { parentItem: parentKey } : coll ? { collections: [coll] } : {}) });
		refresh();
		selectOnly(parentKey ?? d.data.key);
	} catch (e) {
		fail("Could not create note", e);
	}
}

/**
 * "Duplicate Item": a copy of each item (item type, fields, creators, tags, collections, relations; no attachments, notes or
 * annotations), then the copies are selected. With one copy its title opens for editing, as in Zotero.
 */
export async function duplicateItems(keys: string[]): Promise<void> {
	if (!keys.length) return;
	const made: string[] = [];
	const errors: string[] = [];
	for (const key of keys) {
		try {
			made.push((await addApi.duplicate(key)).data.key);
		} catch (e) {
			errors.push(errMsg(e));
		}
	}
	if (errors.length) toast(keys.length > 1 ? "Some items could not be duplicated" : "Could not duplicate the item", { kind: "error", description: errors.join("\n") });
	if (!made.length) return;
	refresh();
	selectMany(made);
	if (made.length === 1) focusTitle(made[0]!);
}

/**
 * "Create Parent Item" (the dialog's Create button): the parent comes from an identifier or is empty of the chosen type, and
 * the attachment or note moves under it. Throws so the dialog can show why the lookup failed.
 */
export async function createParentFor(itemKey: string, choice: { text?: string; itemType?: string }): Promise<void> {
	const r = await addApi.createParent({ itemKey, ...choice });
	refresh();
	selectOnly(r.parent.data.key);
	focusTitle(r.parent.data.key);
}

const isPdfPath = (p: string) => /\.pdf$/i.test(p);

/** Import files (stored copies) with progress toasts; standalone PDFs then get "Retrieve Metadata" in the background when the preference is on. */
export async function importPaths(paths: string[], opts: { parentKey?: string; retrieve?: boolean; collectionKey?: string } = {}): Promise<void> {
	if (!paths.length) return;
	toast(`Importing ${plural(paths.length, "file")}…`, { durationMs: 2500 });
	const pdfs: { key: string; title: string }[] = [];
	const errors: string[] = [];
	let last: ItemDetail | null = null;
	for (const path of paths) {
		const name = path.split(/[\\/]/).pop() ?? path;
		try {
			const d = await addApi.file({ path, mode: "imported_file", parentKey: opts.parentKey, collectionKey: opts.parentKey ? undefined : (opts.collectionKey ?? currentCollection()) });
			last = d;
			if (isPdfPath(path) && !opts.parentKey) pdfs.push({ key: d.data.key, title: name });
		} catch (e) {
			errors.push(`${name}: ${errMsg(e)}`);
		}
	}
	refresh();
	if (pdfs.length > 0 && opts.retrieve !== false && autoRetrieveMetadata()) enqueueRetrieve(pdfs);
	else if (last) selectOnly(opts.parentKey ?? last.data.key);
	const msg = `Imported ${plural(paths.length - errors.length, "file")}`;
	if (errors.length) toast(msg, { kind: "error", description: errors.join("\n") });
	else toast(msg, { kind: "success" });
}

/** Add Attachment > Stored File…: native file picker, then import. */
export async function pickAndImport(parentKey?: string): Promise<void> {
	const paths = await pickPaths({ files: true, multiple: true, prompt: "Add" });
	if (paths) await importPaths(paths, { parentKey });
}
const IMPORTER_EXTS = /\.(bib|bibtex|ris|rdf|json)$/i;

/** Handle file drops anywhere on the window or onto a sidebar collection. */
export async function handleFileDrop(paths: string[], target?: { x?: number; y?: number; collectionKey?: string }): Promise<void> {
	if (!paths.length) return;
	const colKey = target?.collectionKey ?? (target?.x !== undefined && target?.y !== undefined ? collectionAt(target.x, target.y) : null) ?? currentCollection();

	const importerPaths: string[] = [];
	const attachmentPaths: string[] = [];
	for (const p of paths) {
		if (IMPORTER_EXTS.test(p)) importerPaths.push(p);
		else attachmentPaths.push(p);
	}

	for (const p of importerPaths) {
		try {
			const text = await Bun.file(p).text();
			await runImport(text, stripExt(baseName(p)), colKey ?? undefined, dirname(p)); // the folder: RDF attachment paths resolve against it
		} catch (e) {
			toast(`Could not read ${baseName(p)}`, { kind: "error", description: errMsg(e) });
		}
	}

	if (attachmentPaths.length > 0) {
		await importPaths(attachmentPaths, { collectionKey: colKey ?? undefined });
	}
}


export async function addLinkedFile(path: string, parentKey?: string): Promise<boolean> {
	const p = path.trim().replace(/^"|"$/g, "");
	try {
		const d = await addApi.file({ mode: "linked_file", path: p, parentKey, collectionKey: parentKey ? undefined : currentCollection() });
		refresh();
		if (!parentKey && isPdfPath(p) && autoRetrieveMetadata()) enqueueRetrieve([{ key: d.data.key, title: String(d.data.filename || d.data.title || p) }]);
		else selectOnly(parentKey ?? d.data.key);
		toast("Linked file added", { kind: "success" });
		return true;
	} catch (e) {
		fail("Could not link file", e);
		return false;
	}
}

export async function addLinkedUri(url: string, title: string, parentKey?: string): Promise<boolean> {
	try {
		const d = await addApi.link({ url: url.trim(), title: title.trim() || undefined, parentKey, collectionKey: parentKey ? undefined : currentCollection() });
		refresh();
		selectOnly(parentKey ?? d.data.key);
		toast("Link added", { kind: "success" });
		return true;
	} catch (e) {
		fail("Could not add link", e);
		return false;
	}
}

// ---------------------------------------------------------------- Retrieve Metadata for PDF (one shared queue + panel)

export type RetrieveRowState = "queued" | "running" | "retrieved" | "existing" | "failed";
export interface RetrieveRow {
	key: string;
	title: string;
	state: RetrieveRowState;
	message?: string;
	itemKey?: string;
}
const [retrieveRows, setRetrieveRows] = createSignal<RetrieveRow[]>([]);
export { retrieveRows };
export const retrieveActive = () => retrieveRows().some((r) => r.state === "queued" || r.state === "running");
export const dismissRetrieve = () => {
	if (!retrieveActive()) setRetrieveRows([]);
};
let draining = false;
let dismissTimer: ReturnType<typeof setTimeout> | undefined;

const patchRow = (key: string, p: Partial<RetrieveRow>) => setRetrieveRows((l) => l.map((r) => (r.key === key ? { ...r, ...p } : r)));

/** Queue standalone PDF attachments for recognition; rows show in the panel (RetrievePanel). */
export function enqueueRetrieve(items: { key: string; title?: string }[]): void {
	clearTimeout(dismissTimer);
	const fresh = items.filter((i, n) => items.findIndex((j) => j.key === i.key) === n);
	setRetrieveRows((l) => {
		const keep = l.some((r) => r.state === "queued" || r.state === "running") ? l : []; // a finished run is replaced
		const have = new Set(keep.map((r) => r.key));
		return [...keep, ...fresh.filter((i) => !have.has(i.key)).map((i): RetrieveRow => ({ key: i.key, title: i.title ?? i.key, state: "queued" }))];
	});
	for (const i of fresh) {
		if (i.title) continue;
		detail(i.key).then((d) => patchRow(i.key, { title: String(d.data.filename || d.data.title || i.key) })).catch(() => {});
	}
	void drainRetrieve();
}

async function drainRetrieve(): Promise<void> {
	if (draining) return;
	draining = true;
	const batch = new Set<string>();
	try {
		for (;;) {
			const next = retrieveRows().find((r) => r.state === "queued");
			if (!next) break;
			batch.add(next.key);
			patchRow(next.key, { state: "running" });
			try {
				const r = (await addApi.retrieve([next.key], { autoTag: autoTag() })).results[0];
				if (r && r.status !== "failed") patchRow(next.key, { state: r.status, itemKey: r.itemKey, message: r.status === "existing" ? "Attached to an item already in the library" : undefined });
				else patchRow(next.key, { state: "failed", message: r?.error ?? "Not found" });
				refresh();
			} catch (e) {
				patchRow(next.key, { state: "failed", message: errMsg(e) });
			}
		}
	} finally {
		draining = false;
	}
	const first = retrieveRows().find((r) => batch.has(r.key) && r.itemKey);
	if (first?.itemKey) selectOnly(first.itemKey);
	if (retrieveRows().every((r) => r.state === "retrieved" || r.state === "existing")) dismissTimer = setTimeout(dismissRetrieve, 8000);
}

export async function retrieveMetadata(attachmentKeys: string[]): Promise<void> {
	const ok: string[] = [];
	for (const k of attachmentKeys) if ((await isStandalonePdf(k)) !== false) ok.push(k);
	if (!ok.length) return void toast("Select standalone PDF attachments to retrieve their metadata", { kind: "info" });
	enqueueRetrieve(ok.map((key) => ({ key })));
}

// ---------------------------------------------------------------- which top-level items are standalone PDFs

const details = new Map<string, Promise<ItemDetail>>();
const detail = (key: string): Promise<ItemDetail> => {
	let p = details.get(key);
	if (!p) {
		p = get<ItemDetail>(`/api/items/${encodeURIComponent(key)}`);
		p.catch(() => details.delete(key));
		details.set(key, p);
	}
	return p;
};

/** true when the key is a standalone PDF attachment, false when not, undefined when it could not be read. */
export async function isStandalonePdf(key: string): Promise<boolean | undefined> {
	try {
		const d = await detail(key);
		return d.data.itemType === "attachment" && !d.data.parentItem && (/pdf/i.test(String(d.data.contentType ?? "")) || /\.pdf$/i.test(String(d.data.filename ?? "")));
	} catch {
		return undefined;
	}
}

/** Screenshot / test hook: replace the Retrieve Metadata rows. */
export const _seedRetrieveRows = setRetrieveRows;
