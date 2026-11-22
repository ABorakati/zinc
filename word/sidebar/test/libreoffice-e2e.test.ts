// End-to-end: the real sidebar controller (app.ts, unchanged) -> the LibreOffice extension's document code (zinc_lo.LoDoc,
// libreoffice/extension/pythonpath) -> a private HEADLESS LibreOffice. The library side is the in-memory mock (the same
// three sample items as the browser preview), so no real library is ever read.
// Off by default (it starts soffice). Run with:
//   ZN_LO_E2E=1 ZN_LO_PROGRAM="<LibreOffice>/program" bun test test/libreoffice-e2e.test.ts
// soffice gets its own profile folder and pipe name inside a temp folder: the user's LibreOffice and profile are never touched.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, type Pick } from "../src/app";
import { parseFieldCode, parsePrefsXml } from "../src/fields";
import { fixtureStyles, LoHarnessHost, loAvailable } from "./lo-harness-host";

const ENABLED = process.env.ZN_LO_E2E === "1";
const d = ENABLED ? describe : describe.skip;

const NOTE_STYLE = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="note" version="1.0" default-locale="en-US"><info><title>ZN note test</title><id>http://www.zotero.org/styles/znnote</id><link href="http://www.zotero.org/styles/znnote" rel="self"/><updated>2020-01-01T00:00:00+00:00</updated></info>
<citation><layout delimiter="; " suffix="."><group delimiter=", "><names variable="author"><name form="short"/></names><text variable="title" font-style="italic"/></group></layout></citation>
<bibliography><layout suffix="."><text variable="title"/></layout></bibliography></style>`;

/** Zotero's name for a citation reference mark: ZOTERO_ITEM CSL_CITATION {json} RND + 10 letters/digits. */
const ITEM_MARK = /^ZOTERO_ITEM CSL_CITATION \{.*\} RND[0-9A-Za-z]{10}$/s;
const BIBL_SECTION = /^ZOTERO_BIBL \{.*\} CSL_BIBLIOGRAPHY RND[0-9A-Za-z]{10}$/s;

d("sidebar controller driving a headless LibreOffice", () => {
	let h: LoHarnessHost;
	let app: App;
	let tmp: string;
	const picks: Pick[] = [];

	beforeAll(async () => {
		if (!loAvailable()) throw new Error("set ZN_LO_PROGRAM to LibreOffice's program folder (with soffice and python)");
		tmp = mkdtempSync(join(tmpdir(), "zn-lo-e2e-"));
		h = await LoHarnessHost.start(join(tmp, "profile"), fixtureStyles({ znnote: NOTE_STYLE }));
		const started = await h.raw<{ pid: number; version: string }>("h.start");
		expect(started.pid).toBeGreaterThan(0);
		console.log("LibreOffice", started.version);
		app = new App(h);
		await app.init();
		for (const k of ["AAAA1111", "BBBB2222", "CCCC3333"]) picks.push((await app.pickFromKey(k))!);
	}, 120_000);

	afterAll(async () => {
		await h?.stop();
	}, 60_000);

	test("insert citations and a bibliography in Zotero's storage format", async () => {
		await h.raw("h.newDoc");
		await h.raw("h.type", { text: "Liver transplant outcomes vary by centre" });
		await app.insertCitation([picks[0]!]);
		await h.raw("h.type", { text: ", and machine perfusion may help" });
		const p1 = { ...picks[1]!, locator: "12-14", prefix: "see" };
		await app.insertCitation([p1, picks[2]!]);
		await h.raw("h.type", { text: "." });
		await h.raw("h.cursorEnd");
		await h.raw("h.para");
		const rep = await app.insertBibliography();
		expect(rep.citations).toBe(2);

		const fields = await app.readFields();
		expect(fields.map((f) => f.kind)).toEqual(["item", "item", "bibl"]);
		expect(fields[0]!.text).toBe("(1)");
		expect(fields[1]!.text).toBe("(see 2,3)");
		const c1 = fields[0]!.parsed!;
		expect(c1.kind).toBe("item");
		if (c1.kind === "item") expect(c1.data.citationItems[0]!.uris[0]).toBe(`${app.uriBase}/items/AAAA1111`);
		expect(fields[2]!.text.split("\r").length).toBe(3);
		expect(fields[2]!.code).toBe('ADDIN ZOTERO_BIBL {"uncited":[],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY');

		const text = (await h.raw<{ text: string }>("h.text")).text;
		expect(text).toContain("Liver transplant outcomes vary by centre(1), and machine perfusion may help(see 2,3).");

		// what Zotero's LibreOffice plugin reads: reference marks and a section named with the code, prefs in ZOTERO_PREF_n
		const marks = await h.raw<{ marks: string[]; sections: string[] }>("h.marks");
		expect(marks.marks.length).toBe(2);
		for (const m of marks.marks) expect(m).toMatch(ITEM_MARK);
		expect(marks.sections.filter((s) => s.startsWith("ZOTERO_")).length).toBe(1);
		expect(marks.sections.find((s) => s.startsWith("ZOTERO_"))).toMatch(BIBL_SECTION);
		const props = await h.raw<Record<string, string>>("h.props");
		expect(Object.keys(props)).toContain("ZOTERO_PREF_1");
		const xml = Object.keys(props)
			.filter((k) => k.startsWith("ZOTERO_PREF_"))
			.sort((a, b) => Number(a.slice(12)) - Number(b.slice(12)))
			.map((k) => props[k])
			.join("");
		for (const k of Object.keys(props)) if (k.startsWith("ZOTERO_PREF_")) expect(props[k]!.length).toBeLessThanOrEqual(255);
		const prefs = parsePrefsXml(xml)!;
		expect(prefs.fieldType).toBe("ReferenceMark");
		expect(prefs.styleId).toContain("vancouver");

		// the bibliography uses LibreOffice's bibliography paragraph style
		const font = await h.raw<{ para: string }>("h.fontAt", { text: "Outcomes after liver transplantation" });
		expect(font.para).toBe("Bibliography 1");
	}, 120_000);

	test("save as ODT, reopen, refresh changes nothing", async () => {
		const path = join(tmp, "e2e.odt");
		await h.raw("h.saveAs", { path });
		await h.raw("h.open", { path });
		const before = await app.readFields();
		expect(before.map((f) => f.text.split("\r")[0])).toEqual(["(1)", "(see 2,3)", expect.stringContaining("Smith J")]);
		const rep = await app.refreshAll();
		expect(rep.updated).toBe(0);
		expect(rep.citations).toBe(2);
	}, 60_000);

	test("change style: every citation and the bibliography are rewritten, formatting applied, codes stay parseable", async () => {
		const rep = await app.setStyle("apa", "en-US");
		expect(rep.citations).toBe(2);
		const fields = await app.readFields();
		expect(fields[0]!.text).toBe("(Smith & Haddad, 2021)");
		expect(fields[1]!.text).toContain("Chen, 2019");
		for (const f of fields) expect(f.parsed).not.toBeNull();
		// APA italicises the journal title in the bibliography
		const font = await h.raw<{ italic: boolean }>("h.fontAt", { text: "Transplantation" });
		expect(font.italic).toBe(true);
		const marks = await h.raw<{ marks: string[] }>("h.marks");
		expect(marks.marks.length).toBe(2);
		for (const m of marks.marks) expect(m).toMatch(ITEM_MARK);
	}, 60_000);

	test("a refresh with Track Changes on leaves no tracked change behind", async () => {
		await h.raw("h.track", { on: true });
		await app.setStyle("vancouver", "en-US");
		const t = await h.raw<{ on: boolean; redlines: boolean }>("h.track");
		expect(t.on).toBe(true);
		expect(t.redlines).toBe(false);
		await h.raw("h.track", { on: false });
		expect((await app.readFields())[0]!.text).toBe("(1)");
	}, 60_000);

	test("note style: citations move into footnotes and back", async () => {
		await app.setStyle("znnote", "en-US");
		let fields = await app.readFields();
		const items = fields.filter((f) => f.kind === "item");
		expect(items.map((f) => f.story)).toEqual(["fn", "fn"]);
		expect(items.map((f) => f.note)).toEqual([1, 2]);
		const notes = await h.raw<{ footnotes: string[] }>("h.footnotes");
		expect(notes.footnotes.length).toBe(2);
		expect(notes.footnotes[0]).toContain("Smith");
		await app.setStyle("vancouver", "en-US");
		fields = await app.readFields();
		expect(fields.filter((f) => f.kind === "item").map((f) => f.story)).toEqual(["main", "main"]);
		expect((await h.raw<{ footnotes: string[] }>("h.footnotes")).footnotes.length).toBe(0);
	}, 90_000);

	test("touching citations merge on refresh; split gives one citation per item", async () => {
		await h.raw("h.newDoc");
		await h.raw("h.type", { text: "Two sources" });
		await app.insertCitation([picks[0]!]);
		await app.insertCitation([picks[1]!]);
		let fields = await app.readFields();
		expect(fields.length).toBe(2);
		expect(fields[1]!.start).toBe(fields[0]!.end);
		const rep = await app.refreshAll({ merge: true });
		expect(rep.merged).toBe(1);
		fields = await app.readFields();
		expect(fields.length).toBe(1);
		expect(fields[0]!.parsed?.kind === "item" && fields[0]!.parsed.data.citationItems.length).toBe(2);
		const f = fields[0]!;
		if (f.parsed?.kind !== "item") throw new Error("not a citation");
		await app.splitCitation({ story: f.story, idx: f.idx }, f.parsed.data.citationID);
		fields = await app.readFields();
		expect(fields.length).toBe(2);
		expect(fields.map((x) => x.text)).toEqual(["(1)", "(2)"]);
	}, 60_000);

	test("a document as Zotero writes it ({Citation} placeholder, no Zinc state) is refreshed in place", async () => {
		await h.raw("h.newDoc");
		await h.raw("h.type", { text: "Written by Zotero " });
		const data = {
			citationID: "zotero01",
			properties: { formattedCitation: "{Citation}", plainCitation: "{Citation}", noteIndex: 0 },
			citationItems: [{ id: 1, uris: [`${app.uriBase}/items/BBBB2222`], itemData: picks[1]!.csl }],
			schema: "https://github.com/citation-style-language/schema/raw/master/csl-citation.json",
		};
		await h.raw("h.rawMark", { name: `ZOTERO_ITEM CSL_CITATION ${JSON.stringify(data)} RNDzoteroAB12`, text: "{Citation}" });
		await h.raw("doc.setPrefs", {
			xml: '<data data-version="3" zotero-version="7.0.11"><session id="abcdEFGH"/><style id="http://www.zotero.org/styles/vancouver" locale="en-US" hasBibliography="1" bibliographyStyleHasBeenSet="0"/><prefs><pref name="fieldType" value="ReferenceMark"/><pref name="automaticJournalAbbreviations" value="true"/><pref name="noteType" value="0"/></prefs></data>',
		});
		const rep = await app.refreshAll({ onModified: "overwrite" });
		expect(rep.citations).toBe(1);
		const fields = await app.readFields();
		expect(fields[0]!.text).toBe("(1)");
		expect(parseFieldCode(fields[0]!.code)?.kind).toBe("item");
		expect((await h.raw<{ marks: string[] }>("h.marks")).marks[0]).toMatch(ITEM_MARK);
	}, 60_000);

	test("unlink keeps the text and its formatting, removes every mark", async () => {
		await h.raw("h.cursorEnd");
		await h.raw("h.para");
		await app.insertBibliography();
		const r = await app.unlinkCitations();
		expect(r.unlinked).toBe(2);
		const marks = await h.raw<{ marks: string[]; sections: string[] }>("h.marks");
		expect(marks.marks).toEqual([]);
		expect(marks.sections.filter((s) => s.startsWith("ZOTERO_"))).toEqual([]);
		expect((await h.raw<{ text: string }>("h.text")).text).toContain("Written by Zotero (1)");
	}, 60_000);

	test("speed: a 40-citation document reads and refreshes with few round trips", async () => {
		await h.raw("h.newDoc");
		for (let i = 0; i < 40; i++) {
			await h.raw("h.type", { text: `Sentence ${i} with a claim` });
			await h.raw("h.rawMark", {
				name: `ZOTERO_ITEM CSL_CITATION ${JSON.stringify({
					citationID: "c" + i,
					properties: { formattedCitation: "", plainCitation: "", noteIndex: 0 },
					citationItems: [{ id: 1, uris: [`${app.uriBase}/items/${picks[i % 3]!.key}`], itemData: picks[i % 3]!.csl }],
				})} RND${String(i).padStart(10, "0")}`,
				text: "[x]",
			});
			await h.raw("h.type", { text: ". " });
		}
		const fieldsMs = (await h.raw<{ ms: number }>("h.bench", { method: "doc.fields", n: 5 })).ms;
		// inside soffice, as the installed extension runs: the numbers that matter
		const inFields = await h.raw<{ ms: number }>("h.benchInProcess", { method: "doc.fields", n: 20 });
		const inCursor = await h.raw<{ ms: number }>("h.benchInProcess", { method: "doc.cursor", n: 50 });
		const inRewrite = await h.raw<{ ms: number; n: number }>("h.benchInProcess", { method: "rewriteAll" });
		console.log(
			`in-process: doc.fields ${inFields.ms.toFixed(1)} ms, doc.cursor ${inCursor.ms.toFixed(2)} ms, read + rewrite all ${inRewrite.n} citations ${inRewrite.ms.toFixed(0)} ms`,
		);
		expect(inRewrite.n).toBe(40);
		expect(inFields.ms).toBeLessThan(fieldsMs);
		h.docCalls.length = 0;
		const t0 = performance.now();
		const rep = await app.refreshAll({ onModified: "overwrite" });
		const refreshMs = performance.now() - t0;
		expect(rep.citations).toBe(40);
		console.log(
			`doc.fields (40 citations, remote UNO): ${fieldsMs.toFixed(1)} ms; refresh: ${refreshMs.toFixed(0)} ms, doc calls: ${h.docCalls.join(" ")}`,
		);
		// one read, one batched write (plus prefs/state and the undo bracket): never a call per citation
		expect(h.docCalls.filter((c) => c === "doc.set").length).toBe(0);
		expect(h.docCalls.filter((c) => c === "doc.setMany").length).toBe(1);
		expect(h.docCalls.length).toBeLessThan(10);
		const fields = await app.readFields();
		expect(fields[0]!.text).toBe("(1)");
		expect(fields[39]!.text).toBe("(1)");
	}, 180_000);
});
