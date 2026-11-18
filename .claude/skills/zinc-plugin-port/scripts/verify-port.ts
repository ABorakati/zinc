#!/usr/bin/env bun
// Build a ported plugin and run it through the plugin supervisor against a THROWAWAY core. Never touches the user's library
// (data/library.sqlite, the Zotero data folder) or ports 23119 / 23120: the core is core's own test fixture (a temp library with a few
// items, an attachment, full text) served by core's `startServer({ port: 0 })`.
//
//   bun verify-port.ts <plugin dir> [--scenario <file.ts>] [--no-build] [--keep]
//
// What runs for real: the plugin's wasm in the plugin host process, and the host-side handlers (library, attachments, fulltext, net,
// notifier, ...) against the throwaway core. What is stubbed: the Zinc-app-side interfaces (extend, ui, reader, prefs, l10n, app, ...).
// The stubs RECORD every call, so you can assert "startup registered a column, a menu with these entries, a pref pane".
//
// A scenario is a module with `export default async (t) => { ... }`. `t` gives you:
//   t.sup, t.id           the supervisor and the plugin id: t.sup.call(t.id, "extend-handlers", "on-menu-command", [menuId, entryId, undefined, ctx])
//   t.core                { url, dir, db } the throwaway core (db is a bun:sqlite handle for assertions)
//   t.calls               every recorded stub call: { iface, fn, args }
//   t.prefs               Map of plain pref values the stub `prefs` interface serves, wrapped as pref-value variants (seeded from manifest default_prefs)
//   t.api(path, init?)    fetch against the throwaway core as JSON
//   t.check(cond, what)   counts a failure instead of throwing
//   t.until(fn, ms, what) poll until fn() is truthy
// Exit code 1 if any check failed. The scratch folder (%TEMP%\zn-verify-port-*) is deleted at the end unless --keep.
//
// Needs: plugin-host/node_modules (for the JS build), core/vendor (a junction to the main checkout's core/vendor, git-ignored).
// The runner code (plugin-host/, plugin-host-wasmtime/) changes often: if the harness itself breaks, say so and fall back to
// `bun plugin-api/samples/test.ts`-style stub tests (see references/verification.md).
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const pluginDir = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--scenario");
if (!pluginDir) {
	console.error("usage: bun verify-port.ts <plugin dir> [--scenario <file.ts>] [--no-build] [--keep]");
	process.exit(2);
}

// repo root = the nearest parent holding plugin-host/ and plugin-api/
let root = import.meta.dir;
while (!(existsSync(join(root, "plugin-host")) && existsSync(join(root, "plugin-api")))) {
	const up = dirname(root);
	if (up === root) throw new Error("run this from inside the Zinc repo: no plugin-host/ + plugin-api/ above " + import.meta.dir);
	root = up;
}
const scratch = mkdtempSync(join(tmpdir(), "zn-verify-port-"));
process.env.APPDATA = join(scratch, "appdata"); // core logs to %APPDATA%: keep it in scratch

let failures = 0;
const check = (cond: unknown, what: string) => {
	if (cond) console.log(`  ok   ${what}`);
	else {
		failures++;
		console.error(`  FAIL ${what}`);
	}
};
const until = async <T>(fn: () => T | undefined | false, ms = 5000, what = "condition"): Promise<T> => {
	const t0 = Date.now();
	for (;;) {
		const v = fn();
		if (v) return v as T;
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(25);
	}
};

const dir = resolve(pluginDir);
const manifestSrc = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const language: string = manifestSrc.main?.language ?? (existsSync(join(dir, "Cargo.toml")) ? "rust" : "js");

// ---- build ------------------------------------------------------------------------------------------------------------------
const out = flag("--no-build") ? (existsSync(join(dir, "dist", "manifest.json")) ? join(dir, "dist") : dir) : join(scratch, "pkg");
if (!flag("--no-build")) {
	console.log(`building ${manifestSrc.id} (${language})`);
	if (language === "js") {
		const { buildJsPlugin } = await import(pathToFileURL(join(root, "plugin-api/sdk/js/scripts/build.ts")).href);
		await buildJsPlugin({ dir, out, log: (l: string) => console.error("  " + l) });
	} else {
		const { buildPlugin } = await import(pathToFileURL(join(root, "plugin-host/scripts/build-plugin.ts")).href);
		await buildPlugin({ dir, out, log: (l: string) => console.error("  " + l) });
	}
}

// ---- stubs for the Zinc-app side (extend, ui, reader, prefs, ...): record, answer neutrally ---------------------------------------
const { defineHandler } = await import(pathToFileURL(join(root, "plugin-host/src/imports/registry.ts")).href);
const { createPluginSupervisor } = await import(pathToFileURL(join(root, "plugin-host/src/supervisor.ts")).href);

const calls: { iface: string; fn: string; args: unknown[] }[] = [];
const prefs = new Map<string, unknown>(Object.entries(manifestSrc.default_prefs ?? {}));
const wit = (f: string) => readFileSync(join(root, "plugin-api/wit", f), "utf8");
/** `iface: func` names of one interface block of a .wit file (so the stub list follows the WIT). */
function funcsOf(file: string, iface: string): string[] {
	const src = wit(file);
	const start = src.search(new RegExp(`^interface ${iface} \\{`, "m"));
	if (start < 0) return [];
	const end = src.indexOf("\n}\n", start);
	return [...src.slice(start, end).matchAll(/^\s+([a-z][a-z0-9-]*): func/gm)].map((m) => m[1]);
}
/** `pref-value` is a variant: flag(bool) | integer(s32) | text(string). t.prefs holds plain JS values. */
const toPrefValue = (v: unknown) => (v === undefined ? undefined : typeof v === "boolean" ? { tag: "flag", val: v } : typeof v === "number" ? { tag: "integer", val: v } : { tag: "text", val: String(v) });
const answers: Record<string, Record<string, (...a: any[]) => unknown>> = {
	log: { write: (_l: string, m: string) => void console.log(`    [plugin log] ${m}`) },
	prefs: {
		get: (k: string) => toPrefValue(prefs.get(k)),
		"get-all": () => [...prefs].map(([key, value]) => ({ key, value: toPrefValue(value) })),
		set: (k: string, v: any) => void prefs.set(k, v?.val),
		clear: (k: string) => void prefs.delete(k),
		"has-user-value": () => false,
		observe: () => 1,
	},
	"extend": { "list-selected-items": () => [], "get-context": () => { throw { tag: "unavailable", val: "no window in the harness" }; } },
	timers: {},
};
const zincIfaces: [string, string][] = [
	["extend", "extend.wit"], ["ui", "ui.wit"], ["reader", "reader.wit"], ["note-editor", "reader.wit"], ["annotations", "reader.wit"],
	["prefs", "lifecycle.wit"], ["l10n", "lifecycle.wit"], ["app", "lifecycle.wit"], ["plugins", "lifecycle.wit"], ["permissions", "lifecycle.wit"],
	["secrets", "lifecycle.wit"], ["clipboard", "lifecycle.wit"], ["shell", "lifecycle.wit"], ["log", "lifecycle.wit"],
];
const stubs = zincIfaces.map(([iface, file]) => {
	const functions: Record<string, (ctx: unknown, ...a: unknown[]) => unknown> = {};
	for (const fn of funcsOf(file, iface)) {
		functions[fn] = (_ctx, ...a) => {
			calls.push({ iface, fn, args: a });
			const f = answers[iface]?.[fn];
			return f ? f(...a) : undefined; // undefined suits `result<_, error>`, `option` and `()`; set an answer above when a plugin needs a real value
		};
	}
	return defineHandler({ interface: `zinc:plugin/${iface}`, where: "zinc", functions });
});

// ---- throwaway core -----------------------------------------------------------------------------------------------------------
const { buildFixture } = await import(pathToFileURL(join(root, "core/test/fixture.ts")).href);
const { startServer } = await import(pathToFileURL(join(root, "core/src/server.ts")).href);
const { Database } = await import("bun:sqlite");
const fx = buildFixture();
fx.db.close();
const dbPath = join(fx.dir, "lib.sqlite");
const server = startServer({ dbPath, port: 0, hostname: "127.0.0.1" });
const db = new Database(dbPath);
db.exec("PRAGMA busy_timeout = 5000");
const core = { url: server.url as string, dir: fx.dir as string, db };
console.log(`throwaway core at ${core.url} (library copy in ${core.dir})`);
const api = async (path: string, init: RequestInit & { json?: unknown } = {}) => {
	const r = await fetch(core.url + path, { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) }, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
	return r.json();
};

const sup = createPluginSupervisor({ importHandlers: stubs, coreUrl: core.url, callTimeoutMs: 15_000, lifecycleTimeoutMs: 20_000, loadTimeoutMs: 90_000 });
let id = manifestSrc.id as string;
try {
	const info = await sup.load(out);
	id = info.id ?? id;
	await sup.start(id);
	console.log(`started ${id}`);
	const regs = calls.filter((c) => /^(register|open|show|subscribe)/.test(c.fn) || c.iface === "notifier");
	console.log("registrations made in startup:");
	for (const c of regs) console.log(`  ${c.iface}.${c.fn} ${JSON.stringify(c.args, (_, v) => (typeof v === "bigint" ? `${v}n` : v)).slice(0, 220)}`);
	check(true, "startup completed");

	const scenario = opt("--scenario");
	if (scenario) {
		const mod = await import(pathToFileURL(resolve(scenario)).href);
		await mod.default({ sup, id, core, calls, prefs, api, check, until });
	}
} catch (e) {
	failures++;
	console.error("FAILED:", e);
} finally {
	await sup.shutdown().catch(() => {});
	db.close();
	server.stop();
	if (!flag("--keep")) {
		for (const d of [fx.dir, scratch]) {
			try {
				rmSync(d, { recursive: true, force: true });
			} catch {}
		}
	} else console.log(`kept ${scratch} and ${fx.dir}`);
}
console.log(failures ? `${failures} failure(s)` : "all checks passed");
process.exit(failures ? 1 : 0);
