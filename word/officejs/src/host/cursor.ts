import type { HostContext } from "../contracts";
import { loadStoryAddinFields } from "./fields";
import { getDocIdentity } from "./prefs";
import { inspectOoxmlFields } from "./tracking";
import { CURSOR_DEBOUNCE_MS, type StoryId, isZincTag, kindOf, looksDoubled, normalizeFieldCode, storyNumber, trackObj } from "./types";

function storyFromBodyType(bodyType: unknown): StoryId {
	if (bodyType === "Footnote" || bodyType === "footnote") return "fn";
	if (bodyType === "Endnote" || bodyType === "endnote") return "en";
	return "main";
}

function overlapsSelection(rel: unknown): boolean {
	return (
		rel === "Contains" ||
		rel === "ContainsStart" ||
		rel === "ContainsEnd" ||
		rel === "Equal" ||
		rel === "Contained" ||
		rel === "OverlapsBefore" ||
		rel === "OverlapsAfter"
	);
}

/**
 * Read the current selection and identify the Zotero field it sits in (or covers), matching the return shape of
 * `WordDoc.Cursor()` in C#. Outside a citation this completes in a single cheap sync.
 */
export async function readDocCursor(ctx: Word.RequestContext, office: any, tracked: any[]): Promise<Record<string, unknown>> {
	const id = getDocIdentity(office, ctx.document);
	if (!id.hasDoc) return { hasDoc: false };

	const sel = trackObj(ctx.document.getSelection(), tracked);
	sel.load(["isEmpty", "text"]);
	sel.parentBody.load("type");
	const parentCc = trackObj(sel.parentContentControlOrNullObject, tracked);
	parentCc.load(["isNullObject", "id", "tag"]);
	const innerCcs = sel.contentControls;
	innerCcs.load(["id", "tag"]);
	const selFields = sel.fields?.getByTypes?.(["Addin"]) ?? null;
	selFields?.load("items");
	const paraFields = sel.parentParagraph?.fields?.getByTypes?.(["Addin"]) ?? null;
	paraFields?.load("items");

	await ctx.sync();

	const story = storyFromBodyType(sel.parentBody.type);
	const selLen = sel.isEmpty ? 0 : (sel.text ?? "").length;
	const res: Record<string, unknown> = {
		hasDoc: true,
		doc: id.fullName,
		start: 0,
		end: selLen,
		story: storyNumber(story),
		inField: false,
	};

	try {
		let targetCc: Word.ContentControl | null = null;
		if (!parentCc.isNullObject && isZincTag(parentCc.tag)) {
			targetCc = parentCc;
		} else {
			targetCc = (innerCcs.items ?? []).find((c: any) => c && isZincTag(c.tag)) ?? null;
		}

		const hasUnwrappedCandidate = !targetCc && ((selFields?.items ?? []).length > 0 || (paraFields?.items ?? []).length > 0);
		if (!targetCc && !hasUnwrappedCandidate) {
			return res;
		}

		const { byStory, fnNotes, enNotes } = await loadStoryAddinFields(ctx, new Set<StoryId>([story]));
		const storyList = byStory[story];
		if (storyList.length === 0) return res;

		const entries = storyList.map((raw) => {
			if (raw.noteItem) trackObj(raw.noteItem, tracked);
			trackObj(raw.field, tracked);
			raw.field.load("code");
			trackObj(raw.field.result, tracked);
			raw.field.result.load("text");
			const cc = trackObj(raw.field.parentContentControlOrNullObject, tracked);
			cc.load(["isNullObject", "id", "tag"]);
			const cmp = !targetCc ? raw.field.result.compareLocationWith(sel) : null;
			return { raw, cc, cmp };
		});

		// Check Deleted tracking state on the story body(ies) so a tracked-deleted citation at the cursor is ignored.
		const storyBodies: Word.Body[] =
			story === "fn" ? fnNotes.map((n) => n.body) : story === "en" ? enNotes.map((n) => n.body) : [ctx.document.body];
		const deletedColls = storyBodies.map((b) => {
			const c = b.contentControls.getByChangeTrackingStates(["Deleted"]);
			c.load(["id"]);
			return c;
		});

		await ctx.sync();

		const deletedIds = new Set<unknown>();
		const deletedObjs = new Set<any>();
		for (const c of deletedColls) {
			for (const item of c.items ?? []) {
				deletedObjs.add(item);
				if (item?.id !== undefined) deletedIds.add(item.id);
			}
		}

		let hit = targetCc
			? entries.find((e) => !e.cc.isNullObject && ((targetCc!.id !== undefined && e.cc.id === targetCc!.id) || e.cc === targetCc))
			: entries.find((e) => e.cmp && overlapsSelection(e.cmp.value));

		if (hit && !hit.cc.isNullObject && (deletedIds.has(hit.cc.id) || deletedObjs.has(hit.cc))) {
			hit = undefined;
		}

		if (hit) {
			let code = normalizeFieldCode(hit.raw.field.code);
			const kind = kindOf(code);
			if (kind) {
				const text = hit.raw.field.result.text ?? "";
				if (looksDoubled(code)) {
					const hitBody = hit.raw.noteItem?.body ?? ctx.document.body;
					const ooxmlReq = hitBody.getOoxml();
					await ctx.sync();
					const inspect = inspectOoxmlFields(String(ooxmlReq?.value ?? ""));
					const cid = /"citationID"\s*:\s*"([^"]+)"/.exec(code)?.[1] ?? null;
					const accepted = kind === "bibl" ? inspect.damagedBiblCode : cid ? inspect.damagedByCid.get(cid) : null;
					if (accepted) code = accepted;
				}
				res.start = 1;
				res.end = 1 + selLen;
				res.inField = true;
				res.ref = { story, idx: hit.raw.idx };
				res.kind = kindOf(code) ?? kind;
				res.code = code;
				res.text = text;
			}
		}
	} catch (err) {
		res.error = err instanceof Error ? err.message : String(err);
	}

	return res;
}

function cursorSig(c: Record<string, unknown>): string {
	const ref = c.ref as { story?: unknown; idx?: unknown } | undefined;
	return JSON.stringify([c.hasDoc, c.doc, c.start, c.end, c.story, c.inField, ref?.story, ref?.idx, c.code]);
}

export interface CursorWatcher {
	/** Mark the cached cursor signature stale and schedule a debounced refresh (called after document writes). */
	invalidate(): void;
}

/**
 * Subscribe to `Office.EventType.DocumentSelectionChanged`, debounce rapid selection updates while the user types or
 * drags, and emit `"cursor"` through `hostCtx.emit` whenever the cursor state changes (matching `PaneControl.OnCursor`).
 */
export function startCursorWatcher(
	hostCtx: HostContext,
	office: any,
	runCursor: () => Promise<Record<string, unknown>>,
	debounceMs = CURSOR_DEBOUNCE_MS,
): CursorWatcher {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastSig = "";
	let seq = 0;

	const schedule = () => {
		const mine = ++seq;
		clearTimeout(timer);
		timer = setTimeout(async () => {
			try {
				const c = await runCursor();
				if (mine !== seq) return;
				const sig = cursorSig(c);
				if (sig === lastSig) return;
				lastSig = sig;
				hostCtx.emit("cursor", c);
			} catch {
				/* Word busy (e.g. modal dialog): wait for the next selection event */
			}
		}, debounceMs);
	};

	const officeDoc = office?.context?.document;
	if (officeDoc && typeof officeDoc.addHandlerAsync === "function") {
		const eventType = office?.EventType?.DocumentSelectionChanged ?? "documentSelectionChanged";
		try {
			officeDoc.addHandlerAsync(
				eventType,
				() => schedule(),
				() => {},
			);
		} catch {
			/* host without selection events */
		}
	}

	return {
		invalidate() {
			lastSig = "";
			if (officeDoc && typeof officeDoc.addHandlerAsync === "function") {
				schedule();
			}
		},
	};
}
