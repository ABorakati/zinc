import { createContext, createSignal, useContext, type Accessor } from "solid-js";
import type { SetStoreFunction } from "solid-js/store";
import type { Creator, ItemDetail, ZoteroItemData } from "../api";
import type { ZoteroSchema } from "./api";

export interface PaneCtx {
	/** Reactive store holding the currently shown item. */
	d: ItemDetail;
	setD: SetStoreFunction<ItemDetail>;
	/** Optimistic PATCH of item data; reverts and toasts on error. */
	save: (patch: Partial<ZoteroItemData>) => Promise<void>;
	/** Re-fetch the item from the server. */
	reload: () => Promise<void>;
	schema: Accessor<ZoteroSchema | undefined>;
}

export const PaneContext = createContext<PaneCtx>();
export const usePane = () => useContext(PaneContext)!;

// ---- collapsed section state (persisted) ------------------------------------
const LS_KEY = "zn.itempane.collapsed";
function load(): Record<string, boolean> {
	try { return JSON.parse(localStorage.getItem(LS_KEY) ?? "{}") ?? {}; } catch { return {}; }
}
const [collapsed, setCollapsedSig] = createSignal<Record<string, boolean>>(load());
export const isCollapsed = (id: string) => !!collapsed()[id];
export function setCollapsed(id: string, v: boolean) {
	const next = { ...collapsed(), [id]: v };
	setCollapsedSig(next);
	try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
}

// ---- helpers -----------------------------------------------------------------
export const yearOf = (d?: string) => {
	const m = d?.match(/\b(\d{4})\b/);
	return m ? +m[1] : null;
};

export const creatorLast = (c: Creator) => (c.name !== undefined ? c.name : c.lastName ?? "");

/** "Smith", "Smith and Jones", "Smith et al." using the first creator type that is present. */
export function creatorsSummary(creators: Creator[] | undefined, primary: string): string {
	const list = creators ?? [];
	let pick = list.filter((c) => c.creatorType === primary);
	if (!pick.length) pick = list.filter((c) => c.creatorType !== "contributor");
	if (!pick.length) pick = list;
	const names = pick.map(creatorLast).filter(Boolean);
	if (names.length === 0) return "";
	if (names.length === 1) return names[0];
	if (names.length === 2) return `${names[0]} and ${names[1]}`;
	return `${names[0]} et al.`;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const monthIdx = (s: string) => {
	const l = s.toLowerCase();
	const i = MONTHS.findIndex((m) => m.startsWith(l.slice(0, 3)) && m.startsWith(l));
	return i < 0 ? 0 : i + 1;
};

/** Rough equivalent of Zotero's strToDate: returns the parsed year/month/day parts, if any. */
export function parseDate(s: string): { y?: string; m?: string; d?: string } | null {
	const t = s.trim();
	if (!t) return null;
	let m = t.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
	if (m) return { y: m[1], m: String(+m[2]), d: m[3] ? String(+m[3]) : undefined };
	m = t.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/); // day/month/year (non-US, as Zotero's default locale parsing)
	if (m) return { y: m[3], m: String(+m[2]), d: String(+m[1]) };
	m = t.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
	if (m && monthIdx(m[1])) return { y: m[3], m: String(monthIdx(m[1])), d: String(+m[2]) };
	m = t.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/);
	if (m && monthIdx(m[2])) return { y: m[3], m: String(monthIdx(m[2])), d: String(+m[1]) };
	m = t.match(/^([A-Za-z]{3,9})\.?,?\s+(\d{4})$/);
	if (m && monthIdx(m[1])) return { y: m[2], m: String(monthIdx(m[1])) };
	m = t.match(/\b(\d{4})\b/);
	return m ? { y: m[1] } : null;
}

export function fmtTimestamp(iso?: string): string {
	if (!iso) return "";
	const d = new Date(iso);
	return isNaN(+d) ? iso : d.toLocaleString(undefined, { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function firstLine(html: string): string {
	const text = html
		.replace(/<\/(p|div|h[1-6]|li|br)>|<br\s*\/?>/gi, "\n")
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
	return text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}
