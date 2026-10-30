// Zotero-style "open" behaviour shared by the table, the cards and the context menus:
// best attachment in a reader tab, else a web link in the browser, else a toast.
import { BookOpen, File as FileIcon, FileText, Globe, Link, StickyNote, type LucideProps } from "lucide-solid";
import type { Component } from "solid-js";
import { toast } from "solid-sonner";
import { api, type ChildSummary, type ItemDetail, type ItemSummary } from "./api";
import { store } from "./store";
import { errMsg } from "~/lib/actions";

// ---- detail cache (item detail carries the children) -----------------------------------------------
let cacheRev = -1;
const details = new Map<string, Promise<ItemDetail>>();

/** GET /api/items/:key, cached per key until store.itemsRev changes. */
export function getDetail(key: string): Promise<ItemDetail> {
	const rev = store.itemsRev();
	if (rev !== cacheRev) { details.clear(); cacheRev = rev; }
	let p = details.get(key);
	if (!p) {
		p = api.item(key);
		details.set(key, p);
		p.catch(() => { if (details.get(key) === p) details.delete(key); });
	}
	return p;
}

// ---- child classification ------------------------------------------------------------------------
export type ChildKind = "reader" | "url" | "file" | "note" | "none";

const isReaderType = (ct: string | null | undefined) => /pdf|epub|html/i.test(ct ?? "");

export function childKind(c: ChildSummary): ChildKind {
	if (c.itemType === "note") return "note";
	if (c.linkMode === "linked_url") return "url";
	if (!c.hasFile) return "none";
	return isReaderType(c.contentType) ? "reader" : "file";
}

export function childIcon(c: ChildSummary): Component<LucideProps> {
	if (c.itemType === "note") return StickyNote;
	if (c.linkMode === "linked_url") return Link;
	if (/pdf/i.test(c.contentType ?? "")) return FileText;
	if (/epub/i.test(c.contentType ?? "")) return BookOpen;
	if (/html/i.test(c.contentType ?? "")) return Globe;
	return FileIcon;
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

// ---- server actions ------------------------------------------------------------------------------
async function post(path: string, body: unknown = {}) {
	const res = await fetch("/api" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
	if (!res.ok) {
		let msg = res.statusText;
		try { msg = (await res.json()).error ?? msg; } catch { /* ignore */ }
		throw new Error(msg);
	}
}

/** Open an http(s) URL in the user's browser through the core (the desktop shell has no window.open). */
export async function openUrl(url: string) {
	try { await post("/open-url", { url }); } catch (e) { toast.error("Could not open link", { description: errMsg(e) }); }
}

export async function openExternal(attachmentKey: string) {
	try { await post(`/attachments/${attachmentKey}/open-external`); } catch (e) { toast.error("Could not open file", { description: errMsg(e) }); }
}

export async function revealAttachment(attachmentKey: string) {
	try { await post(`/attachments/${attachmentKey}/reveal`); } catch (e) { toast.error("Could not show file", { description: errMsg(e) }); }
}

const NOTHING = "No attachment or link to open";

/** `doi.org` link for a DOI field, or null. */
export function doiUrl(doi: string | null | undefined): string | null {
	const d = (doi ?? "").trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "");
	return /^10\.\S+/.test(d) ? "https://doi.org/" + d : null;
}

export const webUrl =(u: string | null | undefined) => (u && /^https?:\/\//i.test(u.trim()) ? u.trim() : null);

// ---- item pane helpers -----------------------------------------------------------------------------
/** Open a section of the item pane for the active item (the pane renders it once the item has loaded). */
export function showInPane(section: string) {
	let tries = 0;
	const go = () => {
		const nav = document.querySelector<HTMLElement>(`[data-nav="${section}"]`);
		if (nav) nav.click();
		else if (tries++ < 8) setTimeout(go, 120);
	};
	setTimeout(go, 60);
}

/** Show a child note: make the parent the pane's item and scroll the pane to Notes. */
export function showNote(parentKey: string, noteKey: string) {
	store.setActiveKey(parentKey);
	window.dispatchEvent(new CustomEvent("zn:show-note", { detail: { parentKey, noteKey } }));
	showInPane("notes");
}

// ---- opening ---------------------------------------------------------------------------------------
/** Open one child row/menu entry: reader tab, browser, default app or the pane's Notes. */
export async function openChild(parent: { key: string; title: string }, c: ChildSummary) {
	switch (childKind(c)) {
		case "note": return showNote(parent.key, c.key);
		case "reader": return store.openAttachment(c.key, c.title || parent.title);
		case "file": return openExternal(c.key);
		case "url": {
			try {
				const url = webUrl((await getDetail(c.key)).data.url);
				if (url) return openUrl(url);
			} catch (e) { return void toast.error("Could not open link", { description: errMsg(e) }); }
			return void toast.info(NOTHING);
		}
		default: return void toast.info(NOTHING);
	}
}

/**
 * Double-click / Enter on a top-level item, as Zotero: the best attachment with a file (PDF > EPUB > snapshot)
 * in a reader tab; else a linked URL, the item's URL or its DOI in the browser; else a toast.
 */
export async function openSummary(it: ItemSummary) {
	if (it.itemType === "note") { store.setActiveKey(it.key); return; }
	if (it.primaryAttachment) return store.openAttachment(it.primaryAttachment.key, it.title);
	// Nothing attached: a URL or DOI the list already carries needs no extra request.
	if (it.attachmentCount === 0) {
		const direct = webUrl(it.fields?.url) ?? doiUrl(it.fields?.DOI);
		if (direct) return openUrl(direct);
	}
	try {
		const d = await getDetail(it.key);
		const kids = d.children.filter((c) => c.itemType === "attachment");
		const rank = (c: ChildSummary) => (/pdf/i.test(c.contentType ?? "") ? 0 : /epub/i.test(c.contentType ?? "") ? 1 : 2);
		const reader = kids.filter((c) => childKind(c) === "reader").sort((a, b) => rank(a) - rank(b))[0];
		if (reader) return store.openAttachment(reader.key, it.title || reader.title);
		for (const c of kids.filter((x) => childKind(x) === "url")) {
			const url = webUrl((await getDetail(c.key)).data.url);
			if (url) return openUrl(url);
		}
		const url = webUrl(d.data.url) ?? doiUrl(d.data.DOI);
		if (url) return openUrl(url);
		const file = kids.find((c) => childKind(c) === "file");
		if (file) return openExternal(file.key);
		toast.info(NOTHING);
	} catch (e) {
		toast.error("Could not open item", { description: errMsg(e) });
	}
}
