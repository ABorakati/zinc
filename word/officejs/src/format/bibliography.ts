// Bibliography paragraph style and formatting for Office.js (`WordDoc.ApplyBibliographyFormat` equivalent).
//
// Desktop Word templates include a built-in "Bibliography" style (`styleBuiltIn = "Bibliography"` works across UI locales),
// whereas Word on the web omits "Bibliography" in blank documents: Zotero's add-in checks `getByNameOrNullObject` and creates
// it with `document.addStyle("Bibliography", "Paragraph")`, then assigns `range.style = "Bibliography"` (custom styles cannot
// be assigned through `styleBuiltIn`).
import type { BibliographyFormat } from "../contracts";

export const HANGING_INDENT_PT = 36;
export const POINTS_PER_LINE = 12;

/** Whether the document's `"Bibliography"` style is Word's built-in style or a custom style added when missing. */
export type BibliographyStyleKind = "builtIn" | "custom";

const docStyleKind = new WeakMap<object, BibliographyStyleKind>();
const pendingStyleProbe = new WeakMap<object, any>();

function bibliographyStyleName(): string {
	return (typeof Word !== "undefined" && Word?.BuiltInStyleName?.bibliography) || "Bibliography";
}

function paragraphStyleType(): string {
	return (typeof Word !== "undefined" && Word?.StyleType?.paragraph) || "Paragraph";
}

function docOfField(field: Word.Field): any {
	return field?.context?.document ?? field?.result?.context?.document ?? null;
}

/**
 * Queue a non-throwing `getByNameOrNullObject("Bibliography")` load onto `context` so that after the caller's next
 * `context.sync()` (for example, the sync that reads/switches `changeTrackingMode` off before writing), a subsequent
 * synchronous `queueBibliographyFormat(field, fmt)` call knows whether `"Bibliography"` is built-in, custom, or missing and
 * can queue `document.addStyle("Bibliography", "Paragraph")` in the same write batch with zero extra round-trips.
 */
export function queueLoadBibliographyStyle(context: Word.RequestContext): void {
	const doc = context?.document;
	if (!doc || typeof doc !== "object" || docStyleKind.has(doc) || typeof doc.getStyles !== "function") return;
	const style = doc.getStyles().getByNameOrNullObject(bibliographyStyleName());
	if (style && typeof style.load === "function") style.load(["isNullObject", "builtIn"]);
	pendingStyleProbe.set(doc, style);
}

/**
 * Async preflight helper: ensures the document has a `"Bibliography"` paragraph style (creating it via `addStyle` when
 * missing, e.g. in Word on the web) and caches whether it is `"builtIn"` or `"custom"` for `queueBibliographyFormat`.
 */
export async function ensureBibliographyStyle(context: Word.RequestContext): Promise<BibliographyStyleKind> {
	const doc = context?.document;
	if (!doc || typeof doc !== "object" || typeof doc.getStyles !== "function") return "builtIn";
	const cached = docStyleKind.get(doc);
	if (cached) return cached;

	const styleName = bibliographyStyleName();
	const style = doc.getStyles().getByNameOrNullObject(styleName);
	if (style && typeof style.load === "function") style.load(["isNullObject", "builtIn"]);
	await context.sync();

	if (style?.isNullObject) {
		doc.addStyle(styleName, paragraphStyleType());
		docStyleKind.set(doc, "custom");
		pendingStyleProbe.delete(doc);
		await context.sync();
		return "custom";
	}

	const kind: BibliographyStyleKind = style?.builtIn === false ? "custom" : "builtIn";
	docStyleKind.set(doc, kind);
	pendingStyleProbe.delete(doc);
	return kind;
}

function resolveOrCreateStyleSync(doc: any, overrideKind?: BibliographyStyleKind): BibliographyStyleKind {
	if (overrideKind) return overrideKind;
	if (!doc || typeof doc !== "object") return "builtIn";

	const cached = docStyleKind.get(doc);
	if (cached) return cached;

	const styleName = bibliographyStyleName();
	let probe = pendingStyleProbe.get(doc);
	if (!probe && typeof doc.getStyles === "function") {
		const styles = doc.getStyles();
		if (styles && typeof styles.getByNameOrNullObject === "function") {
			probe = styles.getByNameOrNullObject(styleName);
		}
	}

	if (probe) {
		try {
			const isMissing: unknown = probe.isNullObject;
			if (isMissing === true) {
				if (typeof doc.addStyle === "function") {
					doc.addStyle(styleName, paragraphStyleType());
				}
				docStyleKind.set(doc, "custom");
				pendingStyleProbe.delete(doc);
				return "custom";
			}
			if (isMissing === false) {
				const kind: BibliographyStyleKind = probe.builtIn === false ? "custom" : "builtIn";
				docStyleKind.set(doc, kind);
				pendingStyleProbe.delete(doc);
				return kind;
			}
		} catch {
			// In real Office.js, reading `.isNullObject` before `context.sync()` throws `PropertyNotLoaded`; fall back to
			// built-in style assignment unless `ensureBibliographyStyle` / `queueLoadBibliographyStyle` ran earlier.
		}
	}

	return "builtIn";
}

/**
 * Queue the `"Bibliography"` paragraph style, hanging indent (`leftIndent = 36`, `firstLineIndent = -36`), entry spacing
 * (`spaceAfter = entrySpacing * 12` pt), and line spacing (`lineSpacing * 12` pt) onto `field.result`. Does not call `sync()`.
 */
export function queueBibliographyFormat(field: Word.Field, fmt: BibliographyFormat, overrideKind?: BibliographyStyleKind): void {
	const res = field.result;
	const styleName = bibliographyStyleName();
	const kind = resolveOrCreateStyleSync(docOfField(field), overrideKind);

	if (kind === "custom") res.style = styleName;
	else res.styleBuiltIn = styleName;

	if (!fmt) return;
	const pf = res.paragraphFormat;
	if (!pf) return;

	if (fmt.hanging || fmt.secondFieldAlign) {
		pf.leftIndent = HANGING_INDENT_PT;
		pf.firstLineIndent = -HANGING_INDENT_PT;
	}
	if (fmt.entrySpacing !== undefined && Number.isFinite(fmt.entrySpacing) && fmt.entrySpacing >= 0) {
		pf.spaceAfter = fmt.entrySpacing * POINTS_PER_LINE;
	}
	if (fmt.lineSpacing !== undefined && Number.isFinite(fmt.lineSpacing) && fmt.lineSpacing > 0) {
		pf.lineSpacing = fmt.lineSpacing * POINTS_PER_LINE;
	}
}
