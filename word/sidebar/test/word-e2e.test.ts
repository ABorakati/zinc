// End-to-end: the real sidebar controller (app.ts) -> the add-in's Bridge/WordDoc -> a private INVISIBLE Word.
// Off by default (it starts WINWORD.EXE). Run with:
//   ZN_WORD_E2E=1 ZN_TEST_DB=<copy of a library.sqlite> bun test test/word-e2e.test.ts
// Never uses the user's Word (the harness refuses to start while any WINWORD.EXE runs), never the real library
// (point ZN_TEST_DB at a copy), never writes outside the temp folder it creates.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/app";
import { parseFieldCode, parsePrefsXml, uriToKey } from "../src/fields";
import { HARNESS_EXE, HarnessHost } from "./harness-host";

const ENABLED = process.env.ZN_WORD_E2E === "1";
const DB = process.env.ZN_TEST_DB ?? "";
const FIX = join(import.meta.dir, "..", "..", "..", "core", "test", "cite", "fixtures");
const d = ENABLED ? describe : describe.skip;

const NOTE_STYLE = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="note" version="1.0" default-locale="en-US"><info><title>ZN note test</title><id>http://www.zotero.org/styles/znnote</id><link href="http://www.zotero.org/styles/znnote" rel="self"/><updated>2020-01-01T00:00:00+00:00</updated></info>
<citation><layout delimiter="; " suffix="."><group delimiter=", "><names variable="author"><name form="short"/></names><text variable="title" font-style="italic"/></group></layout></citation>
<bibliography><layout suffix="."><text variable="title"/></layout></bibliography></style>`;

function zipText(docx: string, member: string): string {
	const r = Bun.spawnSync([process.env.SystemRoot + "/System32/tar.exe", "-xOf", docx, member]);
	return new TextDecoder().decode(r.stdout);
}

d("sidebar controller driving an invisible Word", () => {
	let h: HarnessHost;
	let app: App;
	let tmp: string;
	const docx = () => join(tmp, "e2e.docx");

	beforeAll(async () => {
		if (!existsSync(HARNESS_EXE)) throw new Error("build the harness first: dotnet build word/harness -c Release");
		if (!existsSync(DB)) throw new Error("set ZN_TEST_DB to a COPY of library.sqlite");
		tmp = mkdtempSync(join(tmpdir(), "zn-word-e2e-"));
		const cache = join(tmp, "cache");
		mkdirSync(join(cache, "styles"), { recursive: true });
		mkdirSync(join(cache, "locales"), { recursive: true });
		for (const s of ["vancouver.csl", "apa.csl"]) cpSync(join(FIX, s), join(cache, "styles", s));
		cpSync(join(FIX, "locales-en-US.xml"), join(cache, "locales", "locales-en-US.xml"));
		writeFileSync(join(cache, "styles", "znnote.csl"), NOTE_STYLE);
		h = await HarnessHost.start({ db: DB, settings: join(tmp, "settings.json"), cache });
		const started = await h.call<{ pid: number; version: string }>("h.start");
		expect(started.pid).toBeGreaterThan(0);
		app = new App(h);
		await app.init();
	}, 90_000);

	afterAll(async () => {
		await h?.stop();
	}, 60_000);

	test("COM surface is as Office expects (interfaces, IIDs, ribbon callbacks)", async () => {
		const r = await h.call<any>("h.comSelfTest");
		expect(r["qi B65AD801-ABAF-11D0-BB8B-00A0C90F2744"]).toBe(true);
		expect(r["qi 000C0396-0000-0000-C000-000000000046"]).toBe(true);
		expect(r["qi 000C033E-0000-0000-C000-000000000046"]).toBe(true);
		expect(r["connect.progid"]).toBe("ZoteroNext.WordAddIn");
		expect(r["pane.progid"]).toBe("ZoteroNext.WordPane");
		expect(r["pane.isControl"]).toBe(true);
		expect(r["ribbon.missingCallbacks"]).toEqual([]);
	});

	test("library: opens read-only, searches with FTS, DOI and year filters", async () => {
		expect(app.info!.library.dbExists).toBe(true);
		expect((await app.init(true)).library.items).toBeGreaterThan(1000);
		const rows = await app.search("liver transplantation", 10);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows[0]!.key).toMatch(/^[A-Z0-9]{8}$/);
		const typing = await app.search("transplant", 5);
		expect(typing.length).toBeGreaterThan(0);
		const withDoi = rows.find((r) => r.doi) ?? (await app.search("cohort", 30)).find((r) => r.doi)!;
		const byDoi = await app.search(withDoi.doi, 5);
		expect(byDoi.map((r) => r.key)).toContain(withDoi.key);
		const y = withDoi.year!;
		const byYear = await app.search(`liver ${y}`, 10);
		expect(byYear.every((r) => r.year === y)).toBe(true);
		const recent = await app.search("", 5);
		expect(recent.length).toBe(5);
	}, 60_000);

	let keys: string[] = [];
	test("insert citations and a bibliography, save, reopen, verify", async () => {
		await h.call("h.newDoc");
		const rows = await app.search("liver transplantation", 12);
		keys = rows.slice(0, 3).map((r) => r.key);
		const picks = [];
		for (const k of keys) picks.push((await app.pickFromKey(k))!);

		await h.call("h.type", { text: "Liver transplant outcomes vary by centre" });
		await app.insertCitation([picks[0]!]);
		await h.call("h.type", { text: ", and machine perfusion may help" });
		picks[1]!.locator = "12-14";
		picks[1]!.prefix = "see";
		await app.insertCitation([picks[1]!, picks[2]!]);
		await h.call("h.type", { text: "." });
		await h.call("h.cursorEnd");
		await h.call("h.para");
		const rep = await app.insertBibliography();
		expect(rep.citations).toBe(2);

		const fields = await app.readFields();
		expect(fields.map((f) => f.kind)).toEqual(["item", "item", "bibl"]);
		const c1 = fields[0]!.parsed!;
		expect(c1.kind).toBe("item");
		if (c1.kind !== "item") return;
		expect(c1.data.citationItems[0]!.uris[0]).toBe(`${app.uriBase}/items/${keys[0]}`);
		expect(uriToKey(c1.data.citationItems[0]!.uris[0]!)).toBe(keys[0]!);
		expect(c1.data.properties.plainCitation).toBe("(1)");
		expect(fields[0]!.text).toBe("(1)");
		expect(fields[1]!.text).toBe("(see 2,3)");
		const bibText = fields[2]!.text.split("\r");
		expect(bibText.length).toBe(3);
		expect(fields[2]!.code).toBe('ADDIN ZOTERO_BIBL {"uncited":[],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY');
		const doc = (await h.call<{ text: string }>("h.text")).text;
		expect(doc).toContain("Liver transplant outcomes vary by centre(1), and machine perfusion may help(see 2,3).");

		await h.call("h.saveAs", { path: docx() });
		await h.call("h.close");

		// the saved file, as Zotero would see it
		const xml = zipText(docx(), "word/document.xml");
		expect((xml.match(/ADDIN ZOTERO_ITEM CSL_CITATION/g) ?? []).length).toBe(2);
		expect((xml.match(/ADDIN ZOTERO_BIBL/g) ?? []).length).toBe(1);
		expect((xml.match(/fldCharType="begin"/g) ?? []).length).toBe((xml.match(/fldCharType="end"/g) ?? []).length);
		expect((xml.match(/fldCharType="separate"/g) ?? []).length).toBe(3);
		const custom = zipText(docx(), "docProps/custom.xml");
		expect(custom).toContain('name="ZOTERO_PREF_1"');
		expect(custom).toMatch(/&lt;data data-version=(?:"|&quot;)3(?:"|&quot;) zotero-version=/); // raw XML as the property value, escaped once by the file format

		// reopen: the sidebar reads Word's fields back
		await h.call("h.open", { path: docx() });
		const st = await app.docState();
		expect(st.hasDoc).toBe(true);
		expect(st.prefs?.styleId).toBe("http://www.zotero.org/styles/vancouver");
		expect(st.prefs?.hasBibliography).toBe(true);
		expect(st.prefs?.fieldType).toBe("Field");
		const again = await app.readFields();
		expect(again.map((f) => f.code)).toEqual(fields.map((f) => f.code));
		expect(again.map((f) => f.text)).toEqual(fields.map((f) => f.text));
		const second = parseFieldCode(again[1]!.code)!;
		expect(second.kind === "item" && second.data.citationItems.length).toBe(2);
		expect(second.kind === "item" && second.data.citationItems[0]!.locator).toBe("12-14");
		expect(second.kind === "item" && second.data.citationItems[0]!.prefix).toBe("see");
		// refresh of an unchanged document changes nothing
		const r = await app.refreshAll();
		expect(r.updated).toBe(0);
	}, 180_000);

	test("cursor inside a citation reports the field; the cited item is described with its abstract", async () => {
		await h.call("h.cursor", { start: 3 });
		const outside = await h.call<any>("doc.cursor");
		expect(outside.inField).toBe(false);
		const fields = await app.readFields();
		// caret between "(" and "1" of the first citation's visible text "(1)"
		await h.call("h.cursor", { start: fields[0]!.end - 3 });
		const cur = await h.call<any>("doc.cursor");
		expect(cur.inField).toBe(true);
		expect(cur.kind).toBe("item");
		expect(cur.ref.story).toBe("main");
		const view = (await app.describeCitation(cur))!;
		expect(view.items.length).toBe(1);
		expect(view.items[0]!.key).toBe(keys[0]!);
		expect(view.items[0]!.inLibrary).toBe(true);
		expect(view.items[0]!.title.length).toBeGreaterThan(5);
		expect(typeof view.items[0]!.abstract).toBe("string");
	}, 60_000);

	test("change style: italics applied in Word, prefs rewritten, still idempotent", async () => {
		const r = await app.setStyle("apa", "en-US");
		expect(r.style).toBe("apa");
		const fields = await app.readFields();
		expect(fields[0]!.text).toMatch(/^\(.+, \d{4}\)$/);
		const st = await app.docState();
		expect(st.prefs?.styleId).toBe("http://www.zotero.org/styles/apa");
		// APA bibliography italicises the journal title: some run in the bibliography is italic
		const bib = fields[2]!;
		const probe = await h.call<any>("h.fontOf", { start: bib.start, end: bib.end });
		expect(probe.italic === 9999999 /* mixed */ || probe.italic === -1 || probe.italic === 1).toBe(true);
		const again = await app.refreshAll();
		expect(again.changed).toEqual([]);
		await h.call("h.saveAs", { path: docx() });
		await h.call("h.close");
	}, 120_000);

	test("edit an existing citation and delete another", async () => {
		await h.call("h.open", { path: docx() });
		const fields = await app.readFields();
		const view = await app.picksFromCitation(fields[1]!.code);
		expect(view!.picks.length).toBe(2);
		const keep = view!.picks.slice(0, 1);
		keep[0]!.suffix = "and others";
		await app.updateCitation({ story: "main", idx: fields[1]!.idx }, view!.citationID, keep);
		const after = await app.readFields();
		const p = after[1]!.parsed!;
		expect(p.kind === "item" && p.data.citationItems.length).toBe(1);
		expect(after[1]!.text).toContain("and others");
		// deleting a citation whose id no longer matches is refused (document changed under the sidebar)
		await expect(app.deleteCitation({ story: "main", idx: after[0]!.idx }, "WRONGID1")).rejects.toThrow(/changed/);
		const del = after[0]!.parsed!;
		await app.deleteCitation({ story: "main", idx: after[0]!.idx }, del.kind === "item" ? del.data.citationID : "");
		const left = await app.readFields();
		expect(left.map((f) => f.kind)).toEqual(["item", "bibl"]);
		await h.call("h.close");
	}, 120_000);

	test("note style: the citation goes into a footnote and the bibliography still builds", async () => {
		await h.call("h.newDoc");
		await app.setStyle("znnote", "en-US");
		const rows = await app.search("liver", 5);
		const pick = (await app.pickFromKey(rows[0]!.key))!;
		await h.call("h.type", { text: "A claim worth a footnote" });
		await app.insertCitation([pick]);
		const n = await h.call<{ count: number }>("h.footnotes");
		expect(n.count).toBe(1);
		const fields = await app.readFields();
		expect(fields.length).toBe(1);
		expect(fields[0]!.story).toBe("fn");
		expect(fields[0]!.note).toBe(1);
		expect(fields[0]!.text.endsWith(".")).toBe(true);
		const prefs = (await app.docState()).prefs!;
		expect(prefs.noteType).toBe(1);
		const p = fields[0]!.parsed!;
		expect(p.kind === "item" && p.data.properties.noteIndex).toBe(1);
		await h.call("h.close");
		expect(parsePrefsXml(null)).toBeNull();
	}, 120_000);

	test("the real sidebar page (WebView2 + bridge) searches, adds and inserts a citation into Word", async () => {
		await h.call("h.newDoc");
		await h.call("h.type", { text: "Sentence cited from the real sidebar" });
		const pane = await h.call<{ ready: boolean }>("h.pane");
		expect(pane.ready).toBe(true);
		const ev = async (js: string) => JSON.parse((await h.call<{ json: string }>("h.paneEval", { js })).json);
		const until = async (what: string, js: string, ms = 20000) => {
			const t0 = Date.now();
			for (;;) {
				const v = await ev(js);
				if (v) return v;
				if (Date.now() - t0 > ms) throw new Error("timed out waiting for " + what);
				await h.call("h.pump", { ms: 150 });
			}
		};
		await until("page init", "document.getElementById('docline').textContent.includes('Document')");
		await ev("(() => { const q = document.getElementById('q'); q.value = 'liver transplantation'; q.dispatchEvent(new Event('input')); return 1; })()");
		await until("results", "document.querySelectorAll('#results li').length > 0");
		await ev("document.querySelector('#results li').click(); 1"); // one click cites straight away
		await until("field in Word", "document.getElementById('status') !== null && document.querySelectorAll('#toast .t').length > 0");
		const fields = await app.readFields();
		expect(fields.length).toBe(1);
		expect(fields[0]!.kind).toBe("item");
		expect(fields[0]!.text).toBe("(1)");
		// click into the citation: the add-in's cursor watcher tells the page, which shows title/abstract
		await h.call("h.cursor", { start: fields[0]!.end - 3 });
		await until("cited card", "!document.getElementById('cited').hidden && document.querySelectorAll('#cited .cite-item').length === 1", 15000);
		const card = await ev("document.getElementById('cited').innerText");
		expect(card.toLowerCase()).toContain("cited here"); // the heading is upper-cased by CSS
		expect(card).toContain("In library");
		expect(card).toContain("Open in zotero-next");
		await h.call("h.close");
	}, 180_000);
});
