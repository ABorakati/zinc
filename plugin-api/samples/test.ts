#!/usr/bin/env bun
// bun plugin-api/samples/test.ts [--only word-count|quick-tags|mcp-tools|highlight-export] [--keep]
//
// Builds the sample plugins with plugin-host/scripts/build-plugin.ts (the JS one through sdk/js/scripts/build.ts, which
// bundles the SDK and then calls it), loads each through the supervisor (plugin-host/src) and checks that startup registers what
// the plugin should and that its main exports do their job. Every import is answered by a stub `where: "zinc"` handler defined
// here; nothing depends on the real handlers (the supervisor option `discoverHostHandlers: false` keeps the host process from loading
// them). Output goes to %TEMP%\zn-wasm-samples and is deleted at the end (`--keep` keeps it).
//
// Disk: a Rust build needs several GiB; this script refuses to run below 9216 MiB free on the drive of %TEMP%.
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildPlugin } from "../../plugin-host/scripts/build-plugin";
import { createPluginSupervisor, defineHandler, type ImportHandler, type PluginSupervisor } from "../../plugin-host/src/index";
import { buildJsPlugin } from "../sdk/js/scripts/build";

const here = import.meta.dir;
const scratch = join(process.env.TEMP ?? process.env.TMPDIR ?? "/tmp", "zn-wasm-samples");
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
const keep = args.includes("--keep");

// ---- tiny test harness -----------------------------------------------------------------------------------------------

let failures = 0;
let checks = 0;
function check(cond: unknown, what: string, detail?: unknown) {
	checks++;
	if (!cond) {
		failures++;
		console.error(`  FAIL ${what}${detail === undefined ? "" : ": " + JSON.stringify(detail, (_, v) => (typeof v === "bigint" ? `${v}n` : v))}`);
	}
}
const eq = (a: unknown, b: unknown, what: string) => check(JSON.stringify(a, repl) === JSON.stringify(b, repl), what, { got: a, want: b });
const repl = (_: string, v: unknown) => (typeof v === "bigint" ? `${v}n` : v);

// ---- stub imports ----------------------------------------------------------------------------------------------------

interface Call {
	iface: string;
	fn: string;
	args: unknown[];
}
type Answers = Record<string, (...args: any[]) => unknown>;

/**
 * Zinc-side handlers for every `iface.fn` named in `answers`; each call is recorded. A function without an answer is not
 * handled at all (the plugin gets `error::unavailable`), which is also a result a test can assert on.
 */
function stubs(calls: Call[], answers: Answers): ImportHandler[] {
	const byIface = new Map<string, Record<string, (ctx: unknown, ...a: unknown[]) => unknown>>();
	for (const [name, fn] of Object.entries(answers)) {
		const [iface, f] = name.split(".");
		const fns = byIface.get(iface) ?? {};
		fns[f] = (_ctx, ...a) => {
			calls.push({ iface, fn: f, args: a });
			return fn(...a);
		};
		byIface.set(iface, fns);
	}
	return [...byIface].map(([iface, functions]) => defineHandler({ interface: `zinc:plugin/${iface}`, where: "zinc", functions: functions as any }));
}
const calledWith = (calls: Call[], name: string) => {
	const [iface, fn] = name.split(".");
	return calls.filter((c) => c.iface === iface && c.fn === fn);
};
const ok = () => undefined;

function newSupervisor(calls: Call[], answers: Answers): PluginSupervisor {
	return createPluginSupervisor({
		importHandlers: stubs(calls, { "log.write": (_level: string, m: string) => void console.log(`    [plugin log] ${m}`), ...answers }),
		discoverHostHandlers: false, // the host process loads no src/imports/*.host.ts: every import is answered by the stubs below
		callTimeoutMs: 8000,
		lifecycleTimeoutMs: 15000,
		loadTimeoutMs: 60000,
	});
}

/** Records for a jco `item-summary`. All fields are required by the lowering; options may be undefined. */
const summary = (key: string, over: Record<string, unknown> = {}) => ({
	key,
	library: 1,
	itemType: "journalArticle",
	title: `Item ${key}`,
	creatorsSummary: "",
	year: undefined,
	publication: undefined,
	dateAdded: "2026-01-01 00:00:00",
	dateModified: "2026-01-01 00:00:00",
	parentKey: undefined,
	bestAttachment: undefined,
	attachmentCount: 0,
	noteCount: 0,
	inTrash: false,
	fields: [],
	creators: [],
	tags: [],
	collections: [],
	...over,
});
const emptyCtx = (over: Record<string, unknown> = {}) => ({
	window: 1,
	tab: { id: "library", kind: "library", subtype: undefined },
	library: 1,
	rows: [],
	items: [],
	itemCount: 0,
	itemsTruncated: false,
	editable: true,
	field: undefined,
	...over,
});
const viewContext = (view: string, params: unknown) => ({ view, surface: "item-pane-section", params: JSON.stringify(params), theme: "light", width: undefined, height: undefined, locale: "en-US" });
const uiEvent = (handler: string) => ({ handler, nodeKey: undefined, kind: "press", modifiers: { shift: false, ctrl: false, alt: false, meta: false }, payload: { tag: "none" }, rev: 0n });
const NO_MODS = { shift: false, ctrl: false, alt: false, meta: false };

async function sendDialogClose(sup: PluginSupervisor, id: string, instance: bigint, button: string | undefined, values: { name: string; value: { tag: string; val?: unknown } }[]) {
	const base = { handler: button ?? "", nodeKey: undefined, kind: "close", modifiers: NO_MODS, rev: 0n };
	await sup.call(id, "ui-events", "on-event", [instance, { ...base, payload: button === undefined ? { tag: "none" } : { tag: "button", val: button } }]);
	await sup.call(id, "ui-events", "on-event", [instance, { ...base, payload: { tag: "form", val: values } }]);
}

// ---- the three samples -------------------------------------------------------------------------------------------------

type Sample = { name: string; build: (out: string) => Promise<unknown>; run: (out: string) => Promise<void> };

const samples: Sample[] = [
	{
		name: "word-count",
		build: (out) => buildPlugin({ dir: join(here, "word-count"), out, log: (l) => console.error("   ", l) }),
		async run(out) {
			const calls: Call[] = [];
			const texts_: Record<string, string> = { ATT00001: "The quick brown fox jumps", ATT00003: "page 12 of 40 and then some" };
			const sup = newSupervisor(calls, {
				"extend.register-column": ok,
				"extend.register-section": ok,
				"extend.register-pref-pane": ok,
				"extend.invalidate-columns": ok,
				"ui.refresh": ok,
				"prefs.observe": () => 1,
				"prefs.get": () => undefined, // countNumbers unset: numbers are not words
				"library.get-summaries": (keys: string[]) =>
					keys.map((k) => (k === "AAAA1111" ? summary(k, { bestAttachment: "ATT00001" }) : k === "CCCC3333" ? summary(k, { bestAttachment: "ATT00003" }) : summary(k))),
				"fulltext.get-content": (att: string) => (texts_[att] ? { text: texts_[att], source: "test", indexedAt: "2026-01-01" } : undefined),
			});
			try {
				const info = await sup.load(out);
				await sup.start(info.id);
				const id = info.id;
				// startup registers a column, a section and a preference pane, and watches its preference
				eq(calledWith(calls, "extend.register-column").map((c) => (c.args[0] as any).dataKey), ["word-count"], "registers the word-count column");
				eq(calledWith(calls, "extend.register-section").map((c) => (c.args[0] as any).paneId), ["word-count-section"], "registers the item pane section");
				eq(calledWith(calls, "extend.register-pref-pane").map((c) => (c.args[0] as any).paneId), ["word-count-prefs"], "registers the preference pane");
				const rows = (calledWith(calls, "extend.register-pref-pane")[0]?.args[0] as any)?.content?.val ?? [];
				eq(rows.map((r: any) => r.control.val), ["countNumbers"], "the pane has a toggle bound to the pref");
				eq(calledWith(calls, "prefs.observe").map((c) => c.args[2 - 1]), ["countNumbers"], "observes the pref");

				// the column: counts from the full text, blank when there is none
				const cells = (await sup.call(id, "extend-handlers", "on-column-values", ["word-count", ["AAAA1111", "BBBB2222", "CCCC3333"]])) as any[];
				eq(cells.map((c) => c.body.val), ["5", "", "5"], "column cells (5 words; no text; 'page 12 of 40 and then some' = 5 without numbers)");
				eq(cells[0].sortKey, { tag: "number", val: 5 }, "numeric sort key");
				const bad = await sup.call(id, "extend-handlers", "on-column-values", ["nope", ["AAAA1111"]]).then(() => "ok", (e) => e.payload?.tag ?? String(e));
				eq(bad, "invalid-argument", "unknown column is an error");

				// the item pane section: mount renders JSON tree with the word count; Recount button clears cache and re-reads
				const mounted = (await sup.call(id, "ui-events", "mount", [1n, viewContext("word-count-section", { itemKey: "AAAA1111" })])) as any;
				eq(mounted?.content?.tag, "json", "section mount returns a JSON tree");
				check(String(mounted?.content?.val).includes("5 words"), "section shows 5 words", mounted?.content?.val);
				texts_.ATT00001 = "The quick brown fox jumps over the lazy dog";
				const recounted = (await sup.call(id, "ui-events", "on-event", [1n, uiEvent("recount")])) as any;
				check(String(recounted?.content?.val).includes("9 words"), "recount button re-reads the text (9 words)", recounted?.content?.val);

				// changing the pref clears the cache, invalidates the column and refreshes the mounted section
				const before = calledWith(calls, "extend.invalidate-columns").length;
				const refBefore = calledWith(calls, "ui.refresh").length;
				await sup.call(id, "events", "on-pref-changed", [1, "plugin-own", "countNumbers", { tag: "flag", val: true }]);
				check(calledWith(calls, "extend.invalidate-columns").length === before + 1, "pref change invalidates the column");
				check(calledWith(calls, "ui.refresh").length === refBefore + 1, "pref change refreshes the mounted section");
				await sup.call(id, "ui-events", "unmount", [1n]);

				// an export the plugin does not implement is a no-op, not a trap
				await sup.call(id, "events", "on-locale-changed", ["de"]);
				await sup.call(id, "note-events", "on-note-event", [{ tag: "editor-closed", val: { id: "x", kind: "note", read_only: false } }]).catch(() => {});
				eq(sup.get(id)?.status, "running", "plugin is still running");
			} finally {
				await sup.shutdown();
			}
		},
	},
	{
		name: "quick-tags",
		build: (out) => buildJsPlugin({ dir: join(here, "quick-tags"), out, log: (l) => console.error("   ", l) }),
		async run(out) {
			const calls: Call[] = [];
			let nextDialogId = 10n;
			let lastDialogId = 0n;
			const sup = newSupervisor(calls, {
				"extend.register-menu": ok,
				"extend.list-selected-items": (_w: unknown, _o: number, limit: number) => Array.from({ length: Math.min(limit, 3) }, (_, i) => `KEY0000${i}`),
				"ui.open-dialog": () => (lastDialogId = nextDialogId++),
				"ui.show-toast": () => 5n,
				"library.apply": () => ({ created: [], changed: 2 }),
			});
			try {
				const info = await sup.load(out);
				await sup.start(info.id);
				const id = info.id;
				const reg = calledWith(calls, "extend.register-menu")[0]?.args[0] as any;
				eq(reg?.menuId, "quick-tags-menu", "registers a menu");
				eq(reg?.target, "library-item", "on the item context menu");
				eq(reg?.entries?.map((e: any) => e.id), ["quick-tags.add"], "with the quick tags entry");

				// command: opens a dialog via ui.open-dialog; close event resolves ui.dialog() -> library.apply + toast
				const ctx = emptyCtx({ items: ["AAAA1111", "BBBB2222"], itemCount: 2 });
				await sup.call(id, "extend-handlers", "on-menu-command", ["quick-tags-menu", "quick-tags.add", undefined, ctx]);
				const dialog = calledWith(calls, "ui.open-dialog")[0]?.args[0] as any;
				check(dialog, "opens a dialog via ui.open-dialog");
				const dialogTree = JSON.parse(dialog?.content ?? "{}");
				check(dialogTree?.root?.type === "form", "the dialog JSON tree has a form root", dialogTree);
				const input = dialogTree?.root?.children?.[0]?.children?.find((n: any) => n.type === "text-input");
				eq(input?.name, "tags", "with a named text input");
				eq(dialog?.buttons?.map((b: any) => b.id), ["cancel", "ok"], "and Cancel / OK buttons");

				await sendDialogClose(sup, id, lastDialogId, "ok", [{ name: "tags", value: { tag: "text", val: " alpha, beta;gamma ,, alpha " } }]);
				const applied = calledWith(calls, "library.apply");
				eq(applied.length, 1, "one library.apply call");
				const change = (applied[0]?.args[0] as any[])?.[0];
				eq(change?.tag, "add-tags", "a add-tags change");
				eq(change?.val?.items, ["AAAA1111", "BBBB2222"], "for the selected items");
				eq(change?.val?.tags, [{ name: "alpha", kind: "manual" }, { name: "beta", kind: "manual" }, { name: "gamma", kind: "manual" }], "with the parsed, de-duplicated tags");
				eq(calledWith(calls, "ui.show-toast").length, 1, "a toast confirms");
				check(JSON.stringify(calledWith(calls, "ui.show-toast")[0]?.args[0], repl).includes("Added 3 tags to 2 items"), "toast text");

				// cancel: nothing is written
				await sup.call(id, "extend-handlers", "on-menu-command", ["quick-tags-menu", "quick-tags.add", undefined, ctx]);
				await sendDialogClose(sup, id, lastDialogId, "cancel", []);
				eq(calledWith(calls, "library.apply").length, 1, "cancel writes nothing");

				// another menu or entry is ignored; a truncated selection is fetched through extend.list-selected-items
				await sup.call(id, "extend-handlers", "on-menu-command", ["other-menu", "x", undefined, ctx]);
				await sup.call(id, "extend-handlers", "on-menu-command", ["quick-tags-menu", "quick-tags.add", undefined, emptyCtx({ items: ["AAAA1111"], itemCount: 3, itemsTruncated: true })]);
				await sendDialogClose(sup, id, lastDialogId, "ok", [{ name: "tags", value: { tag: "text", val: "z" } }]);
				const last = (calledWith(calls, "library.apply")[1]?.args[0] as any[])?.[0];
				eq(last?.val?.items, ["KEY00000", "KEY00001", "KEY00002"], "truncated selection is completed");
				// functions it does not implement answer with defaults
				eq(await sup.call(id, "extend-handlers", "on-tab-closing", ["t"]), true, "defaults for the rest (on-tab-closing)");
				eq(sup.get(id)?.status, "running", "plugin is still running");
			} finally {
				await sup.shutdown();
			}
		},
	},
	{
		// End to end through the REAL chain: a throwaway core (a fresh fixture library, never the user's) with its MCP endpoint, the
		// gpui-ui bridge (mcp handler + provider, no window), the supervisor and the built plugin, and the real `library` handlers that
		// talk to that core. An MCP client (plain JSON-RPC over fetch) lists and calls the plugin's tools.
		name: "mcp-tools",
		build: (out) => buildJsPlugin({ dir: join(here, "mcp-tools"), out, log: (l) => console.error("   ", l) }),
		async run(out) {
			process.env.ZN_UI_STATE = "off"; // the bridge's switch store must not read or write the user's ui-state.json
			const { buildFixture } = await import("../../core/test/fixture");
			const { startServer } = await import("../../core/src/server");
			const { installMcpBridge } = await import("../../gpui-ui/src/wasmplugins/mcp/provider");
			const { mcpHandler } = await import("../../gpui-ui/src/wasmplugins/mcp/handler");
			const { resetPluginRegistrations } = await import("../../gpui-ui/src/wasmplugins/host");
			const { declaredGrants } = await import("../../plugin-host/src/manifest");

			const fx = buildFixture();
			fx.db.close(true);
			const core = startServer({ dbPath: join(fx.dir, "lib.sqlite"), port: 0, hostname: "127.0.0.1" });
			let rpcId = 0;
			const rpc = async (method: string, params?: unknown) => {
				const res = await fetch(`${core.url}/mcp`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
					body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
				});
				return ((await res.json()) as any).result;
			};
			const listTools = async () => ((await rpc("tools/list")).tools as any[]).filter((t) => t.name.startsWith("mcp-tools__"));
			const callTool = (name: string, args: unknown) => rpc("tools/call", { name, arguments: args }) as Promise<any>;
			const itemTags = (key: string): string[] => {
				const r = core.db.query("SELECT tag FROM item_tags WHERE item_key = ? ORDER BY tag").all(key) as { tag: string }[];
				return r.map((x) => x.tag);
			};

			let on = false;
			const calls: Call[] = [];
			const sup = createPluginSupervisor({
				importHandlers: [...stubs(calls, { "log.write": (_l: string, m: string) => void console.log(`    [plugin log] ${m}`) }), mcpHandler],
				coreUrl: core.url, // the real `library` handlers (host process) talk to this throwaway core
				callTimeoutMs: 8000,
				lifecycleTimeoutMs: 15000,
				loadTimeoutMs: 60000,
			});
			const dispose = installMcpBridge(sup, { exposed: () => on });
			try {
				const info = await sup.load(out);
				sup.setGrants(info.id, declaredGrants(info.manifest));
				await sup.start(info.id);
				const id = info.id;
				eq(sup.get(id)?.status, "running", "plugin runs");

				// consent: the manifest permission is there, the user's switch is off, so nothing is listed
				eq((await listTools()).length, 0, "switch off: no plugin tools");
				const refused = await callTool("mcp-tools__count_tagged", { tag: "imaging" });
				check(refused.isError, "switch off: a call to the tool fails", refused);

				on = true;
				const tools = await listTools();
				eq(tools.map((t) => t.name).sort(), ["mcp-tools__add_tag", "mcp-tools__count_tagged"], "switch on: the static and the run-time tool are listed");
				const count = tools.find((t) => t.name === "mcp-tools__count_tagged");
				const add = tools.find((t) => t.name === "mcp-tools__add_tag");
				check(String(count?.description).startsWith("[MCP Tools] Count the library items"), "description starts with the plugin name", count?.description);
				eq(count?.annotations?.readOnlyHint, true, "count_tagged is read-only");
				eq(add?.annotations?.readOnlyHint, false, "add_tag is not read-only");
				eq(add?.annotations?.destructiveHint, false, "add_tag is not destructive");
				eq(count?.inputSchema?.required, ["tag"], "input schema comes from the manifest");
				eq(add?.inputSchema?.required, ["item", "tag"], "input schema comes from register-tool");
				eq(count?.outputSchema?.required, ["tag", "count"], "output schema is passed on");

				// the call chain: tools/call -> supervisor.call(mcp-handler.on-mcp-call) -> plugin -> library.count-items -> core
				const n = await callTool("mcp-tools__count_tagged", { tag: "imaging" });
				check(!n.isError, "count_tagged succeeds", n);
				eq(n.structuredContent, { tag: "imaging", count: 2 }, "counts the two items that have the tag in the throwaway library");
				eq((await callTool("mcp-tools__count_tagged", { tag: "ml" })).structuredContent?.count, 1, "another tag");
				eq((await callTool("mcp-tools__count_tagged", { tag: "nothing-has-this" })).structuredContent?.count, 0, "an unused tag");

				// arguments are checked against the schema before the plugin runs
				const bad = await callTool("mcp-tools__count_tagged", {});
				check(bad.isError && String(bad.content?.[0]?.text).includes("Invalid arguments"), "missing argument is a tool error", bad);
				const bad2 = await callTool("mcp-tools__add_tag", { item: "lower-case", tag: "x" });
				check(bad2.isError, "item key that does not match the pattern is a tool error", bad2);

				// the write tool really adds the tag in the core's library
				eq(itemTags("BBBBBBB2"), ["imaging"], "before: the book has one tag");
				const added = await callTool("mcp-tools__add_tag", { item: "BBBBBBB2", tag: "from-agent" });
				check(!added.isError, "add_tag succeeds", added);
				eq(JSON.parse(added.content[0].text), { item: "BBBBBBB2", tag: "from-agent", added: true }, "add_tag result");
				eq(itemTags("BBBBBBB2"), ["from-agent", "imaging"], "after: the tag is in the library");
				eq((await callTool("mcp-tools__count_tagged", { tag: "from-agent" })).structuredContent?.count, 1, "and count_tagged sees it");

				// an error the plugin returns (not-found) is a tool error carrying its message
				const missing = await callTool("mcp-tools__add_tag", { item: "ZZZZZZZZ", tag: "x" });
				check(missing.isError && String(missing.content?.[0]?.text).includes("no item ZZZZZZZZ"), "plugin error becomes a tool error with its message", missing);
				eq(sup.get(id)?.status, "running", "plugin is still running after errors");

				// the user turns the switch off again: gone at the next request
				on = false;
				eq((await listTools()).length, 0, "switch off again: no plugin tools");
				on = true;

				// a stopped plugin lists nothing; after a restart both tools are back (startup registers the run-time one again)
				await sup.stop(id);
				resetPluginRegistrations(id); // what the app does when a plugin stops
				eq((await listTools()).length, 0, "stopped plugin: no tools");
				await sup.start(id);
				eq((await listTools()).map((t) => t.name).sort(), ["mcp-tools__add_tag", "mcp-tools__count_tagged"], "restarted: both tools are back");

				// the user denies the permission: the grant goes, the tools go
				sup.setGrants(id, { capabilities: ["library.read", "library.write"], netHosts: [] });
				eq((await listTools()).length, 0, "mcp.expose revoked: no tools");
				sup.setGrants(id, declaredGrants(sup.get(id)!.manifest));
				eq((await listTools()).length, 2, "granted again: tools are back");
			} finally {
				dispose();
				await sup.shutdown();
				core.stop();
				await rm(fx.dir, { recursive: true, force: true }).catch(() => {});
			}
		},
	},
	{
		name: "highlight-export",
		build: (out) => buildPlugin({ dir: join(here, "highlight-export"), out, log: (l) => console.error("   ", l) }),
		async run(out) {
			const calls: Call[] = [];
			const annotation = (key: string, kind: string, text: string | undefined, comment: string, sortIndex: string, page: string) => ({
				key,
				library: 1,
				attachment: "ATT00001",
				kind,
				color: "#ffd400",
				text,
				comment,
				pageLabel: page,
				sortIndex,
				position: { pageIndex: 0, rects: [], nextPageRects: [], paths: [], width: undefined, fontSize: undefined, rotation: undefined, selector: undefined },
				tags: [],
				authorName: undefined,
				isExternal: false,
				readOnly: false,
				hasImage: false,
				dateAdded: 1n,
				dateModified: 1n,
			});
			const all = [
				annotation("ANN00002", "highlight", "Second <highlight> & more", "my comment", "00002|000000|00000", "2"),
				annotation("ANN00001", "highlight", "First highlight", "", "00001|000000|00000", "1"),
				annotation("ANN00003", "note", undefined, "a sticky note", "00003|000000|00000", "3"),
			];
			const sup = newSupervisor(calls, {
				"reader.register-listener": ok,
				"reader.unregister": ok,
				"annotations.list-annotations": () => all,
				"library.apply": () => ({ created: ["NOTE0001"], changed: 1 }),
				"ui.show-toast": () => 1n,
			});
			try {
				const info = await sup.load(out);
				await sup.start(info.id);
				const id = info.id;
				const regs = calledWith(calls, "reader.register-listener").map((c) => c.args[0] as any);
				eq(regs.map((r) => r.id), ["highlight-export.toolbar", "highlight-export.annotation"], "registers two reader listeners");
				eq(regs[0]?.target, { tag: "slot", val: "toolbar" }, "the first is a toolbar button");
				eq(regs[1]?.target, { tag: "menu", val: "annotation" }, "the second is the annotation context menu");
				eq(regs.map((r) => r.staticMenu.map((e: any) => e.id)), [["export-all"], ["export-selected"]], "each with its entry");

				const reader = { id: "reader-1", kind: "pdf", attachment: { library: 1, key: "ATT00001" }, parentItem: "PARENT01", tabId: "tab-1", window: 1, title: "A <Paper>", readOnly: false, selected: true };
				// toolbar: all highlights/underlines of the attachment become one note under the parent
				await sup.call(id, "reader-events", "on-menu-command", ["highlight-export.toolbar", "export-all", { reader, params: { tag: "view" } }]);
				const first = (calledWith(calls, "library.apply")[0]?.args[0] as any[])?.[0];
				eq(first?.tag, "create-item", "toolbar creates an item");
				const data = JSON.parse(first?.val?.data ?? "{}");
				eq([data.itemType, data.parentItem], ["note", "PARENT01"], "a note under the parent");
				check(data.note?.includes("<h1>Annotations: A &lt;Paper&gt;</h1>"), "note title is escaped", data.note);
				check(data.note?.indexOf("First highlight") < data.note?.indexOf("Second &lt;highlight&gt; &amp; more"), "annotations are in reading order", data.note);
				check(!data.note?.includes("sticky"), "toolbar export is highlights only", data.note);
				check(data.note?.includes("my comment (p. 2)"), "comment with page label", data.note);
				check(calledWith(calls, "log.write").some((c) => String(c.args[1]).includes("2 annotation(s)")), "the log counts them");
				const toasts = calledWith(calls, "ui.show-toast");
				eq(toasts.length, 1, "shows a toast after toolbar export");
				check(JSON.stringify(toasts[0]?.args[0], repl).includes("Exported 2 annotation(s) to a new note."), "toast text counts exported annotations");

				// context menu: exactly the annotations the menu was opened on (here the note one too)
				await sup.call(id, "reader-events", "on-menu-command", [
					"highlight-export.annotation",
					"export-selected",
					{ reader, params: { tag: "annotation", val: { annotations: [all[2]], current: "ANN00003", fromView: true, popup: false } } },
				]);
				const second = (calledWith(calls, "library.apply")[1]?.args[0] as any[])?.[0];
				check(JSON.parse(second?.val?.data ?? "{}").note?.includes("a sticky note"), "context menu exports the chosen annotations");
				eq(calledWith(calls, "ui.show-toast").length, 2, "shows a second toast after context menu export");
				// other listener ids and commands do nothing
				await sup.call(id, "reader-events", "on-menu-command", ["someone-else", "export-all", { reader, params: { tag: "view" } }]);
				eq(calledWith(calls, "library.apply").length, 2, "unknown listener is ignored");
				eq(sup.get(id)?.status, "running", "plugin is still running");
			} finally {
				await sup.shutdown();
			}
		},
	},
];

// ---- main ----------------------------------------------------------------------------------------------------------------

async function freeMiB(path: string): Promise<number | undefined> {
	const root = /^[A-Za-z]:/.test(resolve(path)) ? resolve(path).slice(0, 2) + "/" : resolve(path);
	for (const flag of ["-m", "-BM"]) {
		const p = Bun.spawn(["df", flag, root], { stdout: "pipe", stderr: "ignore" });
		const text = await new Response(p.stdout).text();
		if ((await p.exited) !== 0) continue;
		const cols = text.trim().split("\n").pop()?.trim().split(/\s+/);
		const n = cols ? parseInt(cols[3] ?? "", 10) : NaN;
		if (Number.isFinite(n)) return n;
	}
	return undefined;
}

const free = await freeMiB(process.env.TEMP ?? "/tmp");
if (free !== undefined && free < 9216) {
	console.error(`only ${free} MiB free; a Rust build needs more than 9216 MiB free. Free some space and run again.`);
	process.exit(3);
}

await rm(scratch, { recursive: true, force: true });
await mkdir(scratch, { recursive: true });
const t0 = Date.now();
const selected = samples.filter((s) => !only || s.name === only);
if (!selected.length) {
	console.error(`unknown sample ${only}`);
	process.exit(2);
}
try {
	for (const s of selected) {
		const out = resolve(scratch, s.name);
		console.log(`== ${s.name}: build`);
		const t1 = Date.now();
		try {
			await s.build(out);
		} catch (e) {
			failures++;
			console.error(`  FAIL build of ${s.name}: ${(e as Error).message}`);
			continue;
		}
		console.log(`   built in ${((Date.now() - t1) / 1000).toFixed(1)} s; run`);
		try {
			await s.run(out);
		} catch (e) {
			failures++;
			console.error(`  FAIL ${s.name} threw: ${(e as Error).stack ?? e}`);
		}
	}
} finally {
	if (!keep) await rm(scratch, { recursive: true, force: true });
}
console.log(`${failures === 0 ? "PASS" : "FAIL"}: ${checks} checks, ${failures} failed, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
process.exit(failures === 0 ? 0 : 1);
