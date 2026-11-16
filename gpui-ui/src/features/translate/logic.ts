// Pure helpers for the translator features (no UI, no network): response parsing, pick-list state, error matching.

export interface SavedItem {
	key: string;
	title: string;
	itemType: string;
}
export interface WebSaved {
	items: SavedItem[];
	translator: string | null;
	fallback?: "embedded" | "webpage";
}
export interface ChoiceItem {
	key: string;
	title: string;
	checked?: boolean;
}
export interface WebChoices {
	session: string;
	url: string;
	items: ChoiceItem[];
}
export interface TranslatorFormat {
	id: string;
	label: string;
	extension: string;
}

export type WebOutcome = { kind: "saved"; saved: WebSaved } | { kind: "choices"; choices: WebChoices };

/** POST /api/translate/web answers either {items} (saved) or {choices} (pick which to save). */
export function parseWebResponse(r: unknown): WebOutcome {
	const o = (r ?? {}) as { items?: unknown; choices?: unknown };
	if (o.choices && typeof o.choices === "object") {
		const c = o.choices as Partial<WebChoices>;
		return {
			kind: "choices",
			choices: { session: String(c.session ?? ""), url: String(c.url ?? ""), items: Array.isArray(c.items) ? c.items : [] },
		};
	}
	const s = r as Partial<WebSaved>;
	return {
		kind: "saved",
		saved: { items: Array.isArray(o.items) ? (o.items as SavedItem[]) : [], translator: s.translator ?? null, fallback: s.fallback },
	};
}

/** The keys ticked in the pick-list, in list order. */
export const initialChecked = (items: ChoiceItem[]): Set<string> => new Set(items.filter((i) => i.checked).map((i) => i.key));
export const toggleKey = (set: Set<string>, key: string): Set<string> => {
	const n = new Set(set);
	if (n.has(key)) n.delete(key);
	else n.add(key);
	return n;
};
export const allKeys = (items: ChoiceItem[]): Set<string> => new Set(items.map((i) => i.key));
export const selectedKeys = (items: ChoiceItem[], checked: Set<string>): string[] => items.map((i) => i.key).filter((k) => checked.has(k));

/** Short result text: count, then up to three titles. */
export function summarise(items: SavedItem[]): { title: string; description?: string } {
	const n = items.length;
	const head = `Added ${n} item${n === 1 ? "" : "s"}`;
	const titles = items.slice(0, 3).map((i) => i.title || "(untitled)");
	if (!titles.length) return { title: head };
	return { title: head, description: titles.join("\n") + (n > 3 ? `\n…and ${n - 3} more` : "") };
}

/** The core's auto-detect import refuses text it cannot place with this message; the translators may still read it. */
export const isUnrecognisedFormat = (msg: string): boolean => /could not recogni[sz]e the format/i.test(msg);

/** Add https:// when the user typed a bare address. */
export const normaliseUrl = (s: string): string => {
	const t = s.trim();
	return t && !/^[a-z][a-z0-9+.-]*:/i.test(t) ? `https://${t}` : t;
};
