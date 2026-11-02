// Lucide icons (the same set lucide-solid draws in the web UI) as GPUIX <svg>. The svg element paints its alpha as a mask
// tinted with style.color, so the stroke colour inside the markup is irrelevant (#000); `color` is what you see.
import { readFileSync } from "node:fs";
import type { Style } from "./contracts";

const iconDir = new URL("../node_modules/lucide-static/icons/", import.meta.url);

/** Name -> inner svg markup (paths etc.), null when the icon does not exist. */
const inner = new Map<string, string | null>();
const missing = new Set<string>();
/** Icon names that were asked for but do not exist in lucide-static. */
export const missingIcons = (): string[] => [...missing].sort();

const FALLBACK = "circle-help";

function kebab(name: string): string {
	// accept lucide-solid component names too: FileText -> file-text, Table2 -> table-2
	if (/[A-Z]/.test(name)) return name.replace(/([a-z\d])([A-Z])/g, "$1-$2").replace(/([A-Za-z])(\d)/g, "$1-$2").toLowerCase();
	return name;
}

function load(name: string): string | null {
	let v = inner.get(name);
	if (v !== undefined) return v;
	try {
		const svg = readFileSync(new URL(`${name}.svg`, iconDir), "utf8");
		const body = /<svg[^>]*>([\s\S]*?)<\/svg>/.exec(svg)?.[1]?.trim();
		v = body ? body.replace(/\s+/g, " ") : null;
	} catch {
		v = null;
	}
	inner.set(name, v);
	return v;
}

const markup = new Map<string, string>();

/** The full <svg> markup for an icon (cached per name + strokeWidth). Unknown names fall back to circle-help. */
export function iconSvg(name: string, strokeWidth = 2): string {
	const key = `${name}|${strokeWidth}`;
	let s = markup.get(key);
	if (s) return s;
	const n = kebab(name);
	let body = load(n);
	if (body === null) {
		missing.add(name);
		body = load(FALLBACK) ?? "";
	}
	s =
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="${strokeWidth}" ` +
		`stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
	markup.set(key, s);
	return s;
}

export function Icon(p: { name: string; size?: number; color: string; strokeWidth?: number; style?: Style }) {
	const size = () => p.size ?? 16;
	return <svg source={iconSvg(p.name, p.strokeWidth)} style={{ flexShrink: 0, ...p.style, width: size(), height: size(), color: p.color }} />;
}

// Convenience mappings mirroring ui/src/lib/icons.tsx (names only; draw with <Icon name=... />).
const TYPE_ICONS: Record<string, string> = {
	journalArticle: "file-text",
	magazineArticle: "newspaper",
	newspaperArticle: "newspaper",
	book: "book",
	bookSection: "book-open",
	webpage: "globe",
	blogPost: "globe",
	conferencePaper: "presentation",
	thesis: "graduation-cap",
	report: "scroll-text",
	preprint: "file-clock",
};
/** Lucide name for a Zotero item type (ui/src/lib/icons.tsx itemTypeIcon). */
export const itemTypeIconName = (t: string): string => TYPE_ICONS[t] ?? "file";
/** Lucide name for an attachment by content type (ui/src/lib/icons.tsx attachmentIcon). */
export const attachmentIconName = (contentType: string | null | undefined, linkMode?: string | null): string =>
	/pdf/i.test(contentType ?? "") ? "file-text" : /epub/i.test(contentType ?? "") ? "book-open" : linkMode === "linked_url" ? "link" : "paperclip";
