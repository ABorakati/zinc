// What Zotero's note editor asks of its host besides loading and saving (webview/notes.ts): links, and the citations and annotation
// highlights inside notes. Zotero desktop answers these in its note-editor wrapper; note-host (the Electrobun UI) left them unwired.
//   openURL            http(s)/mailto -> the system browser; zotero://select/... -> select the item; zotero://open-pdf/... -> open it
//   showCitationItem   "Show Item" on a citation: select the cited item in the library
//   openCitationPage   "Show on Page" on a citation: open the cited item's PDF at the citation's page (locator)
//   openAnnotation     "Show on Page" on a highlight: open its PDF at the annotation
// Opening at a page goes through a reader plugin: the reader calls onOpen for every document, and a waiting jump is applied there (or
// at once when that PDF's tab is already open).
import { api } from "../api";
import { registerReaderPlugin, type ReaderContext } from "../reader/plugins";
import { store } from "../store";
import { toast } from "../ui/overlay";

type Msg = { action?: string; [k: string]: unknown };
type Citation = { citationItems?: { uris?: string[]; locator?: string; label?: string }[] };
interface Jump {
	page: number;
	/** the top of the target in PDF points from the page's bottom (Zotero rects) */ top?: number;
}

const readers = new Map<string, ReaderContext>();
const jumps = new Map<string, Jump>();

registerReaderPlugin({
	id: "note-links",
	onOpen(ctx) {
		readers.set(ctx.attachmentKey, ctx);
		const j = jumps.get(ctx.attachmentKey);
		if (j) {
			jumps.delete(ctx.attachmentKey);
			jumpIn(ctx, j);
		}
		return () => {
			if (readers.get(ctx.attachmentKey) === ctx) readers.delete(ctx.attachmentKey);
		};
	},
});

function jumpIn(ctx: ReaderContext, j: Jump): void {
	const go = () => {
		const n = ctx.pageCount();
		if (!n) return;
		const page = Math.max(0, Math.min(n - 1, j.page));
		const h = ctx.pageSize(page).h || 792;
		ctx.scrollTo(page, j.top != null ? Math.max(0, 1 - j.top / h - 0.06) : 0);
	};
	// after the reader restored its saved position (and laid out the pages)
	setTimeout(go, 250);
	setTimeout(() => {
		if (ctx.currentPage() !== Math.max(0, j.page)) go();
	}, 900);
}

/** The 8-character item key at the end of a Zotero item URI (http://zotero.org/users/<id>/items/<KEY>, zotero://select/library/items/<KEY>). */
export function keyOfUri(uri: string): string | null {
	return /\/items\/([A-Z0-9]{8})(?:[/?#]|$)/.exec(uri)?.[1] ?? null;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function selectItem(key: string): void {
	store.setActiveTab("library");
	store.selectItem(key);
}

/** Open a PDF (or whatever the attachment is) in its tab, at a page when it is a PDF. */
async function openAttachmentAt(attachmentKey: string, jump: Jump | null): Promise<void> {
	const d = await api.item(attachmentKey);
	const data = d.data as { title?: unknown; parentItem?: unknown; contentType?: unknown; itemType?: unknown };
	if (data.itemType !== "attachment") return selectItem(attachmentKey);
	if (jump && /pdf/i.test(String(data.contentType ?? ""))) {
		const open = readers.get(attachmentKey);
		if (open) jumpIn(open, jump);
		else jumps.set(attachmentKey, jump);
	}
	store.openAttachment(attachmentKey, String(data.title ?? ""), String(data.parentItem ?? ""));
}

/** Open a PDF attachment in its reader tab at a page (0-based), e.g. from the item pane's page preview. */
export function openPdfAtPage(attachmentKey: string, title: string, itemKey: string, page: number): void {
	const open = readers.get(attachmentKey);
	if (open) jumpIn(open, { page });
	else jumps.set(attachmentKey, { page });
	store.openAttachment(attachmentKey, title, itemKey);
}

/** The cited item's best attachment (its first PDF), or null. */
async function pdfOf(itemKey: string): Promise<string | null> {
	const d = await api.item(itemKey);
	if ((d.data as { itemType?: unknown }).itemType === "attachment") return itemKey;
	const pdf = d.children.find((c) => c.itemType === "attachment" && /pdf/i.test(c.contentType ?? ""));
	return pdf?.key ?? null;
}

const firstCited = (c: unknown): { key: string; locator?: string } | null => {
	for (const ci of (c as Citation | undefined)?.citationItems ?? []) {
		for (const u of ci.uris ?? []) {
			const key = keyOfUri(u);
			if (key) return { key, locator: ci.locator };
		}
	}
	return null;
};

/** zotero:// links in notes (Zotero writes them for annotations and items). True when handled here. */
async function zoteroLink(url: string): Promise<boolean> {
	const m = /^zotero:\/\/(select|open-pdf|open)\//i.exec(url);
	if (!m) return false;
	const key = keyOfUri(url);
	if (!key) return true;
	if (m[1]!.toLowerCase() === "select") {
		selectItem(key);
		return true;
	}
	const q = new URLSearchParams(url.split("?")[1] ?? "");
	const page = Number(q.get("page"));
	const att = await pdfOf(key);
	if (!att) {
		selectItem(key);
		return true;
	}
	await openAttachmentAt(att, Number.isFinite(page) && page > 0 ? { page: page - 1 } : null);
	return true;
}

/** An editor message other than load / save / images. */
export async function handleNoteAction(m: Msg): Promise<void> {
	try {
		switch (m.action) {
			case "openURL": {
				const url = String(m.url ?? "");
				if (!url || (await zoteroLink(url))) return;
				await api.openUrl(url);
				return;
			}
			case "showCitationItem": {
				const c = firstCited(m.citation);
				if (c) selectItem(c.key);
				return;
			}
			case "openCitationPage": {
				const c = firstCited(m.citation);
				if (!c) return;
				const att = await pdfOf(c.key);
				if (!att) {
					toast("The cited item has no PDF", { kind: "info" });
					selectItem(c.key);
					return;
				}
				const page = parseInt(String(c.locator ?? ""), 10);
				await openAttachmentAt(att, Number.isFinite(page) && page > 0 ? { page: page - 1 } : { page: 0 });
				return;
			}
			case "openAnnotation": {
				const key = keyOfUri(String(m.attachmentURI ?? ""));
				if (!key) return;
				const pos = m.position as { pageIndex?: number; rects?: number[][] } | undefined;
				const page = typeof pos?.pageIndex === "number" ? pos.pageIndex : null;
				const top = pos?.rects?.[0]?.[3];
				await openAttachmentAt(key, page != null ? { page, top: typeof top === "number" ? top : undefined } : null);
				return;
			}
			default:
				// not wired, as in note-host: openCitationPopup (citation dialog), importImages / attachImportedImage (pasted images stay
				// embedded as data: URLs), insertObject (drops from the item list), updateCitationItemsList, showNote
				return;
		}
	} catch (e) {
		toast("Could not open that from the note", { kind: "error", description: errText(e) });
	}
}
