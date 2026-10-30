// Client for /api/add/* plus the add-items workflows (shared by dialogs, menus and drag-and-drop).
// Uploads are JSON ({name, contentType, dataBase64}) because the server's CSRF guard only accepts application/json.
import { createSignal } from "solid-js";
import { toast } from "solid-sonner";
import type { ItemDetail } from "~/api";
import { errMsg, fail } from "~/lib/actions";
import { store } from "~/store";

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

export const addApi = {
	identifier: (text: string, collectionKey?: string) => post<IdentifierResult>("/add/identifier", { text, collectionKey }),
	file: (b: { name: string; contentType?: string; dataBase64?: string; path?: string; mode?: "imported_file" | "linked_file"; parentKey?: string; collectionKey?: string }) =>
		post<ItemDetail>("/add/file", b),
	link: (b: { url: string; title?: string; parentKey?: string; collectionKey?: string }) => post<ItemDetail>("/add/link", b),
	retrieve: (attachmentKeys: string[]) => post<{ results: RetrieveResult[]; items: ItemDetail[] }>("/add/retrieve-metadata", { attachmentKeys }),
	createItem: (data: Record<string, unknown>) => post<ItemDetail>("/items", { data }),
};

// ---------------------------------------------------------------- dialog state

export type DialogState =
	| { kind: "identifier"; text?: string }
	| { kind: "newItem" }
	| { kind: "linkFile"; parentKey?: string }
	| { kind: "linkUri"; parentKey?: string }
	| null;
export const [dialog, setDialog] = createSignal<DialogState>(null);

// ---------------------------------------------------------------- helpers

export const currentCollection = (): string | undefined => {
	const v = store.view();
	return v.kind === "collection" ? v.key : undefined;
};

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function refresh() {
	store.bumpItems();
	store.refetchCollections();
}

function readBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const r = new FileReader();
		r.onerror = () => reject(r.error ?? new Error("could not read the file"));
		r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(",") + 1));
		r.readAsDataURL(file);
	});
}

const isPdf = (f: File) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);

// ---------------------------------------------------------------- workflows

export async function addByIdentifier(text: string): Promise<IdentifierResult | null> {
	const id = toast.loading("Looking up identifiers…");
	try {
		const r = await addApi.identifier(text, currentCollection());
		refresh();
		const parts = [r.added.length ? `Added ${plural(r.added.length, "item")}` : "", r.existing.length ? `${r.existing.length} already in library` : "", r.failed.length ? `${r.failed.length} failed` : ""].filter(Boolean);
		const desc = r.failed.map((f) => `${f.id}: ${f.error}`).join("\n") || undefined;
		if (r.added.length) toast.success(parts.join(", "), { id, description: desc });
		else if (r.existing.length && !r.failed.length) toast.info(parts.join(", "), { id });
		else toast.error(parts.join(", ") || "Nothing added", { id, description: desc });
		if (r.added.length) store.selectOnly(r.added[0].data.key);
		else if (r.existing.length) store.selectOnly(r.existing[0].key);
		return r;
	} catch (e) {
		toast.dismiss(id);
		fail("Could not add by identifier", e);
		return null;
	}
}

export async function createNewItem(itemType: string): Promise<void> {
	try {
		const coll = currentCollection();
		const d = await addApi.createItem({ itemType, ...(coll ? { collections: [coll] } : {}) });
		refresh();
		store.selectOnly(d.data.key);
	} catch (e) {
		fail("Could not create item", e);
	}
}

export async function createNote(parentKey?: string): Promise<void> {
	try {
		const coll = currentCollection();
		const d = await addApi.createItem({ itemType: "note", note: "", ...(parentKey ? { parentItem: parentKey } : coll ? { collections: [coll] } : {}) });
		refresh();
		if (parentKey) {
			store.selectOnly(parentKey);
			store.setActiveKey(d.data.key);
		} else store.selectOnly(d.data.key);
	} catch (e) {
		fail("Could not create note", e);
	}
}

/** Import files (stored copies) with a progress toast; PDFs without a parent then get "Retrieve Metadata". */
export async function importFiles(files: File[], opts: { parentKey?: string; retrieve?: boolean } = {}): Promise<void> {
	if (!files.length) return;
	const id = toast.loading(`Importing ${plural(files.length, "file")}…`);
	const pdfKeys: string[] = [];
	const errors: string[] = [];
	let done = 0;
	let last: ItemDetail | null = null;
	for (const f of files) {
		toast.loading(`Importing ${f.name} (${++done}/${files.length})…`, { id });
		try {
			const d = await addApi.file({ name: f.name, contentType: f.type, dataBase64: await readBase64(f), mode: "imported_file", parentKey: opts.parentKey, collectionKey: opts.parentKey ? undefined : currentCollection() });
			last = d;
			if (isPdf(f) && !opts.parentKey) pdfKeys.push(d.data.key);
		} catch (e) {
			errors.push(`${f.name}: ${errMsg(e)}`);
		}
	}
	refresh();
	let retrieved = 0;
	if (pdfKeys.length && opts.retrieve !== false) {
		toast.loading(`Retrieving metadata for ${plural(pdfKeys.length, "PDF")}…`, { id });
		try {
			const r = await addApi.retrieve(pdfKeys);
			retrieved = r.results.filter((x) => x.status !== "failed").length;
			refresh();
			const first = r.results.find((x) => x.itemKey);
			if (first?.itemKey) store.selectOnly(first.itemKey);
		} catch (e) {
			errors.push(`metadata: ${errMsg(e)}`);
		}
	} else if (last) store.selectOnly(last.data.key);
	const ok = files.length - errors.filter((e) => !e.startsWith("metadata:")).length;
	const msg = `Imported ${plural(ok, "file")}` + (pdfKeys.length ? `, identified ${retrieved}/${pdfKeys.length} PDF${pdfKeys.length === 1 ? "" : "s"}` : "");
	if (errors.length) toast.error(msg, { id, description: errors.join("\n") });
	else toast.success(msg, { id });
}

export async function retrieveMetadata(attachmentKeys: string[]): Promise<void> {
	const id = toast.loading(`Retrieving metadata for ${plural(attachmentKeys.length, "PDF")}…`);
	try {
		const r = await addApi.retrieve(attachmentKeys);
		refresh();
		const ok = r.results.filter((x) => x.status !== "failed");
		const bad = r.results.filter((x) => x.status === "failed");
		const first = ok.find((x) => x.itemKey);
		if (first?.itemKey) store.selectOnly(first.itemKey);
		if (bad.length) toast.error(`Retrieved ${ok.length}/${r.results.length}`, { id, description: bad.map((b) => b.error).join("\n") });
		else toast.success(`Retrieved metadata for ${plural(ok.length, "PDF")}`, { id });
	} catch (e) {
		toast.dismiss(id);
		fail("Could not retrieve metadata", e);
	}
}

export function pickFiles(onFiles: (files: File[]) => void): void {
	const input = document.createElement("input");
	input.type = "file";
	input.multiple = true;
	input.onchange = () => onFiles([...(input.files ?? [])]);
	input.click();
}

export async function addLinkedFile(path: string, parentKey?: string): Promise<boolean> {
	try {
		const d = await addApi.file({ mode: "linked_file", path: path.trim().replace(/^"|"$/g, ""), name: "", parentKey, collectionKey: parentKey ? undefined : currentCollection() });
		refresh();
		store.selectOnly(parentKey ?? d.data.key);
		toast.success("Linked file added");
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
		store.selectOnly(parentKey ?? d.data.key);
		toast.success("Link added");
		return true;
	} catch (e) {
		fail("Could not add link", e);
		return false;
	}
}

/** True when the pasted text is only DOIs / PMIDs / arXiv IDs / ISBNs (cheap client-side screen). */
export function looksLikeIdentifiers(text: string): boolean {
	const toks = text.trim().split(/[\s,;]+/).filter(Boolean);
	if (!toks.length || toks.length > 50) return false;
	return toks.every((t) =>
		/^(doi:)?(https?:\/\/(dx\.)?doi\.org\/)?10\.\d{4,9}\/\S+$/i.test(t) ||
		/^(pmid:?)?\d{6,8}$/i.test(t) ||
		/^pmc\d+$/i.test(t) ||
		/^(arxiv:)?\d{4}\.\d{4,5}(v\d+)?$/i.test(t) ||
		/^(isbn:?)?[\d-]{10,17}x?$/i.test(t) ||
		/^https?:\/\/(arxiv\.org\/abs\/|pubmed\.ncbi\.nlm\.nih\.gov\/)\S+$/i.test(t),
	);
}
