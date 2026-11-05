// What the list does with items: open (reader tab / browser / default app), cite, find full text, star, trash, collections.
// Ported from ui/src/itemopen.ts, ui/src/lib/{actions,fulltext}.ts and ui/src/cards/{tags,Card}.tsx, over the core API.
import { api, type ChildSummary, type ItemDetail } from "../api";
import type { ItemRow } from "../contracts";
import { copyRich } from "../features/platform";
import { store } from "../store";
import { toast } from "../ui";
import { doiUrl, isRegular, plural, STAR_TAG, webUrl } from "./logic";
import { fieldOf } from "../table/defs";

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const fail = (what: string, e: unknown) => toast(what, { kind: "error", description: errMsg(e) });

// ---- detail cache (item detail carries the children); per key until store.itemsRev changes ----
let cacheRev = -1;
const details = new Map<string, Promise<ItemDetail>>();
const resolved = new Map<string, ItemDetail>();
export function getDetail(key: string): Promise<ItemDetail> {
	const rev = store.itemsRev();
	if (rev !== cacheRev) { details.clear(); resolved.clear(); cacheRev = rev; }
	let p = details.get(key);
	if (!p) {
		p = api.item(key);
		details.set(key, p);
		p.then((d) => { if (details.get(key) === p) resolved.set(key, d); }, () => { if (details.get(key) === p) details.delete(key); });
	}
	return p;
}
/** The detail if it has already loaded (menus are built synchronously, so they prefetch on hover). */
export const peekDetail = (key: string): ItemDetail | undefined => (cacheRev === store.itemsRev() ? resolved.get(key) : undefined);

// ---- children (attachments / notes) ----
export type ChildKind = "reader" | "url" | "file" | "note" | "none";
const isReaderType = (ct: string | null | undefined) => /pdf|epub|html/i.test(ct ?? "");
export function childKind(c: ChildSummary): ChildKind {
	if (c.itemType === "note") return "note";
	if (c.linkMode === "linked_url") return "url";
	if (!c.hasFile) return "none";
	return isReaderType(c.contentType) ? "reader" : "file";
}
/** lucide name */
export function childIcon(c: ChildSummary): string {
	if (c.itemType === "note") return "sticky-note";
	if (c.linkMode === "linked_url") return "link";
	if (/pdf/i.test(c.contentType ?? "")) return "file-text";
	if (/epub/i.test(c.contentType ?? "")) return "book-open";
	if (/html/i.test(c.contentType ?? "")) return "globe";
	return "file";
}
export function childLabel(c: ChildSummary): string {
	if (c.title) return c.title;
	if (c.itemType === "note") return "Note";
	if (c.linkMode === "linked_url") return "Web link";
	if (/pdf/i.test(c.contentType ?? "")) return "PDF";
	if (/epub/i.test(c.contentType ?? "")) return "EPUB";
	if (/html/i.test(c.contentType ?? "")) return "Snapshot";
	return "Attachment";
}

// ---- opening ----
/** Open an http(s) URL in the system browser (through the core). */
export async function openUrl(url: string): Promise<void> {
	try { await api.openUrl(url); } catch (e) { fail("Could not open link", e); }
}
export async function openExternal(attachmentKey: string): Promise<void> {
	try { await api.openExternal(attachmentKey); } catch (e) { fail("Could not open file", e); }
}
export async function revealAttachment(attachmentKey: string): Promise<void> {
	try { await api.reveal(attachmentKey); } catch (e) { fail("Could not show file", e); }
}

const NOTHING = "No attachment or link to open";

/** Open one child row / menu entry: reader tab, browser, default app. Notes are shown in the item pane (the pane's selection). */
export async function openChild(parent: { key: string; title: string }, c: ChildSummary): Promise<void> {
	switch (childKind(c)) {
		case "note": return void store.selectItem(parent.key);
		case "reader": return store.openAttachment(c.key, c.title || parent.title, parent.key);
		case "file": return openExternal(c.key);
		case "url": {
			try {
				const url = webUrl((await getDetail(c.key)).data.url);
				if (url) return openUrl(url);
			} catch (e) { return fail("Could not open link", e); }
			return void toast(NOTHING);
		}
		default: return void toast(NOTHING);
	}
}

/**
 * Double-click / Enter on a top-level item, as Zotero: the best attachment with a file (PDF > EPUB > snapshot) in a reader tab;
 * else a linked URL, the item's URL or its DOI in the browser; else a toast.
 */
export async function openItem(it: ItemRow): Promise<void> {
	if (it.itemType === "note") return void store.selectItem(it.key);
	if (it.primaryAttachment) return store.openAttachment(it.primaryAttachment.key, it.title || "Reader", it.key);
	if (it.itemType === "attachment") { // a standalone attachment: open the file itself (the list row carries no content type)
		try {
			const d = await getDetail(it.key);
			const child = { key: it.key, itemType: "attachment", title: it.title, contentType: d.data.contentType as string | undefined, linkMode: d.data.linkMode as string | undefined, hasFile: d.data.linkMode !== "linked_url" };
			return openChild({ key: it.key, title: it.title }, child);
		} catch (e) { return fail("Could not open item", e); }
	}
	// Nothing attached: a URL or DOI the list already carries needs no extra request.
	if ((it.attachmentCount ?? 0) === 0) {
		const direct = webUrl(fieldOf(it, "url")) ?? doiUrl(fieldOf(it, "DOI"));
		if (direct) return openUrl(direct);
	}
	try {
		const d = await getDetail(it.key);
		const kids = d.children.filter((c) => c.itemType === "attachment");
		const rank = (c: ChildSummary) => (/pdf/i.test(c.contentType ?? "") ? 0 : /epub/i.test(c.contentType ?? "") ? 1 : 2);
		const reader = kids.filter((c) => childKind(c) === "reader").sort((a, b) => rank(a) - rank(b))[0];
		if (reader) return store.openAttachment(reader.key, it.title || reader.title || "Reader", it.key);
		for (const c of kids.filter((x) => childKind(x) === "url")) {
			const url = webUrl((await getDetail(c.key)).data.url);
			if (url) return openUrl(url);
		}
		const url = webUrl(d.data.url) ?? doiUrl(d.data.DOI);
		if (url) return openUrl(url);
		const file = kids.find((c) => childKind(c) === "file");
		if (file) return openExternal(file.key);
		toast(NOTHING);
	} catch (e) {
		fail("Could not open item", e);
	}
}

// ---- cite / full text / star / trash / collections ----
/** Copy a citation for one item in the Quick Copy style (HTML + plain text on the clipboard). */
export async function copyCitation(key: string): Promise<void> {
	try {
		const s = (await api.citeSettings()).quickCopy;
		const r = await api.citeFormat({ keys: [key], style: s.style, locale: s.locale, mode: "bibliography", format: ["html", "text"] });
		await copyRich(r.html ?? "", r.text ?? "");
		toast(`Reference copied (${s.style})`, { kind: "success" });
	} catch (e) {
		fail("Could not copy the citation", e);
	}
}

/** Find Full Text for top-level item keys: starts the core's job and reports the result in a toast when it finishes. */
export async function findFullText(keys: string[], opts: { openAccessOnly?: boolean } = {}): Promise<void> {
	if (keys.length === 0) return;
	try {
		const { jobId } = await api.findFullText(keys, opts.openAccessOnly === true);
		toast(`Finding full text for ${plural(keys.length, "item")}…`);
		for (let i = 0; i < 600; i++) { // up to 10 minutes
			await new Promise((r) => setTimeout(r, 1000));
			const job = await api.fullTextJob(jobId);
			if (!job.done) continue;
			const n = (s: string) => job.items.filter((x) => x.state === s).length;
			const attached = n("attached"), signIn = n("needs-sign-in"), notFound = n("not-found"), failed = n("failed"), already = n("already-has-pdf");
			const parts = [already && `${already} already had a PDF`, signIn && `${signIn} need sign-in`, notFound && `${notFound} not found`, failed && `${failed} failed`].filter(Boolean);
			if (attached) toast(`Attached ${plural(attached, "PDF")}`, { kind: "success", description: parts.join(", ") || undefined });
			else toast(signIn ? "Sign-in needed for full text" : "No full text found", { kind: signIn ? "info" : "error", description: parts.join(", ") || undefined });
			if (attached) store.refresh();
			return;
		}
	} catch (e) {
		fail("Could not start Find Full Text", e);
	}
}

/** Add/remove the Starred tag with an optimistic update of the cached row. */
export async function toggleStar(it: ItemRow): Promise<void> {
	const was = !!it.tags?.some((t) => t.tag === STAR_TAG);
	const before = it.tags ?? [];
	store.patchItem(it.key, { tags: was ? before.filter((t) => t.tag !== STAR_TAG) : [...before, { tag: STAR_TAG, type: 0 }] });
	try {
		await (was ? api.removeTags(it.key, [STAR_TAG]) : api.addTags(it.key, [STAR_TAG]));
	} catch (e) {
		store.patchItem(it.key, { tags: before });
		fail(was ? "Could not remove the star" : "Could not star the item", e);
	}
}

export async function trashItems(keys: string[], trashed: boolean): Promise<void> {
	try {
		await Promise.all(keys.map((k) => api.setDeleted(k, trashed)));
		store.setSelected(new Set());
		store.refresh();
		toast(`${trashed ? "Moved" : "Restored"} ${plural(keys.length, "item")} ${trashed ? "to Trash" : "from Trash"}`, { kind: "success" });
	} catch (e) {
		fail(trashed ? "Could not move to Trash" : "Could not restore", e);
	}
}

/** Add or remove top-level regular items in My Publications. */
export async function setInPublications(keys: string[], inPublications: boolean): Promise<void> {
	try {
		await Promise.all(keys.map((k) => api.setInPublications(k, inPublications)));
		store.refresh();
		toast(`${inPublications ? "Added" : "Removed"} ${plural(keys.length, "item")} ${inPublications ? "to" : "from"} My Publications`, { kind: "success" });
	} catch (e) {
		fail(inPublications ? "Could not add to My Publications" : "Could not remove from My Publications", e);
	}
}

export async function copyDoi(key: string): Promise<void> {
	try {
		const doi = (await getDetail(key)).data.DOI;
		if (!doi) return void toast("This item has no DOI");
		await copyRich("", doi);
		toast("DOI copied", { kind: "success", description: doi });
	} catch (e) {
		fail("Could not copy DOI", e);
	}
}

export async function addItemsToCollection(collKey: string, name: string, keys: string[]): Promise<void> {
	try {
		await api.addToCollection(collKey, keys);
		store.refresh();
		toast(`Added ${plural(keys.length, "item")} to "${name}"`, { kind: "success" });
	} catch (e) {
		fail("Could not add to collection", e);
	}
}

export { isRegular };
