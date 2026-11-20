import { getDocIdentity } from "./prefs";
import { bibliographyHasTrackedFormatting, inspectOoxmlFields, withTrackingOff } from "./tracking";
import {
	type FieldInfoOut,
	type FieldRef,
	type StoryId,
	checkFieldCode,
	isZincTag,
	kindOf,
	looksDoubled,
	normalizeFieldCode,
	normalizeStory,
	tagForCode,
	trackObj,
} from "./types";

export interface RawStoryField {
	story: StoryId;
	/** 1-based index among `getByTypes(["Addin"])` fields of `story`. */
	idx: number;
	/** 0 for main body, 1-based note index for footnotes / endnotes. */
	note: number;
	noteItem: Word.Note | null;
	field: Word.Field;
}

export interface StoryCollections {
	byStory: Record<StoryId, RawStoryField[]>;
	fnNotes: Word.Note[];
	enNotes: Word.Note[];
}

/**
 * List `fields.getByTypes(["Addin"])` on the requested stories (`"main"`, `"fn"`, `"en"`).
 * Uses 1 sync when only `"main"` is requested or there are no notes, 2 syncs when notes exist.
 */
export async function loadStoryAddinFields(
	ctx: Word.RequestContext,
	wanted: ReadonlySet<StoryId> = new Set<StoryId>(["main", "fn", "en"]),
): Promise<StoryCollections> {
	const body = ctx.document.body;
	const mainColl = wanted.has("main") ? body.fields.getByTypes(["Addin"]) : null;
	const fnColl = wanted.has("fn") ? body.footnotes : null;
	const enColl = wanted.has("en") ? body.endnotes : null;

	mainColl?.load("items");
	fnColl?.load("items");
	enColl?.load("items");
	await ctx.sync();

	const fnNotes: Word.Note[] = fnColl?.items ?? [];
	const enNotes: Word.Note[] = enColl?.items ?? [];
	const fnFieldColls = fnNotes.map((n) => {
		const c = n.body.fields.getByTypes(["Addin"]);
		c.load("items");
		return c;
	});
	const enFieldColls = enNotes.map((n) => {
		const c = n.body.fields.getByTypes(["Addin"]);
		c.load("items");
		return c;
	});
	if (fnFieldColls.length > 0 || enFieldColls.length > 0) {
		await ctx.sync();
	}

	const byStory: Record<StoryId, RawStoryField[]> = { main: [], fn: [], en: [] };
	if (mainColl) {
		(mainColl.items ?? []).forEach((f: Word.Field, i: number) => {
			byStory.main.push({ story: "main", idx: i + 1, note: 0, noteItem: null, field: f });
		});
	}
	fnFieldColls.forEach((coll, noteIdx) => {
		const noteItem = fnNotes[noteIdx]!;
		for (const f of coll.items ?? []) {
			byStory.fn.push({ story: "fn", idx: byStory.fn.length + 1, note: noteIdx + 1, noteItem, field: f });
		}
	});
	enFieldColls.forEach((coll, noteIdx) => {
		const noteItem = enNotes[noteIdx]!;
		for (const f of coll.items ?? []) {
			byStory.en.push({ story: "en", idx: byStory.en.length + 1, note: noteIdx + 1, noteItem, field: f });
		}
	});

	return { byStory, fnNotes, enNotes };
}

export interface ResolvedField {
	raw: RawStoryField;
	field: Word.Field;
	result: Word.Range;
	parentCc: Word.ContentControl;
	kind: "item" | "bibl";
	code: string;
	text: string;
}

/**
 * Resolve one or more `FieldRef`s against the document, `.track()`ing every `field`, `field.result` and `parentCc`
 * before any subsequent sync, and verifying `kind` and `cid` (`CheckField`) before returning.
 */
export async function resolveFieldRefs(
	ctx: Word.RequestContext,
	refs: FieldRef[],
	tracked: any[],
	opts: { loadOoxmlIfBibl?: boolean; loadChangeTrackingMode?: boolean } = {},
): Promise<{ resolved: ResolvedField[]; bodyOoxml: string | null; changeTrackingMode: unknown }> {
	const stories = new Set<StoryId>();
	for (const r of refs) stories.add(normalizeStory(r.story));
	if (opts.loadChangeTrackingMode) ctx.document.load("changeTrackingMode");

	const { byStory } = await loadStoryAddinFields(ctx, stories);
	const changeTrackingMode = opts.loadChangeTrackingMode ? ctx.document.changeTrackingMode : undefined;

	const unique = new Map<string, { raw: RawStoryField; parentCc: Word.ContentControl }>();
	for (const r of refs) {
		const story = normalizeStory(r.story);
		const idx = Number(r.idx);
		const list = byStory[story];
		const raw = Number.isInteger(idx) && idx >= 1 ? list[idx - 1] : undefined;
		if (!raw) {
			throw new Error(`The document changed: field ${idx} no longer exists. Refresh and try again.`);
		}
		if (raw.noteItem) trackObj(raw.noteItem, tracked);
		const key = `${story}|${idx}`;
		if (!unique.has(key)) {
			trackObj(raw.field, tracked);
			raw.field.load("code");
			trackObj(raw.field.result, tracked);
			raw.field.result.load("text");
			const parentCc = raw.field.parentContentControlOrNullObject;
			trackObj(parentCc, tracked);
			parentCc.load(["isNullObject", "id", "tag"]);
			unique.set(key, { raw, parentCc });
		}
	}

	const ooxmlResult = opts.loadOoxmlIfBibl ? ctx.document.body.getOoxml() : null;
	await ctx.sync();

	const resolved: ResolvedField[] = [];
	for (const r of refs) {
		const story = normalizeStory(r.story);
		const entry = unique.get(`${story}|${Number(r.idx)}`)!;
		const { kind, code } = checkFieldCode(entry.raw.field.code, r);
		resolved.push({
			raw: entry.raw,
			field: entry.raw.field,
			result: entry.raw.field.result,
			parentCc: entry.parentCc,
			kind,
			code,
			text: entry.raw.field.result.text ?? "",
		});
	}

	return {
		resolved,
		bodyOoxml: ooxmlResult ? String(ooxmlResult.value ?? "") : null,
		changeTrackingMode,
	};
}

/**
 * Wrap unwrapped Zotero fields in rich-text content controls tagged `ZINC <citationID>` (`ZINC bibl` for bibliography).
 * Must be called while Track Changes is already switched `"Off"`. Preserves the user's selection.
 */
export async function wrapUnwrappedFields(
	ctx: Word.RequestContext,
	targets: { field: Word.Field; parentCc: Word.ContentControl; kind: "item" | "bibl"; code: string }[],
	tracked: any[],
): Promise<boolean> {
	const unwrapped = targets.filter((t) => !t.parentCc || t.parentCc.isNullObject || !isZincTag(t.parentCc.tag));
	if (unwrapped.length === 0) return false;

	const origSel = trackObj(ctx.document.getSelection(), tracked);
	for (const t of unwrapped) {
		t.field.select("Select");
		const cc = ctx.document.getSelection().insertContentControl();
		cc.tag = tagForCode(t.kind, t.code);
	}
	origSel.select();
	await ctx.sync();
	return true;
}

// ---------------------------------------------------------------- doc.fields

function extractCidFromCode(code: string): string | null {
	const m = /"citationID"\s*:\s*"([^"]+)"/.exec(code);
	return m ? m[1]! : null;
}

function isBeforeRelation(rel: unknown): boolean {
	return rel === "Before" || rel === "AdjacentBefore" || rel === "OverlapsBefore" || rel === "ContainsStart";
}

/**
 * Scan every Zotero field in document order (`main`, `fn`, `en`), skipping tracked-deleted citations, flagging fields
 * damaged by older tracked rewrites or bibliography tracked formatting (`checkTracked`), and wrapping unwrapped Zotero
 * fields with Track Changes off during a refresh (`checkTracked`).
 */
export async function scanDocFields(ctx: Word.RequestContext, checkTracked: boolean, tracked: any[]): Promise<FieldInfoOut[]> {
	const { byStory, fnNotes, enNotes } = await loadStoryAddinFields(ctx);
	const allRaw = [...byStory.main, ...byStory.fn, ...byStory.en];
	if (allRaw.length === 0) return [];

	// Track every field, field.result and parent content control we touch after the listing sync.
	const items = allRaw.map((raw) => {
		if (raw.noteItem) trackObj(raw.noteItem, tracked);
		trackObj(raw.field, tracked);
		raw.field.load("code");
		trackObj(raw.field.result, tracked);
		raw.field.result.load("text");
		const parentCc = trackObj(raw.field.parentContentControlOrNullObject, tracked);
		parentCc.load(["isNullObject", "id", "tag"]);
		return { raw, parentCc };
	});

	// Query Deleted / Added content controls per populated body in one batch (WordApi 1.5; never getTrackedChanges).
	const ccStates: {
		story: StoryId;
		note: number;
		deleted: Word.ContentControlCollection;
		added: Word.ContentControlCollection;
	}[] = [];
	const queueBodyCcStates = (story: StoryId, note: number, body: Word.Body) => {
		const deleted = body.contentControls.getByChangeTrackingStates(["Deleted"]);
		const added = body.contentControls.getByChangeTrackingStates(["Added"]);
		deleted.load(["id", "tag"]);
		added.load(["id", "tag"]);
		ccStates.push({ story, note, deleted, added });
	};
	if (byStory.main.length > 0) queueBodyCcStates("main", 0, ctx.document.body);
	const fnNotesUsed = new Set(byStory.fn.map((x) => x.note));
	for (const n of fnNotesUsed) queueBodyCcStates("fn", n, fnNotes[n - 1]!.body);
	const enNotesUsed = new Set(byStory.en.map((x) => x.note));
	for (const n of enNotesUsed) queueBodyCcStates("en", n, enNotes[n - 1]!.body);

	await ctx.sync();

	const deletedCcIds = new Set<string>();
	const addedCcIds = new Set<string>();
	const deletedCcObjs = new Set<any>();
	const addedCcObjs = new Set<any>();
	for (const st of ccStates) {
		for (const cc of st.deleted.items ?? []) {
			deletedCcObjs.add(cc);
			if (cc?.id !== undefined) deletedCcIds.add(`${st.story}|${st.note}|${String(cc.id)}`);
		}
		for (const cc of st.added.items ?? []) {
			addedCcObjs.add(cc);
			if (cc?.id !== undefined) addedCcIds.add(`${st.story}|${st.note}|${String(cc.id)}`);
		}
	}

	const isCcInSet = (story: StoryId, note: number, cc: Word.ContentControl, ids: Set<string>, objs: Set<any>): boolean => {
		if (!cc || cc.isNullObject) return false;
		if (cc.id !== undefined) return ids.has(`${story}|${note}|${String(cc.id)}`);
		return objs.has(cc);
	};

	// Filter to Zotero fields, detect unwrapped fields / doubled codes / bibliography needing OOXML inspection.
	type Candidate = {
		raw: RawStoryField;
		parentCc: Word.ContentControl;
		wrapped: boolean;
		added: boolean;
		kind: "item" | "bibl";
		code: string;
		text: string;
		tracked: boolean;
	};
	const candidates: Candidate[] = [];
	let hasUnwrappedMainOrFn = false;
	const unwrappedEnNotes = new Set<number>();
	let hasDoubled = false;
	let hasBibl = false;

	for (const it of items) {
		const { raw, parentCc } = it;
		const wrapped = !!parentCc && !parentCc.isNullObject && isZincTag(parentCc.tag);
		if (wrapped && isCcInSet(raw.story, raw.note, parentCc, deletedCcIds, deletedCcObjs)) {
			continue; // Tracked-deleted citation: skip so it leaves numbering.
		}
		const code = normalizeFieldCode(raw.field.code);
		const kind = kindOf(code);
		if (!kind) continue;
		const added = wrapped && isCcInSet(raw.story, raw.note, parentCc, addedCcIds, addedCcObjs);
		if (!wrapped) {
			if (raw.story === "en") unwrappedEnNotes.add(raw.note);
			else hasUnwrappedMainOrFn = true;
		}
		if (looksDoubled(code)) hasDoubled = true;
		if (kind === "bibl") hasBibl = true;
		candidates.push({
			raw,
			parentCc,
			wrapped,
			added,
			kind,
			code,
			text: raw.field.result.text ?? "",
			tracked: false,
		});
	}

	if (candidates.length === 0) return [];

	// Fetch OOXML only when needed: unwrapped fields (w:delInstrText fallback), doubled codes, or checkTracked checks.
	const needBodyOoxml = hasUnwrappedMainOrFn || hasDoubled || (checkTracked && (hasBibl || candidates.some((c) => !c.added)));
	const bodyOoxmlReq = needBodyOoxml ? ctx.document.body.getOoxml() : null;
	const enOoxmlReqs = new Map<number, any>();
	for (const n of unwrappedEnNotes) {
		enOoxmlReqs.set(n, enNotes[n - 1]!.body.getOoxml());
	}
	if (bodyOoxmlReq || enOoxmlReqs.size > 0) {
		await ctx.sync();
	}

	const bodyOoxml = bodyOoxmlReq ? String(bodyOoxmlReq.value ?? "") : "";
	const bodyInspect = bodyOoxml ? inspectOoxmlFields(bodyOoxml) : null;
	const enInspects = new Map<number, ReturnType<typeof inspectOoxmlFields>>();
	for (const [n, req] of enOoxmlReqs) {
		enInspects.set(n, inspectOoxmlFields(String(req?.value ?? "")));
	}
	const biblTrackedFmt = checkTracked && hasBibl && bodyOoxml ? bibliographyHasTrackedFormatting(bodyOoxml) : false;

	const live: Candidate[] = [];
	for (const c of candidates) {
		const inspect = c.raw.story === "en" ? (enInspects.get(c.raw.note) ?? bodyInspect) : bodyInspect;
		const cid = c.kind === "item" ? extractCidFromCode(c.code) : null;
		if (!c.wrapped && inspect) {
			const deletedUnwrapped =
				(c.kind === "bibl" && inspect.deletedBibl) ||
				(cid !== null && inspect.deletedCids.has(cid)) ||
				inspect.deletedCodes.has(c.code);
			if (deletedUnwrapped) continue;
		}
		if (inspect && !c.added) {
			const accepted = c.kind === "bibl" ? inspect.damagedBiblCode : cid ? (inspect.damagedByCid.get(cid) ?? null) : null;
			if (accepted && (checkTracked || looksDoubled(c.code))) {
				c.code = accepted;
				c.tracked = true;
			}
		}
		if (looksDoubled(c.code)) {
			// Fallback if doubled code had no separate OOXML parts: take the second instruction and flag tracked.
			const second = c.code.indexOf("ZOTERO_", c.code.indexOf("ZOTERO_") + 7);
			if (second > 0) {
				const addinBefore = c.code.lastIndexOf("ADDIN", second);
				c.code = (addinBefore >= 0 ? c.code.slice(addinBefore) : "ADDIN " + c.code.slice(second)).trim();
			}
			c.tracked = true;
		}
		if (c.kind === "bibl" && biblTrackedFmt) {
			c.tracked = true;
		}
		live.push(c);
	}

	if (live.length === 0) return [];

	// Adjacency between consecutive live fields of the same story/note + main/note interleaving in one sync.
	const adjChecks: { idx: number; cmp?: any; between?: Word.Range; prevText?: string; currText?: string }[] = [];
	for (let i = 1; i < live.length; i++) {
		const prev = live[i - 1]!;
		const curr = live[i]!;
		if (prev.raw.story !== curr.raw.story || prev.raw.note !== curr.raw.note) continue;
		if (prev.wrapped && curr.wrapped) {
			adjChecks.push({ idx: i, cmp: prev.parentCc.getRange("Whole").compareLocationWith(curr.parentCc.getRange("Whole")) });
		} else {
			const between = prev.raw.field.result.expandTo(curr.raw.field.result);
			between.load("text");
			adjChecks.push({ idx: i, between, prevText: prev.text, currText: curr.text });
		}
	}

	const mainLive = live.filter((c) => c.raw.story === "main");
	const noteGroups = new Map<string, { story: StoryId; note: number; refRange: Word.Range; items: Candidate[] }>();
	for (const c of live) {
		if (c.raw.story === "main" || !c.raw.noteItem) continue;
		const key = `${c.raw.story}|${c.raw.note}`;
		let g = noteGroups.get(key);
		if (!g) {
			g = { story: c.raw.story, note: c.raw.note, refRange: c.raw.noteItem.reference, items: [] };
			noteGroups.set(key, g);
		}
		g.items.push(c);
	}

	const noteGroupList = [...noteGroups.values()];
	const mainAnchorRange = (c: Candidate): Word.Range => (c.wrapped ? c.parentCc.getRange("Whole") : c.raw.field.result);
	const mainVsNote = new Map<string, any>();
	if (mainLive.length > 0 && noteGroupList.length > 0) {
		for (let m = 0; m < mainLive.length; m++) {
			const mr = mainAnchorRange(mainLive[m]!);
			for (let g = 0; g < noteGroupList.length; g++) {
				mainVsNote.set(`${m}|${g}`, mr.compareLocationWith(noteGroupList[g]!.refRange));
			}
		}
	}
	const fnVsEn = new Map<string, any>();
	const fnGroups = noteGroupList.filter((g) => g.story === "fn");
	const enGroups = noteGroupList.filter((g) => g.story === "en");
	if (fnGroups.length > 0 && enGroups.length > 0) {
		for (let fi = 0; fi < fnGroups.length; fi++) {
			for (let ei = 0; ei < enGroups.length; ei++) {
				fnVsEn.set(`${fi}|${ei}`, fnGroups[fi]!.refRange.compareLocationWith(enGroups[ei]!.refRange));
			}
		}
	}

	if (adjChecks.length > 0 || mainVsNote.size > 0 || fnVsEn.size > 0) {
		await ctx.sync();
	}

	const touchingPrev = new Set<number>();
	for (const chk of adjChecks) {
		if (chk.cmp) {
			if (chk.cmp.value === "AdjacentBefore") touchingPrev.add(chk.idx);
		} else if (chk.between && chk.between.text === (chk.prevText ?? "") + (chk.currText ?? "")) {
			touchingPrev.add(chk.idx);
		}
	}

	// Compute per-story start/end offsets so `f.start <= last.end` holds iff two fields in the same story/note touch.
	const storyCursor: Record<StoryId, number> = { main: 0, fn: 0, en: 0 };
	const fieldSpan = new Map<Candidate, { start: number; end: number }>();
	for (let i = 0; i < live.length; i++) {
		const c = live[i]!;
		const st = c.raw.story;
		const gap = touchingPrev.has(i) ? 0 : st === "main" ? 1 : 3;
		const start = storyCursor[st] + gap;
		const end = start + c.text.length + 2;
		storyCursor[st] = end;
		fieldSpan.set(c, { start, end });
	}

	// Merge ordered note groups (fn + en) in reference-mark order, then interleave with mainLive.
	let orderedNotes: typeof noteGroupList = [];
	if (fnGroups.length > 0 && enGroups.length > 0) {
		let fi = 0;
		let ei = 0;
		while (fi < fnGroups.length && ei < enGroups.length) {
			const rel = fnVsEn.get(`${fi}|${ei}`)?.value;
			if (isBeforeRelation(rel)) orderedNotes.push(fnGroups[fi++]!);
			else orderedNotes.push(enGroups[ei++]!);
		}
		while (fi < fnGroups.length) orderedNotes.push(fnGroups[fi++]!);
		while (ei < enGroups.length) orderedNotes.push(enGroups[ei++]!);
	} else {
		orderedNotes = noteGroupList;
	}

	const ordered: Candidate[] = [];
	if (mainLive.length === 0) {
		for (const g of orderedNotes) ordered.push(...g.items);
	} else if (orderedNotes.length === 0) {
		ordered.push(...mainLive);
	} else {
		let mi = 0;
		for (const g of orderedNotes) {
			const gi = noteGroupList.indexOf(g);
			while (mi < mainLive.length && isBeforeRelation(mainVsNote.get(`${mi}|${gi}`)?.value)) {
				ordered.push(mainLive[mi++]!);
			}
			ordered.push(...g.items);
		}
		while (mi < mainLive.length) ordered.push(mainLive[mi++]!);
	}

	// During a refresh (`checkTracked`), wrap any unwrapped existing Zotero fields with Track Changes off.
	if (checkTracked && ordered.some((c) => !c.wrapped)) {
		try {
			await withTrackingOff(ctx, async () => {
				await wrapUnwrappedFields(
					ctx,
					ordered
						.filter((c) => !c.wrapped)
						.map((c) => ({ field: c.raw.field, parentCc: c.parentCc, kind: c.kind, code: c.code })),
					tracked,
				);
			});
		} catch {
			/* If Track Changes is locked, leave unwrapped here; any subsequent write refuses with TRACKING_LOCKED_MESSAGE. */
		}
	}

	return ordered.map((c) => {
		const span = fieldSpan.get(c)!;
		return {
			story: c.raw.story,
			idx: c.raw.idx,
			kind: c.kind,
			code: c.code,
			text: c.text,
			start: span.start,
			end: span.end,
			note: c.raw.note,
			tracked: c.tracked,
		};
	});
}

// ---------------------------------------------------------------- doc.signature

export async function readDocSignature(
	ctx: Word.RequestContext,
	office: any,
	writes: number,
): Promise<{ doc: string; fields: string; writes: number }> {
	const id = getDocIdentity(office, ctx.document);
	if (!id.hasDoc) throw new Error("No document is open in Word.");
	const { byStory } = await loadStoryAddinFields(ctx);
	return {
		doc: id.fullName,
		fields: `${byStory.main.length}|${byStory.fn.length}|${byStory.en.length}`,
		writes,
	};
}
