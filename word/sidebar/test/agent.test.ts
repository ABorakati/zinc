// The agent API (agent.ts) against the in-memory host: every tool, argument validation, document targeting, undo records.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, HANDLER_NAMES, TOOL_DEFS, validate } from "../src/agent";
import { parseFieldCode, parsePrefsXml } from "../src/fields";
import { SAMPLE_ITEMS, createMockHost } from "../src/mockhost";
import type { Host } from "../src/host";

const FIX = join(import.meta.dir, "..", "..", "..", "core", "test", "cite", "fixtures");
const read = (f: string) => readFileSync(join(FIX, f), "utf8");

function setup(otherDocs: string[] = []) {
	const items = structuredClone(SAMPLE_ITEMS);
	const mock = createMockHost({
		items,
		userId: "5106252",
		otherDocs,
		styleXml: async (id) => read(`${id}.csl`),
		localeXml: async (l) => (l === "en-US" ? read("locales-en-US.xml") : null),
	});
	const log: { method: string; params: any }[] = [];
	const host: Host = {
		call: (method, params) => {
			log.push({ method, params });
			return mock.call(method, params);
		},
		on: (e, cb) => mock.on(e, cb),
	};
	return { mock, log, agent: new Agent(host) };
}

const code = (f: any) => {
	const p = parseFieldCode(f.code);
	if (!p || p.kind !== "item") throw new Error("not a citation");
	return p.data;
};

describe("tool definitions", () => {
	test("every tool in McpTools.json has a handler and vice versa", () => {
		expect(TOOL_DEFS.map((t) => t.name).sort()).toEqual([...HANDLER_NAMES].sort());
		expect(TOOL_DEFS.map((t) => t.name)).toEqual([
			"list_documents",
			"search_library",
			"search_styles",
			"list_citations",
			"insert_citation",
			"edit_citation",
			"delete_citation",
			"insert_bibliography",
			"get_document_prefs",
			"set_style",
			"set_document_prefs",
			"refresh",
		]);
		for (const t of TOOL_DEFS) {
			expect(t.description.length).toBeGreaterThan(40);
			expect(t.inputSchema.type).toBe("object");
		}
	});

	test("schema validation: required, types, enum, pattern, oneOf, unknown arguments", () => {
		const insert = TOOL_DEFS.find((t) => t.name === "insert_citation")!.inputSchema;
		expect(validate(insert, { items: [{ key: "AAAA1111" }] })).toEqual([]);
		expect(validate(insert, {})).toEqual(["arguments.items: required"]);
		expect(validate(insert, { items: [] })[0]).toContain("at least 1");
		expect(validate(insert, { items: [{ key: "short" }] })[0]).toContain("items[0].key");
		expect(validate(insert, { items: [{ key: "AAAA1111", label: "nope" }] })[0]).toContain("one of");
		expect(validate(insert, { items: [{ key: "AAAA1111" }], position: "middle" })[0]).toContain("arguments.position");
		expect(validate(insert, { items: [{ key: "AAAA1111" }], position: { afterText: "x", occurrence: 2 } })).toEqual([]);
		expect(validate(insert, { items: [{ key: "AAAA1111" }], position: { occurrence: 2 } }).length).toBeGreaterThan(0);
		expect(validate(insert, { items: [{ key: "AAAA1111" }], bogus: 1 })).toEqual(["arguments.bogus: unknown argument"]);
	});

	test("bad arguments and unknown tools are rejected with a readable message", async () => {
		const { agent } = setup();
		await expect(agent.call("insert_citation", { items: [{ key: "x" }] })).rejects.toThrow(/Invalid arguments for insert_citation/);
		await expect(agent.call("nope", {})).rejects.toThrow(/Unknown tool: nope/);
	});
});

describe("search tools", () => {
	test("search_library returns keys, honours limit; search_styles lists styles", async () => {
		const { agent, log } = setup();
		const r: any = await agent.call("search_library", { query: "liver", limit: 1 });
		expect(r.count).toBe(1);
		expect(r.items[0].key).toBe("AAAA1111");
		const s: any = await agent.call("search_styles", { query: "apa" });
		expect(s.styles.map((x: any) => x.id)).toContain("apa");
		// searches never touch the document
		expect(log.some((c) => c.method === "doc.begin" || c.method === "doc.target")).toBe(false);
	});
});

describe("citations", () => {
	test("insert at end / after text / cursor, list, edit with a locator, delete", async () => {
		const { agent, mock } = setup();
		const a: any = await agent.call("insert_citation", {
			items: [{ key: "AAAA1111" }],
			position: { afterText: "Second sentence here" },
		});
		expect(a.inserted.index).toBe(1);
		expect(a.inserted.text).toBe("(1)");
		expect(a.inserted.items[0].key).toBe("AAAA1111");
		const b: any = await agent.call("insert_citation", {
			items: [{ key: "BBBB2222", locator: "12", label: "page" }],
			position: { afterText: "Intro sentence one" },
		});
		// document order: B (earlier in the text) now comes first and is numbered 1
		expect(b.inserted.index).toBe(1);
		const c: any = await agent.call("insert_citation", { items: [{ key: "CCCC3333" }], position: "end" });
		expect(c.inserted.index).toBe(3);

		let list: any = await agent.call("list_citations", {});
		expect(list.count).toBe(3);
		expect(list.citations.map((x: any) => x.items[0].key)).toEqual(["BBBB2222", "AAAA1111", "CCCC3333"]);
		expect(list.citations[0].items[0].locator).toBe("12");
		expect(list.citations[0].items[0].title).toContain("Machine perfusion");
		expect(list.citations.map((x: any) => x.text)).toEqual(["(1)", "(2)", "(3)"]);
		expect(list.citations[0].fieldId).toMatch(/^[A-Za-z0-9]+$/);
		expect(list.bibliography.present).toBe(false);

		// edit by index: add a locator and a second item
		const e: any = await agent.call("edit_citation", {
			index: 2,
			items: [{ key: "AAAA1111", locator: "5-7", label: "page" }, { key: "CCCC3333" }],
		});
		expect(e.edited.items.map((x: any) => x.key)).toEqual(["AAAA1111", "CCCC3333"]);
		expect(code(mock.fields[1]).citationItems[0].locator).toBe("5-7");
		expect(code(mock.fields[1]).citationItems[0].label).toBe("page");
		expect(code(mock.fields[1]).citationItems.length).toBe(2);

		// edit by fieldId; editing with fewer items drops the rest and the locator
		list = await agent.call("list_citations", {});
		const id = list.citations[1].fieldId;
		await agent.call("edit_citation", { fieldId: id, items: [{ key: "AAAA1111" }] });
		expect(code(mock.fields[1]).citationItems.length).toBe(1);
		expect(code(mock.fields[1]).citationItems[0].locator).toBeUndefined();

		// delete by index, then by fieldId; numbering closes up
		const d: any = await agent.call("delete_citation", { index: 1 });
		expect(d.deleted.items[0].key).toBe("BBBB2222");
		expect(d.remaining).toBe(2);
		list = await agent.call("list_citations", {});
		expect(list.citations.map((x: any) => x.text)).toEqual(["(1)", "(2)"]);
		await agent.call("delete_citation", { fieldId: list.citations[0].fieldId });
		expect(((await agent.call("list_citations", {})) as any).count).toBe(1);
	});

	test("prefix, suffix, suppressAuthor and label land in the field code", async () => {
		const { agent, mock } = setup();
		await agent.call("insert_citation", {
			items: [{ key: "AAAA1111", locator: "3", label: "chapter", prefix: "see", suffix: "and refs", suppressAuthor: true }],
			position: "end",
		});
		const ci = code(mock.fields[0]).citationItems[0]!;
		expect(ci.locator).toBe("3");
		expect(ci.label).toBe("chapter");
		expect(ci.prefix).toBe("see");
		expect(ci.suffix).toBe("and refs");
		expect(ci["suppress-author"]).toBe(true);
		expect(ci.uris).toEqual(["http://zotero.org/users/5106252/items/AAAA1111"]);
	});

	test("clear errors: unknown item, unknown text, bad index, bad fieldId, no identifier", async () => {
		const { agent } = setup();
		await expect(agent.call("insert_citation", { items: [{ key: "ZZZZ9999" }], position: "end" })).rejects.toThrow(
			/ZZZZ9999 is not in the library/,
		);
		await expect(
			agent.call("insert_citation", { items: [{ key: "AAAA1111" }], position: { afterText: "no such text" } }),
		).rejects.toThrow(/not found/);
		await expect(
			agent.call("insert_citation", { items: [{ key: "AAAA1111" }], position: { afterText: "sentence here", occurrence: 5 } }),
		).rejects.toThrow(/only 2 occurrence/);
		await agent.call("insert_citation", { items: [{ key: "AAAA1111" }], position: "end" });
		await expect(agent.call("edit_citation", { index: 9, items: [{ key: "AAAA1111" }] })).rejects.toThrow(
			/no citation number 9: the document has 1/,
		);
		await expect(agent.call("delete_citation", { fieldId: "nope" })).rejects.toThrow(/No citation with fieldId nope/);
		await expect(agent.call("delete_citation", {})).rejects.toThrow(/index.*fieldId/);
	});
});

describe("bibliography, style, preferences, refresh", () => {
	test("insert_bibliography creates once, then only updates; set_style apa reformats; prefs round trip", async () => {
		const { agent, mock } = setup();
		await agent.call("insert_citation", { items: [{ key: "BBBB2222" }], position: "end" });
		await agent.call("insert_citation", { items: [{ key: "AAAA1111" }], position: "end" });
		const first: any = await agent.call("insert_bibliography", {});
		expect(first.created).toBe(true);
		expect(first.bibliography.entries).toBe(2);
		const second: any = await agent.call("insert_bibliography", { position: "cursor" });
		expect(second.created).toBe(false);
		expect(mock.fields.filter((f: any) => f.kind === "bibl").length).toBe(1);

		let prefs: any = await agent.call("get_document_prefs", {});
		expect(prefs).toMatchObject({
			configured: true,
			styleId: "vancouver",
			citationPlacement: "inline",
			automaticUpdates: true,
			hasBibliography: true,
		});

		const r: any = await agent.call("set_style", { styleId: "apa" });
		expect(r.prefs.styleId).toBe("apa");
		expect(r.report.style).toBe("apa");
		expect(parsePrefsXml(mock.prefsXml)!.styleId).toBe("http://www.zotero.org/styles/apa");
		const list: any = await agent.call("list_citations", {});
		expect(list.citations[0].text).toContain("Chen");
		expect(list.style).toBe("apa");
		expect(list.bibliography.present).toBe(true);
		// the sidebar's default style is not changed by an agent
		expect(mock.settings.style).toBe("vancouver");

		const n: any = await agent.call("set_document_prefs", { noteType: "footnotes", automaticUpdates: false });
		expect(n.noteType.applied).toBe(false);
		prefs = await agent.call("get_document_prefs", {});
		expect(prefs.automaticUpdates).toBe(false);
		await expect(agent.call("set_document_prefs", {})).rejects.toThrow(/noteType/);
	});

	test("refresh picks up library edits", async () => {
		const items = structuredClone(SAMPLE_ITEMS);
		const mock = createMockHost({
			items,
			userId: "5106252",
			styleXml: async (id) => read(`${id}.csl`),
			localeXml: async (l) => (l === "en-US" ? read("locales-en-US.xml") : null),
		});
		const agent = new Agent(mock);
		await agent.call("insert_citation", { items: [{ key: "AAAA1111" }], position: "end" });
		items[0]!.title = "A new title";
		const r: any = await agent.call("refresh", { mergeAdjacent: true });
		expect(r.updated).toBeGreaterThan(0);
		expect(code(mock.fields[0]).citationItems[0]!.itemData!.title).toBe("A new title");
	});

	test("get_document_prefs on a document without Zotero data reports the defaults", async () => {
		const { agent } = setup();
		const p: any = await agent.call("get_document_prefs", {});
		expect(p).toMatchObject({ configured: false, styleId: "vancouver", hasBibliography: false });
	});
});

describe("documents and undo records", () => {
	test("list_documents; the document argument is passed to the host; an unknown one is an error", async () => {
		const { agent, log } = setup(["other.docx"]);
		const l: any = await agent.call("list_documents", {});
		expect(l.documents.map((d: any) => d.name)).toEqual(["Preview.docx", "other.docx"]);
		await agent.call("list_citations", { document: "other.docx" });
		expect(log.filter((c) => c.method === "doc.target").at(-1)!.params).toEqual({ document: "other.docx" });
		await agent.call("list_citations", {});
		expect(log.filter((c) => c.method === "doc.target").at(-1)!.params).toEqual({ document: null });
		await expect(agent.call("list_citations", { document: "missing.docx" })).rejects.toThrow(/No open document matches 'missing.docx'/);
	});

	test("each document-changing tool is one undo record named 'Zinc: <tool>'; reads open none", async () => {
		const { agent, log } = setup();
		await agent.call("insert_citation", { items: [{ key: "AAAA1111" }], position: "end" });
		await agent.call("list_citations", {});
		await agent.call("refresh", {});
		await agent.call("set_style", { styleId: "apa" });
		const begins = log.filter((c) => c.method === "doc.begin");
		const outer = begins.filter((c) => (c.params.name as string).startsWith("Zinc: ")).map((c) => c.params.name);
		expect(outer).toEqual(["Zinc: insert_citation", "Zinc: refresh", "Zinc: set_style"]);
		// begin/end stay balanced even when a tool fails
		await expect(agent.call("delete_citation", { index: 99 })).rejects.toThrow();
		await expect(agent.call("insert_citation", { items: [{ key: "ZZZZ9999" }] })).rejects.toThrow();
		expect(log.filter((c) => c.method === "doc.begin").length).toBe(log.filter((c) => c.method === "doc.end").length);
	});

	test("calls run one after another", async () => {
		const { agent } = setup();
		const rs = await Promise.all([
			agent.call("insert_citation", { items: [{ key: "AAAA1111" }], position: "end" }),
			agent.call("insert_citation", { items: [{ key: "BBBB2222" }], position: "end" }),
			agent.call("insert_citation", { items: [{ key: "CCCC3333" }], position: "end" }),
		]);
		expect(rs.map((r: any) => r.inserted.items[0].key)).toEqual(["AAAA1111", "BBBB2222", "CCCC3333"]);
		expect(((await agent.call("list_citations", {})) as any).count).toBe(3);
	});
});
