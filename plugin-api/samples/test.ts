#!/usr/bin/env bun
// bun plugin-api/samples/test.ts [--only word-count|quick-tags|highlight-export] [--keep]
//
// Builds the three sample plugins with plugin-host/scripts/build-plugin.ts (the JS one through sdk/js/scripts/build.ts, which
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

/** Every text a render-result shows (plain text of text nodes, buttons and callouts), for loose assertions. */
function texts(result: any): string[] {
	const out: string[] = [];
	const visit = (k: any) => {
		for (const run of k?.val?.runs ?? []) if (run.text?.val) out.push(String(run.text.val));
		for (const f of ["label", "message", "title"]) if (k?.val?.[f]?.val && typeof k.val[f].val === "string") out.push(k.val[f].val);
	};
	const c = result.content;
	if (c.tag === "full") for (const n of c.val.nodes) visit(n.kind);
	else if (c.tag === "json") out.push(c.val);
	return out;
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
				"extend.register-pref-pane": ok,
				"extend.invalidate-columns": ok,
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
				// startup registers a column and a preference pane, and watches its preference
				eq(calledWith(calls, "extend.register-column").map((c) => (c.args[0] as any).dataKey), ["word-count"], "registers the word-count column");
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

				// changing the pref clears the cache and invalidates the column
				const before = calledWith(calls, "extend.invalidate-columns").length;
				await sup.call(id, "events", "on-pref-changed", [1, "plugin-own", "countNumbers", { tag: "flag", val: true }]);
				check(calledWith(calls, "extend.invalidate-columns").length === before + 1, "pref change invalidates the column");
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
			let dialogAnswer: unknown = { button: "ok", values: [{ name: "tags", value: { tag: "text", val: " alpha, beta;gamma ,, alpha " } }] };
			const sup = newSupervisor(calls, {
				"extend.register-menu": ok,
				"extend.list-selected-items": (_w: unknown, _o: number, limit: number) => Array.from({ length: Math.min(limit, 3) }, (_, i) => `KEY0000${i}`),
				"ui.run-dialog": () => dialogAnswer,
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

				// command: dialog (with a form), then library.apply, then a toast
				const ctx = emptyCtx({ items: ["AAAA1111", "BBBB2222"], itemCount: 2 });
				await sup.call(id, "extend-handlers", "on-menu-command", ["quick-tags-menu", "quick-tags.add", undefined, ctx]);
				const dialog = calledWith(calls, "ui.run-dialog")[0]?.args[0] as any;
				check(dialog, "opens a dialog");
				check(dialog?.content?.nodes?.some((n: any) => n.kind.tag === "form"), "the dialog has a form");
				const input = dialog?.content?.nodes?.find((n: any) => n.kind.tag === "text-input");
				eq(input?.props?.name, "tags", "with a named text input");
				eq(dialog?.buttons?.map((b: any) => b.id), ["cancel", "ok"], "and Cancel / OK buttons");
				const applied = calledWith(calls, "library.apply");
				eq(applied.length, 1, "one library.apply call");
				const change = (applied[0]?.args[0] as any[])?.[0];
				eq(change?.tag, "add-tags", "a add-tags change");
				eq(change?.val?.items, ["AAAA1111", "BBBB2222"], "for the selected items");
				eq(change?.val?.tags, [{ name: "alpha", kind: "manual" }, { name: "beta", kind: "manual" }, { name: "gamma", kind: "manual" }], "with the parsed, de-duplicated tags");
				eq(calledWith(calls, "ui.show-toast").length, 1, "a toast confirms");
				check(JSON.stringify(calledWith(calls, "ui.show-toast")[0]?.args[0], repl).includes("Added 3 tags to 2 items"), "toast text");

				// cancel: nothing is written
				dialogAnswer = { button: "cancel", values: [] };
				await sup.call(id, "extend-handlers", "on-menu-command", ["quick-tags-menu", "quick-tags.add", undefined, ctx]);
				eq(calledWith(calls, "library.apply").length, 1, "cancel writes nothing");

				// another menu or entry is ignored; a truncated selection is fetched through extend.list-selected-items
				await sup.call(id, "extend-handlers", "on-menu-command", ["other-menu", "x", undefined, ctx]);
				dialogAnswer = { button: "ok", values: [{ name: "tags", value: { tag: "text", val: "z" } }] };
				await sup.call(id, "extend-handlers", "on-menu-command", ["quick-tags-menu", "quick-tags.add", undefined, emptyCtx({ items: ["AAAA1111"], itemCount: 3, itemsTruncated: true })]);
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

				// context menu: exactly the annotations the menu was opened on (here the note one too)
				await sup.call(id, "reader-events", "on-menu-command", [
					"highlight-export.annotation",
					"export-selected",
					{ reader, params: { tag: "annotation", val: { annotations: [all[2]], current: "ANN00003", fromView: true, popup: false } } },
				]);
				const second = (calledWith(calls, "library.apply")[1]?.args[0] as any[])?.[0];
				check(JSON.parse(second?.val?.data ?? "{}").note?.includes("a sticky note"), "context menu exports the chosen annotations");
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
	const p = Bun.spawn(["df", "-m", path], { stdout: "pipe", stderr: "ignore" });
	const text = await new Response(p.stdout).text();
	const cols = text.trim().split("\n").pop()?.trim().split(/\s+/);
	const n = cols ? Number(cols[3]) : NaN;
	return Number.isFinite(n) ? n : undefined;
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
