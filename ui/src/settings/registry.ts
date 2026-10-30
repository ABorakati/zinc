// Data-driven settings: a section list plus one definition per setting. The Settings page only renders and searches
// these, so a new setting is one registerSetting() entry in settings/defs/*.tsx (or from any feature's register.ts).
import { createSignal, type Component, type JSX } from "solid-js";

type Icon = Component<{ class?: string }>;

export interface SectionDef {
	id: string;
	label: string;
	icon?: Icon;
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
export const registerSettingsProvider = (fn: () => SettingDef[]) => { providers.push(fn); setProviderRev((n) => n + 1); };

/** All settings in registration order, then provided ones. Reactive. */
export function allSettings(): SettingDef[] {
	providerRev();
	return [...settings(), ...providers.flatMap((p) => p())];
}
export { sections };

// ---------------------------------------------------------------- search

const norm = (s: string) => s.toLowerCase();

/** Search words of a query (all must match). */
export const queryTokens = (q: string) => norm(q).split(/\s+/).filter(Boolean);

/** True when every token occurs in the setting's label, description, keywords, group or section. */
export function matches(s: SettingDef, sec: SectionDef | undefined, tokens: string[]): boolean {
	if (!tokens.length) return true;
	const hay = norm([s.label, s.description ?? "", s.group ?? "", ...(s.keywords ?? []), sec?.label ?? "", ...(sec?.keywords ?? [])].join(" \n "));
	return tokens.every((t) => hay.includes(t));
}
