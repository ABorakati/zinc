import { TRACKING_LOCKED_MESSAGE, kindOf, normalizeFieldCode } from "./types";

export function isTrackingOn(mode: unknown): mode is string {
	return typeof mode === "string" && mode !== "" && mode !== "Off" && mode !== "off";
}

/**
 * Check whether Track Changes is locked (`Lock Tracking` / `wdAllowOnlyRevisions`).
 * When `changeTrackingMode` is `"Off"`, tracking is not locked. When it is on, probe by switching it `"Off"` in its own
 * sync and immediately restoring the user's mode in a `finally` in its own sync; if Word refuses or keeps tracking on,
 * tracking is locked and nothing has changed.
 */
export async function probeTrackingLocked(ctx: Word.RequestContext): Promise<boolean> {
	const doc = ctx.document;
	doc.load("changeTrackingMode");
	await ctx.sync();
	const was = doc.changeTrackingMode;
	if (!isTrackingOn(was)) return false;
	let switchedOff = false;
	try {
		try {
			doc.changeTrackingMode = "Off";
			doc.load("changeTrackingMode");
			await ctx.sync();
			switchedOff = !isTrackingOn(doc.changeTrackingMode);
		} catch {
			switchedOff = false;
		}
		return !switchedOff;
	} finally {
		if (switchedOff) {
			try {
				doc.changeTrackingMode = was;
				await ctx.sync();
			} catch {
				/* best effort restore */
			}
		}
	}
}

/** Refuse a citation write up front while Track Changes is locked (matches `WordDoc.EnsureTrackingUnlocked`). */
export async function ensureTrackingUnlocked(ctx: Word.RequestContext): Promise<void> {
	if (await probeTrackingLocked(ctx)) throw new Error(TRACKING_LOCKED_MESSAGE);
}

/**
 * Run `act` with `document.changeTrackingMode` switched `"Off"` in its own sync, restoring the user's mode in a `finally`
 * in its own sync (also when `act` throws). If `changeTrackingMode` is still on after setting `"Off"`, tracking is locked:
 * throw `TRACKING_LOCKED_MESSAGE` before running `act`.
 */
export async function withTrackingOff<T>(ctx: Word.RequestContext, act: () => Promise<T>, preloadedMode?: unknown): Promise<T> {
	const doc = ctx.document;
	let was = preloadedMode;
	if (was === undefined) {
		doc.load("changeTrackingMode");
		await ctx.sync();
		was = doc.changeTrackingMode;
	}
	if (isTrackingOn(was)) {
		let stillOn: boolean;
		try {
			doc.changeTrackingMode = "Off";
			doc.load("changeTrackingMode");
			await ctx.sync();
			stillOn = isTrackingOn(doc.changeTrackingMode);
		} catch {
			stillOn = true;
		}
		if (stillOn) throw new Error(TRACKING_LOCKED_MESSAGE);
	}
	try {
		return await act();
	} finally {
		if (isTrackingOn(was)) {
			doc.changeTrackingMode = was;
			await ctx.sync();
		}
	}
}

// ---------------------------------------------------------------- OOXML inspection (never call getTrackedChanges)

const XML_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
};

function decodeXml(s: string): string {
	return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, ent: string) => {
		if (ent[0] === "#") {
			const cp = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
			return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
		}
		return XML_ENTITIES[ent] ?? m;
	});
}

function extractTagTexts(xml: string, localName: string): string {
	const re = new RegExp(`<(?:\\w+:)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${localName}>`, "g");
	let out = "";
	for (const m of xml.matchAll(re)) out += decodeXml(m[1]!);
	return out;
}

function extractCid(code: string): string | null {
	const m = /"citationID"\s*:\s*"([^"]+)"/.exec(code);
	return m ? m[1]! : null;
}

export interface OoxmlFieldRecord {
	kind: "item" | "bibl";
	cid: string | null;
	/** Whole field deleted under Track Changes (`w:delInstrText` only, no live `w:instrText`). */
	deleted: boolean;
	/** Field code rewritten under Track Changes (`w:delInstrText` alongside live `w:instrText`). */
	damagedCode: boolean;
	/** Accepted code from `<w:instrText>` when present, else the deleted code. */
	acceptedCode: string;
}

export interface OoxmlInspection {
	fields: OoxmlFieldRecord[];
	deletedCids: Set<string>;
	deletedBibl: boolean;
	deletedCodes: Set<string>;
	damagedByCid: Map<string, string>;
	damagedBiblCode: string | null;
}

/**
 * Inspect `body.getOoxml()` for unwrapped tracked-deleted fields (`w:delInstrText`) and tracked-rewritten field codes,
 * without ever calling `getTrackedChanges()`. Handles both full Word Flat OPC (`w:fldChar`) and compact XML fixtures.
 */
export function inspectOoxmlFields(ooxml: string): OoxmlInspection {
	const res: OoxmlInspection = {
		fields: [],
		deletedCids: new Set(),
		deletedBibl: false,
		deletedCodes: new Set(),
		damagedByCid: new Map(),
		damagedBiblCode: null,
	};
	if (!ooxml || (!ooxml.includes("delInstrText") && !ooxml.includes("ZOTERO_"))) return res;

	const record = (liveRaw: string, delRaw: string) => {
		const live = normalizeFieldCode(liveRaw);
		const del = normalizeFieldCode(delRaw);
		const liveKind = kindOf(live);
		const delKind = kindOf(del);
		const kind = liveKind ?? delKind;
		if (!kind) return;
		const deleted = !liveKind && !!delKind;
		const damagedCode = !!liveKind && delRaw.trim().length > 0;
		const acceptedCode = liveKind ? live : del;
		const cid = extractCid(acceptedCode) ?? extractCid(del);
		res.fields.push({ kind, cid, deleted, damagedCode, acceptedCode });
		if (deleted) {
			if (kind === "bibl") res.deletedBibl = true;
			if (cid) res.deletedCids.add(cid);
			if (del) res.deletedCodes.add(del);
		} else if (damagedCode) {
			if (kind === "bibl") res.damagedBiblCode = acceptedCode;
			if (cid) res.damagedByCid.set(cid, acceptedCode);
		}
	};

	if (/<(?:\w+:)?fldChar\b/.test(ooxml)) {
		const tokenRe = /<(?:\w+:)?fldChar\b[^>]*?\bfldCharType="([^"]+)"[^>]*?\/?>/g;
		const stack: { codeStart: number; sepAt: number }[] = [];
		for (const m of ooxml.matchAll(tokenRe)) {
			const type = m[1];
			const pos = m.index!;
			const after = pos + m[0].length;
			if (type === "begin") {
				stack.push({ codeStart: after, sepAt: -1 });
			} else if (type === "separate" && stack.length > 0) {
				const top = stack[stack.length - 1]!;
				if (top.sepAt < 0) top.sepAt = pos;
			} else if (type === "end" && stack.length > 0) {
				const top = stack.pop()!;
				const codeEnd = top.sepAt >= 0 ? top.sepAt : pos;
				const codeXml = ooxml.slice(top.codeStart, codeEnd);
				if (codeXml.includes("ZOTERO_")) {
					record(extractTagTexts(codeXml, "instrText"), extractTagTexts(codeXml, "delInstrText"));
				}
			}
		}
		return res;
	}

	// Fallback for simplified OOXML without explicit <w:fldChar> delimiters: inspect per paragraph (or whole XML).
	const blocks = [...ooxml.matchAll(/<(?:\w+:)?p\b[^>]*>[\s\S]*?<\/(?:\w+:)?p>/g)].map((m) => m[0]);
	for (const block of blocks.length > 0 ? blocks : [ooxml]) {
		if (!block.includes("delInstrText")) continue;
		record(extractTagTexts(block, "instrText"), extractTagTexts(block, "delInstrText"));
	}
	return res;
}

const TRACKED_FMT_RE = /<(?:\w+:)?(?:pPrChange|rPrChange)\b/;

/**
 * True when the bibliography field in `body.getOoxml()` carries tracked formatting (`w:pPrChange` or `w:rPrChange`
 * inside the bibliography's paragraphs or on the paragraph mark immediately ending/following the bibliography field).
 */
export function bibliographyHasTrackedFormatting(ooxml: string): boolean {
	if (!ooxml) return false;
	const bibAt = ooxml.indexOf("ZOTERO_BIBL");
	if (bibAt < 0) return false;
	if (!TRACKED_FMT_RE.test(ooxml)) return false;

	// Start of the paragraph (or SDT wrapper) in which the bibliography begins.
	const before = ooxml.slice(0, bibAt);
	const pStart = Math.max(before.lastIndexOf("<w:p "), before.lastIndexOf("<w:p>"));
	const sliceStart = pStart >= 0 ? pStart : 0;

	// Find where the bibliography field ends, then include up to the end of that paragraph (and an adjacent empty paragraph if any).
	let endPos = bibAt + "ZOTERO_BIBL".length;
	const fldCharRe = /<(?:\w+:)?fldChar\b[^>]*?\bfldCharType="([^"]+)"[^>]*?\/?>/g;
	fldCharRe.lastIndex = bibAt;
	let depth = 1;
	let sawFldChar = false;
	for (let m = fldCharRe.exec(ooxml); m !== null; m = fldCharRe.exec(ooxml)) {
		sawFldChar = true;
		if (m[1] === "begin") depth++;
		else if (m[1] === "end" && --depth === 0) {
			endPos = m.index + m[0].length;
			break;
		}
	}

	let sliceEnd: number;
	const closeP = ooxml.indexOf("</w:p>", endPos);
	if (closeP >= 0) {
		sliceEnd = closeP + "</w:p>".length;
		// Include an immediately following empty paragraph (after an optional </w:sdtContent></w:sdt>) if it holds a trailing mark change.
		const tail = ooxml.slice(sliceEnd);
		const emptyNextP = /^(?:\s*<\/(?:\w+:)?sdtContent>\s*<\/(?:\w+:)?sdt>)?\s*(<(?:\w+:)?p\b[^>]*>[\s\S]*?<\/(?:\w+:)?p>)/.exec(tail);
		if (emptyNextP && !/<(?:\w+:)?(?:t|instrText|fldChar)\b/.test(emptyNextP[1]!)) {
			sliceEnd += emptyNextP[0].length;
		}
	} else if (!sawFldChar) {
		sliceEnd = ooxml.length;
	} else {
		sliceEnd = Math.min(ooxml.length, endPos + 2048);
	}

	return TRACKED_FMT_RE.test(ooxml.slice(sliceStart, sliceEnd));
}
