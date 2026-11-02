// DOM-free helpers shared by the citation popup (popup.ts): reading the Word cursor, turning formatted references into
// safe HTML, and the one-line item header. Kept separate so they run under bun test.
import type { CitedItemView } from "./app";
import { parseFieldCode, type Run } from "./fields";

export interface PopupTarget {
	code: string;
	ref: { story: string; idx: number } | null;
}

/** The Word cursor object carried by `popup.show` -> the citation field it sits in, or null when it is not a Zotero citation. */
export function targetFromCursor(c: any): PopupTarget | null {
	const code = typeof c?.code === "string" ? c.code : "";
	if (!code) return null;
	const parsed = parseFieldCode(code);
	if (!parsed || parsed.kind !== "item") return null;
	const r = c.ref;
	const ref = r && typeof r.story === "string" && typeof r.idx === "number" ? { story: r.story as string, idx: r.idx as number } : null;
	return { code, ref };
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!);

/** Styled runs -> HTML (text escaped; italic/bold/sup/sub/small-caps only). */
export function runsToHtml(runs: Run[]): string {
	return runs
		.map((r) => {
			let h = escapeHtml(r.t).replace(/\r|\n/g, " ");
			if (r.sc) h = `<span style="font-variant:small-caps">${h}</span>`;
			if (r.sup) h = `<sup>${h}</sup>`;
			if (r.sub) h = `<sub>${h}</sub>`;
			if (r.b) h = `<b>${h}</b>`;
			if (r.i) h = `<i>${h}</i>`;
			return h;
		})
		.join("");
}

/** "creators · year · publication" header line. */
export function metaLine(v: Pick<CitedItemView, "authors" | "year" | "journal">): string {
	return [v.authors, v.year, v.journal].filter(Boolean).join(" · ");
}

/** Locator / prefix / suffix chips of a cited item ("p. 23-25", "see … and others"). */
export function noteChips(v: Pick<CitedItemView, "locator" | "prefix" | "suffix">): string[] {
	const out: string[] = [];
	if (v.locator) out.push("loc. " + v.locator);
	if (v.prefix) out.push("prefix: " + v.prefix);
	if (v.suffix) out.push("suffix: " + v.suffix);
	return out;
}

/** Height to ask the host for: the content height, rounded up, capped (the page scrolls inside beyond the cap). */
export function popupHeight(contentHeight: number, cap = 520, min = 80): number {
	return Math.max(min, Math.min(cap, Math.ceil(contentHeight)));
}
