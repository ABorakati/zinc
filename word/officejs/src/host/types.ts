import { parseFieldCode, type Run } from "../../../../core/src/cite/docfields";
import type { BibliographyFormat, ResultWriter } from "../contracts";

export type { BibliographyFormat, ResultWriter, Run };

export type StoryId = "main" | "fn" | "en";

export interface FieldRef {
	story?: string;
	idx: number;
	kind?: string;
	cid?: string;
}

export interface FieldInfoOut {
	story: StoryId;
	idx: number;
	kind: "item" | "bibl";
	code: string;
	text: string;
	start: number;
	end: number;
	note: number;
	tracked: boolean;
}

export type LocateEntry = { end: true } | { afterText: string; occurrence: number };

export interface DocHostOptions {
	/** Override the result formatter (defaults to `resultWriter` from `../format`). */
	writer?: ResultWriter;
	/** Override the global `Word` object (for unit tests without mutating globals). */
	word?: any;
	/** Override the global `Office` object (for unit tests without mutating globals). */
	office?: any;
	/** Debounce window in ms for `DocumentSelectionChanged` -> `"cursor"` events (default 250). */
	debounceMs?: number;
}

export const TRACKING_LOCKED_MESSAGE =
	"Track Changes is locked in this document (Review > Track Changes > Lock Tracking), so Zinc cannot switch it off " +
	"while it updates citations, and updating them with tracking on would record every field code as a tracked change " +
	"and damage the citations. Zinc has changed nothing. Unlock tracking (it needs the password), or work on a copy " +
	"without the lock.";

export const SET_MANY_CHUNK_SIZE = 25;
export const PREF_PREFIX = "ZOTERO_PREF_";
export const PREF_CHUNK_LEN = 250;
export const PREF_MAX_CHUNKS = 200;
export const CURSOR_DEBOUNCE_MS = 250;

const ITEM_CODE_RE = /^\s*ADDIN\s+ZOTERO_ITEM\b/;
const BIBL_CODE_RE = /^\s*ADDIN\s+ZOTERO_BIBL\b/;
const MERGEFORMAT_RE = /\s*\\\*\s*MERGEFORMAT\s*$/i;
const ZINC_TAG_PREFIX = "ZINC ";

/** Matches WordDoc.KindOf: "item", "bibl", or null when not a Zotero field (or empty/deleted). */
export function kindOf(code: string | null | undefined): "item" | "bibl" | null {
	if (!code) return null;
	if (ITEM_CODE_RE.test(code)) return "item";
	if (BIBL_CODE_RE.test(code)) return "bibl";
	return null;
}

/** Normalize a raw `field.code` read from an Addin `Word.Field` (strips trailing `\* MERGEFORMAT` and surrounding spaces). */
export function normalizeFieldCode(raw: string | null | undefined): string {
	if (!raw) return "";
	let c = raw.replace(MERGEFORMAT_RE, "").trim();
	if (/^ZOTERO_(?:ITEM|BIBL)\b/.test(c)) c = "ADDIN " + c;
	return c;
}

/** Remove the leading `ADDIN ` token for `Range.insertField("Start", "Addin", codeWithoutAddin, true)`. */
export function stripAddinPrefix(code: string): string {
	return code.trim().replace(/^ADDIN\s+/i, "");
}

/** Surround a field code with spaces the way Word / WordDoc.Wrap stores `field.code`. */
export function wrapFieldCode(code: string): string {
	return " " + code.trim() + " ";
}

/** Two Zotero instructions glued together in one code (damage from an older tracked rewrite). */
export function looksDoubled(code: string): boolean {
	const i = code.indexOf("ZOTERO_");
	return i >= 0 && code.indexOf("ZOTERO_", i + 7) >= 0;
}

/** Content-control tag for a Zotero field: `ZINC <citationID>` for citations, `ZINC bibl` for a bibliography. */
export function tagForCode(kind: "item" | "bibl", code: string): string {
	if (kind === "bibl") return "ZINC bibl";
	const parsed = parseFieldCode(code);
	if (parsed?.kind === "item" && parsed.data.citationID) return ZINC_TAG_PREFIX + parsed.data.citationID;
	const m = /"citationID"\s*:\s*"([^"]+)"/.exec(code);
	return ZINC_TAG_PREFIX + (m?.[1] ?? "item");
}

export function isZincTag(tag: unknown): tag is string {
	return typeof tag === "string" && tag.startsWith(ZINC_TAG_PREFIX);
}

export function storyNumber(story: StoryId): 1 | 2 | 3 {
	return story === "main" ? 1 : story === "fn" ? 2 : 3;
}

export function normalizeStory(story: unknown): StoryId {
	return story === "fn" ? "fn" : story === "en" ? "en" : "main";
}

/** C# WordDoc.CheckField: verify the resolved field still has the expected kind and citationID. */
export function checkFieldCode(rawCode: string | null | undefined, ref: FieldRef): { kind: "item" | "bibl"; code: string } {
	const code = normalizeFieldCode(rawCode);
	const kind = kindOf(code);
	const expectKind = typeof ref.kind === "string" && ref.kind ? ref.kind : null;
	const cid = typeof ref.cid === "string" && ref.cid ? ref.cid : null;
	if (!kind || (expectKind && kind !== expectKind) || (cid && !code.includes(`"${cid}"`))) {
		throw new Error("The document changed under the sidebar. Refresh and try again.");
	}
	return { kind, code };
}

/** Track an Office.js proxy and push it onto `list` for cleanup at the end of `Word.run`. */
export function trackObj<T>(obj: T, list: any[]): T {
	if (obj && typeof (obj as any).track === "function") {
		(obj as any).track();
		list.push(obj);
	}
	return obj;
}

/** Release every tracked proxy (calls `.untrack()` and `ctx.trackedObjects.remove` when available). */
export function untrackAll(ctx: Word.RequestContext, list: any[]): void {
	for (const obj of list) {
		if (!obj) continue;
		try {
			if (typeof obj.untrack === "function") obj.untrack();
			else ctx?.trackedObjects?.remove?.(obj);
		} catch {
			/* ignore already-removed proxy */
		}
	}
	list.length = 0;
}
