// Data-driven settings, as ui/src/settings/registry.ts: one SettingDef per setting, grouped into sections; the Settings page renders
// and searches them. Built-in sections (defs/*.tsx) are registered with the shell's registry (registerSettingsSection), so other
// features add their own sections the same way and the page lists both. A feature that wants the same row look and the search
// can register SettingDefs for its own section id too (registerSetting) and use registerSection for the heading metadata.
import { createMemo, createRoot, createSignal, type Accessor, type JSX } from "solid-js";

export interface SectionDef {
	id: string;
	label: string;
	/** lucide kebab-case name */
	icon?: string;
	/** Left list order, low first. */
	order: number;
	/** One line under the section heading. */
	description?: string;
	/** Extra search terms for the section itself (matches every row in it). */
	keywords?: string[];
}

export interface SettingDef {
	id: string;
	section: string;
	/** Sub-heading inside the section (e.g. "Files and Folders"). */
	group?: string;
	label: string;
	description?: string;
	/** Extra search terms (synonyms, Zotero's wording, related field names). */
	keywords?: string[];
	/** The control; reactive, so read signals inside. */
	control?: () => JSX.Element;
	/** "inline" puts the control beside the text (default), "block" gives it the full row width underneath. */
	layout?: "inline" | "block";
	/** Not implemented: shown dimmed with this note (default "Not available yet") instead of a control. */
	unavailable?: boolean | string;
}

interface ProviderEntry {
	section?: string;
	fn: () => SettingDef[];
	memo?: Accessor<SettingDef[]>;
}

const [sections, setSections] = createSignal<SectionDef[]>([]);
const [settings, setSettings] = createSignal<SettingDef[]>([]);
const providers: ProviderEntry[] = [];
const [providerRev, setProviderRev] = createSignal(0);

const upsert = <T extends { id: string }>(list: T[], x: T) => [...list.filter((y) => y.id !== x.id), x];

export const registerSection = (s: SectionDef) => setSections((l) => upsert(l, s).sort((a, b) => a.order - b.order));
export const registerSetting = (s: SettingDef) => setSettings((l) => upsert(l, s));
export const registerSettings = (list: SettingDef[]) => {
	if (!list.length) return;
	const ids = new Set(list.map((x) => x.id));
	setSettings((l) => [...l.filter((y) => !ids.has(y.id)), ...list]);
};
/** Settings computed from reactive state (e.g. one row per registered keyboard shortcut). Pass `section` to skip computing it for other sections. */
export const registerSettingsProvider = (fn: () => SettingDef[], section?: string) => {
	providers.push({ section, fn });
	setProviderRev((n) => n + 1);
};

const readProvider = (p: ProviderEntry): SettingDef[] => {
	if (!p.memo) p.memo = createRoot(() => createMemo(p.fn));
	return p.memo();
};

/** All settings in registration order, then provided ones. Reactive. */
export function allSettings(): SettingDef[] {
	providerRev();
	return [...settings(), ...providers.flatMap(readProvider)];
}
export { sections };

const sectionMap = createRoot(() =>
	createMemo(() => {
		const map = new Map<string, SectionDef>();
		for (const s of sections()) map.set(s.id, s);
		return map;
	}),
);
const staticBySection = createRoot(() =>
	createMemo(() => {
		const map = new Map<string, SettingDef[]>();
		for (const s of settings()) {
			let list = map.get(s.section);
			if (!list) map.set(s.section, (list = []));
			list.push(s);
		}
		return map;
	}),
);
export const sectionDef = (id: string): SectionDef | undefined => sectionMap().get(id);

// ---------------------------------------------------------------- search

const norm = (s: string) => s.toLowerCase();

/** The search box text (shared: the page owns the input, section bodies filter by it). */
export const [settingsQuery, setSettingsQuery] = createSignal("");

/** Search words of a query (all must match). */
export const queryTokens = (q: string) => norm(q).split(/\s+/).filter(Boolean);

/** True when every token occurs in the setting's label, description, keywords, group or section. */
export function matches(s: SettingDef, sec: SectionDef | undefined, tokens: string[]): boolean {
	if (!tokens.length) return true;
	const hay = norm(
		[s.label, s.description ?? "", s.group ?? "", ...(s.keywords ?? []), sec?.label ?? "", ...(sec?.keywords ?? [])].join(" \n "),
	);
	return tokens.every((t) => hay.includes(t));
}

function groupRows(rows: SettingDef[]): { name?: string; rows: SettingDef[] }[] {
	const groups: { name?: string; rows: SettingDef[] }[] = [];
	for (const r of rows) {
		let g = groups.find((x) => x.name === r.group);
		if (!g) groups.push((g = { name: r.group, rows: [] }));
		g.rows.push(r);
	}
	return groups.sort((a, b) => Number(!!a.name) - Number(!!b.name));
}

const activeTokens = createRoot(() => createMemo(() => queryTokens(settingsQuery())));

/** Filtered + grouped rows for every section, computed once per search query so nav badges, totals and bodies share it. */
const matchedBySection = createRoot(() =>
	createMemo(() => {
		const tokens = activeTokens();
		const out = new Map<string, { name?: string; rows: SettingDef[] }[]>();
		if (!tokens.length) return out;
		const bySec = new Map<string, SettingDef[]>();
		for (const s of allSettings()) {
			if (!matches(s, sectionDef(s.section), tokens)) continue;
			let list = bySec.get(s.section);
			if (!list) bySec.set(s.section, (list = []));
			list.push(s);
		}
		for (const [id, rows] of bySec) out.set(id, groupRows(rows));
		return out;
	}),
);

/** Settings of one section that match the current query, grouped (rows without a group first). Reactive. */
export function sectionRows(sectionId: string): { name?: string; rows: SettingDef[] }[] {
	if (activeTokens().length) return matchedBySection().get(sectionId) ?? [];
	providerRev();
	const base = staticBySection().get(sectionId) ?? [];
	const extra: SettingDef[] = [];
	for (const p of providers) {
		if (p.section !== undefined && p.section !== sectionId) continue;
		for (const s of readProvider(p)) if (s.section === sectionId) extra.push(s);
	}
	return groupRows(extra.length ? [...base, ...extra] : base);
}
export const sectionCount = (sectionId: string): number => sectionRows(sectionId).reduce((n, g) => n + g.rows.length, 0);

// ---------------------------------------------------------------- refresh hooks

export interface ShownHookOptions {
	/** Skip re-running when this hook already ran within the last N ms (default 3000). */
	minIntervalMs?: number;
}

interface ShownHook {
	fn: () => void;
	section?: string;
	minIntervalMs: number;
	lastRun: number;
}

const DEFAULT_MIN_INTERVAL_MS = 3000;
const openHooks: ShownHook[] = [];

/**
 * Run `fn` when the Settings tab is shown (or, when `section` is given, only while that section is visible).
 * Returns an unsubscribe function. Deduplicated by `minIntervalMs` so rapid switches / search keystrokes do not hammer the core.
 */
export function onSettingsShown(fn: () => void, section?: string, opts?: ShownHookOptions): () => void {
	const hook: ShownHook = { fn, section, minIntervalMs: opts?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS, lastRun: -Infinity };
	openHooks.push(hook);
	return () => {
		const i = openHooks.indexOf(hook);
		if (i !== -1) openHooks.splice(i, 1);
	};
}

/** Run `fn` only when Settings section `section` is actually visible (active or matched in search). */
export const onSectionShown = (section: string, fn: () => void, opts?: ShownHookOptions): (() => void) =>
	onSettingsShown(fn, section, opts);

/** Trigger refresh hooks for `visibleSections` (or all hooks when omitted), skipping hooks still within their staleness window. */
export function settingsShown(visibleSections?: Iterable<string>, now = Date.now()): void {
	const visible = visibleSections ? new Set(visibleSections) : null;
	for (const h of [...openHooks]) {
		if (visible && h.section !== undefined && !visible.has(h.section)) continue;
		if (now - h.lastRun < h.minIntervalMs) continue;
		h.lastRun = now;
		h.fn();
	}
}

/** Tests: clear recorded last-run timestamps so subsequent `settingsShown` calls are not throttled. */
export function resetSettingsShownState(): void {
	for (const h of openHooks) h.lastRun = -Infinity;
}
