// The Word integration endpoints (/connector/document/execCommand + respond), driven by a scripted client that behaves like the
// official Word add-in (zotero-word-js-integration): it keeps an in-memory document, asks for the first command and answers each
// request over HTTP. Runs on a TEST port (never 23119).
import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseFieldCode, parsePrefsXml } from "../../src/cite/docfields";
import { startZoteroPort } from "../../src/zport";
import { type IntegrationUI, integrationOptions, setIntegrationUI } from "../../src/zport/integration";
import { buildFixture, type Fixture } from "../fixture";

const PORT = 23291;
const URL0 = `http://127.0.0.1:${PORT}`;
const FIX = join(import.meta.dir, "..", "cite", "fixtures");

interface F {
	id: string;
	code: string; // without the ADDIN ZOTERO_ prefix
	text: string;
	noteType: number;
	adjacent: boolean;
}

/** An in-memory Word document plus the client loop of the Word add-in. */
class FakeWord {
	fields: F[] = [];
	docData = "";
	cursor: string | null = null;
	alerts: string[] = [];
	alertAnswer = 1;
	bibStyleCalls = 0;
	removed: string[] = [];
	private n = 0;
	log: string[] = [];

	private fieldJson(f: F) {
		return { id: f.id, code: f.code, text: f.text, noteType: f.noteType, adjacent: f.adjacent };
	}
	private handle(command: string, args: any[]): unknown {
		this.log.push(command);
		const [, a, b, c] = args; // args[0] is the document id
		const fieldById = (id: string) => this.fields.find((f) => f.id === id)!;
		switch (command) {
			case "Application.getActiveDocument":
				return { documentID: "doc1", outputFormat: "html", supportedNotes: ["footnotes", "endnotes"], supportsImportExport: true, supportsTextInsertion: true, supportsCitationMerging: true, processorName: "Test Word" };
			case "Document.getDocumentData":
				return this.docData;
			case "Document.setDocumentData":
				this.docData = a;
				return null;
			case "Document.canInsertField":
				return true;
			case "Document.cursorInField": {
				const f = this.cursor ? this.fields.find((x) => x.id === this.cursor) : undefined;
				return f ? this.fieldJson(f) : null;
			}
			case "Document.insertField": {
				const f: F = { id: `f${++this.n}`, code: "TEMP", text: "{Updating}", noteType: Number(b) || 0, adjacent: false };
				this.fields.push(f);
				this.cursor = f.id;
				return this.fieldJson(f);
			}
			case "Document.getFields":
				return this.fields.map((f) => this.fieldJson(f));
			case "Document.setBibliographyStyle":
				this.bibStyleCalls++;
				return null;
			case "Document.displayAlert":
				this.alerts.push(a);
				return this.alertAnswer;
			case "Document.convert":
				return null;
			case "Field.setCode":
				fieldById(a).code = b;
				return null;
			case "Field.setText":
				fieldById(a).text = String(b).replace(/<br>/g, "\r").replace(/<\/div>/g, "\r").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/\r$/, "");
				return null;
			case "Field.delete":
				this.fields = this.fields.filter((f) => f.id !== a);
				if (this.cursor === a) this.cursor = null;
				return null;
			case "Field.removeCode":
				this.removed.push(fieldById(a).text);
				this.fields = this.fields.filter((f) => f.id !== a);
				return null;
			case "Field.select":
			case "Document.activate":
			case "Document.cleanup":
				return null;
			default:
				throw new Error("fake word: unhandled " + command + " " + c);
		}
	}

	/** Run one integration command like a ribbon button does; resolves when zotero-next sends Document.complete. */
	async run(command: string): Promise<{ status: number }> {
		let res = await fetch(`${URL0}/connector/document/execCommand`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command, docId: "doc1" }) });
		if (res.status !== 200) return { status: res.status };
		for (;;) {
			const req = (await res.json()) as { command: string; arguments: any[] };
			if (req.command === "Document.complete") return { status: 200 };
			let result: unknown;
			try {
				result = this.handle(req.command, req.arguments);
			} catch (e) {
				result = { error: "Connector Error", message: String(e) };
			}
			res = await fetch(`${URL0}/connector/document/respond`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(result ?? null) });
		}
	}
}

let fx: Fixture;
let db: Database;
let zport: ReturnType<typeof startZoteroPort>;

beforeAll(() => {
	fx = buildFixture();
	db = fx.db;
	mkdirSync(join(fx.dir, "styles"), { recursive: true });
	mkdirSync(join(fx.dir, "locales"), { recursive: true });
	for (const s of ["vancouver", "apa"]) copyFileSync(join(FIX, `${s}.csl`), join(fx.dir, "styles", `${s}.csl`));
	copyFileSync(join(FIX, "locales-en-US.xml"), join(fx.dir, "locales", "locales-en-US.xml"));
	zport = startZoteroPort(db, { port: PORT });
	expect(zport.listening).toBe(true);
});
afterAll(() => {
	setIntegrationUI(null);
	zport.stop();
	db.close();
});

let word: FakeWord;
let script: { citation: any[]; bibliography: any[]; docPrefs: any[] };
const ui: IntegrationUI = {
	citation: async () => script.citation.shift() ?? null,
	bibliography: async (req) => {
		lastBibRequest = req;
		return script.bibliography.shift() ?? null;
	},
	docPrefs: async () => script.docPrefs.shift() ?? null,
};
let lastBibRequest: any;
beforeEach(() => {
	word = new FakeWord();
	script = { citation: [], bibliography: [], docPrefs: [] };
	setIntegrationUI(ui);
});

const cit = (f: F) => {
	const p = parseFieldCode("ADDIN ZOTERO_" + f.code);
	if (p?.kind !== "item") throw new Error("not a citation: " + f.code);
	return p.data;
};

describe("execCommand / respond", () => {
	test("a new document asks for preferences, then inserts and formats a citation", async () => {
		script.docPrefs.push({ style: "vancouver", locale: "en-US", noteType: 1, fieldType: "Field" });
		script.citation.push({ items: [{ key: "AAAAAAA1", locator: "12", label: "page" }] });
		expect((await word.run("addEditCitation")).status).toBe(200);
		expect(word.fields.length).toBe(1);
		expect(word.fields[0]!.code.startsWith("ITEM CSL_CITATION {")).toBe(true);
		expect(word.fields[0]!.text).toBe("(1)");
		const c = cit(word.fields[0]!);
		expect(c.citationItems[0]!.uris[0]).toMatch(/^http:\/\/zotero\.org\/users\/local\/[^/]+\/items\/AAAAAAA1$/);
		expect(c.citationItems[0]!.locator).toBe("12");
		expect(c.citationItems[0]!.itemData!.title).toBe("Deep learning for radiology");
		expect(c.properties.plainCitation).toBe("(1)");
		const prefs = parsePrefsXml(word.docData)!;
		expect(prefs.styleId).toBe("http://www.zotero.org/styles/vancouver");
		expect(prefs.fieldType).toBe("Field");
		expect(prefs.hasBibliography).toBe(false);
		// the exact request sequence is Zotero's: document first, data, then field work
		expect(word.log[0]).toBe("Application.getActiveDocument");
		expect(word.log[1]).toBe("Document.getDocumentData");
	});

	test("second citation, bibliography, then refresh after a library edit", async () => {
		script.docPrefs.push({ style: "vancouver", fieldType: "Field" });
		script.citation.push({ items: [{ key: "BBBBBBB2" }] }, { items: [{ key: "AAAAAAA1" }] });
		await word.run("addEditCitation");
		word.cursor = null;
		await word.run("addEditCitation");
		expect(word.fields.map((f) => f.text)).toEqual(["(1)", "(2)"]);
		word.cursor = null;
		await word.run("addEditBibliography");
		expect(word.fields.length).toBe(3);
		const bib = word.fields[2]!;
		expect(bib.code).toBe('BIBL {"uncited":[],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY');
		expect(bib.text).toContain("Surgical anatomy");
		expect(bib.text).toContain("Deep learning for radiology");
		expect(bib.text.indexOf("Surgical")).toBeLessThan(bib.text.indexOf("Deep learning"));
		expect(word.bibStyleCalls).toBe(1);
		expect(parsePrefsXml(word.docData)!.hasBibliography).toBe(true);

		db.query("UPDATE items SET data = json_set(data, '$.title', 'Deep learning for radiology, revised') WHERE key = 'AAAAAAA1'").run();
		await word.run("refresh");
		expect(word.fields[2]!.text).toContain("revised");
		expect(cit(word.fields[1]!).citationItems[0]!.itemData!.title).toBe("Deep learning for radiology, revised");
		db.query("UPDATE items SET data = json_set(data, '$.title', 'Deep learning for radiology') WHERE key = 'AAAAAAA1'").run();
	});

	test("refresh merges adjacent citations into the field after them", async () => {
		script.docPrefs.push({ style: "vancouver", fieldType: "Field" });
		script.citation.push({ items: [{ key: "AAAAAAA1" }] }, { items: [{ key: "BBBBBBB2" }] });
		await word.run("addEditCitation");
		word.cursor = null;
		await word.run("addEditCitation");
		word.fields[0]!.adjacent = true;
		await word.run("refresh");
		expect(word.fields.length).toBe(1);
		const c = cit(word.fields[0]!);
		expect(c.citationItems.map((i) => i.uris[0]!.split("/").pop())).toEqual(["BBBBBBB2", "AAAAAAA1"]);
		expect(word.fields[0]!.text).toBe("(1,2)");
	});

	test("editing a citation keeps its id; cancelling an insert removes the placeholder", async () => {
		script.docPrefs.push({ style: "vancouver", fieldType: "Field" });
		script.citation.push({ items: [{ key: "AAAAAAA1" }] });
		await word.run("addEditCitation");
		const id1 = cit(word.fields[0]!).citationID;
		script.citation.push({ items: [{ key: "AAAAAAA1", prefix: "see", suffix: "for more" }, { key: "BBBBBBB2" }] });
		await word.run("addEditCitation"); // the cursor is still in the field
		expect(word.fields.length).toBe(1);
		const c = cit(word.fields[0]!);
		expect(c.citationID).toBe(id1);
		expect(c.citationItems.length).toBe(2);
		expect(c.citationItems[0]!.prefix).toBe("see");
		word.cursor = null;
		script.citation.push(null);
		await word.run("addEditCitation");
		expect(word.fields.length).toBe(1);
	});

	test("bibliography editor: exclude, custom text, uncited item", async () => {
		script.docPrefs.push({ style: "vancouver", fieldType: "Field" });
		script.citation.push({ items: [{ key: "AAAAAAA1" }, { key: "BBBBBBB2" }] });
		await word.run("addEditCitation");
		word.cursor = null;
		await word.run("addEditBibliography");
		script.bibliography.push({ omitted: ["BBBBBBB2"], uncited: ["DDDDDDD4"], custom: { AAAAAAA1: "My <i>own</i> entry" } });
		word.cursor = null;
		await word.run("addEditBibliography");
		expect(lastBibRequest.entries.length).toBe(2);
		const bib = word.fields[1]!;
		const data = parseFieldCode("ADDIN ZOTERO_" + bib.code);
		expect(data?.kind).toBe("bibl");
		if (data?.kind === "bibl") {
			expect(data.data.omitted.length).toBe(1);
			expect(data.data.uncited.length).toBe(1);
			expect(data.data.custom.length).toBe(1);
		}
		expect(bib.text).not.toContain("Surgical anatomy");
		expect(bib.text).toContain("My own entry");
		expect(bib.text).toContain("Zebra genetics");
		// a plain refresh keeps the edits
		await word.run("refresh");
		expect(word.fields[1]!.text).toContain("My own entry");
		expect(word.fields[1]!.text).not.toContain("Surgical anatomy");
	});

	test("a hand-edited citation is frozen (dontUpdate) when the user chooses to keep it", async () => {
		script.docPrefs.push({ style: "vancouver", fieldType: "Field" });
		script.citation.push({ items: [{ key: "AAAAAAA1" }] });
		await word.run("addEditCitation");
		word.fields[0]!.text = "(my own text)";
		word.alertAnswer = 1; // yes, keep
		await word.run("refresh");
		expect(word.alerts.some((a) => a.includes("edited"))).toBe(true);
		expect(word.fields[0]!.text).toBe("(my own text)");
		expect(cit(word.fields[0]!).properties.dontUpdate).toBe(true);
	});

	test("Unlink citations removes every code after confirmation", async () => {
		script.docPrefs.push({ style: "vancouver", fieldType: "Field" });
		script.citation.push({ items: [{ key: "AAAAAAA1" }] });
		await word.run("addEditCitation");
		word.alertAnswer = 0; // cancel
		await word.run("removeCodes");
		expect(word.fields.length).toBe(1);
		word.alertAnswer = 1;
		await word.run("removeCodes");
		expect(word.fields.length).toBe(0);
		expect(word.removed).toEqual(["(1)"]);
	});

	test("changing document preferences converts to footnotes and reformats", async () => {
		script.docPrefs.push({ style: "vancouver", fieldType: "Field" });
		script.citation.push({ items: [{ key: "AAAAAAA1" }] });
		await word.run("addEditCitation");
		script.docPrefs.push({ style: "apa", locale: "en-US", fieldType: "Field" });
		await word.run("setDocPrefs");
		expect(word.fields[0]!.text).toBe("(Smith & Jones, 2020)");
		expect(parsePrefsXml(word.docData)!.styleId).toBe("http://www.zotero.org/styles/apa");
	});

	test("automatic updates off: only the inserted citation is formatted", async () => {
		script.docPrefs.push({ style: "vancouver", fieldType: "Field", delayCitationUpdates: true });
		script.citation.push({ items: [{ key: "BBBBBBB2" }] }, { items: [{ key: "AAAAAAA1" }] });
		await word.run("addEditCitation");
		word.cursor = null;
		await word.run("addEditCitation");
		expect(parsePrefsXml(word.docData)!.delayCitationUpdates).toBe(true);
		expect(word.fields.map((f) => f.text)).toEqual(["(1)", "(1)"]); // not renumbered until Refresh
		await word.run("refresh");
		expect(word.fields.map((f) => f.text)).toEqual(["(1)", "(2)"]);
	});

	test("commands that need fields alert on an empty document; unknown commands alert", async () => {
		script.docPrefs.push({ style: "vancouver", fieldType: "Field" });
		await word.run("refresh");
		expect(word.alerts.at(-1)).toContain("must first insert");
		await word.run("noSuchCommand");
		expect(word.alerts.at(-1)).toContain("not supported");
	});

	test("a second command while one is running answers 503", async () => {
		script.docPrefs.push({ style: "vancouver", fieldType: "Field" });
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		setIntegrationUI({ ...ui, citation: async () => (await gate, { items: [{ key: "AAAAAAA1" }] }) });
		const first = word.run("addEditCitation");
		await Bun.sleep(150);
		const other = new FakeWord();
		expect((await other.run("refresh")).status).toBe(503);
		release();
		await first;
		expect(word.fields.length).toBe(1);
	});
});

describe("dialog queue over HTTP", () => {
	test("a UI client polls, answers the citation dialog; with no poll the command alerts", async () => {
		setIntegrationUI(null);
		// no UI polling: new documents take the Quick Copy style, the citation dialog cannot be shown
		await word.run("addEditCitation");
		expect(word.alerts.at(-1)).toContain("not showing its citation dialog");
		expect(word.fields.length).toBe(0);
		expect(parsePrefsXml(word.docData)?.styleId).toContain("vancouver");

		// a UI client appears: poll once (marks it present), start a command, answer its dialog
		await fetch(`${URL0}/zotero-next/integration/dialogs`);
		const running = word.run("addEditCitation");
		let dlg: { id: string; kind: string; payload: any; secret: string } | undefined;
		for (let i = 0; i < 50 && !dlg; i++) {
			const r = (await (await fetch(`${URL0}/zotero-next/integration/dialogs`)).json()) as { pending: { id: string; kind: string; payload: any; secret: string }[] };
			dlg = r.pending[0];
			if (!dlg) await Bun.sleep(40);
		}
		expect(dlg?.kind).toBe("citation");
		expect(dlg!.payload.isNote).toBe(false);
		expect(dlg!.secret.length).toBeGreaterThan(16);
		// an answer without (or with a wrong) secret is refused and leaves the dialog open
		for (const bad of [{}, { secret: "nope" }]) {
			const r = await fetch(`${URL0}/zotero-next/integration/dialogs/${dlg!.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...bad, result: { items: [{ key: "AAAAAAA1" }] } }) });
			expect(r.status).toBe(403);
		}
		const ok = await fetch(`${URL0}/zotero-next/integration/dialogs/${dlg!.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secret: dlg!.secret, result: { items: [{ key: "BBBBBBB2" }] } }) });
		expect(ok.status).toBe(200);
		await running;
		expect(word.fields[0]!.text).toBe("(1)");
		expect((await fetch(`${URL0}/zotero-next/integration/dialogs/${dlg!.id}`, { method: "POST", body: "{}" })).status).toBe(404);
	});
});

describe("abandoned transactions", () => {
	test("a client that never answers its first command loses the transaction after the deadline", async () => {
		const was = integrationOptions.clientAnswerTimeoutMs;
		integrationOptions.clientAnswerTimeoutMs = 300;
		try {
			const first = await fetch(`${URL0}/connector/document/execCommand`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: "refresh", docId: "doc1" }) });
			expect(((await first.json()) as { command: string }).command).toBe("Application.getActiveDocument");
			// the page now sits on the lock without answering
			expect((await new FakeWord().run("refresh")).status).toBe(503);
			await Bun.sleep(700);
			setIntegrationUI(null);
			const again = new FakeWord();
			expect((await again.run("refresh")).status).toBe(200); // the lock was released
		} finally {
			integrationOptions.clientAnswerTimeoutMs = was;
		}
	});
});
