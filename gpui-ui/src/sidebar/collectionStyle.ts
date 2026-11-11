// Local, unsynced presentation of collections: colour, icon, user-made section, pin, plus the sidebar's sort / group choices.
// Kept OUT of the collection's Zotero JSON (it syncs to zotero.org, which rejects unknown fields) in a sidecar next to read-state.json
// (%APPDATA%\zotero-next-gpui\collection-style.json; ZN_COLLECTION_STYLE redirects it, "off" disables persistence).
// The store is a plain object with an injectable path / clock / change hook, so tests use a temp dir and no Solid; the singleton at the
// bottom wires it to a Solid signal so reads are reactive.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "../../../core/src/platform-dirs";
import { createSignal } from "solid-js";

export type SortKey = "name-asc" | "name-desc" | "created" | "modified" | "items";
export type GroupKey = "none" | "colour" | "section";
export const SORT_KEYS: readonly SortKey[] = ["name-asc", "name-desc", "created", "modified", "items"];
export const GROUP_KEYS: readonly GroupKey[] = ["none", "colour", "section"];
export const SORT_LABELS: Record<SortKey, string> = {
	"name-asc": "Name A–Z", "name-desc": "Name Z–A", created: "Date created", modified: "Date modified", items: "Number of items",
};
export const GROUP_LABELS: Record<GroupKey, string> = { none: "None", colour: "By colour", section: "By section" };

/** The Quiet Paper folder palette (sidebar/parts.tsx FOLDER_COLORS) plus a sky blue; ids are what the sidecar stores. */
export const PALETTE: readonly { id: string; name: string; hex: string }[] = [
	{ id: "blue", name: "Blue", hex: "#2B5FA8" },
	{ id: "sky", name: "Sky", hex: "#2E8AB8" },
	{ id: "green", name: "Green", hex: "#1F7A62" },
	{ id: "amber", name: "Amber", hex: "#B76A12" },
	{ id: "rust", name: "Rust", hex: "#C0532E" },
	{ id: "rose", name: "Rose", hex: "#B2457A" },
	{ id: "violet", name: "Violet", hex: "#6A4FC8" },
	{ id: "slate", name: "Slate", hex: "#5F6B7A" },
];
export const paletteHex = (id: string | undefined): string | undefined => PALETTE.find((c) => c.id === id)?.hex;

/** Lucide icons a collection can use (all exist in lucide-static); "folder" is the default and not stored. */
export const ICONS: readonly string[] = [
	"book", "book-open", "bookmark", "star", "heart", "flag", "lightbulb", "flask-conical", "microscope", "brain",
	"graduation-cap", "file-text", "newspaper", "pen-line", "archive", "inbox", "layers", "tag", "globe", "users",
	"briefcase", "calendar", "target", "zap",
];

export interface CollectionStyle { color?: string; icon?: string; section?: string }
export interface Stamp { c: number; m: number; sig: string }
export interface StyleData {
	sort: SortKey;
	group: GroupKey;
	/** User-made sections, in creation order. */
	sections: string[];
	/** Collapsed group headers: `sec:<name>`, `sec-default`, `col:<id>`, `col-none`, `pinned`, `all`. */
	collapsed: string[];
	/** Pinned collection keys in pin order. */
	pins: string[];
	styles: Record<string, CollectionStyle>;
	/** First-seen / last-changed times: the core sends no dates for collections, so "Date created / modified" use these. */
	stamps: Record<string, Stamp>;
	stampsSeeded: boolean;
}

export function collectionStylePath(): string | null {
	const env = process.env.ZN_COLLECTION_STYLE;
	if (env === "off") return null;
	if (env) return env;
	return join(configDir(), "zotero-next-gpui", "collection-style.json");
}

const empty = (): StyleData => ({ sort: "name-asc", group: "none", sections: [], collapsed: [], pins: [], styles: {}, stamps: {}, stampsSeeded: false });
const isStrs = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Parse a file's JSON defensively: wrong-shaped parts fall back to defaults. */
export function parseStyleData(raw: unknown): StyleData {
	const d = empty();
	if (!isObj(raw)) return d;
	const prefs = isObj(raw.prefs) ? raw.prefs : {};
	if (SORT_KEYS.includes(prefs.sort as SortKey)) d.sort = prefs.sort as SortKey;
	if (GROUP_KEYS.includes(prefs.group as GroupKey)) d.group = prefs.group as GroupKey;
	if (isStrs(raw.sections)) d.sections = [...new Set(raw.sections)];
	if (isStrs(raw.collapsed)) d.collapsed = raw.collapsed;
	if (isStrs(raw.pins)) d.pins = [...new Set(raw.pins)];
	if (isObj(raw.styles)) {
		for (const [k, v] of Object.entries(raw.styles)) {
			if (!isObj(v)) continue;
			const s: CollectionStyle = {};
			if (typeof v.color === "string" && paletteHex(v.color)) s.color = v.color;
			if (typeof v.icon === "string" && v.icon) s.icon = v.icon;
			if (typeof v.section === "string" && v.section) s.section = v.section;
			if (s.color || s.icon || s.section) d.styles[k] = s;
		}
	}
	if (isObj(raw.stamps)) {
		for (const [k, v] of Object.entries(raw.stamps)) {
			if (isObj(v) && typeof v.c === "number" && typeof v.m === "number" && typeof v.sig === "string") d.stamps[k] = { c: v.c, m: v.m, sig: v.sig };
		}
	}
	d.stampsSeeded = raw.stampsSeeded === true;
	return d;
}

export interface StoreOptions {
	/** Sidecar file; null = in memory only. */
	path: string | null;
	/** Called after every change (the singleton bumps its Solid signal here). */
	onChange?: () => void;
	/** Called by every read (the singleton reads its signal here so Solid tracks it). */
	track?: () => void;
	debounceMs?: number;
	now?: () => number;
}

export function createCollectionStyleStore(opts: StoreOptions) {
	const { path } = opts;
	const now = opts.now ?? Date.now;
	let data = empty();
	if (path && existsSync(path)) {
		try { data = parseStyleData(JSON.parse(readFileSync(path, "utf8"))); } catch { data = empty(); }
	}
	let timer: ReturnType<typeof setTimeout> | undefined;

	function persist(): void {
		if (!path) return;
		try {
			mkdirSync(dirname(path), { recursive: true });
			const out = {
				_version: 1,
				prefs: { sort: data.sort, group: data.group },
				sections: data.sections, collapsed: data.collapsed, pins: data.pins,
				styles: data.styles, stamps: data.stamps, stampsSeeded: data.stampsSeeded,
			};
			const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
			writeFileSync(temp, JSON.stringify(out, null, 2), "utf8");
			renameSync(temp, path);
		} catch { /* ignore write errors */ }
	}
	function changed(): void {
		opts.onChange?.();
		if (!path) return;
		clearTimeout(timer);
		timer = setTimeout(() => { timer = undefined; persist(); }, opts.debounceMs ?? 250);
	}
	function patchStyle(key: string, patch: CollectionStyle): void {
		const next = { ...data.styles[key], ...patch };
		for (const k of Object.keys(next) as (keyof CollectionStyle)[]) if (next[k] === undefined) delete next[k];
		if (Object.keys(next).length) data.styles[key] = next;
		else delete data.styles[key];
		changed();
	}

	return {
		get(): Readonly<StyleData> { opts.track?.(); return data; },
		styleOf(key: string): CollectionStyle { opts.track?.(); return data.styles[key] ?? {}; },
		setSort(s: SortKey): void { if (data.sort !== s) { data.sort = s; changed(); } },
		setGroup(g: GroupKey): void { if (data.group !== g) { data.group = g; changed(); } },
		setColor(key: string, color: string | undefined): void { patchStyle(key, { color: color && paletteHex(color) ? color : undefined }); },
		setIcon(key: string, icon: string | undefined): void { patchStyle(key, { icon: icon && icon !== "folder" ? icon : undefined }); },
		setSection(key: string, section: string | undefined): void { patchStyle(key, { section }); },
		/** Add a section (false when the name is empty or taken). */
		addSection(name: string): boolean {
			const n = name.trim();
			if (!n || data.sections.includes(n)) return false;
			data.sections = [...data.sections, n];
			changed();
			return true;
		},
		renameSection(from: string, to: string): boolean {
			const n = to.trim();
			if (!n || n === from || data.sections.includes(n) || !data.sections.includes(from)) return false;
			data.sections = data.sections.map((s) => (s === from ? n : s));
			for (const s of Object.values(data.styles)) if (s.section === from) s.section = n;
			data.collapsed = data.collapsed.map((c) => (c === `sec:${from}` ? `sec:${n}` : c));
			changed();
			return true;
		},
		/** Remove a section; its collections go back to the default "Collections" group. */
		deleteSection(name: string): void {
			data.sections = data.sections.filter((s) => s !== name);
			for (const [k, s] of Object.entries(data.styles)) if (s.section === name) patchStyle(k, { section: undefined });
			data.collapsed = data.collapsed.filter((c) => c !== `sec:${name}`);
			changed();
		},
		toggleCollapsed(id: string): void {
			data.collapsed = data.collapsed.includes(id) ? data.collapsed.filter((c) => c !== id) : [...data.collapsed, id];
			changed();
		},
		isPinned(key: string): boolean { opts.track?.(); return data.pins.includes(key); },
		pin(key: string): void { if (!data.pins.includes(key)) { data.pins = [...data.pins, key]; changed(); } },
		unpin(key: string): void { if (data.pins.includes(key)) { data.pins = data.pins.filter((k) => k !== key); changed(); } },
		/** Drop everything stored for a deleted collection. */
		forget(key: string): void {
			delete data.styles[key];
			delete data.stamps[key];
			data.pins = data.pins.filter((k) => k !== key);
			changed();
		},
		/**
		 * Record first-seen / last-changed times for the flat collection list. The first ever call seeds every existing collection
		 * with time 0 (so ones created afterwards sort as newer); later calls stamp new keys and keys whose name / parent / count changed.
		 */
		observe(flat: readonly { key: string; name: string; parentKey: string | null; itemCount: number }[]): void {
			if (!flat.length) return;
			const t = now();
			let dirty = false;
			const seed = !data.stampsSeeded;
			for (const c of flat) {
				const sig = `${c.name}|${c.parentKey ?? ""}|${c.itemCount}`;
				const st = data.stamps[c.key];
				if (!st) { data.stamps[c.key] = { c: seed ? 0 : t, m: seed ? 0 : t, sig }; dirty = true; }
				else if (st.sig !== sig) { st.sig = sig; st.m = t; dirty = true; }
			}
			if (seed) { data.stampsSeeded = true; dirty = true; }
			if (dirty) changed();
		},
		flush(): void {
			if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
			persist();
		},
	};
}

export type CollectionStyleStore = ReturnType<typeof createCollectionStyleStore>;

const [rev, setRev] = createSignal(0);
/** The app's store (reads are tracked by Solid). */
export const collectionStyle: CollectionStyleStore = createCollectionStyleStore({
	path: collectionStylePath(),
	onChange: () => setRev((n) => n + 1),
	track: () => { rev(); },
});
