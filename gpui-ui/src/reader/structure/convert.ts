// SDT (Zotero's structured document text) -> DocStructure. Pure: no DOM, no I/O, so it is unit-testable.
// Schema: vendor/reader/structured-document-text/schema.d.ts. PDF page rects are [page, x1, y1, x2, y2] in
// PDF user space (bottom-left origin, points), exactly what DocStructure uses.
import type { Block, BlockType, DocStructure, FigureOrTable, PdfRect, ReferenceEntry } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Node = any;
export type Sdt = {
	metadata?: { source?: { properties?: Record<string, unknown> } };
	catalog: { outline?: any[]; pages?: { viewRect?: number[]; label?: string }[] };
	content: Node[];
};

export const CONVERTER_VERSION = 6;

// ---------------------------------------------------------------- text helpers

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Collapse whitespace, drop soft hyphens, join "hy-\nphen" line breaks. */
export function cleanText(s: string, preformatted = false): string {
	s = s.replace(/­/g, "");
	if (preformatted) return s.replace(/\s+$/, "");
	s = s.replace(/(\p{L})-[ \t]*\r?\n[ \t]*(\p{Ll})/gu, "$1$2");
	return s.replace(/\s+/g, " ").trim();
}

/** Join two text fragments that belong to one logical paragraph (column / page break). */
export function joinFragments(a: string, b: string): string {
	if (!a) return b;
	if (!b) return a;
	if (/\p{L}-$/u.test(a) && /^\p{Ll}/u.test(b)) return a.slice(0, -1) + b; // hard hyphen at a break
	if (/\s$/.test(a) || /^\s/.test(b)) return a + b;
	return a + " " + b;
}

/** Same as joinFragments but for HTML strings (the hyphen is never inside a tag at the very end in practice). */
export function joinHtml(a: string, b: string): string {
	if (!a) return b;
	if (!b) return a;
	const ta = a.replace(/<[^>]*>/g, "");
	const tb = b.replace(/<[^>]*>/g, "");
	if (/\p{L}-$/u.test(ta) && /^\p{Ll}/u.test(tb)) return a.replace(/-((?:<\/[^>]+>)*)$/, "$1") + b;
	if (/\s$/.test(ta) || /^\s/.test(tb)) return a + b;
	return a + " " + b;
}

interface Dest { page: number; top: number; kind: "ref" | "fig" | "other" }

function nodeAt(content: Node[], ref: number[]): Node | null {
	let node: Node = { content };
	for (const i of ref) {
		if (!Array.isArray(node?.content)) return null;
		node = node.content[i];
		if (!node || typeof node !== "object") return null;
	}
	return node;
}

function firstRect(node: Node): [number, number, number, number, number] | null {
	const r = node?.anchor?.pageRects?.[0];
	return Array.isArray(r) && r.length >= 5 ? (r as any) : null;
}

/** Destination of a link / citation node: where the target sits (page index + top y in PDF points). */
function destOf(content: Node[], t: Node): Dest | null {
	const refs: number[][] | undefined = t.refs;
	if (Array.isArray(refs) && refs.length) {
		const target = nodeAt(content, refs[0]);
		const kind = target?.reference ? "ref" : target && ["image", "table", "caption", "math"].includes(target.type) ? "fig" : "other";
		for (let n = refs[0]; n.length > 0; n = n.slice(0, -1)) {
			const r = firstRect(nodeAt(content, n));
			if (r) return { page: r[0], top: r[4], kind };
		}
	}
	const pos = t.target?.position;
	if (pos && Number.isInteger(pos.pageIndex)) {
		return { page: pos.pageIndex, top: Array.isArray(pos.rect) ? pos.rect[3] : Infinity, kind: "other" };
	}
	return null;
}

interface Inline { text: string; html: string }

/** Inline TextNode[] (or a node whose content is text) -> plain text + inline html. */
function inline(content: Node[], nodes: Node[], pre = false): Inline {
	let text = "";
	let html = "";
	let hasTag = false;
	for (const n of nodes) {
		if (typeof n?.text !== "string") continue;
		const raw = pre ? n.text : n.text.replace(/­/g, "");
		text += raw;
		let h = esc(raw);
		const st = n.style;
		const dest = n.refs || n.target?.position ? destOf(content, n) : null;
		const url: string | undefined = typeof n.target?.url === "string" ? n.target.url : undefined;
		if (st?.monospace) { h = `<code>${h}</code>`; hasTag = true; }
		if (st?.sup) { h = `<sup>${h}</sup>`; hasTag = true; }
		if (st?.sub) { h = `<sub>${h}</sub>`; hasTag = true; }
		if (st?.italic) { h = `<i>${h}</i>`; hasTag = true; }
		if (st?.bold) { h = `<b>${h}</b>`; hasTag = true; }
		if (dest && /\S/.test(raw)) {
			const top = Number.isFinite(dest.top) ? ` data-top="${Math.round(dest.top * 10) / 10}"` : "";
			h = `<a class="rx-cite" href="#" data-kind="${dest.kind}" data-page="${dest.page}"${top}>${h}</a>`;
			hasTag = true;
		}
		else if (url && /\S/.test(raw)) {
			h = `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${h}</a>`;
			hasTag = true;
		}
		html += h;
	}
	if (!pre) {
		text = cleanText(text);
		html = html.replace(/(\p{L})-[ \t]*\r?\n[ \t]*(\p{Ll})/gu, "$1$2").replace(/\s+/g, " ").trim();
	}
	return { text, html: hasTag || pre ? html : "" };
}

/** Everything text-like under a node, in order. */
function leafNodes(node: Node, out: Node[] = []): Node[] {
	if (!node) return out;
	if (typeof node.text === "string") out.push(node);
	else if (Array.isArray(node.content)) for (const c of node.content) leafNodes(c, out);
	return out;
}

const BULLET = /^[\s•●▪■◦‣⁃·–—−*\-]+/u;

function listHtml(content: Node[], list: Node): { text: string; html: string } {
	const ordered = !!list.ordered;
	const items: Inline[] = [];
	for (const li of list.content ?? []) {
		const leaves = leafNodes(li);
		let { text, html } = inline(content, leaves);
		// strip a leading bullet glyph / number label (the view draws its own markers)
		if (!ordered) { text = text.replace(BULLET, ""); html = html.replace(/^(?:\s|<[^>]+>)*[•●▪■◦‣·–—−*](?:<\/[^>]+>)*\s*/u, ""); }
		else { text = text.replace(/^\(?(?:\d+|[a-zA-Z]|[ivxIVX]+)[.)]\s+/, ""); html = html.replace(/^((?:<[^>]+>)*)\(?(?:\d+|[a-zA-Z]|[ivxIVX]+)[.)]\s+/, "$1"); }
		items.push({ text, html: html || esc(text) });
	}
	const tag = ordered ? "ol" : "ul";
	const start = ordered && list.startIndex && list.startIndex !== 1 ? ` start="${list.startIndex}"` : "";
	return {
		text: items.map((i) => i.text).join("\n"),
		html: `<${tag}${start}>${items.map((i) => `<li>${i.html}</li>`).join("")}</${tag}>`,
	};
}

function tableHtml(content: Node[], t: Node): string | undefined {
	const rows = t.content;
	if (!Array.isArray(rows) || !rows.length || rows[0].type !== "tablerow") return undefined;
	let h = "<table>";
	for (const row of rows) {
		h += "<tr>";
		for (const cell of row.content ?? []) {
			const tag = cell.header ? "th" : "td";
			const span = (cell.colspan > 1 ? ` colspan="${cell.colspan}"` : "") + (cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : "");
			const { text, html } = inline(content, leafNodes(cell));
			h += `<${tag}${span}>${html || esc(text)}</${tag}>`;
		}
		h += "</tr>";
	}
	return h + "</table>";
}

// ---------------------------------------------------------------- geometry

const unionRect = (rs: PdfRect[]): PdfRect => [
	Math.min(...rs.map((r) => r[0])), Math.min(...rs.map((r) => r[1])),
	Math.max(...rs.map((r) => r[2])), Math.max(...rs.map((r) => r[3])),
];
const xOverlap = (a: PdfRect, b: PdfRect) => Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
const yGap = (a: PdfRect, b: PdfRect) => Math.max(0, Math.max(a[1], b[1]) - Math.min(a[3], b[3]));

// ---------------------------------------------------------------- labels

const LABEL = /^\s*(?:(Supplementary|Supp\.?|Extended Data|Appendix)\s+)?(Figure|Fig\.?|Table|Scheme|Box|Panel)\s*([A-Z]?\d+[A-Za-z]?(?:\.\d+)?|[IVXL]{1,5})(?=[\s.:|,–—)\-]|$)/i;

export function captionLabel(text: string): { label: string; kind: "figure" | "table" } | null {
	const m = LABEL.exec(text);
	if (!m) return null;
	const word = /^fig/i.test(m[2]) ? "Figure" : m[2][0].toUpperCase() + m[2].slice(1).toLowerCase();
	const prefix = m[1] ? (/^ext/i.test(m[1]) ? "Extended Data " : /^app/i.test(m[1]) ? "Appendix " : "Supplementary ") : "";
	return { label: `${prefix}${word} ${m[3]}`, kind: /^table/i.test(m[2]) ? "table" : "figure" };
}

// ---------------------------------------------------------------- main conversion

interface Item {
	key: string; // ref path joined by "."
	node: Node;
	block: Block;
	flow?: string;
	merged?: boolean; // absorbed into another block
	imageOf?: string;
}

const REF_HEADING = /^\s*(?:\d+\.?\s*)?(references?|bibliography|literature cited|works cited|reference list|sources)\s*$/i;

export function convertSdt(sdt: Sdt): DocStructure {
	const content = sdt.content ?? [];
	const pages = sdt.catalog?.pages ?? [];
	const pageHeight = (p: number) => {
		const v = pages[p]?.viewRect;
		return v && v.length === 4 ? v[3] - v[1] : 792;
	};
	const items: Item[] = [];
	const byRef = new Map<string, Item>();
	const refToId = new Map<string, string>();

	const rectsOf = (node: Node): { page: number; rects: PdfRect[] } => {
		const pr: any[] = node?.anchor?.pageRects ?? [];
		if (!pr.length) return { page: 0, rects: [] };
		const page = pr[0][0];
		return { page, rects: pr.filter((r) => r[0] === page).map((r) => [r[1], r[2], r[3], r[4]] as PdfRect) };
	};

	const push = (ref: number[], node: Node, type: BlockType, text: string, html: string | undefined, extra: Partial<Block> = {}) => {
		const key = ref.join(".");
		const { page, rects } = rectsOf(node);
		const block: Block = { id: "b" + key, type, page, rects, text, ...(html ? { html } : {}), ...extra };
		const item: Item = { key, node, block, flow: node.flowClass };
		items.push(item);
		byRef.set(key, item);
		refToId.set(key, block.id);
		return item;
	};

	// -- 1. flatten top-level nodes into items
	const visit = (node: Node, ref: number[]) => {
		const t = node.type as string;
		const inlineNodes = () => leafNodes(node);
		switch (t) {
			case "heading": {
				const { text, html } = inline(content, inlineNodes());
				if (text) push(ref, node, "heading", text, html);
				break;
			}
			case "paragraph": {
				const { text, html } = inline(content, inlineNodes());
				if (text) push(ref, node, node.reference ? "reference" : "paragraph", text, html);
				break;
			}
			case "math": {
				const { text } = inline(content, inlineNodes());
				push(ref, node, "equation", text, undefined);
				break;
			}
			case "image":
				push(ref, node, "figure", "", undefined);
				break;
			case "caption": {
				const { text, html } = inline(content, inlineNodes());
				if (text) push(ref, node, "caption", text, html);
				break;
			}
			case "note": {
				const { text, html } = inline(content, inlineNodes());
				if (text) push(ref, node, node.reference ? "reference" : "footnote", text, html);
				break;
			}
			case "preformatted": {
				const { text, html } = inline(content, inlineNodes(), true);
				if (text.trim()) push(ref, node, "other", cleanText(text, true), html);
				break;
			}
			case "table": {
				const { text, html } = inline(content, inlineNodes());
				push(ref, node, "table", text, tableHtml(content, node) ?? (html || undefined));
				break;
			}
			case "list": {
				const isRefList = (node.content ?? []).some((li: Node) => li.reference);
				if (isRefList) {
					(node.content ?? []).forEach((li: Node, i: number) => {
						const { text, html } = inline(content, leafNodes(li));
						if (text) push([...ref, i], li, "reference", text, html);
					});
				}
				else {
					const { text, html } = listHtml(content, node);
					if (text.trim()) push(ref, node, "list", text, html);
				}
				break;
			}
			case "blockquote":
				(node.content ?? []).forEach((c: Node, i: number) => visit(c, [...ref, i]));
				break;
			default: break;
		}
	};
	content.forEach((n, i) => visit(n, [i]));

	// -- 2. merge parts (a paragraph split over columns) when they sit on the same page
	for (const it of items) {
		const prev: number[] | undefined = it.node.previousPart;
		if (!Array.isArray(prev)) continue;
		const root = byRef.get(prev.join("."));
		if (!root || root === it) continue;
		if (root.block.type !== it.block.type || root.block.page !== it.block.page) continue;
		if (!["paragraph", "caption", "heading", "footnote"].includes(it.block.type)) continue;
		const rootHtml = root.block.html || esc(root.block.text);
		const itHtml = it.block.html || esc(it.block.text);
		root.block.html = root.block.html || it.block.html ? joinHtml(rootHtml, itHtml) : undefined;
		root.block.text = joinFragments(root.block.text, it.block.text);
		root.block.rects = [...root.block.rects, ...it.block.rects];
		root.node = { ...root.node, nextPart: it.node.nextPart };
		it.merged = true;
		byRef.set(it.key, root);
		refToId.set(it.key, root.block.id);
	}

	// -- 3. header / footer / footnote classification
	for (const it of items) {
		if (it.merged) continue;
		const b = it.block;
		if (it.flow === "excluded" && (b.type === "paragraph" || b.type === "other" || b.type === "heading")) {
			const r = b.rects[0];
			const mid = r ? (r[1] + r[3]) / 2 : 0;
			b.type = mid > pageHeight(b.page) / 2 ? "header" : "footer";
		}
		else if (it.flow === "auxiliary" && b.type === "paragraph") {
			b.type = /^\d+$/.test(b.text) && b.text.length < 4 ? "footer" : "footnote";
		}
	}

	// -- 4. headings: title + levels
	const live = () => items.filter((i) => !i.merged);
	const outlineDepth = new Map<string, number>();
	(function walk(list: any[] | undefined, d: number) {
		for (const o of list ?? []) {
			if (Array.isArray(o.ref)) outlineDepth.set(o.ref.join("."), d);
			walk(o.children, d + 1);
		}
	})(sdt.catalog?.outline, 0);
	const srcTitle = String(sdt.metadata?.source?.properties?.Title ?? "").toLowerCase().replace(/\W+/g, " ").trim();
	// title: the heading on page 0 (before the first section heading) that matches the PDF's Title property,
	// else the longest one; short kickers like "Meeting report" stay ordinary headings
	const norm = (t: string) => t.toLowerCase().replace(/\W+/g, " ").trim();
	const SECTION = /^(abstract|introduction|summary|background|keywords?|a b s t r a c t|article info)\b|^\d+(\.\d+)*\.?\s/i;
	const cands: Item[] = [];
	for (const it of live()) {
		const b = it.block;
		if (b.type !== "heading") continue;
		if (b.page !== 0 || SECTION.test(b.text) || REF_HEADING.test(b.text)) break;
		cands.push(it);
	}
	const longest = cands.reduce<Item | undefined>((best, c) => (!best || c.block.text.length > best.block.text.length * 1.15 ? c : best), undefined);
	// the PDF's own Title property wins only when it is about as long as the longest candidate (it is often just a section tag)
	const titleItem = cands.find((c) => srcTitle && norm(c.block.text) === srcTitle && c.block.text.length >= (longest?.block.text.length ?? 0) * 0.6) ?? longest;
	if (titleItem) { titleItem.block.type = "title"; titleItem.block.level = 1; }
	for (const it of live()) {
		const b = it.block;
		if (b.type !== "heading") continue;

		const num = /^(\d+(?:\.\d+)*)\.?\s/.exec(b.text) ?? /^([A-Z](?:\.\d+)*)\.?\s/.exec(b.text);
		if (num) b.level = Math.min(num[1].split(".").length + 1, 5);
		else if (outlineDepth.has(it.key)) b.level = Math.min((outlineDepth.get(it.key) ?? 0) + 2, 5);
		else b.level = 2;
	}

	// -- 5. figures and tables: pair labelled captions with image/table regions on the same page
	const figures: FigureOrTable[] = [];
	const tables: FigureOrTable[] = [];
	const caps = live().filter((i) => i.block.type === "caption");
	const labelled = caps.map((c) => ({ c, lab: captionLabel(c.block.text) })).filter((x) => x.lab);
	const regionItems = live().filter((i) => i.block.type === "figure" || i.block.type === "table" || i.block.type === "other");
	const claimed = new Map<Item, Item>(); // region -> caption
	const assign = (region: Item) => {
		const rr = region.block.rects[0];
		if (!rr) return;
		let best: { c: Item; score: number } | null = null;
		for (const { c, lab } of labelled) {
			if (c.block.page !== region.block.page || !c.block.rects[0]) continue;
			const cr = c.block.rects[0];
			// prefer the natural pairing (tables with tables, figures with images) but accept the other
			const natural = lab!.kind === "table" ? region.block.type === "table" : region.block.type === "figure";
			const score = yGap(rr, cr) + (xOverlap(rr, cr) > 0 ? 0 : 1000) + (natural ? 0 : 150);
			if (score < 1000 && yGap(rr, cr) < 160 && (!best || score < best.score)) best = { c, score };
		}
		if (best) claimed.set(region, best.c);
	};
	regionItems.forEach(assign);

	// running heads / page numbers sometimes sit inside a figure's bounding box: crop them off
	const furniture = live().filter((i) => (i.block.type === "header" || i.block.type === "footer") && i.block.rects[0]);
	const clip = (page: number, r: PdfRect): PdfRect => {
		let [x1, y1, x2, y2] = r;
		for (const fu of furniture) {
			if (fu.block.page !== page) continue;
			const h = fu.block.rects[0];
			if (xOverlap([x1, y1, x2, y2], h) <= 0 || h[3] < y1 || h[1] > y2) continue;
			const mid = (h[1] + h[3]) / 2;
			if (mid > (y1 + y2) / 2) y2 = Math.min(y2, h[1] - 1);
			else y1 = Math.max(y1, h[3] + 1);
		}
		return y2 - y1 > 12 ? [x1, y1, x2, y2] : r;
	};

	const used = new Set<string>();
	const idCount = { figure: 0, table: 0 };
	for (const { c, lab } of labelled) {
		const regions = regionItems.filter((r) => claimed.get(r) === c);
		let primary: Item | undefined = regions[0];
		let rect: PdfRect | undefined;
		if (regions.length) rect = unionRect(regions.flatMap((r) => r.block.rects.map((q) => clip(c.block.page, q))));
		else {
			// no detected region: take the open space beside the caption's column (above for figures, below for tables)
			const cr = c.block.rects[0];
			if (cr) {
				const bodies = live().filter((i) => i.block.page === c.block.page && i !== c && ["paragraph", "heading", "list", "table", "equation", "other"].includes(i.block.type) && i.block.rects[0] && xOverlap(i.block.rects[0], cr) > 20);
				if (lab!.kind === "figure") {
					const above = bodies.map((b) => b.block.rects[0]).filter((r) => r[1] >= cr[3] - 1).map((r) => r[1]);
					const top = above.length ? Math.min(...above) : pageHeight(c.block.page) - 36;
					if (top - cr[3] > 60) rect = [cr[0], cr[3] + 2, cr[2], top - 2];
				}
				else {
					const below = bodies.map((b) => b.block.rects[0]).filter((r) => r[3] <= cr[1] + 1).map((r) => r[3]);
					const bottom = below.length ? Math.max(...below) : 36;
					if (cr[1] - bottom > 60) rect = [cr[0], bottom + 2, cr[2], cr[1] - 2];
				}
			}
		}
		if (!rect) continue;
		const kind = lab!.kind;
		const idx = ++idCount[kind];
		const id = primary?.block.id ?? `${kind[0]}${idx}`;
		if (used.has(id)) continue;
		used.add(id);
		let fig: Block;
		if (primary) {
			fig = primary.block;
			fig.type = kind;
			fig.rects = regions.flatMap((r) => r.block.rects.map((q) => clip(fig.page, q)));
			for (const r of regions.slice(1)) { r.merged = true; refToId.set(r.key, fig.id); }
		}
		else {
			// synthetic block placed just before the caption
			const synth: Item = { key: `${c.key}.fig`, node: {}, block: { id, type: kind, page: c.block.page, rects: [rect], text: "" } };
			items.splice(items.indexOf(c), 0, synth);
			fig = synth.block;
			primary = synth;
		}
		c.block.captionOf = fig.id;
		const seen = [...figures, ...tables].some((e) => e.label === lab!.label);
		const entry: FigureOrTable = { id: fig.id, kind, label: seen ? `${lab!.label} (cont.)` : lab!.label, page: fig.page, rect, captionBlockId: c.block.id, caption: c.block.text };
		(kind === "figure" ? figures : tables).push(entry);
		// sub-captions ("(a)", panel text) lying inside the figure rect belong to it
		for (const o of caps) {
			if (o === c || o.block.captionOf || o.block.page !== fig.page || !o.block.rects[0]) continue;
			const r = o.block.rects[0];
			if (r[0] >= rect[0] - 4 && r[2] <= rect[2] + 4 && r[1] >= rect[1] - 4 && r[3] <= rect[3] + 4) o.block.captionOf = fig.id;
		}
	}

	// -- 6. references
	let refItems = live().filter((i) => i.block.type === "reference");
	if (!refItems.length) {
		// fall back to "everything after a References heading"
		const list = live();
		const h = list.findIndex((i) => i.block.type === "heading" && REF_HEADING.test(i.block.text));
		if (h >= 0) {
			for (let k = h + 1; k < list.length; k++) {
				const b = list[k].block;
				if (b.type === "heading" || b.type === "title") break;
				if (b.type === "paragraph") { b.type = "reference"; refItems.push(list[k]); }
				else if (b.type === "list") {
					b.type = "reference";
					// split the list into one reference per item
					const lines = b.text.split("\n").filter(Boolean);
					const node = list[k].node;
					const idx = items.indexOf(list[k]);
					const newItems: Item[] = lines.map((t, n) => {
						const li = node.content?.[n];
						const rr = rectsOf(li ?? node);
						const blk: Block = { id: `${b.id}.${n}`, type: "reference", page: rr.rects.length ? rr.page : b.page, rects: rr.rects.length ? rr.rects : b.rects, text: t };
						return { key: `${list[k].key}.${n}`, node: li ?? {}, block: blk };
					});
					list[k].merged = true;
					items.splice(idx + 1, 0, ...newItems);
					refItems.push(...newItems);
				}
			}
		}
	}
	refItems = refItems.filter((i) => !i.merged);
	const references: ReferenceEntry[] = refItems.map((i, n) => ({
		index: n + 1,
		text: i.block.text.replace(/^\s*(?:\[\s*\d+\s*\]|\(\s*\d+\s*\)|\d+\s*[.)])\s*/, ""),
		page: i.block.page,
		rects: i.block.rects,
	}));

	// -- 7. result
	const blocks = items.filter((i) => !i.merged).map((i) => i.block);
	const idOf = (ref: number[]) => refToId.get(ref.join(".")) ?? refToId.get(String(ref[0])) ?? "b" + ref[0];
	const outline: DocStructure["outline"] = [];
	(function walk(list: any[] | undefined, d: number) {
		for (const o of list ?? []) {
			if (o && typeof o.title === "string" && o.title.trim() && Array.isArray(o.ref)) outline.push({ title: o.title.trim(), level: d + 1, blockId: idOf(o.ref) });
			walk(o.children, d + 1);
		}
	})(sdt.catalog?.outline, 0);
	if (!outline.length) {
		for (const b of blocks) if (b.type === "heading" || b.type === "title") outline.push({ title: b.text, level: b.level ?? 2, blockId: b.id });
	}
	return { blocks, figures, tables, references, outline };
}
