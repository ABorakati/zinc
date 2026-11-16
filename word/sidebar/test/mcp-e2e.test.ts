// End-to-end for the add-in's MCP server (addin/McpServer.cs): real HTTP on a loopback port -> the hidden agent WebView2
// (sidebar/agent.html + the bundled agent.ts) -> the add-in's Bridge -> (part 2) a private INVISIBLE Word.
// Off by default. Build into a scratch dir first (never word/dist: that is the installed add-in) and point the tests at it:
//   ZN_WORD_DIST=<dir> bun build.ts                       (sidebar -> <dir>/addin/sidebar)
//   dotnet build word/harness -c Release -p:OutputPath=<dir>/harness/
//   bun C:/Users/abora/zn-ws/copy-lib.ts <copy.sqlite>
//   ZN_WORD_DIST=<dir> ZN_MCP_E2E=1 ZN_TEST_DB=<copy.sqlite> bun test test/mcp-e2e.test.ts          # part 1: HTTP layer + library tools, no Word
//   ... plus ZN_WORD_E2E=1 for part 2 (the full citation flow in a private Word; skipped when any WINWORD.EXE is running).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFieldCode } from "../src/fields";
import { HARNESS_EXE, HarnessHost } from "./harness-host";
import spec from "../../addin/McpTools.json";

const FIX = join(import.meta.dir, "..", "..", "..", "core", "test", "cite", "fixtures");
const DB = process.env.ZN_TEST_DB ?? "";
const PART1 = process.env.ZN_MCP_E2E === "1" || process.env.ZN_WORD_E2E === "1";

function wordRunning(): boolean {
	const r = Bun.spawnSync(["tasklist", "/FI", "IMAGENAME eq WINWORD.EXE", "/NH"]);
	return /WINWORD\.EXE/i.test(new TextDecoder().decode(r.stdout));
}
const PART2 = process.env.ZN_WORD_E2E === "1" && !wordRunning();
if (process.env.ZN_WORD_E2E === "1" && !PART2)
	console.warn("mcp-e2e part 2 skipped: WINWORD.EXE is running (the harness never touches an existing Word)");

function freePort(): number {
	const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
	const p = s.port;
	s.stop(true);
	return p;
}

/** One raw HTTP exchange (for headers fetch() will not let us set, like Host). */
async function raw(port: number, request: string): Promise<string> {
	return new Promise((resolve, reject) => {
		let out = "";
		Bun.connect({
			hostname: "127.0.0.1",
			port,
			socket: {
				open: (s) => void s.write(request),
				data: (_s, d) => void (out += Buffer.from(d).toString("utf8")),
				close: () => resolve(out),
				error: (_s, e) => reject(e),
			},
		}).catch(reject);
		setTimeout(() => resolve(out), 8000);
	});
}

class Mcp {
	private id = 0;
	constructor(
		readonly port: number,
		readonly token: string,
	) {}
	get url() {
		return `http://127.0.0.1:${this.port}/mcp`;
	}
	headers(extra: Record<string, string> = {}) {
		return {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			authorization: `Bearer ${this.token}`,
			...extra,
		};
	}
	async rpc(method: string, params?: unknown): Promise<any> {
		const r = await fetch(this.url, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
		});
		expect(r.status).toBe(200);
		return r.json();
	}
	/** tools/call -> {isError, text, json} */
	async tool(name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string; json: any }> {
		const res = await this.rpc("tools/call", { name, arguments: args });
		expect(res.error).toBeUndefined();
		const text: string = res.result.content[0].text;
		let json: any;
		if (!res.result.isError) json = JSON.parse(text);
		return { isError: !!res.result.isError, text, json };
	}
}

const d1 = PART1 ? describe : describe.skip;

d1("MCP server: HTTP layer and library tools (no Word needed)", () => {
	let h: HarnessHost;
	let tmp: string;
	let mcp: Mcp;
	let tokenFile: string;

	beforeAll(async () => {
		if (!existsSync(HARNESS_EXE)) throw new Error("build the harness first (see the header of this file)");
		if (!existsSync(DB)) throw new Error("set ZN_TEST_DB to a COPY of library.sqlite");
		tmp = mkdtempSync(join(tmpdir(), "zn-mcp-e2e-"));
		const cache = join(tmp, "cache");
		mkdirSync(join(cache, "styles"), { recursive: true });
		mkdirSync(join(cache, "locales"), { recursive: true });
		for (const s of ["vancouver.csl", "apa.csl"]) cpSync(join(FIX, s), join(cache, "styles", s));
		cpSync(join(FIX, "locales-en-US.xml"), join(cache, "locales", "locales-en-US.xml"));
		const settings = join(tmp, "settings.json");
		// the add-in probes a zotero-next app on apiBase: aim it at a dead port, never at the real app
		writeFileSync(settings, JSON.stringify({ apiBase: "http://127.0.0.1:9", mcpTimeoutMs: 60000 }));
		h = await HarnessHost.start({ db: DB, settings, cache });
		tokenFile = join(tmp, "mcp-token");
		const port = freePort();
		await h.call("h.mcp", { port, tokenFile });
		mcp = new Mcp(port, readFileSync(tokenFile, "utf8").trim());
	}, 90_000);

	afterAll(async () => {
		await h?.stop();
	}, 60_000);

	test("the token is random, 256 bits, in a file only the current user can read", () => {
		expect(mcp.token).toMatch(/^[0-9a-f]{64}$/);
		const acl = new TextDecoder().decode(Bun.spawnSync(["icacls", tokenFile]).stdout);
		expect(acl).not.toMatch(/Everyone|BUILTIN\\Users|Authenticated Users/i);
		expect(acl).toContain(process.env.USERNAME ?? "");
	});

	test("authorization: no token, wrong token, Origin header, bad Host, GET, unknown path", async () => {
		const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
		const noAuth = await fetch(mcp.url, { method: "POST", headers: { "content-type": "application/json" }, body });
		expect(noAuth.status).toBe(401);
		expect(noAuth.headers.get("www-authenticate")).toContain("Bearer");
		const wrong = await fetch(mcp.url, { method: "POST", headers: mcp.headers({ authorization: "Bearer " + "0".repeat(64) }), body });
		expect(wrong.status).toBe(401);
		const withOrigin = await raw(
			mcp.port,
			`POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${mcp.port}\r\nOrigin: http://evil.example\r\nAuthorization: Bearer ${mcp.token}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
		);
		expect(withOrigin).toMatch(/^HTTP\/1\.1 403/);
		const badHost = await raw(
			mcp.port,
			`POST /mcp HTTP/1.1\r\nHost: rebind.example:${mcp.port}\r\nAuthorization: Bearer ${mcp.token}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
		);
		expect(badHost).toMatch(/^HTTP\/1\.1 403/);
		const get = await fetch(mcp.url, { method: "GET", headers: mcp.headers() });
		expect(get.status).toBe(405);
		expect(get.headers.get("allow")).toBe("POST");
		const other = await fetch(`http://127.0.0.1:${mcp.port}/elsewhere`, { method: "POST", headers: mcp.headers(), body });
		expect(other.status).toBe(404);
		// the token never shows up in a response body
		expect(await noAuth.text()).not.toContain(mcp.token);
	});

	test("initialize, initialized notification, ping, tools/list", async () => {
		const init = await mcp.rpc("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "test", version: "1" },
		});
		expect(init.result.protocolVersion).toBe("2025-06-18");
		expect(init.result.serverInfo.name).toBe("zotero-next-word");
		expect(init.result.capabilities.tools).toBeDefined();
		expect(init.result.instructions).toContain("Zotero");
		const old = await mcp.rpc("initialize", { protocolVersion: "1999-01-01" });
		expect(old.result.protocolVersion).toBe("2025-06-18");
		const note = await fetch(mcp.url, {
			method: "POST",
			headers: mcp.headers(),
			body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
		});
		expect(note.status).toBe(202);
		expect((await mcp.rpc("ping")).result).toEqual({});
		const list = await mcp.rpc("tools/list");
		const names = list.result.tools.map((t: any) => t.name);
		expect(names).toEqual((spec as any).tools.map((t: any) => t.name));
		for (const t of list.result.tools) {
			expect(t.description.length).toBeGreaterThan(40);
			expect(t.inputSchema.type).toBe("object");
		}
		const unknown = await mcp.rpc("nope/method");
		expect(unknown.error.code).toBe(-32601);
		const badTool = await mcp.rpc("tools/call", { name: "no_such_tool", arguments: {} });
		expect(badTool.error.code).toBe(-32602);
		// malformed JSON and batches
		const bad = await fetch(mcp.url, { method: "POST", headers: mcp.headers(), body: "{not json" });
		expect(bad.status).toBe(400);
		const batch = await fetch(mcp.url, {
			method: "POST",
			headers: mcp.headers(),
			body: JSON.stringify([
				{ jsonrpc: "2.0", id: 1, method: "ping" },
				{ jsonrpc: "2.0", method: "notifications/initialized" },
				{ jsonrpc: "2.0", id: 2, method: "ping" },
			]),
		});
		expect((await batch.json()).length).toBe(2);
	});

	test("library tools run through the hidden agent page; bad arguments and missing Word are tool errors", async () => {
		const found = await mcp.tool("search_library", { query: "liver transplantation", limit: 5 });
		expect(found.isError).toBe(false);
		expect(found.json.count).toBeGreaterThan(0);
		expect(found.json.items[0].key).toMatch(/^[A-Z0-9]{8}$/);
		expect(found.json.items.length).toBeLessThanOrEqual(5);
		const styles = await mcp.tool("search_styles", { query: "apa" });
		expect(styles.isError).toBe(false);
		expect(styles.json.styles.map((s: any) => s.id)).toContain("apa");
		const badArgs = await mcp.tool("search_library", { limit: 5 });
		expect(badArgs.isError).toBe(true);
		expect(badArgs.text).toMatch(/Invalid arguments for search_library.*query/);
		const noWord = await mcp.tool("list_citations");
		expect(noWord.isError).toBe(true);
		expect(noWord.text).toMatch(/Word is not available/);
	}, 120_000);

	test("a chunked request body with Expect: 100-continue is understood", async () => {
		const body = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" });
		const hex = body.length.toString(16);
		const out = await raw(
			mcp.port,
			`POST /mcp HTTP/1.1\r\nHost: localhost:${mcp.port}\r\nAuthorization: Bearer ${mcp.token}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${hex}\r\n${body}\r\n0\r\n\r\n`,
		);
		expect(out).toMatch(/^HTTP\/1\.1 200/);
		expect(out).toContain('"id":9');
	});
});

const d2 = PART2 ? describe : describe.skip;

d2("MCP server: the citation flow in a private Word", () => {
	let h: HarnessHost;
	let tmp: string;
	let mcp: Mcp;
	const docx = () => join(tmp, "mcp-e2e.docx");

	function zipText(file: string, member: string): string {
		const r = Bun.spawnSync([process.env.SystemRoot + "/System32/tar.exe", "-xOf", file, member]);
		return new TextDecoder().decode(r.stdout);
	}

	beforeAll(async () => {
		if (!existsSync(HARNESS_EXE)) throw new Error("build the harness first (see the header of this file)");
		if (!existsSync(DB)) throw new Error("set ZN_TEST_DB to a COPY of library.sqlite");
		tmp = mkdtempSync(join(tmpdir(), "zn-mcp-word-"));
		const cache = join(tmp, "cache");
		mkdirSync(join(cache, "styles"), { recursive: true });
		mkdirSync(join(cache, "locales"), { recursive: true });
		for (const s of ["vancouver.csl", "apa.csl"]) cpSync(join(FIX, s), join(cache, "styles", s));
		cpSync(join(FIX, "locales-en-US.xml"), join(cache, "locales", "locales-en-US.xml"));
		const settings = join(tmp, "settings.json");
		writeFileSync(settings, JSON.stringify({ apiBase: "http://127.0.0.1:9", mcpTimeoutMs: 120000, style: "vancouver" }));
		h = await HarnessHost.start({ db: DB, settings, cache });
		const started = await h.call<{ pid: number }>("h.start");
		expect(started.pid).toBeGreaterThan(0);
		const tokenFile = join(tmp, "mcp-token");
		const port = freePort();
		await h.call("h.mcp", { port, tokenFile });
		mcp = new Mcp(port, readFileSync(tokenFile, "utf8").trim());
	}, 120_000);

	afterAll(async () => {
		await h?.stop();
	}, 60_000);

	let keys: string[] = [];
	test("initialize -> tools/list -> insert two citations -> edit one -> delete one -> bibliography -> set_style apa -> list_citations", async () => {
		await h.call("h.newDoc");
		await h.call("h.type", { text: "Intro sentence one. Second sentence here. Final words." });

		const init = await mcp.rpc("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "e2e", version: "1" },
		});
		expect(init.result.serverInfo.name).toBe("zotero-next-word");
		const list = await mcp.rpc("tools/list");
		expect(list.result.tools.length).toBe(12);

		const docs = await mcp.tool("list_documents");
		expect(docs.json.documents.length).toBe(1);
		expect(docs.json.documents[0].active).toBe(true);

		const found = await mcp.tool("search_library", { query: "liver transplantation", limit: 6 });
		keys = found.json.items.slice(0, 2).map((i: any) => i.key);
		expect(keys.length).toBe(2);

		const a = await mcp.tool("insert_citation", { items: [{ key: keys[0] }], position: { afterText: "Intro sentence one" } });
		expect(a.isError).toBe(false);
		expect(a.json.inserted.index).toBe(1);
		expect(a.json.inserted.text).toBe("(1)");
		const b = await mcp.tool("insert_citation", { items: [{ key: keys[1] }], position: { afterText: "Second sentence here" } });
		expect(b.isError).toBe(false);
		expect(b.json.inserted.index).toBe(2);
		expect(b.json.inserted.text).toBe("(2)");
		const text = (await h.call<{ text: string }>("h.text")).text;
		expect(text).toContain("Intro sentence one(1). Second sentence here(2).");

		// edit the first: add a locator
		const e = await mcp.tool("edit_citation", { index: 1, items: [{ key: keys[0], locator: "45-47", label: "page" }] });
		expect(e.isError).toBe(false);
		expect(e.json.edited.items[0].locator).toBe("45-47");

		// delete the second
		const listed = await mcp.tool("list_citations");
		expect(listed.json.count).toBe(2);
		const del = await mcp.tool("delete_citation", { fieldId: listed.json.citations[1].fieldId });
		expect(del.isError).toBe(false);
		expect(del.json.remaining).toBe(1);

		const bib = await mcp.tool("insert_bibliography", { position: "end" });
		expect(bib.isError).toBe(false);
		expect(bib.json.created).toBe(true);
		expect(bib.json.bibliography.entries).toBe(1);
		const bib2 = await mcp.tool("insert_bibliography");
		expect(bib2.json.created).toBe(false);

		const style = await mcp.tool("set_style", { styleId: "apa" });
		expect(style.isError).toBe(false);
		expect(style.json.prefs.styleId).toBe("apa");

		const after = await mcp.tool("list_citations");
		expect(after.json.count).toBe(1);
		expect(after.json.style).toBe("apa");
		expect(after.json.bibliography.present).toBe(true);
		expect(after.json.citations[0].items[0].key).toBe(keys[0]);
		expect(after.json.citations[0].items[0].locator).toBe("45-47");
		expect(after.json.citations[0].text).toMatch(/45/);
		expect(after.json.citations[0].text).toMatch(/\d{4}|n\.d\./);

		// the document's field codes: real Zotero fields, readable by desktop Zotero
		const fields = await h.call<{ kind: string; code: string; text: string }[]>("doc.fields");
		expect(fields.map((f) => f.kind)).toEqual(["item", "bibl"]);
		expect(fields[0]!.code).toMatch(/^ADDIN ZOTERO_ITEM CSL_CITATION /);
		expect(fields[1]!.code).toBe('ADDIN ZOTERO_BIBL {"uncited":[],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY');
		const p = parseFieldCode(fields[0]!.code)!;
		expect(p.kind === "item" && p.data.citationItems.length).toBe(1);
		expect(p.kind === "item" && p.data.citationItems[0]!.locator).toBe("45-47");
		expect(p.kind === "item" && p.data.citationItems[0]!.label).toBe("page");
		expect(p.kind === "item" && p.data.citationItems[0]!.uris[0]).toMatch(new RegExp(`/items/${keys[0]}$`));
		expect(fields[1]!.text.length).toBeGreaterThan(20);
		const prefs = await h.call<{ xml: string }>("doc.getPrefs");
		expect(prefs.xml).toContain("http://www.zotero.org/styles/apa");
		expect(prefs.xml).toMatch(/hasBibliography="(?:1|true)"/);

		// the saved file, as desktop Zotero would read it
		await h.call("h.saveAs", { path: docx() });
		const xml = zipText(docx(), "word/document.xml");
		expect((xml.match(/ADDIN ZOTERO_ITEM CSL_CITATION/g) ?? []).length).toBe(1);
		expect((xml.match(/ADDIN ZOTERO_BIBL/g) ?? []).length).toBe(1);
		expect(zipText(docx(), "docProps/custom.xml")).toContain('name="ZOTERO_PREF_1"');
	}, 240_000);

	test("an agent edit is one undo step in Word; document targeting and the cursor position work", async () => {
		const before = (await h.call<{ count: number }>("h.fieldCount")).count;
		const ins = await mcp.tool("insert_citation", { items: [{ key: keys[1] }], position: "end" });
		expect(ins.isError).toBe(false);
		expect((await h.call<{ count: number }>("h.fieldCount")).count).toBe(before + 1);
		const undone = await h.call<{ ok: boolean }>("h.undo", { times: 1 });
		expect(undone.ok).toBe(true);
		expect((await h.call<{ count: number }>("h.fieldCount")).count).toBe(before);

		// by name or by path; an unknown document is a readable tool error
		const docs = (await mcp.tool("list_documents")).json.documents;
		const byPath = await mcp.tool("list_citations", { document: docs[0].path });
		expect(byPath.isError).toBe(false);
		const bad = await mcp.tool("list_citations", { document: "missing.docx" });
		expect(bad.isError).toBe(true);
		expect(bad.text).toMatch(/No open document matches/);
		const nope = await mcp.tool("insert_citation", { items: [{ key: keys[0] }], position: { afterText: "no such text anywhere" } });
		expect(nope.isError).toBe(true);
		expect(nope.text).toMatch(/not found/);
	}, 120_000);
});
