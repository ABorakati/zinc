import { describe, expect, test } from "bun:test";
import {
	buildBiblCode,
	buildItemCode,
	defaultPrefs,
	buildPrefsXml,
	parsePrefsXml,
	type CitationData,
} from "../../../../core/src/cite/docfields";
import type { HostContext } from "../../src/contracts";
import { SET_MANY_CHUNK_SIZE, TRACKING_LOCKED_MESSAGE, createDocMethods } from "../../src/host";
import { FakeWordEnv, bodyPlainText, fieldPlainText } from "./fake-word";

function makeItemCode(cid: string, key = "AAAA1111", plain = "(1)"): string {
	const data: CitationData = {
		citationID: cid,
		properties: { formattedCitation: plain, plainCitation: plain, noteIndex: 0 },
		citationItems: [
			{
				id: 101,
				uris: [`http://zotero.org/users/12345/items/${key}`],
				itemData: { id: 101, type: "article-journal", title: `Study ${key}` },
			},
		],
	};
	return buildItemCode(data);
}

function setup(paragraphs?: string[], debounceMs = 15) {
	const env = new FakeWordEnv(paragraphs);
	const events: { event: string; data: any }[] = [];
	const hostCtx: HostContext = {
		emit(event, data) {
			events.push({ event, data });
		},
	};
	const methods = createDocMethods(hostCtx, {
		writer: env.writer,
		word: env.word,
		office: env.office,
		debounceMs,
	});
	const call = <T = any>(name: string, params: Record<string, unknown> = {}): Promise<T> => {
		const fn = methods[name];
		if (!fn) throw new Error(`Missing method ${name}`);
		return fn(params) as Promise<T>;
	};
	return { env, events, methods, call };
}

describe("surface, state, list, target, batching, save and signature", () => {
	test("exposes all 19 doc.* methods and nothing extra", () => {
		const { methods } = setup();
		expect(Object.keys(methods).sort()).toEqual([
			"doc.begin",
			"doc.convert",
			"doc.cursor",
			"doc.delete",
			"doc.end",
			"doc.fields",
			"doc.getPrefs",
			"doc.insert",
			"doc.list",
			"doc.locate",
			"doc.save",
			"doc.select",
			"doc.set",
			"doc.setMany",
			"doc.setPrefs",
			"doc.signature",
			"doc.state",
			"doc.target",
			"doc.unlink",
		]);
	});

	test("doc.state, doc.list, doc.target, doc.save, doc.begin/end and doc.signature match WordDoc/Bridge", async () => {
		const { env, call } = setup();
		env.saved = false;
		env.readOnly = true;

		const st = await call("doc.state");
		expect(st).toEqual({
			hasDoc: true,
			name: "Manuscript.docx",
			fullName: "C:\\Docs\\Manuscript.docx",
			readOnly: true,
			prefsXml: null,
			protection: -1,
			trackingLocked: false,
		});

		const docs = await call("doc.list");
		expect(docs).toEqual([{ name: "Manuscript.docx", path: "C:\\Docs\\Manuscript.docx", active: true, saved: false, readOnly: true }]);

		expect(await call("doc.target", { document: "manuscript.docx" })).toEqual({
			ok: true,
			name: "Manuscript.docx",
			path: "C:\\Docs\\Manuscript.docx",
		});
		expect(await call("doc.target", { document: null })).toEqual({ ok: true });
		await expect(call("doc.target", { document: "missing.docx" })).rejects.toThrow(/No open document matches 'missing.docx'/);

		await call("doc.save");
		expect(env.saved).toBe(true);

		const sig0 = await call("doc.signature");
		expect(sig0).toEqual({ doc: "C:\\Docs\\Manuscript.docx", fields: "0|0|0", writes: 0 });

		await call("doc.begin", { name: "Zinc: test" });
		await call("doc.end");
		const sig1 = await call("doc.signature");
		expect(sig1.writes).toBe(1);
	});
});

describe("listing, wrapper creation, document ordering, adjacency and CheckField refs", () => {
	test("creates wrapped fields (ZINC <cid> and ZINC bibl), strips ADDIN for insertField, and lists in document order", async () => {
		const { env, call } = setup(["Alpha claim. Beta claim."]);

		// Insert inline citation at "Alpha claim"
		const loc1 = await call("doc.locate", { afterText: "Alpha claim" });
		const ins1 = await call("doc.insert", {
			kind: "item",
			code: makeItemCode("cidAlpha", "AAAA1111", "(1)"),
			runs: [{ t: "(1)" }],
			at: loc1,
		});
		expect(ins1).toEqual({ ok: true, story: "main" });

		// Insert footnote citation at "Beta claim"
		const loc2 = await call("doc.locate", { afterText: "Beta claim" });
		const ins2 = await call("doc.insert", {
			kind: "item",
			code: makeItemCode("cidNote1", "BBBB2222", "1"),
			runs: [{ t: "Smith, " }, { t: "Title", i: 1 }],
			placement: "footnote",
			at: loc2,
		});
		expect(ins2).toEqual({ ok: true, story: "fn" });

		// Insert bibliography at document end
		const endLoc = await call("doc.locate", { end: true });
		const insBib = await call("doc.insert", {
			kind: "bibl",
			code: buildBiblCode(),
			runs: [{ t: "1. Study AAAA1111\r2. Study BBBB2222" }],
			format: { hanging: true, entrySpacing: 1 },
			at: endLoc,
		});
		expect(insBib).toEqual({ ok: true, story: "main" });

		// Non-Zotero Addin field is ignored
		env.addExistingField({ story: "main", type: "Addin", code: "ADDIN OTHER_PLUGIN {}", text: "ignored", wrapped: false });

		const fields = await call("doc.fields", {});
		expect(fields.map((f: any) => [f.story, f.idx, f.kind, f.note, f.tracked])).toEqual([
			["main", 1, "item", 0, false],
			["fn", 1, "item", 1, false],
			["main", 2, "bibl", 0, false],
		]);
		// Note: `\* MERGEFORMAT` added by `insertField(..., true)` was normalized off cleanly
		expect(fields[0].code).toBe(makeItemCode("cidAlpha", "AAAA1111", "(1)"));
		expect(fields[1].text).toBe("Smith, Title");
		expect(fields[2].code).toBe(buildBiblCode());

		// Content controls have the exact tags `ZINC <cid>` and `ZINC bibl`
		expect(env.mainBody.paragraphs[0]!.segments.find((s) => s.kind === "field")!).toMatchObject({
			field: { cc: { tag: "ZINC cidAlpha" } },
		});
		expect(env.footnotes[0]!.body.paragraphs[0]!.segments[0]!).toMatchObject({
			field: { cc: { tag: "ZINC cidNote1" } },
		});
		const bibSeg = env.mainBody.paragraphs
			.flatMap((p) => p.segments)
			.find((s) => s.kind === "field" && s.field.code.includes("ZOTERO_BIBL"))!;
		expect(bibSeg.kind === "field" && bibSeg.field.cc?.tag).toBe("ZINC bibl");

		// No leaked tracked proxies after Word.run
		expect(env.lastTrackedCount).toBe(0);
	});

	test("touching citations (insert after) report start <= prev.end; separated citations report start > prev.end", async () => {
		const { env, call } = setup(["Start "]);
		await call("doc.insert", { kind: "item", code: makeItemCode("c1"), text: "(1)" });
		// Insert c2 directly after c1 (splitCitation pattern: zero gap)
		await call("doc.insert", {
			kind: "item",
			code: makeItemCode("c2"),
			text: "(2)",
			after: { story: "main", idx: 1, kind: "item", cid: "c1" },
		});
		// Add a separated citation after body text
		env.addExistingField({
			story: "main",
			code: makeItemCode("c3"),
			text: "(3)",
			wrapped: true,
			leadingGapText: " words between ",
		});

		const fields = await call("doc.fields", {});
		expect(fields.length).toBe(3);
		expect(fields[1].start).toBeLessThanOrEqual(fields[0].end); // c1 and c2 touch -> mergeable
		expect(fields[2].start).toBeGreaterThan(fields[1].end); // c2 and c3 separated -> not mergeable
	});

	test("CheckField validates idx, kind and cid before writing anything", async () => {
		const { env, call } = setup(["Claim "]);
		await call("doc.insert", { kind: "item", code: makeItemCode("origCid"), text: "(1)" });
		const newCode = makeItemCode("origCid", "BBBB2222", "(updated)");

		await expect(call("doc.set", { ref: { story: "main", idx: 9, kind: "item", cid: "origCid" }, code: newCode })).rejects.toThrow(
			/field 9 no longer exists/,
		);
		await expect(call("doc.set", { ref: { story: "main", idx: 1, kind: "bibl" }, code: buildBiblCode() })).rejects.toThrow(
			/changed under the sidebar/,
		);
		await expect(call("doc.set", { ref: { story: "main", idx: 1, kind: "item", cid: "wrongCid" }, code: newCode })).rejects.toThrow(
			/changed under the sidebar/,
		);
		await expect(call("doc.set", { ref: { story: "main", idx: 1, kind: "item", cid: "origCid" }, code: "QUOTE nope" })).rejects.toThrow(
			/not a Zotero field code/,
		);

		// Valid ref succeeds and updates footnote fields without ItemNotFound (tracks & untracks proxies)
		await call("doc.insert", { kind: "item", code: makeItemCode("fnCid"), text: "1", placement: "footnote" });
		await call("doc.set", {
			ref: { story: "fn", idx: 1, kind: "item", cid: "fnCid" },
			code: makeItemCode("fnCid", "CCCC3333", "2"),
			runs: [{ t: "2" }],
		});
		const fields = await call("doc.fields", {});
		expect(fields.find((f: any) => f.story === "fn")!.text).toBe("2");
		expect(env.lastTrackedCount).toBe(0);
	});
});

describe("Track Changes: deleted skipping, unwrapped w:delInstrText fallback, and damaged codes", () => {
	test("skips tracked-deleted wrapped citations (including duplicate citationIDs) without calling getTrackedChanges", async () => {
		const { env, call } = setup(["A "]);
		const sharedCode = makeItemCode("dupCid11", "AAAA1111", "(1)");
		env.addExistingField({ story: "main", code: sharedCode, text: "(1)", wrapped: true, ccState: "Normal", leadingGapText: "x " });
		env.addExistingField({ story: "main", code: sharedCode, text: "(2)", wrapped: true, ccState: "Normal", leadingGapText: "y " });
		env.addExistingField({
			story: "main",
			code: makeItemCode("addedCid"),
			text: "(3)",
			wrapped: true,
			ccState: "Added",
			leadingGapText: "z ",
		});

		// User turns Track Changes on and deletes the first copy of dupCid11
		env.trackingMode = "TrackAll";
		await call("doc.delete", { ref: { story: "main", idx: 1, kind: "item", cid: "dupCid11" } });

		// Deleted field is still present in body.fields (idx 1), so remaining live fields are at idx 2 and idx 3
		expect(env.fieldsInBody(env.mainBody, ["Addin"]).length).toBe(3);

		const listed = await call("doc.fields", { checkTracked: true });
		expect(listed.length).toBe(2);
		expect(listed.map((f: any) => [f.idx, f.text, f.tracked])).toEqual([
			[2, "(2)", false],
			[3, "(3)", false], // Added citation stays tracked=false (user's insertion, not damaged!)
		]);
	});

	test("skips unwrapped Zotero fields whose code is w:delInstrText in body.getOoxml(), and flags tracked code damage", async () => {
		const { env, call } = setup(["From Zotero: "]);
		const liveCode = makeItemCode("zotLive1", "AAAA1111", "(1)");
		const delCode = makeItemCode("zotGone2", "BBBB2222", "(2)");
		const oldDamaged = makeItemCode("zotDmg03", "CCCC3333", "(old)");
		const newDamaged = makeItemCode("zotDmg03", "CCCC3333", "(new)");

		env.addExistingField({ story: "main", code: liveCode, text: "(1)", wrapped: false, leadingGapText: "one " });
		// Unwrapped deleted field: Word still lists it in body.fields, OOXML has only <w:delInstrText>
		const delField = env.addExistingField({
			story: "main",
			code: "",
			deletedCode: ` ${delCode} `,
			text: "(2)",
			wrapped: false,
			leadingGapText: "two ",
		});
		// Simulate Word build that still returns deleted instruction text on field.code while OOXML marks it w:delInstrText
		delField.code = "";
		env.addExistingField({
			story: "main",
			code: makeItemCode("zotGone4", "BBBB2222", "(4)"),
			text: "(4)",
			wrapped: false,
			leadingGapText: "four ",
		});
		// Override fourth field in OOXML to have only w:delInstrText (even if field.code returned non-empty)
		const fourth = env.fieldsInBody(env.mainBody, ["Addin"])[2]!;
		fourth.deletedCode = fourth.code;
		fourth.code = "";
		// Keep `field.code` returning the deleted text on proxy read via custom simulation:
		// Add a fifth unwrapped field with BOTH deletedCode and live code (tracked rewrite damage!)
		env.addExistingField({
			story: "main",
			code: newDamaged,
			deletedCode: ` ${oldDamaged} `,
			text: "(new)",
			wrapped: false,
			leadingGapText: "five ",
		});

		// Also test pure OOXML w:delInstrText fallback when `field.code` still reads non-empty for an unwrapped deleted citation:
		const ghostCode = makeItemCode("zotGhost", "AAAA1111", "(ghost)");
		env.addExistingField({ story: "main", code: ghostCode, text: "(ghost)", wrapped: false, leadingGapText: "six " });
		const baseOoxml = await renderOoxmlReplacingLiveWithDel(env, "zotGhost");
		env.mainBody.ooxmlOverride = baseOoxml;

		const plainScan = await call("doc.fields", {});
		expect(plainScan.map((f: any) => [f.idx, f.tracked])).toEqual([
			[1, false],
			[4, true], // doubled code read as accepted `newDamaged` and flagged tracked even on a plain scan
		]);
		expect(plainScan[1].code).toBe(newDamaged);
	});
});

async function renderOoxmlReplacingLiveWithDel(env: FakeWordEnv, cid: string): Promise<string> {
	// Trigger normal OOXML generation, then convert the target cid's <w:instrText> into <w:delInstrText>.
	let xml = "";
	await env.word.run(async (ctx: any) => {
		const req = ctx.document.body.getOoxml();
		await ctx.sync();
		xml = req.value;
	});
	return xml.replace(
		new RegExp(`<w:r><w:instrText>([^<]*${cid}[^<]*)</w:instrText></w:r>`),
		`<w:del><w:r><w:delInstrText>$1</w:delInstrText></w:r></w:del>`,
	);
}

describe("wrap-on-refresh for unwrapped Zotero fields", () => {
	test("plain doc.fields leaves unwrapped fields untouched; refresh wraps them with Track Changes off and restores selection & mode", async () => {
		const { env, call } = setup(["Zotero doc: "]);
		const fMain = env.addExistingField({
			story: "main",
			code: makeItemCode("unwrap01", "AAAA1111", "(1)"),
			text: "(1)",
			wrapped: false,
			leadingGapText: "body ",
		});
		const fFn = env.addExistingField({
			story: "fn",
			code: makeItemCode("unwrapFn", "BBBB2222", "1"),
			text: "Note 1",
			wrapped: false,
		});
		const fBib = env.addExistingField({
			story: "main",
			code: buildBiblCode(),
			text: "1. Ref",
			wrapped: false,
			leadingGapText: " ",
		});

		env.trackingMode = "TrackAll";
		env.setCursorOutside(0, 0);

		// Plain read does not wrap
		const before = await call("doc.fields", {});
		expect(before.length).toBe(3);
		expect(fMain.cc).toBeNull();
		expect(fFn.cc).toBeNull();
		expect(fBib.cc).toBeNull();

		// Refresh scan (`checkTracked: true`) wraps every unwrapped field with Track Changes off, then restores TrackAll
		env.syncHistory = [];
		const refreshed = await call("doc.fields", { checkTracked: true });
		expect(refreshed.length).toBe(3);
		expect(fMain.cc?.tag).toBe("ZINC unwrap01");
		expect(fMain.cc?.trackingState).toBe("Normal"); // wrapped with Track Changes OFF, not Added!
		expect(fFn.cc?.tag).toBe("ZINC unwrapFn");
		expect(fFn.cc?.trackingState).toBe("Normal");
		expect(fBib.cc?.tag).toBe("ZINC bibl");
		expect(fBib.cc?.trackingState).toBe("Normal");
		expect(env.trackingMode).toBe("TrackAll"); // restored!
		expect(env.selection.body).toBe(env.mainBody);
		expect(env.selection.paraIdx).toBe(0);
	});
});

describe("Track Changes off/restore around rewrites, including on failure, and locked refusal", () => {
	test("doc.set switches changeTrackingMode Off in its own sync, writes untracked, and restores in its own sync", async () => {
		const { env, call } = setup(["Text "]);
		await call("doc.insert", { kind: "item", code: makeItemCode("tc1"), text: "(1)" });

		env.trackingMode = "TrackMineOnly";
		env.syncHistory = [];

		await call("doc.set", {
			ref: { story: "main", idx: 1, kind: "item", cid: "tc1" },
			code: makeItemCode("tc1", "AAAA1111", "(2)"),
			runs: [{ t: "(2)" }],
		});

		expect(env.trackingMode).toBe("TrackMineOnly");
		const fm = env.fieldsInBody(env.mainBody, ["Addin"])[0]!;
		expect(fm.deletedCode).toBeUndefined(); // code was rewritten with tracking OFF!
		expect(fieldPlainText(fm)).toBe("(2)");

		// Verify dedicated sync boundaries:
		// 1) mode switched Off in its own sync (0 field writes in that sync)
		const offSync = env.syncHistory.find((s) => s.modeBefore === "TrackMineOnly" && s.modeAfter === "Off");
		expect(offSync).toBeDefined();
		expect(offSync!.fieldWrites).toBe(0);

		// 2) field write sync ran with modeBefore === "Off" and modeAfter === "Off"
		const writeSync = env.syncHistory.find((s) => s.fieldWrites > 0);
		expect(writeSync).toBeDefined();
		expect(writeSync!.modeBefore).toBe("Off");
		expect(writeSync!.modeAfter).toBe("Off");

		// 3) mode restored to TrackMineOnly in its own sync at the end (0 field writes)
		const restoreSync = env.syncHistory.at(-1)!;
		expect(restoreSync.modeBefore).toBe("Off");
		expect(restoreSync.modeAfter).toBe("TrackMineOnly");
		expect(restoreSync.fieldWrites).toBe(0);
	});

	test("restores changeTrackingMode in a finally in its own sync when queueResult or a write sync throws", async () => {
		const { env, call } = setup(["Text "]);
		await call("doc.insert", { kind: "item", code: makeItemCode("err1"), text: "(1)" });
		await call("doc.insert", { kind: "item", code: makeItemCode("err2"), text: "(2)" });

		// Case 1: ResultWriter throws while queueing
		env.trackingMode = "TrackAll";
		env.failWriterOnCall = (env as any).writerCallSeq + 1;
		await expect(
			call("doc.set", {
				ref: { story: "main", idx: 1, kind: "item", cid: "err1" },
				runs: [{ t: "(boom)" }],
			}),
		).rejects.toThrow(/Simulated writer failure/);
		expect(env.trackingMode).toBe("TrackAll");
		env.failWriterOnCall = null;

		// Case 2: Word `ctx.sync()` throws on the write batch itself
		env.trackingMode = "TrackAll";
		// Syncs inside set: 1=load fields+mode, 2=load code/result/cc, 3=set Off, 4=write batch (fail here!), 5=finally restore
		env.failOnSyncIndex = env.totalSyncs + 4;
		await expect(
			call("doc.set", {
				ref: { story: "main", idx: 2, kind: "item", cid: "err2" },
				code: makeItemCode("err2", "BBBB2222", "(9)"),
				runs: [{ t: "(9)" }],
			}),
		).rejects.toThrow(/Simulated Office\.js sync error/);
		env.failOnSyncIndex = null;
		expect(env.trackingMode).toBe("TrackAll");
		expect(env.lastTrackedCount).toBe(0);
	});

	test("locked Track Changes: reported in doc.state and refuses insert, set, setMany, delete, unlink and convert before writing", async () => {
		const { env, call } = setup(["Locked doc "]);
		await call("doc.insert", { kind: "item", code: makeItemCode("lock1"), text: "(1)" });
		const codeBefore = env.fieldsInBody(env.mainBody, ["Addin"])[0]!.code;

		for (const throwOnSet of [false, true]) {
			env.lockTracking(true);
			env.throwOnLockedTrackingOff = throwOnSet;

			const st = await call("doc.state");
			expect(st.trackingLocked).toBe(true);

			await expect(call("doc.insert", { kind: "item", code: makeItemCode("lock2"), text: "(2)" })).rejects.toThrow(
				TRACKING_LOCKED_MESSAGE,
			);
			await expect(
				call("doc.set", { ref: { story: "main", idx: 1, kind: "item", cid: "lock1" }, runs: [{ t: "(9)" }] }),
			).rejects.toThrow(TRACKING_LOCKED_MESSAGE);
			await expect(
				call("doc.setMany", { items: [{ ref: { story: "main", idx: 1, kind: "item", cid: "lock1" }, runs: [{ t: "(9)" }] }] }),
			).rejects.toThrow(TRACKING_LOCKED_MESSAGE);
			await expect(call("doc.delete", { ref: { story: "main", idx: 1, kind: "item", cid: "lock1" } })).rejects.toThrow(
				TRACKING_LOCKED_MESSAGE,
			);
			await expect(call("doc.unlink", { ref: { story: "main", idx: 1, kind: "item", cid: "lock1" } })).rejects.toThrow(
				TRACKING_LOCKED_MESSAGE,
			);
			await expect(
				call("doc.convert", { ref: { story: "main", idx: 1, kind: "item", cid: "lock1" }, target: "footnote" }),
			).rejects.toThrow(TRACKING_LOCKED_MESSAGE);

			// Nothing in the document was modified
			const fieldsNow = env.fieldsInBody(env.mainBody, ["Addin"]);
			expect(fieldsNow.length).toBe(1);
			expect(fieldsNow[0]!.code).toBe(codeBefore);
			expect(fieldPlainText(fieldsNow[0]!)).toBe("(1)");
		}
	});
});

describe("doc.setMany chunking (~25 per sync) and selective writes", () => {
	test("writes only the given fields in chunks of 25 per sync, with constant non-chunk syncs", async () => {
		expect(SET_MANY_CHUNK_SIZE).toBe(25);
		const { env, call } = setup(["Many citations: "]);

		const totalFields = 70;
		for (let i = 1; i <= totalFields; i++) {
			env.addExistingField({
				story: "main",
				code: makeItemCode(`cid${String(i).padStart(4, "0")}`, "AAAA1111", `(${i})`),
				text: `(${i})`,
				wrapped: true,
				leadingGapText: " ",
			});
		}

		// Update 60 of the 70 fields -> ceil(60 / 25) = 3 write syncs; fields 61..70 must stay untouched
		const subset = Array.from({ length: 60 }, (_, k) => {
			const idx = k + 1;
			const cid = `cid${String(idx).padStart(4, "0")}`;
			return {
				ref: { story: "main", idx, kind: "item", cid },
				code: makeItemCode(cid, "BBBB2222", `[${idx}]`),
				runs: [{ t: `[${idx}]` }],
			};
		});

		env.trackingMode = "TrackAll";
		env.syncHistory = [];
		env.writerCalls.length = 0;

		const res = await call("doc.setMany", { items: subset });
		expect(res).toEqual({ ok: true, count: 60 });
		expect(env.writerCalls.filter((w) => w.kind === "result").length).toBe(60);

		const writeSyncs60 = env.syncHistory.filter((s) => s.fieldWrites > 0);
		expect(writeSyncs60.length).toBe(3); // 25 + 25 + 10
		const nonWriteSyncs60 = env.syncHistory.length - writeSyncs60.length;
		expect(nonWriteSyncs60).toBeLessThanOrEqual(5);

		// Compare against updating just 10 fields: non-chunk sync count stays constant!
		env.syncHistory = [];
		await call("doc.setMany", { items: subset.slice(0, 10) });
		const writeSyncs10 = env.syncHistory.filter((s) => s.fieldWrites > 0);
		expect(writeSyncs10.length).toBe(1);
		expect(env.syncHistory.length - writeSyncs10.length).toBe(nonWriteSyncs60);

		// Verify untouched fields 61..70 kept their original text & code
		const after = await call("doc.fields", {});
		expect(after[0].text).toBe("[1]");
		expect(after[59].text).toBe("[60]");
		expect(after[60].text).toBe("(61)");
		expect(after[69].text).toBe("(70)");
	});
});

describe("document preferences (ZOTERO_PREF_n custom properties)", () => {
	test("round-trips short and multi-chunk (>250 char) raw XML, and deletes stale tail chunks on shrink", async () => {
		const { env, call } = setup();
		expect(await call("doc.getPrefs")).toEqual({ xml: null });

		// Long XML (>600 chars -> 3 chunks of <=250 chars each)
		const prefs = defaultPrefs("vancouver", "en-GB");
		prefs.hasBibliography = true;
		prefs.extraPrefs = {
			customNote: "x".repeat(420),
			ampAndQuotes: 'a & b < c > "d"',
		};
		const longXml = buildPrefsXml(prefs);
		expect(longXml.length).toBeGreaterThan(600);

		await call("doc.setPrefs", { xml: longXml });
		expect(env.customProps.has("ZOTERO_PREF_1")).toBe(true);
		expect(env.customProps.has("ZOTERO_PREF_2")).toBe(true);
		expect(env.customProps.has("ZOTERO_PREF_3")).toBe(true);
		for (const [, v] of env.customProps) {
			expect(v.length).toBeLessThanOrEqual(250);
		}
		// Stored as raw <data ...> XML (not pre-escaped twice)
		expect(env.customProps.get("ZOTERO_PREF_1")!.startsWith("<data ")).toBe(true);

		const got = await call("doc.getPrefs");
		expect(got.xml).toBe(longXml);
		expect(parsePrefsXml(got.xml)?.extraPrefs.ampAndQuotes).toBe('a & b < c > "d"');
		expect((await call("doc.state")).prefsXml).toBe(longXml);

		// Shrink from 3 chunks -> 2 chunks (standard defaultPrefs ~335 chars): ZOTERO_PREF_3 deleted
		const twoChunkXml = buildPrefsXml(defaultPrefs("apa", "en-US"));
		expect(twoChunkXml.length).toBeGreaterThan(250);
		expect(twoChunkXml.length).toBeLessThan(500);
		await call("doc.setPrefs", { xml: twoChunkXml });
		expect(env.customProps.has("ZOTERO_PREF_1")).toBe(true);
		expect(env.customProps.has("ZOTERO_PREF_2")).toBe(true);
		expect(env.customProps.has("ZOTERO_PREF_3")).toBe(false);
		expect((await call("doc.getPrefs")).xml).toBe(twoChunkXml);

		// Shrink further to 1 chunk (<250 chars): ZOTERO_PREF_2 deleted too
		const oneChunkXml =
			'<data data-version="3" zotero-version="7.0.11"><session id="s1"/><style id="http://www.zotero.org/styles/apa" hasBibliography="0" bibliographyStyleHasBeenSet="0"/><prefs><pref name="fieldType" value="Field"/></prefs></data>';
		expect(oneChunkXml.length).toBeLessThan(250);
		await call("doc.setPrefs", { xml: oneChunkXml });
		expect(env.customProps.has("ZOTERO_PREF_1")).toBe(true);
		expect(env.customProps.has("ZOTERO_PREF_2")).toBe(false);
		expect((await call("doc.getPrefs")).xml).toBe(oneChunkXml);
	});
});

describe("bibliography tracked-formatting detection and whole-paragraph repair", () => {
	test("clean or tracked-inserted bibliography rewrites in place; bibliography with w:pPrChange/w:rPrChange is flagged and rebuilt whole", async () => {
		const { env, call } = setup(["Body paragraph one.", "Appendix after bibliography."]);

		// Insert a 2-entry bibliography after paragraph 1 while Track Changes is ON (user insertion: <w:ins>, no pPrChange)
		env.trackingMode = "TrackAll";
		const loc = await call("doc.locate", { afterText: "Body paragraph one." });
		await call("doc.insert", {
			kind: "bibl",
			code: buildBiblCode(),
			runs: [{ t: "1. First entry\r2. Second entry" }],
			format: { hanging: true, entrySpacing: 1 },
			at: loc,
		});

		// QueueBibliographyFormat ran with Track Changes OFF -> zero pPrChange, so checkTracked is FALSE
		let fields = await call("doc.fields", { checkTracked: true });
		expect(fields.length).toBe(1);
		expect(fields[0].kind).toBe("bibl");
		expect(fields[0].tracked).toBe(false);

		// In-place rewrite does NOT delete paragraphs whole when bibliography is clean
		env.syncHistory = [];
		await call("doc.set", {
			ref: { story: "main", idx: 1, kind: "bibl" },
			runs: [{ t: "1. First entry updated\r2. Second entry" }],
			format: { hanging: true },
		});
		expect(env.syncHistory.some((s) => s.ops.some((op) => op.startsWith("paraRange.delete")))).toBe(false);

		// Now simulate tracked formatting left by an older add-in (`w:pPrChange` on the bibliography's last paragraph)
		const bibField = env.fieldsInBody(env.mainBody, ["Addin"])[0]!;
		bibField.pPrChange = true;

		fields = await call("doc.fields", { checkTracked: true });
		expect(fields[0].tracked).toBe(true);

		// Refresh rewrite deletes whole bibliography paragraphs (marks included) with tracking off and inserts fresh para + ZINC bibl + field
		const customBibCode = buildBiblCode({ uncited: [["http://zotero.org/users/1/items/AAAA1111"]], omitted: [], custom: [] });
		env.syncHistory = [];
		await call("doc.setMany", {
			items: [
				{
					ref: { story: "main", idx: 1, kind: "bibl" },
					code: customBibCode,
					runs: [{ t: "1. Clean rebuilt one\r2. Clean rebuilt two" }],
					format: { hanging: true, entrySpacing: 1 },
				},
			],
		});

		expect(env.syncHistory.some((s) => s.ops.includes("paraRange.delete(Whole)") && s.modeBefore === "Off")).toBe(true);
		expect(env.trackingMode).toBe("TrackAll"); // user's tracking mode restored!

		// Re-scan: no tracked formatting remains, code & multi-line text & surrounding paragraphs are intact
		fields = await call("doc.fields", { checkTracked: true });
		expect(fields.length).toBe(1);
		expect(fields[0].tracked).toBe(false);
		expect(fields[0].code).toBe(customBibCode);
		expect(fields[0].text).toBe("1. Clean rebuilt one\r2. Clean rebuilt two");
		const fullText = bodyPlainText(env.mainBody);
		expect(fullText).toContain("Body paragraph one.");
		expect(fullText).toContain("Appendix after bibliography.");

		// Also verify w:rPrChange when bibliography is at the very end of the document (final paragraph mark edge case!)
		const endDoc = setup(["Intro."]);
		const endAt = await endDoc.call("doc.locate", { end: true });
		await endDoc.call("doc.insert", {
			kind: "bibl",
			code: buildBiblCode(),
			runs: [{ t: "1. End bib line 1\r2. End bib line 2" }],
			at: endAt,
		});
		const endBib = endDoc.env.fieldsInBody(endDoc.env.mainBody, ["Addin"])[0]!;
		endBib.rPrChange = true;
		expect((await endDoc.call("doc.fields", { checkTracked: true }))[0].tracked).toBe(true);
		await endDoc.call("doc.set", {
			ref: { story: "main", idx: 1, kind: "bibl" },
			runs: [{ t: "1. End bib clean" }],
			format: { hanging: true },
		});
		expect((await endDoc.call("doc.fields", { checkTracked: true }))[0].tracked).toBe(false);
	});
});

describe("locate, non-nesting insert, convert, unlink, select, cursor and debounced selection events", () => {
	test("doc.locate validates inputs and reports occurrence counts on miss", async () => {
		const { call } = setup(["Repeat word and Repeat word."]);
		await expect(call("doc.locate", {})).rejects.toThrow(/afterText is required/);
		await expect(call("doc.locate", { afterText: "a".repeat(251) })).rejects.toThrow(/250 characters/);
		await expect(call("doc.locate", { afterText: "line1\nline2" })).rejects.toThrow(/one paragraph/);
		await expect(call("doc.locate", { afterText: "Repeat word", occurrence: 3 })).rejects.toThrow(/only 2 occurrence/);
		await expect(call("doc.locate", { afterText: "repeat word" })).rejects.toThrow(/not found in the document body/); // case-sensitive
		const hit2 = await call("doc.locate", { afterText: "Repeat word", occurrence: 2 });
		expect(hit2.pos).toBeGreaterThan(0);
	});

	test("inserting while cursor is inside an existing citation continues after it rather than nesting", async () => {
		const { env, call } = setup(["Start "]);
		await call("doc.insert", { kind: "item", code: makeItemCode("first1"), text: "(1)" });
		const firstModel = env.fieldsInBody(env.mainBody, ["Addin"])[0]!;
		env.setCursorInField(firstModel);

		await call("doc.insert", { kind: "item", code: makeItemCode("second2"), text: "(2)" });
		const fields = await call("doc.fields", {});
		expect(fields.map((f: any) => f.text)).toEqual(["(1)", "(2)"]);
		expect(fields[1].start).toBeLessThanOrEqual(fields[0].end); // placed immediately after first1
	});

	test("doc.convert moves citations inline <-> footnote <-> endnote, preserving shared notes and rolling back on error", async () => {
		const { env, call } = setup(["Claim "]);
		await call("doc.insert", { kind: "item", code: makeItemCode("conv1"), text: "(1)" });

		// inline -> footnote
		expect(await call("doc.convert", { ref: { story: "main", idx: 1, kind: "item", cid: "conv1" }, target: "footnote" })).toEqual({
			ok: true,
			story: "fn",
		});
		expect(env.footnotes.length).toBe(1);
		expect((await call("doc.fields", {}))[0].story).toBe("fn");

		// footnote -> endnote (sole content of footnote -> old footnote is removed)
		expect(await call("doc.convert", { ref: { story: "fn", idx: 1, kind: "item", cid: "conv1" }, target: "endnote" })).toEqual({
			ok: true,
			story: "en",
		});
		expect(env.footnotes.length).toBe(0);
		expect(env.endnotes.length).toBe(1);

		// Add user prose to the endnote: converting endnote -> inline must KEEP the endnote for the user's prose
		env.endnotes[0]!.body.paragraphs[0]!.segments.unshift({ kind: "text", text: "See also: " });
		expect(await call("doc.convert", { ref: { story: "en", idx: 1, kind: "item", cid: "conv1" }, target: "inline" })).toEqual({
			ok: true,
			story: "main",
		});
		expect(env.endnotes.length).toBe(1);
		expect(bodyPlainText(env.endnotes[0]!.body)).toBe("See also: ");

		// Failure while creating replacement leaves the original citation intact
		env.failWriterOnCall = (env as any).writerCallSeq + 1;
		await expect(
			call("doc.convert", { ref: { story: "main", idx: 1, kind: "item", cid: "conv1" }, target: "footnote" }),
		).rejects.toThrow(/Simulated writer failure/);
		env.failWriterOnCall = null;
		expect(env.footnotes.length).toBe(0);
		expect((await call("doc.fields", {})).length).toBe(1);
	});

	test("doc.unlink keeps visible text and removes field codes and ZINC wrappers", async () => {
		const { env, call } = setup(["Cited "]);
		await call("doc.insert", { kind: "item", code: makeItemCode("unl1"), text: "(Smith, 2021)" });
		await call("doc.unlink", { ref: { story: "main", idx: 1, kind: "item", cid: "unl1" } });

		expect(await call("doc.fields", {})).toEqual([]);
		expect(env.ccsInBody(env.mainBody).length).toBe(0);
		expect(bodyPlainText(env.mainBody)).toContain("(Smith, 2021)");
	});

	test("doc.select, doc.cursor and debounced DocumentSelectionChanged -> 'cursor' events", async () => {
		const { env, events, call } = setup(["Hello "], 20);
		await call("doc.insert", { kind: "item", code: makeItemCode("cur1"), text: "(1)" });

		env.setCursorOutside(0, 0);
		const outside = await call("doc.cursor");
		expect(outside).toEqual({
			hasDoc: true,
			doc: "C:\\Docs\\Manuscript.docx",
			start: 0,
			end: 0,
			story: 1,
			inField: false,
		});

		await call("doc.select", { ref: { story: "main", idx: 1, kind: "item", cid: "cur1" } });
		const inside = await call("doc.cursor");
		expect(inside).toMatchObject({
			hasDoc: true,
			doc: "C:\\Docs\\Manuscript.docx",
			story: 1,
			inField: true,
			ref: { story: "main", idx: 1 },
			kind: "item",
			code: makeItemCode("cur1"),
			text: "(1)",
		});

		// Rapid burst of DocumentSelectionChanged events while typing coalesces into ONE debounced cursor read & emit
		events.length = 0;
		const syncsBeforeBurst = env.totalSyncs;
		env.setCursorOutside(0, 0);
		for (let i = 0; i < 6; i++) env.fireSelectionChanged();
		const fm = env.fieldsInBody(env.mainBody, ["Addin"])[0]!;
		env.setCursorInField(fm);
		env.fireSelectionChanged();

		await new Promise((r) => setTimeout(r, 60));
		const cursorEvents = events.filter((e) => e.event === "cursor");
		expect(cursorEvents.length).toBe(1);
		expect(cursorEvents[0]!.data).toMatchObject({
			hasDoc: true,
			inField: true,
			ref: { story: "main", idx: 1 },
			kind: "item",
			text: "(1)",
		});
		expect(env.totalSyncs - syncsBeforeBurst).toBeLessThanOrEqual(4); // 1 cursor read, not 7!

		// Firing again without moving does not emit a duplicate event
		env.fireSelectionChanged();
		await new Promise((r) => setTimeout(r, 50));
		expect(events.filter((e) => e.event === "cursor").length).toBe(1);
	});
});
