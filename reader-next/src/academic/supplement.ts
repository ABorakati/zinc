// "Supplementary" sidebar tab + popup content for supplementary mentions ("Supplementary Table S1", "eTable 2", "Appendix B").
import type { ViewerHandle } from "../contract";
import { doiUrl } from "../../../ui/src/references/match";
import type { AcademicApi } from "./api";
import { button, h } from "./dom";
import type { SuppMention } from "./mentions";
import { formatSize, matchSupplement, supplementaryItems, type SuppItem, type SuppKind } from "./supp";

const ICON: Record<SuppKind, string> = {
	pdf: "PDF", epub: "EPUB", doc: "DOC", sheet: "XLS", slides: "PPT", image: "IMG", video: "VID", audio: "AUD",
	archive: "ZIP", text: "TXT", link: "URL", snapshot: "WEB", other: "FILE",
};

export interface Supplement {
	items(): Promise<SuppItem[]>;
	mentionContent(m: SuppMention, close: () => void): Promise<HTMLElement>;
	renderTab(container: HTMLElement): () => void;
	open(item: SuppItem): Promise<void>;
}

export function createSupplement(viewer: ViewerHandle, api: AcademicApi): Supplement {
	let itemsP: Promise<SuppItem[]> | null = null;
	const sizes = new Map<string, Promise<number | null>>();

	function items(): Promise<SuppItem[]> {
		itemsP ??= api.children().then((c) => supplementaryItems(c, viewer.attachmentKey)).catch((e) => { itemsP = null; throw e; });
		return itemsP;
	}

	function sizeOf(item: SuppItem): Promise<number | null> {
		if (!item.hasFile || item.kind === "link") return Promise.resolve(null);
		let p = sizes.get(item.key);
		if (!p) {
			p = fetch(`/api/attachments/${encodeURIComponent(item.key)}/file`, { method: "HEAD" })
				.then((r) => { const n = Number(r.headers.get("content-length")); return r.ok && n > 0 ? n : null; })
				.catch(() => null);
			sizes.set(item.key, p);
		}
		return p;
	}

	async function open(item: SuppItem) {
		if (item.kind === "pdf" || item.kind === "epub") api.post({ type: "open-attachment", key: item.key, title: item.title });
		else if (item.kind === "link") {
			const it = await api.item(item.key);
			const url = typeof it.data.url === "string" ? it.data.url : undefined;
			if (url) await api.openUrl(url);
		}
		else await api.openExternal(item.key);
	}

	function openButton(item: SuppItem): HTMLButtonElement {
		const label = item.kind === "pdf" || item.kind === "epub" ? "Open in new tab" : item.kind === "link" ? "Open link" : "Open";
		return button(label, async (b) => {
			b.disabled = true;
			try { await open(item); } catch (e) { b.textContent = "Failed - retry"; }
			b.disabled = false;
		}, { primary: true });
	}

	/** DOI landing page of the paper, for "Find supplementary materials". */
	async function landingUrl(): Promise<string | undefined> {
		await api.children().catch(() => []);
		const d = api.parent?.data;
		const doi = typeof d?.DOI === "string" ? d.DOI : undefined;
		if (doi) return doiUrl(doi);
		return typeof d?.url === "string" ? d.url : undefined;
	}

	function findButton(): HTMLElement {
		return button("Find supplementary materials", async (b) => {
			const u = await landingUrl();
			if (u) api.openUrl(u).catch(() => {});
			else b.textContent = "No DOI or URL on this item";
		});
	}

	async function mentionContent(m: SuppMention, close: () => void): Promise<HTMLElement> {
		const root = h("div", { "data-testid": "rn-supp-popup" }, h("div", { class: "rn-title" }, m.label));
		let list: SuppItem[] = [];
		try { list = await items(); } catch { /* shown as none */ }
		if (!list.length) {
			root.append(
				h("div", { class: "rn-meta" }, "This file is not attached to the item. Supplementary data usually lives on the publisher page."),
				h("div", { class: "rn-row" }, findButton()),
			);
			return root;
		}
		const ranked = matchSupplement(m, list);
		const top = ranked.filter((r) => r.score >= Math.max(1, (ranked[0]?.score ?? 0) - 1)).slice(0, 3);
		if (top.length) root.append(h("div", { class: "rn-meta" }, top.length === 1 ? "Likely attached as:" : "Likely attached as one of:"));
		else root.append(h("div", { class: "rn-meta" }, "No attached file clearly matches. Attached files:"));
		for (const it of top.length ? top.map((t) => t.item) : list.slice(0, 5)) {
			root.append(
				h("div", { class: "rn-li-head", style: { alignItems: "center", marginTop: "6px" } },
					h("span", { class: "rn-ico", style: { width: "34px" } }, ICON[it.kind]),
					h("span", { class: "rn-grow" }, it.title),
				),
				h("div", { class: "rn-row", style: { marginTop: "4px" } }, openButton(it)),
			);
		}
		return root;
	}

	function renderTab(container: HTMLElement): () => void {
		let alive = true;
		const head = h("div", { class: "rn-tab-head" }, h("b", null, "Supplementary files"));
		const scroll = h("div", { class: "rn-scroll" }, h("div", { class: "rn-empty" }, "Loading…"));
		const root = h("div", { class: "rn-tab", "data-testid": "rn-supp-tab" }, head, scroll);
		container.append(root);

		items().then((list) => {
			if (!alive) return;
			scroll.textContent = "";
			if (!list.length) {
				scroll.append(h("div", { class: "rn-empty" },
					h("p", { style: { margin: "0 0 8px" } }, "No other attachments on this item."),
					findButton(),
				));
				return;
			}
			for (const it of list) scroll.append(row(it));
		}).catch((e) => {
			if (!alive) return;
			scroll.textContent = "";
			scroll.append(h("div", { class: "rn-empty" }, `Could not load attachments (${(e as Error).message}).`));
		});

		function row(it: SuppItem): HTMLElement {
			const sizeEl = h("span", { class: "rn-pg" });
			sizeOf(it).then((n) => { if (n && alive) sizeEl.textContent = formatSize(n); });
			const isImage = it.kind === "image" && it.hasFile;
			const lead = isImage
				? h("img", { class: "rn-thumb", loading: "lazy", alt: "", src: `/api/attachments/${encodeURIComponent(it.key)}/file` })
				: h("span", { class: "rn-ico" }, ICON[it.kind]);
			const body = h("div", { class: "rn-grow" },
				h("div", { class: "rn-lbl", style: { wordBreak: "break-word" } }, it.title, sizeEl),
				h("div", { class: "rn-row", style: { marginTop: "4px" } }, openButton(it)),
			);
			const r = h("div", { class: "rn-item", tabindex: "0", "data-key": it.key, "data-kind": it.kind }, lead, body);
			if (isImage) {
				let big: HTMLElement | null = null;
				r.addEventListener("click", () => {
					if (big) { big.remove(); big = null; return; }
					big = h("img", { class: "rn-preview", alt: it.title, src: `/api/attachments/${encodeURIComponent(it.key)}/file` });
					body.append(big);
				});
			}
			else r.addEventListener("dblclick", () => open(it).catch(() => {}));
			return r;
		}
		return () => { alive = false; root.remove(); };
	}

	return { items, mentionContent, renderTab, open };
}
