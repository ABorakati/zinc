// A throwaway core for the data-area tests: a temp library (core's own test fixture: a few items, an attachment, full text),
// served by core's startServer on a free port. Never touches data/library.sqlite or ports 23119/23120.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HandlerTable, WitError, type HandlerContext, type ImportHandler } from "../../src/imports/registry";
import { declaredGrants, type Grants, type PluginManifest } from "../../src/manifest";

// core logs to %APPDATA%: keep it in the scratch folder
const scratch = mkdtempSync(join(tmpdir(), "zn-data-test-"));
process.env.APPDATA = join(scratch, "appdata");

export interface TestCore {
	url: string;
	dir: string;
	dbPath: string;
	/** Direct handle on the library, for assertions. */
	db: import("bun:sqlite").Database;
	stop(): void;
}

export async function startCore(): Promise<TestCore> {
	const { buildFixture } = await import("../../../core/test/fixture");
	const { startServer } = await import("../../../core/src/server");
	const { Database } = await import("bun:sqlite");
	const fx = buildFixture();
	fx.db.close();
	const dbPath = join(fx.dir, "lib.sqlite");
	const s = startServer({ dbPath, port: 0, hostname: "127.0.0.1" });
	const db = new Database(dbPath);
	db.exec("PRAGMA busy_timeout = 5000");
	return {
		url: s.url,
		dir: fx.dir,
		dbPath,
		db,
		stop() {
			db.close();
			s.stop();
			try {
				rmSync(fx.dir, { recursive: true, force: true });
			} catch {
				// Windows: still open; the temp sweep handles it
			}
		},
	};
}

export function manifestOf(over: Partial<PluginManifest> & { capabilities?: string[]; netHosts?: string[]; shellSchemes?: string[] } = {}): PluginManifest {
	const { capabilities, netHosts, shellSchemes, ...rest } = over;
	return {
		manifest_version: 1,
		id: "data-test@zinc.test",
		name: "Data test",
		version: "1.0.0",
		main: { wasm: "plugin.wasm" },
		permissions: {
			capabilities: capabilities ?? [],
			net: { hosts: netHosts ?? [] },
			...(shellSchemes ? { shell: { schemes: shellSchemes } } : {}),
		} as PluginManifest["permissions"],
		...rest,
	};
}

/** A HandlerContext for calling a handler directly (no plugin, no worker). */
export function fakeCtx(
	core: { url: string } | undefined,
	m: PluginManifest = manifestOf(),
	extra: { grants?: Grants; calls?: unknown[][]; log?: string[] } = {},
): HandlerContext {
	const grants = extra.grants ?? declaredGrants(m);
	return {
		pluginId: m.id,
		manifest: m,
		grants,
		where: "host",
		coreUrl: core?.url,
		has: (p) => grants.capabilities.includes(p),
		require(p) {
			if (!grants.capabilities.includes(p)) throw new WitError("permission-denied", p);
		},
		async callExport(iface, fn, args = []) {
			extra.calls?.push([iface, fn, ...args]);
			return undefined;
		},
		log: (_l, msg) => extra.log?.push(msg),
		resource: (name, state) => ({ "$zinc-resource": name, id: -1, state }) as never,
	};
}

/** Call a handler function by name the way the router does (kebab or camel). */
export async function call(handler: ImportHandler | ImportHandler[], ctx: HandlerContext, fn: string, ...args: unknown[]): Promise<any> {
	const list = Array.isArray(handler) ? handler : [handler];
	return new HandlerTable(list).call(ctx, list[0].interface, fn, args);
}

/** The error payload of what a handler throws, or undefined if it returned. */
export async function failure(p: Promise<unknown>): Promise<{ tag: string; val?: unknown; index?: number; error?: any } | undefined> {
	try {
		await p;
		return undefined;
	} catch (e: any) {
		return e?.payload ?? { tag: "thrown", val: String(e?.message ?? e) };
	}
}

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(f: () => T | undefined | false, ms = 4000, what = "condition"): Promise<T> {
	const t0 = Date.now();
	for (;;) {
		const v = f();
		if (v) return v as T;
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
		await wait(20);
	}
}
