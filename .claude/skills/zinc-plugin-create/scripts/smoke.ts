#!/usr/bin/env bun
// Load a BUILT plugin folder (manifest.json + plugin.wasm [+ transpiled/]) through Zinc's plugin supervisor with stub imports,
// run `startup`, and show what the plugin registered and called. No app, no core, no real library, no ports: every import is
// answered by a stub defined here (Zinc's own handlers are not loaded).
//
//   bun smoke.ts <built dir> [--call <iface>.<fn> '<json array of args>'] ... [--runner wasmtime|worker] [--keep-going]
//   e.g. bun smoke.ts dist --call extend-handlers.on-menu-command '["hello-menu","hello.hello",null,{"window":1,"tab":{"id":"library","kind":"library"},"rows":[],"items":[],"itemCount":0,"itemsTruncated":false,"editable":true}]'
//
// As a module (see ../assets/plugin.test.ts) it exports openPlugin() and builders for the records callbacks take.
// Values are jco values: camelCase fields, enums as strings, variants as { tag, val }, option as value or undefined/null,
// u64 as BigInt. In --call JSON a number written as "123n" is turned into a BigInt.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function findZinc(): string {
	for (const c of [process.env.ZINC_ROOT, process.cwd(), import.meta.dir].filter(Boolean) as string[]) {
		let d = resolve(c);
		for (let i = 0; i < 10; i++) {
			if (existsSync(join(d, "plugin-api", "wit", "world.wit"))) return d;
			const up = dirname(d);
			if (up === d) break;
			d = up;
		}
	}
	throw new Error("cannot find the Zinc root (the folder with plugin-api/wit): set ZINC_ROOT or run from inside the checkout");
}
export const zincRoot = findZinc();
const host: any = await import(pathToFileURL(join(zincRoot, "plugin-host", "src", "index.ts")).href);
// Zinc validates every UI tree a plugin returns against plugin-api/ui-schema/ui-tree.schema.json (unknown props are errors).
// Use the same validator here so a typo shows up in the test, not in the app. Optional: skipped if the file has moved.
const uiValidate: any = await import(pathToFileURL(join(zincRoot, "gpui-ui", "src", "wasmplugins", "ui", "validate.ts")).href).catch(() => undefined);

/** Check a render-result a callback returned (`{ content: { tag: "json" | "patch" | "unchanged", val } }`). Returns an error text, or undefined when fine. */
export function checkRender(r: any): string | undefined {
	const c = r?.content;
	if (!c || !uiValidate || (c.tag !== "json" && c.tag !== "patch")) return undefined;
	let j: unknown;
	try {
		j = JSON.parse(c.val);
	} catch (e) {
		return "content is not JSON: " + (e as Error).message;
	}
	return c.tag === "json" ? uiValidate.validateTreeObject(j, "full") : uiValidate.validatePatchObject(j, "full");
}

export interface Call {
	iface: string;
	fn: string;
	args: unknown[];
}
export type Answers = Record<string, (...args: any[]) => unknown>;

const ok = () => undefined;
/** Answers that make a plugin's startup work. Your own `answers` override them. Anything not listed is "unavailable" to the plugin. */
export const DEFAULT_ANSWERS: Answers = {
	"extend.register-menu": ok,
	"extend.register-column": ok,
	"extend.register-columns": ok,
	"extend.register-section": ok,
	"extend.register-pref-pane": ok,
	"extend.register-shortcut": ok,
	"extend.register-toolbar-button": ok,
	"extend.invalidate-columns": ok,
	"extend.subscribe-events": ok,
	"reader.register-listener": ok,
	"reader.register-panel": ok,
	"reader.register-overlay": ok,
	"reader.unregister": ok,
	"prefs.observe": () => 1,
	"prefs.get": () => undefined,
	"prefs.set": ok,
	"prefs.set-many": ok,
	"prefs.clear": ok,
	"timers.set-timeout": () => 1,
	"timers.set-interval": () => 1,
	"timers.clear": ok,
	"library.apply": () => ({ created: [], changed: 0 }),
	"library.query-items": () => ({ total: 0n, items: [] }),
	"library.count-items": () => 0n,
	"notifier.subscribe": () => 1,
	"ui.refresh": ok,
	"ui.push": ok,
	"ui.show-toast": () => 1n,
	"ui.open-dialog": () => 100n, // see closeDialog() to deliver the user's answer
};

export const repl = (_: string, v: unknown) => (typeof v === "bigint" ? `${v}n` : v instanceof Uint8Array ? `<${v.length} bytes>` : v);
export const show = (v: unknown, max = 600) => {
	const s = JSON.stringify(v, repl) ?? "undefined";
	return s.length > max ? s.slice(0, max) + "..." : s;
};

function stubs(calls: Call[], answers: Answers, echoLog: boolean) {
	const byIface = new Map<string, Record<string, (ctx: unknown, ...a: unknown[]) => unknown>>();
	const all: Answers = {
		"log.write": (level: string, m: string) => {
			if (echoLog) console.log(`  [plugin log ${level}] ${m}`);
		},
		...DEFAULT_ANSWERS,
		...answers,
	};
	for (const [name, fn] of Object.entries(all)) {
		const [iface, f] = name.split(".");
		const fns = byIface.get(iface) ?? {};
		fns[f] = (_ctx, ...a) => {
			calls.push({ iface, fn: f, args: a });
			return fn(...a);
		};
		byIface.set(iface, fns);
	}
	return [...byIface].map(([iface, functions]) => host.defineHandler({ interface: `zinc:plugin/${iface}`, where: "zinc", functions }));
}

export interface OpenOptions {
	/** "wasmtime" (needs the `zhw` binary) or "worker" (Bun Worker + jco). Default: wasmtime if zhw exists, else worker. */
	runner?: "wasmtime" | "worker";
	/** Print the plugin's own log lines. Default true. */
	echoLog?: boolean;
	callTimeoutMs?: number;
	lifecycleTimeoutMs?: number;
}
export interface OpenPlugin {
	sup: any;
	id: string;
	calls: Call[];
	runner: string;
	/** `await p.call("extend-handlers", "on-menu-command", [menu, entry, undefined, ctx])` */
	call(iface: string, fn: string, args?: unknown[]): Promise<any>;
	/** Recorded import calls, `calledWith("extend.register-menu")`. */
	calledWith(name: string): Call[];
	shutdown(): Promise<void>;
}

/** Load the built folder, grant the permissions its manifest declares, run `startup`. */
export async function openPlugin(builtDir: string, answers: Answers = {}, o: OpenOptions = {}): Promise<OpenPlugin> {
	const calls: Call[] = [];
	let runner = o.runner ?? (process.env.ZN_PLUGIN_RUNNER === "worker" ? "worker" : undefined);
	if (!runner) runner = existsSync(host.resolveZhwPath()) ? "wasmtime" : "worker";
	const sup = host.createPluginSupervisor({
		importHandlers: stubs(calls, answers, o.echoLog ?? true),
		discoverHostHandlers: false, // do not load src/imports/*.host.ts (they would talk to a real core)
		runner,
		callTimeoutMs: o.callTimeoutMs ?? 8000,
		lifecycleTimeoutMs: o.lifecycleTimeoutMs ?? 15000,
		loadTimeoutMs: 60000,
	});
	const info = await sup.load(resolve(builtDir));
	await sup.start(info.id);
	const id: string = info.id;
	return {
		sup,
		id,
		calls,
		runner,
		call: (iface, fn, args = []) => sup.call(id, iface, fn, args),
		calledWith: (name) => {
			const [i, f] = name.split(".");
			return calls.filter((c) => c.iface === i && c.fn === f);
		},
		shutdown: () => sup.shutdown(),
	};
}

// ---- builders for callback arguments (all required fields set: a missing one is an error) ----------------------------

export const NO_MODS = { shift: false, ctrl: false, alt: false, meta: false };
/** `extend-handlers.on-menu-command` context. */
export const menuContext = (over: Record<string, unknown> = {}) => ({
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
/** `ui-events.mount` context for an item pane section (`params` is JSON). */
export const viewContext = (view: string, params: unknown = {}, surface = "item-pane-section") => ({
	view,
	surface,
	params: JSON.stringify(params),
	theme: "light",
	width: undefined,
	height: undefined,
	locale: "en-US",
});
/** `ui-events.on-event` argument for a button press (or another kind). */
export const uiEvent = (handler: string, kind = "press", payload: unknown = { tag: "none" }) => ({ handler, nodeKey: undefined, kind, modifiers: NO_MODS, payload, rev: 0n });
/** Deliver the two `close` events a dialog sends: the pressed button, then the form values. `values`: `[{ name, value: { tag: "text", val } }]`. */
export async function closeDialog(p: OpenPlugin, instance: bigint, button: string | undefined, values: { name: string; value: { tag: string; val?: unknown } }[] = []) {
	const base = { handler: button ?? "", nodeKey: undefined, kind: "close", modifiers: NO_MODS, rev: 0n };
	await p.call("ui-events", "on-event", [instance, { ...base, payload: button === undefined ? { tag: "none" } : { tag: "button", val: button } }]);
	await p.call("ui-events", "on-event", [instance, { ...base, payload: { tag: "form", val: values } }]);
}
/** An `item-summary` for `library.get-summaries` / `query-items` stubs. */
export const itemSummary = (key: string, over: Record<string, unknown> = {}) => ({
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

// ---- CLI -------------------------------------------------------------------------------------------------------------
if (import.meta.main) {
	const args = process.argv.slice(2);
	const take = (flag: string) => {
		const i = args.indexOf(flag);
		return i >= 0 ? args.splice(i, 2)[1] : undefined;
	};
	const runner = take("--runner") as "wasmtime" | "worker" | undefined;
	const callSpecs: { name: string; json?: string }[] = [];
	for (let i = args.indexOf("--call"); i >= 0; i = args.indexOf("--call")) {
		const [, name, json] = args.splice(i, 3);
		callSpecs.push({ name, json });
	}
	const dir = args[0];
	if (!dir) {
		console.error("usage: bun smoke.ts <built dir> [--call iface.fn '<json args>'] [--runner wasmtime|worker]");
		process.exit(2);
	}
	let code = 0;
	const p = await openPlugin(dir, {}, { runner }).catch((e) => {
		console.error(`FAIL load/startup: ${e?.message ?? e}${e?.payload ? " " + show(e.payload) : ""}`);
		process.exit(1);
	});
	try {
		console.log(`loaded ${p.id} (runner: ${p.runner}); startup ran`);
		const interesting = p.calls.filter((c) => c.iface !== "log");
		console.log(`import calls during startup (${interesting.length}):`);
		for (const c of interesting) console.log(`  ${c.iface}.${c.fn} ${show(c.args)}`);
		for (const s of callSpecs) {
			const [iface, fn] = s.name.split(".");
			const argv = JSON.parse(s.json ?? "[]", (_k, v) => (typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v === null ? undefined : v));
			const before = p.calls.length;
			try {
				const r = await p.call(iface, fn, argv);
				console.log(`call ${s.name} -> ${show(r)}`);
				const bad = checkRender(r);
				if (bad) {
					code = 1;
					console.log(`  UI TREE INVALID: ${bad}`);
				} else if (r?.content?.tag === "json" || r?.content?.tag === "patch") console.log("  ui tree: valid against ui-tree.schema.json");
			} catch (e: any) {
				code = 1;
				console.log(`call ${s.name} FAILED: ${e?.message ?? e} ${e?.payload ? show(e.payload) : ""}`);
			}
			for (const c of p.calls.slice(before).filter((c) => c.iface !== "log")) console.log(`  import ${c.iface}.${c.fn} ${show(c.args)}`);
		}
		console.log(`status: ${p.sup.get(p.id)?.status}`);
	} finally {
		await p.shutdown();
	}
	process.exit(code);
}
