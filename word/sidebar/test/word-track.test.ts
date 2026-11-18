// End-to-end against a private INVISIBLE Word (see word-e2e.test.ts): Track Changes and the cursor watcher's cost.
// Off by default (it starts WINWORD.EXE). Needs no library copy: it builds a small synthetic library in a temp folder.
//   ZN_WORD_E2E=1 bun test test/word-track.test.ts
// With the user's own Word open, also set ZN_HARNESS_ALLOW_OTHER_WORD=1: the harness then starts a second, private Word
// and lets go of (never quits) any Word it cannot prove it started itself.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, type Pick } from "../src/app";
import { buildItemCode, parseFieldCode } from "../src/fields";
import { HARNESS_EXE, HarnessHost } from "./harness-host";

const ENABLED = process.env.ZN_WORD_E2E === "1";
const FIX = join(import.meta.dir, "..", "..", "..", "core", "test", "cite", "fixtures");
const d = ENABLED ? describe : describe.skip;
const key = (i: number) => "ITEM" + String(i).padStart(4, "0");

type FieldInfo = { idx: number; codeRevisions: number; resultRevisions: number; codeLength: number; result: string; code: string };
type Revision = { type: number; text: string };

d("Track Changes and the cursor watcher in an invisible Word", () => {
	let h: HarnessHost;
	let app: App;
	const picks: Pick[] = [];

	beforeAll(async () => {
		if (!existsSync(HARNESS_EXE)) throw new Error("build the harness first: pwsh word/build.ps1 -Harness");
		// core's own library code builds the test library; imported by path at run time so the sidebar's typecheck stays
		// within the sidebar (core's .sql text imports only type-check under core's own config)
		const CORE = join(import.meta.dir, "..", "..", "..", "core");
		const { openDb } = await import(join(CORE, "src", "db.ts"));
		const { rebuildSearchIndex } = await import(join(CORE, "src", "search.ts"));
		const { insertItem } = await import(join(CORE, "test", "fixture.ts"));
		const tmp = mkdtempSync(join(tmpdir(), "zn-word-track-"));
		const dbPath = join(tmp, "lib.sqlite");
		const db = openDb(dbPath);
		for (let i = 1; i <= 12; i++)
			insertItem(db, {
				key: key(i),
				itemType: "journalArticle",
				title: `Liver transplantation outcomes study number ${i}`,
				creators: [{ creatorType: "author", firstName: "Ann", lastName: "Author" + i }],
				date: String(1990 + i),
				publicationTitle: "Journal of Hepatology",
			});
		rebuildSearchIndex(db);
		db.close();
		const cache = join(tmp, "cache");
		mkdirSync(join(cache, "styles"), { recursive: true });
		mkdirSync(join(cache, "locales"), { recursive: true });
		cpSync(join(FIX, "vancouver.csl"), join(cache, "styles", "vancouver.csl"));
		cpSync(join(FIX, "locales-en-US.xml"), join(cache, "locales", "locales-en-US.xml"));
		writeFileSync(join(tmp, "settings.json"), JSON.stringify({ dbPath }));
		h = await HarnessHost.start({ db: dbPath, settings: join(tmp, "settings.json"), cache });
		await h.call("h.start");
		app = new App(h);
		await app.init();
		for (let i = 1; i <= 12; i++) picks.push((await app.pickFromKey(key(i)))!);
	}, 90_000);

	afterAll(async () => {
		await h?.stop();
	}, 60_000);

	/** A new document "Alpha (1) and beta (2) and gamma (3) end." + bibliography, Track Changes off. */
	async function threeCitations() {
		await h.call("h.newDoc");
		for (const [i, text] of [
			[1, "Alpha claim "],
			[2, " and beta claim "],
			[3, " and gamma claim "],
		] as const) {
			await h.call("h.type", { text });
			await app.insertCitation([picks[i]!]);
		}
		await h.call("h.type", { text: " end." });
		await h.call("h.para");
		await app.insertBibliography();
	}
	const info = () => h.call<FieldInfo[]>("h.fieldInfo");
	const revisions = () => h.call<Revision[]>("h.revisions");
	const texts = async () => (await app.readFields()).filter((f) => f.kind === "item").map((f) => f.text);

	test("a refresh with Track Changes on rewrites codes untracked: no JSON in any tracked change, nothing left doubled", async () => {
		await threeCitations();
		await h.call("h.track", { on: true, author: "Reviewer" });
		await h.call("h.cursor", { start: 5 });
		const rep = await app.insertCitation([picks[0]!]); // new first citation: every later number shifts
		expect(rep.updated).toBeGreaterThanOrEqual(4);
		expect(await texts()).toEqual(["(1)", "(2)", "(3)", "(4)"]);
		// the one tracked change is the user's: the inserted citation (as one insertion), never a field code on its own
		const revs = await revisions();
		expect(revs.length).toBe(1);
		expect(revs[0]!.type).toBe(1);
		expect(revs.some((r) => /CSL_CITATION|ZOTERO_BIBL/.test(r.text))).toBe(false);
		for (const f of await info()) {
			expect(f.code.match(/ZOTERO_/g)?.length).toBe(1); // one instruction per code, not old + new
			expect(f.result).not.toContain(")(");
		}
		const fields = await app.readFields({ checkTracked: true });
		expect(fields.every((f) => f.parsed !== null && !f.tracked)).toBe(true);
		expect((await app.refreshAll()).updated).toBe(0); // idempotent
		expect((await h.call<{ on: boolean }>("h.track")).on).toBe(true); // the user's setting is left as it was
		await h.call("h.cursor", { start: 2 });
		await h.call("h.type", { text: "typed later" });
		expect((await revisions()).length).toBe(2); // and the user's own typing (away from the new citation) is still tracked
		await h.call("h.close");
	}, 120_000);

	test("rejecting the tracked citation leaves no stray JSON, and a refresh renumbers again", async () => {
		await threeCitations();
		await h.call("h.track", { on: true, author: "Reviewer" });
		await h.call("h.cursor", { start: 5 });
		await app.insertCitation([picks[0]!]);
		await h.call("h.rejectAll");
		const plain = (await h.call<{ text: string }>("h.text")).text;
		expect(plain).not.toMatch(/CSL_CITATION|citationID/);
		// the renumbering was untracked, so it stays until the next refresh puts it right
		await app.refreshAll();
		expect(await texts()).toEqual(["(1)", "(2)", "(3)"]);
		await h.call("h.close");
	}, 120_000);

	test("a document damaged by an older tracked refresh is read correctly and cleaned by the next refresh", async () => {
		await threeCitations();
		const before = await app.readFields();
		await h.call("h.track", { on: true, author: "Reviewer" });
		// what the add-in used to do: rewrite the code with tracking on (old JSON tracked as deleted, new as inserted)
		const p = parseFieldCode(before[1]!.code)!;
		if (p.kind !== "item") throw new Error("expected a citation");
		// any change to the JSON will do; the schema URL is one a refresh keeps, so only the damage makes it rewrite this field
		const changed = buildItemCode({ ...p.data, schema: String(p.data.schema ?? "") + "#v2" });
		await h.call("h.rawSetCode", { idx: before[1]!.idx, code: changed });
		expect((await info())[1]!.codeRevisions).toBeGreaterThan(0); // old JSON tracked as deleted, new as inserted
		expect((await app.readFields()).every((f) => f.parsed !== null)).toBe(true); // a plain read (popup labels) parses it too
		const damaged = await app.readFields({ checkTracked: true }); // as a refresh reads it
		expect(damaged[1]!.tracked).toBe(true);
		expect(damaged[1]!.parsed).not.toBeNull(); // read as it is with the change accepted
		const rep = await app.refreshAll();
		expect(rep.changed.some((c) => c.startsWith(`item#${before[1]!.idx}:`))).toBe(true);
		const after = await info();
		expect(after.every((f) => f.codeRevisions === 0)).toBe(true);
		expect((await app.readFields({ checkTracked: true })).every((f) => !f.tracked && f.parsed !== null)).toBe(true);
		expect((await app.refreshAll()).updated).toBe(0);
		await h.call("h.close");
	}, 120_000);

	test("with many tracked changes in the document, a damaged citation is still read and cleaned (only its own changes looked at)", async () => {
		await threeCitations();
		const before = await app.readFields();
		await h.call("h.track", { on: true, author: "Reviewer" });
		const p = parseFieldCode(before[1]!.code)!;
		if (p.kind !== "item") throw new Error("expected a citation");
		await h.call("h.rawSetCode", {
			idx: before[1]!.idx,
			code: buildItemCode({ ...p.data, schema: String(p.data.schema ?? "") + "#v2" }),
		});
		// a document under review: dozens of the user's own tracked changes (separate insertions, apart from the fields)
		// (an untracked space after each one, or Word merges them into one insertion)
		for (let i = 0; i < 45; i++) {
			await h.call("h.cursor", { start: 1 });
			await h.call("h.track", { on: true });
			await h.call("h.type", { text: "y" });
			await h.call("h.track", { on: false });
			await h.call("h.type", { text: " " });
		}
		await h.call("h.track", { on: true });
		expect((await revisions()).length).toBeGreaterThan(40);
		const plain = await app.readFields(); // the popup's read: no tracked-change lookups for a code that reads clean
		expect(plain.every((f) => f.parsed !== null)).toBe(true);
		const damaged = await app.readFields({ checkTracked: true });
		expect(damaged.map((f) => f.tracked)).toEqual([false, true, false, false]);
		expect(damaged.every((f) => f.parsed !== null)).toBe(true);
		await app.refreshAll();
		expect((await info()).every((f) => f.codeRevisions === 0)).toBe(true);
		expect((await app.readFields({ checkTracked: true })).every((f) => !f.tracked)).toBe(true);
		expect((await app.refreshAll()).updated).toBe(0);
		await h.call("h.close");
	}, 180_000);

	test("a citation deleted with Track Changes on stays a tracked deletion and leaves the numbering", async () => {
		await threeCitations();
		await h.call("h.track", { on: true, author: "Reviewer" });
		const fields = await app.readFields();
		const second = fields[1]!.parsed!;
		if (second.kind !== "item") throw new Error("expected a citation");
		await app.deleteCitation({ story: "main", idx: fields[1]!.idx }, second.data.citationID);
		const revs = await revisions();
		expect(revs.length).toBe(1);
		expect(revs[0]!.type).toBe(2); // still there as the user's tracked deletion
		expect(await texts()).toEqual(["(1)", "(2)"]); // the deleted one no longer counts: gamma is now (2)
		await h.call("h.close");
	}, 120_000);

	test("the cursor watcher stays out of Word's way while the user types, and reads once the cursor rests", async () => {
		await threeCitations();
		await h.call("h.cursorEnd");
		await h.call("h.watch", { on: true });
		await h.call("h.typeFor", { ms: 2500, every: 100 });
		const typing = await h.call<{ fullReads: number; wordTicks: number }>("h.watch");
		expect(typing.wordTicks).toBeGreaterThan(5);
		expect(typing.fullReads).toBeLessThanOrEqual(1); // never while the selection keeps moving
		await h.call("h.pump", { ms: 1200 });
		const rested = await h.call<{ fullReads: number }>("h.watch");
		expect(rested.fullReads).toBe(typing.fullReads + 1); // one read when it stops, then nothing new to read
		await h.call("h.close");
	}, 120_000);
});
