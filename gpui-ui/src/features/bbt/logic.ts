// Pure logic of the Better BibTeX UI (no window, no network): Quick Copy format choice, settings model, formula-preview state,
// auto-export row text. Unit-tested in logic.test.ts.
import { BBT_FORMATS, type AutoExport, type BbtExportFormat, type BbtSettings, type QuickCopyFormat } from "../../../../core/src/bbt/types";

// ---------------------------------------------------------------- Quick Copy

export const QUICK_COPY_OPTIONS: { value: QuickCopyFormat; label: string; hint: string }[] = [
	{ value: "latex", label: "LaTeX \\cite", hint: "\\cite{key}" },
	{ value: "pandoc", label: "Pandoc", hint: "[@key]" },
	{ value: "key", label: "Citation key", hint: "@key" },
	{ value: "biblatex", label: "BibLaTeX \\autocite", hint: "\\autocite{key}" },
	{ value: "textcite", label: "\\textcite", hint: "\\textcite{key}" },
	{ value: "org-mode", label: "Org-mode", hint: "[[cite:@key]]" },
	{ value: "typst", label: "Typst", hint: "@key" },
];

/** The body of POST /api/bbt/cite for the Quick Copy settings: the LaTeX command only matters for the latex format. */
export function citeRequest(keys: string[], s: Pick<BbtSettings, "quickCopy" | "citeCommand">): { items: string[]; format: QuickCopyFormat; command?: string } {
	const format = QUICK_COPY_OPTIONS.some((o) => o.value === s.quickCopy) ? s.quickCopy : "latex";
	const command = s.citeCommand.trim();
	return format === "latex" && command ? { items: keys, format, command } : { items: keys, format };
}

// ---------------------------------------------------------------- item pane

/** Only regular items have a citation key (notes, attachments and annotations do not). */
export const hasCitationKey = (itemType: string): boolean => !["note", "attachment", "annotation"].includes(itemType);

/** What committing the key box means: a non-empty, changed value pins it; anything else does nothing. */
export function pinTarget(typed: string, current: string): string | null {
	const v = typed.trim();
	return v && v !== current ? v : null;
}

// ---------------------------------------------------------------- settings model

export type FormulaState =
	| { status: "idle"; formula: string }
	| { status: "pending"; formula: string }
	| { status: "ok"; formula: string; preview: string }
	| { status: "error"; formula: string; error: string; position?: number };

/** The user typed: a check is due. */
export function formulaTyped(formula: string): FormulaState {
	return formula.trim() ? { status: "pending", formula } : { status: "error", formula, error: "The formula is empty" };
}

/** A check came back; a result for a formula that is no longer the current one is dropped (returns `state` unchanged). */
export function formulaChecked(state: FormulaState, formula: string, r: { ok: boolean; error?: string; preview?: string; position?: number }): FormulaState {
	if (state.formula !== formula) return state;
	return r.ok ? { status: "ok", formula, preview: r.preview ?? "" } : { status: "error", formula, error: r.error ?? "Invalid formula", position: r.position };
}

/** Save is enabled only for a formula that was checked valid and differs from the saved one. */
export const canSaveFormula = (state: FormulaState, saved: string): boolean => state.status === "ok" && state.formula !== saved;

/** A debouncer with an injectable clock (tests pass their own scheduler). */
export interface Scheduler { set(fn: () => void, ms: number): unknown; clear(h: unknown): void }
const real: Scheduler = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number, s: Scheduler = real): ((...a: A) => void) & { cancel(): void } {
	let h: unknown;
	const d = (...a: A) => { if (h !== undefined) s.clear(h); h = s.set(() => { h = undefined; fn(...a); }, ms); };
	d.cancel = () => { if (h !== undefined) s.clear(h); h = undefined; };
	return d;
}

/** The fields of `draft` that differ from `saved` (what POST /api/bbt/settings gets). */
export function settingsPatch(saved: BbtSettings, draft: Partial<BbtSettings>): Partial<BbtSettings> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(draft)) if (v !== undefined && v !== (saved as unknown as Record<string, unknown>)[k]) out[k] = v;
	return out as Partial<BbtSettings>;
}

/** Whole seconds >= 0 from a text box; undefined when it is not a number. */
export function parseSeconds(text: string): number | undefined {
	const n = Number(text.trim());
	return text.trim() !== "" && Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
}

export const staleKeysNote = (n: number): string =>
	n > 0 ? `${n.toLocaleString()} citation key${n === 1 ? " is" : "s are"} out of date with the formula. Refresh all citation keys to regenerate them.` : "";

// ---------------------------------------------------------------- automatic exports

export const FORMAT_OPTIONS = (Object.keys(BBT_FORMATS) as BbtExportFormat[]).map((f) => ({ value: f, label: BBT_FORMATS[f].label }));
export const TRIGGER_OPTIONS: { value: "change" | "idle"; label: string }[] = [
	{ value: "change", label: "On change" },
	{ value: "idle", label: "When idle" },
];
export const triggerLabel = (t: AutoExport["trigger"]): string => TRIGGER_OPTIONS.find((o) => o.value === t)?.label ?? t;
export const formatLabel = (f: string): string => BBT_FORMATS[f as BbtExportFormat]?.label ?? f;

/** A starter file name for a new automatic export: "My Library.bib". */
export const defaultExportName = (scopeName: string, format: BbtExportFormat): string => `${scopeName.replace(/[\\/:*?"<>|]+/g, "_").trim() || "export"}.${BBT_FORMATS[format].ext}`;

export function statusText(e: AutoExport): string {
	if (e.status === "error") return e.error ? `Error: ${e.error}` : "Error";
	return { idle: "Up to date", pending: "Waiting to export", running: "Exporting…", done: "Up to date" }[e.status];
}

/** The lines of one auto-export row, in display order. */
export function autoExportLines(e: AutoExport, ago: (iso: string | null) => string): { title: string; detail: string; status: string; error: boolean } {
	const count = e.count == null ? "" : `, ${e.count.toLocaleString()} item${e.count === 1 ? "" : "s"}`;
	return {
		title: e.path,
		detail: `${formatLabel(e.format)} · ${e.scopeName} · ${triggerLabel(e.trigger)}`,
		status: `${statusText(e)} · last export ${ago(e.lastExport)}${count}`,
		error: e.status === "error",
	};
}
