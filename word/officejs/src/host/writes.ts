import type { BibliographyFormat, ResultWriter } from "../contracts";
import { fieldToOoxml } from "../format/ooxml";
import { resolveFieldRefs, wrapUnwrappedFields } from "./fields";
import { bibliographyHasTrackedFormatting, ensureTrackingUnlocked, withTrackingOff } from "./tracking";
import {
	type FieldRef,
	type LocateEntry,
	type Run,
	SET_MANY_CHUNK_SIZE,
	type StoryId,
	isZincTag,
	kindOf,
	normalizeStory,
	stripAddinPrefix,
	tagForCode,
	trackObj,
	wrapFieldCode,
} from "./types";

function runsFromParams(p: Record<string, unknown>): Run[] {
	if (Array.isArray(p.runs) && p.runs.length > 0) return p.runs as Run[];
	return [{ t: typeof p.text === "string" ? p.text : "" }];
}

function storyFromBodyType(bodyType: unknown): StoryId {
	if (bodyType === "Footnote" || bodyType === "footnote") return "fn";
	if (bodyType === "Endnote" || bodyType === "endnote") return "en";
	return "main";
}

function isInsideRelation(rel: unknown): boolean {
	return (
		rel === "Contains" ||
		rel === "ContainsStart" ||
		rel === "ContainsEnd" ||
		rel === "Equal" ||
		rel === "OverlapsBefore" ||
		rel === "OverlapsAfter"
	);
}

// ---------------------------------------------------------------- doc.locate

export async function locateInBody(
	ctx: Word.RequestContext,
	p: Record<string, unknown>,
	storeLocate: (entry: LocateEntry) => number,
): Promise<{ pos: number }> {
	if (p.end) {
		return { pos: storeLocate({ end: true }) };
	}
	const text = typeof p.afterText === "string" ? p.afterText : "";
	if (!text) throw new Error("afterText is required");
	if (text.length > 250) throw new Error("afterText is limited to 250 characters (Word's search limit)");
	if (text.includes("\r") || text.includes("\n")) throw new Error("afterText must be within one paragraph");
	const occurrence = Math.max(1, Number.isFinite(Number(p.occurrence)) ? Math.trunc(Number(p.occurrence)) : 1);

	const hits = ctx.document.body.search(text, { matchCase: true, matchWholeWord: false, matchWildcards: false });
	hits.load("items");
	await ctx.sync();

	const found = (hits.items ?? []).length;
	if (found < occurrence) {
		const shown = text.length > 60 ? text.slice(0, 60) + "..." : text;
		const suffix =
			found > 0 ? ` as occurrence ${occurrence} (only ${found} occurrence(s) in the document body)` : " in the document body";
		throw new Error(`The text '${shown}' was not found${suffix}. Matching is case-sensitive and covers one paragraph.`);
	}
	return { pos: storeLocate({ afterText: text, occurrence }) };
}

async function resolveLocatedRange(
	ctx: Word.RequestContext,
	pos: number,
	getLocate: (pos: number) => LocateEntry | undefined,
): Promise<Word.Range> {
	if (!Number.isFinite(pos) || pos < 0) throw new Error("the insert position is outside the document");
	if (pos === 0) return ctx.document.body.getRange("Start");
	const entry = getLocate(pos);
	if (!entry) throw new Error("the insert position is outside the document");
	if ("end" in entry) return ctx.document.body.getRange("End");

	const hits = ctx.document.body.search(entry.afterText, { matchCase: true, matchWholeWord: false, matchWildcards: false });
	hits.load("items");
	await ctx.sync();
	const target = (hits.items ?? [])[entry.occurrence - 1];
	if (!target) throw new Error("the insert position is outside the document");
	return target.getRange("End");
}

/**
 * Create a wrapped Zotero field at `range`: the content control first, then the whole field (code and formatted result) from
 * WordprocessingML. Not `insertField("Start", "Addin", ...)`: in Word that makes an ADDIN field without a result part, and the
 * result written to it lands after the field's end (seen in Word for Windows, 2026-11-20).
 */
function queueWrappedField(
	range: Word.Range,
	kind: "item" | "bibl",
	code: string,
	runs: Run[],
	_writer: ResultWriter,
): { cc: Word.ContentControl; field: Word.Field } {
	const cc = range.insertContentControl();
	cc.tag = tagForCode(kind, code);
	cc.insertOoxml(fieldToOoxml("ADDIN " + stripAddinPrefix(code), runs), "Replace");
	const field = cc.fields.getFirst();
	return { cc, field };
}

// ---------------------------------------------------------------- doc.insert

export async function insertDocField(
	ctx: Word.RequestContext,
	p: Record<string, unknown>,
	writer: ResultWriter,
	getLocate: (pos: number) => LocateEntry | undefined,
	tracked: any[],
): Promise<{ ok: true; story: StoryId }> {
	const kind = typeof p.kind === "string" && p.kind ? p.kind : "item";
	const code = typeof p.code === "string" ? p.code.trim() : "";
	if (kindOf(code) !== kind) throw new Error(`code does not match kind ${kind}`);

	await ensureTrackingUnlocked(ctx);

	const placement = typeof p.placement === "string" && p.placement ? p.placement : "inline";
	const runs = runsFromParams(p);

	if (p.after && typeof p.after === "object") {
		if (kind !== "item") throw new Error("only citations can be inserted after another field");
		const afterRef = p.after as FieldRef;
		const afterStory = normalizeStory(afterRef.story);
		const { resolved } = await resolveFieldRefs(ctx, [afterRef], tracked);
		const prev = resolved[0]!;
		let atRange: Word.Range;
		if (!prev.parentCc.isNullObject && isZincTag(prev.parentCc.tag)) {
			atRange = prev.parentCc.getRange("After");
		} else {
			prev.field.select("End");
			atRange = ctx.document.getSelection();
		}
		queueWrappedField(atRange, "item", code, runs, writer);
		await ctx.sync();
		return { ok: true, story: afterStory };
	}

	const wantFootnote = placement === "footnote";
	const wantEndnote = placement === "endnote";
	let range: Word.Range;
	let currentStory: StoryId = "main";
	let usedSelection = false;

	if (p.at && typeof p.at === "object") {
		const atPos = Number((p.at as Record<string, unknown>).pos ?? -1);
		range = await resolveLocatedRange(ctx, atPos, getLocate);
	} else {
		usedSelection = true;
		range = ctx.document.getSelection();
		range.parentBody.load("type");
	}

	// Never nest inside an existing citation/bibliography: continue right after it.
	const parentCc = trackObj(range.parentContentControlOrNullObject, tracked);
	parentCc.load(["isNullObject", "tag"]);
	const paraFields = range.parentParagraph?.fields?.getByTypes?.(["Addin"]) ?? null;
	paraFields?.load("items");
	await ctx.sync();

	if (usedSelection) {
		currentStory = storyFromBodyType(range.parentBody.type);
	}

	if (!parentCc.isNullObject && isZincTag(parentCc.tag)) {
		range = parentCc.getRange("After");
	} else if (paraFields && (paraFields.items ?? []).length > 0) {
		const pfItems: Word.Field[] = paraFields.items;
		const cmps = pfItems.map((pf) => {
			trackObj(pf, tracked);
			trackObj(pf.result, tracked);
			return pf.result.compareLocationWith(range);
		});
		await ctx.sync();
		const insideIdx = cmps.findIndex((c) => isInsideRelation(c.value));
		if (insideIdx >= 0) {
			pfItems[insideIdx]!.select("End");
			range = ctx.document.getSelection();
		}
	}

	if (kind === "bibl") {
		const collapsed = range.getRange("End");
		const freshPara = collapsed.insertParagraph("", "After");
		const { field } = queueWrappedField(freshPara.getRange("Start"), "bibl", code, runs, writer);
		trackObj(field, tracked);
		await ctx.sync();

		// Bibliography paragraph style and indents are applied untracked so Word records no tracked formatting changes.
		const fmt = (p.format && typeof p.format === "object" ? p.format : {}) as BibliographyFormat;
		await withTrackingOff(ctx, async () => {
			writer.queueBibliographyFormat(field, fmt);
			await ctx.sync();
		});
		return { ok: true, story: currentStory };
	}

	let insertTarget = range.getRange("End");
	let outStory: StoryId = currentStory;
	if ((wantFootnote || wantEndnote) && currentStory === "main") {
		const note = wantFootnote ? insertTarget.insertFootnote("") : insertTarget.insertEndnote("");
		insertTarget = note.body.getRange("Start");
		outStory = wantFootnote ? "fn" : "en";
	}

	const { cc } = queueWrappedField(insertTarget, "item", code, runs, writer);
	if (usedSelection && outStory === "main") {
		trackObj(cc, tracked);
	}
	await ctx.sync();

	if (usedSelection && outStory === "main") {
		try {
			cc.getRange("After").select();
			await ctx.sync();
		} catch {
			/* ignore selection move failures */
		}
	}
	return { ok: true, story: outStory };
}

// ---------------------------------------------------------------- bibliography repair + doc.set / doc.setMany

/**
 * Repair a bibliography carrying tracked formatting (`w:pPrChange` / `w:rPrChange`): delete its paragraphs whole
 * (`getRange("Whole")` from first to last result paragraph, marks included) with Track Changes already off and insert
 * a fresh paragraph + wrapper + field with the same code and result.
 */
async function rebuildBibliographyParagraphs(
	ctx: Word.RequestContext,
	field: Word.Field,
	parentCc: Word.ContentControl,
	effectiveCode: string,
	effectiveRuns: Run[],
	fmt: BibliographyFormat | undefined,
	writer: ResultWriter,
	tracked: any[],
): Promise<void> {
	// Strip any existing content-control wrapper first (keepContent=true) so the fresh paragraph inserted after `lastPara`
	// sits at top level in the body rather than inside the old wrapper.
	if (parentCc && !parentCc.isNullObject && isZincTag(parentCc.tag)) {
		parentCc.delete(true);
	}
	const firstPara = trackObj(field.result.paragraphs.getFirst(), tracked);
	const lastPara = trackObj(field.result.paragraphs.getLast(), tracked);
	await ctx.sync();

	const wholeSpan = firstPara.getRange("Whole").expandTo(lastPara.getRange("Whole"));
	// Insert the fresh paragraph right after `lastPara` BEFORE deleting `wholeSpan`, so deleting a bibliography at the end
	// of the body never tries to delete the story's sole remaining final paragraph mark, and middle-of-body position stays exact.
	const freshPara = trackObj(lastPara.insertParagraph("", "After"), tracked);
	wholeSpan.delete();
	await ctx.sync();

	const { field: newField } = queueWrappedField(freshPara.getRange("Start"), "bibl", effectiveCode, effectiveRuns, writer);
	writer.queueBibliographyFormat(newField, fmt ?? {});
	await ctx.sync();
}

export interface SetItemSpec {
	ref: FieldRef;
	code?: string;
	runs?: Run[];
	format?: BibliographyFormat;
}

function parseSetItem(raw: Record<string, unknown>): SetItemSpec {
	if (!raw.ref || typeof raw.ref !== "object") throw new Error("ref is required");
	const code = raw.code !== undefined && raw.code !== null ? String(raw.code) : undefined;
	if (code !== undefined && kindOf(code) === null) throw new Error("not a Zotero field code");
	const runs = Array.isArray(raw.runs) && raw.runs.length > 0 ? (raw.runs as Run[]) : undefined;
	const format = raw.format && typeof raw.format === "object" ? (raw.format as BibliographyFormat) : undefined;
	return { ref: raw.ref as FieldRef, code, runs, format };
}

export async function setDocFields(
	ctx: Word.RequestContext,
	rawItems: Record<string, unknown>[],
	writer: ResultWriter,
	tracked: any[],
): Promise<number> {
	const specs = rawItems.map(parseSetItem);
	if (specs.length === 0) {
		await ensureTrackingUnlocked(ctx);
		return 0;
	}

	const mightTouchBibl = specs.some(
		(s) => s.runs !== undefined && (s.ref.kind === "bibl" || (s.code !== undefined && kindOf(s.code) === "bibl") || !s.ref.kind),
	);
	const { resolved, bodyOoxml, changeTrackingMode } = await resolveFieldRefs(
		ctx,
		specs.map((s) => s.ref),
		tracked,
		{ loadOoxmlIfBibl: mightTouchBibl, loadChangeTrackingMode: true },
	);

	const biblNeedsRepair = bodyOoxml !== null && bibliographyHasTrackedFormatting(bodyOoxml);

	await withTrackingOff(
		ctx,
		async () => {
			// Wrap any unwrapped existing fields (excluding a bibliography we are about to rebuild whole).
			const toWrap = specs
				.map((s, i) => ({ s, r: resolved[i]! }))
				.filter(({ s, r }) => !(r.kind === "bibl" && s.runs && biblNeedsRepair))
				.map(({ s, r }) => ({ field: r.field, parentCc: r.parentCc, kind: r.kind, code: s.code ?? r.code }));
			await wrapUnwrappedFields(ctx, toWrap, tracked);

			// Separate any bibliography requiring whole-paragraph rebuild from normal in-place field writes.
			const normal: { s: SetItemSpec; r: (typeof resolved)[number] }[] = [];
			const rebuilds: { s: SetItemSpec; r: (typeof resolved)[number] }[] = [];
			for (let i = 0; i < specs.length; i++) {
				const s = specs[i]!;
				const r = resolved[i]!;
				if (r.kind === "bibl" && s.runs && biblNeedsRepair) rebuilds.push({ s, r });
				else normal.push({ s, r });
			}

			// Write normal items in chunks of SET_MANY_CHUNK_SIZE (25) per sync.
			for (let offset = 0; offset < normal.length; offset += SET_MANY_CHUNK_SIZE) {
				const chunk = normal.slice(offset, offset + SET_MANY_CHUNK_SIZE);
				for (const { s, r } of chunk) {
					if (s.code !== undefined) {
						r.field.code = wrapFieldCode(s.code);
						if (!r.parentCc.isNullObject && isZincTag(r.parentCc.tag)) {
							const wantTag = tagForCode(r.kind, s.code);
							if (r.parentCc.tag !== wantTag) r.parentCc.tag = wantTag;
						}
					}
					if (s.runs) {
						writer.queueResult(r.field, s.runs);
						if (r.kind === "bibl") {
							writer.queueBibliographyFormat(r.field, s.format ?? {});
						}
					}
				}
				await ctx.sync();
			}

			for (const { s, r } of rebuilds) {
				await rebuildBibliographyParagraphs(
					ctx,
					r.field,
					r.parentCc,
					s.code ?? r.code,
					s.runs ?? [{ t: r.text }],
					s.format,
					writer,
					tracked,
				);
			}
		},
		changeTrackingMode,
	);

	return specs.length;
}

// ---------------------------------------------------------------- doc.delete, doc.unlink, doc.convert, doc.select

export async function deleteDocField(ctx: Word.RequestContext, p: Record<string, unknown>, tracked: any[]): Promise<{ ok: true }> {
	if (!p.ref || typeof p.ref !== "object") throw new Error("ref is required");
	await ensureTrackingUnlocked(ctx);
	const { resolved } = await resolveFieldRefs(ctx, [p.ref as FieldRef], tracked);
	const target = resolved[0]!;
	if (!target.parentCc.isNullObject && isZincTag(target.parentCc.tag)) {
		target.parentCc.delete(false);
	} else {
		target.field.delete();
	}
	await ctx.sync();
	return { ok: true };
}

export async function unlinkDocField(ctx: Word.RequestContext, p: Record<string, unknown>, tracked: any[]): Promise<{ ok: true }> {
	if (!p.ref || typeof p.ref !== "object") throw new Error("ref is required");
	const { resolved, changeTrackingMode } = await resolveFieldRefs(ctx, [p.ref as FieldRef], tracked, {
		loadChangeTrackingMode: true,
	});
	const target = resolved[0]!;

	const ooxmlReq = typeof target.result.getOoxml === "function" ? target.result.getOoxml() : null;
	if (ooxmlReq) await ctx.sync();
	const resultOoxml = ooxmlReq && typeof ooxmlReq.value === "string" ? ooxmlReq.value : "";

	await withTrackingOff(
		ctx,
		async () => {
			if (!target.parentCc.isNullObject && isZincTag(target.parentCc.tag)) {
				const contentRange = target.parentCc.getRange("Content");
				if (resultOoxml && typeof contentRange.insertOoxml === "function") {
					contentRange.insertOoxml(resultOoxml, "Replace");
				} else {
					contentRange.insertText(target.text, "Replace");
				}
				target.parentCc.delete(true);
			} else {
				const origSel = trackObj(ctx.document.getSelection(), tracked);
				target.field.select("Select");
				const sel = ctx.document.getSelection();
				if (resultOoxml && typeof sel.insertOoxml === "function") {
					sel.insertOoxml(resultOoxml, "Replace");
				} else {
					sel.insertText(target.text, "Replace");
				}
				origSel.select();
			}
			await ctx.sync();
		},
		changeTrackingMode,
	);
	return { ok: true };
}

export async function convertDocField(
	ctx: Word.RequestContext,
	p: Record<string, unknown>,
	writer: ResultWriter,
	tracked: any[],
): Promise<{ ok: true; story: StoryId }> {
	if (!p.ref || typeof p.ref !== "object") throw new Error("ref is required");
	const target = typeof p.target === "string" ? p.target : "";
	if (target !== "inline" && target !== "footnote" && target !== "endnote") {
		throw new Error("target must be inline, footnote or endnote");
	}
	await ensureTrackingUnlocked(ctx);

	const ref = p.ref as FieldRef;
	const fromStory = normalizeStory(ref.story);
	const { resolved } = await resolveFieldRefs(ctx, [ref], tracked);
	const cur = resolved[0]!;
	const effectiveCode = typeof p.code === "string" && p.code ? p.code.trim() : cur.code;
	if (kindOf(effectiveCode) !== "item") throw new Error("only citations can be converted");

	const now = fromStory === "main" ? "inline" : fromStory === "fn" ? "footnote" : "endnote";
	const targetStory: StoryId = target === "inline" ? "main" : target === "footnote" ? "fn" : "en";
	if (now === target) return { ok: true, story: fromStory };

	let anchorRange: Word.Range;
	let wholeNote = false;
	const noteItem = cur.raw.noteItem;

	if (fromStory === "main") {
		if (!cur.parentCc.isNullObject && isZincTag(cur.parentCc.tag)) {
			anchorRange = cur.parentCc.getRange("Before");
		} else {
			cur.field.select("Start");
			anchorRange = ctx.document.getSelection();
		}
	} else {
		if (!noteItem) throw new Error("Could not find the note this citation is in.");
		const noteBodyRange = noteItem.body.getRange();
		const noteFields = noteItem.body.fields.getByTypes(["Addin"]);
		noteBodyRange.load("text");
		noteFields.load("items");
		await ctx.sync();

		anchorRange = noteItem.reference.getRange("Before");
		const remaining = (noteBodyRange.text ?? "").replace(cur.text, "").trim();
		wholeNote = (noteFields.items ?? []).length <= 1 && remaining.length === 0;
	}

	// Create the replacement first; remove the original only once the new field exists.
	let newNote: Word.Note | null = null;
	try {
		let destRange = anchorRange;
		if (target !== "inline") {
			newNote = target === "footnote" ? anchorRange.insertFootnote("") : anchorRange.insertEndnote("");
			trackObj(newNote, tracked);
			destRange = newNote.body.getRange("Start");
		}
		queueWrappedField(destRange, "item", effectiveCode, [{ t: cur.text }], writer);
		await ctx.sync();
	} catch (err) {
		if (newNote) {
			try {
				newNote.delete();
				await ctx.sync();
			} catch {
				/* ignore cleanup failure */
			}
		}
		throw err;
	}

	if (fromStory !== "main" && wholeNote && noteItem) {
		noteItem.delete();
	} else if (!cur.parentCc.isNullObject && isZincTag(cur.parentCc.tag)) {
		cur.parentCc.delete(false);
	} else {
		cur.field.delete();
	}
	await ctx.sync();

	return { ok: true, story: targetStory };
}

export async function selectDocField(ctx: Word.RequestContext, p: Record<string, unknown>, tracked: any[]): Promise<{ ok: true }> {
	if (!p.ref || typeof p.ref !== "object") throw new Error("ref is required");
	const { resolved } = await resolveFieldRefs(ctx, [p.ref as FieldRef], tracked);
	resolved[0]!.result.select();
	await ctx.sync();
	return { ok: true };
}
