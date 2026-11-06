// Quick Copy: the text that Copy Bibliography / Copy Citation (Ctrl+Shift+C / Ctrl+Shift+A) and dragging items out of the window produce.
// The format is the Quick Copy citation style (the server-side cite settings) unless an export format is chosen in Settings > Cite
// (`quickExport`, a local preference); logic.ts decides, this file fetches.
import { ioApi, EXPORT_FORMATS, type ExportFormat } from "../io/client";
import { persisted } from "../prefs";
import { citeApi, type CiteSettings } from "./client";
import { dropText, formatRequest, planQuickCopy, type QuickCopyPlan } from "./logic";

/** "" = format with the Quick Copy citation style; otherwise an export format id (BibTeX, RIS, CSL JSON…). */
export const [quickExport, setQuickExport] = persisted<string>("features.cite.quickExport", "", (v) => (typeof v === "string" && (v === "" || EXPORT_FORMATS.some((f) => f.id === v)) ? v : undefined));

export interface QuickCopyContent {
	plan: QuickCopyPlan;
	text: string;
	/** HTML fragment (style-formatted results with HTML enabled only) */
	html?: string;
	/** items that were formatted */
	count: number;
}

/** The Quick Copy settings from the core. */
export const quickCopySettings = (): Promise<CiteSettings["quickCopy"]> => citeApi.settings().then((s) => s.quickCopy);

/** Format `keys` as the plan says. */
export async function formatQuickCopy(keys: string[], plan: QuickCopyPlan): Promise<QuickCopyContent> {
	if (plan.kind === "export") {
		const r = await ioApi.export({ keys, format: plan.format as ExportFormat });
		return { plan, text: r.text, count: r.count };
	}
	const r = await citeApi.format(formatRequest(keys, plan));
	return { plan, text: dropText(r.text ?? ""), html: plan.includeHtml && r.html ? r.html : undefined, count: r.keys.length };
}

/** Plan and format in one go: `how.mode` for the explicit shortcuts, `how.shift` for a drag. */
export async function quickCopyContent(keys: string[], how: { mode?: "bibliography" | "citation"; shift?: boolean } = {}): Promise<QuickCopyContent> {
	return formatQuickCopy(keys, planQuickCopy(await quickCopySettings(), quickExport(), how));
}
