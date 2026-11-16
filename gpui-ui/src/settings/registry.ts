// Data-driven settings, as ui/src/settings/registry.ts: one SettingDef per setting, grouped into sections; the Settings page renders
// and searches them. Built-in sections (defs/*.tsx) are registered with the shell's registry (registerSettingsSection), so other
// features add their own sections the same way and the page lists both. A feature that wants the same row look and the search
// can register SettingDefs for its own section id too (registerSetting) and use registerSection for the heading metadata.
import { createSignal, type JSX } from "solid-js";

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

const [sections, setSections] = createSignal<SectionDef[]>([]);
const [settings, setSettings] = createSignal<SettingDef[]>([]);
const providers: (() => SettingDef[])[] = [];
const [providerRev, setProviderRev] = createSignal(0);

const upsert = <T extends { id: string }>(list: T[], x: T) => [...list.filter((y) => y.id !== x.id), x];

export const registerSection = (s: SectionDef) => setSections((l) => upsert(l, s).sort((a, b) => a.order - b.order));
export const registerSetting = (s: SettingDef) => setSettings((l) => upsert(l, s));
export const registerSettings = (list: SettingDef[]) => list.forEach(registerSetting);
/** Settings computed from reactive state (e.g. one row per registered keyboard shortcut). */
export const registerSettingsProvider = (fn: () => SettingDef[]) => {
	providers.push(fn);
	setProviderRev((n) => n + 1);
};

/** All settings in registration order, then provided ones. Reactive. */
export function allSettings(): SettingDef[] {
	providerRev();
	return [...settings(), ...providers.flatMap((p) => p())];
}
export { sections };
export const sectionDef = (id: string): SectionDef | undefined => sections().find((s) => s.id === id);

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

/** Settings of one section that match the current query, grouped (rows without a group first). Reactive. */
export function sectionRows(sectionId: string): { name?: string; rows: SettingDef[] }[] {
	const tokens = queryTokens(settingsQuery());
	const sec = sectionDef(sectionId);
	const rows = allSettings().filter((s) => s.section === sectionId && matches(s, sec, tokens));
	const groups: { name?: string; rows: SettingDef[] }[] = [];
	for (const r of rows) {
		let g = groups.find((x) => x.name === r.group);
		if (!g) groups.push((g = { name: r.group, rows: [] }));
		g.rows.push(r);
	}
	return groups.sort((a, b) => Number(!!a.name) - Number(!!b.name));
}
export const sectionCount = (sectionId: string): number => sectionRows(sectionId).reduce((n, g) => n + g.rows.length, 0);

// ---------------------------------------------------------------- refresh hooks

const openHooks: (() => void)[] = [];
/** Run `fn` each time the Settings tab is shown (and once at start): server-backed settings re-read their state. */
export const onSettingsShown = (fn: () => void) => {
	openHooks.push(fn);
};
export const settingsShown = () => openHooks.forEach((f) => f());
