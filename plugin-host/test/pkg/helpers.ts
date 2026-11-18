import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { buildPlugin } from "../../scripts/build-plugin";
import { loadHandlerModule, type ImportHandler } from "../../src/imports/registry";
import { createPluginRuntime, type RuntimeOptions } from "../../src/package/services";
import { writeZip, type ZipWriteEntry } from "../../src/package/zip";
import type { PluginRunner } from "../../src/supervisor";

const tmp = process.env.TEMP ?? process.env.TMPDIR ?? "/tmp";
export const fixtureRoot = join(tmp, `zn-wasm-pkg-fixtures-${process.pid}`);
process.on("exit", () => {
	try {
		rmSync(fixtureRoot, { recursive: true, force: true });
	} catch {}
});
const here = import.meta.dir;
export const importsDir = join(here, "..", "..", "src", "imports");

/** `ZN_TEST_RUNNER=worker bun test` runs against the fallback Bun Worker host; default is `"wasmtime"` (`zhw`). */
export const RUNNER: PluginRunner = process.env.ZN_TEST_RUNNER === "worker" ? "worker" : "wasmtime";

/** A fresh scratch folder under %TEMP%. */
export function scratch(name = "root"): string {
	mkdirSync(tmp, { recursive: true });
	return mkdtempSync(join(tmp, `zn-wasm-pkg-${name}-`));
}

export function rmTree(dir: string) {
	rmSync(dir, { recursive: true, force: true });
}

let built: Promise<string> | undefined;
/** Builds the e2e-js plugin once per test run (componentize-qjs + jco). Returns the loadable folder. */
export function buildE2e(): Promise<string> {
	built ??= buildPlugin({ dir: join(here, "fixtures", "e2e-js"), out: join(fixtureRoot, "e2e-js"), world: "e2e" }).then((r) => r.out);
	return built;
}

function walk(dir: string, base = dir): ZipWriteEntry[] {
	const out: ZipWriteEntry[] = [];
	for (const n of readdirSync(dir)) {
		const p = join(dir, n);
		const rel = relative(base, p).replaceAll("\\", "/");
		if (statSync(p).isDirectory()) out.push(...walk(p, base));
		else out.push({ name: rel, data: new Uint8Array(readFileSync(p)) });
	}
	return out;
}

export interface PackOptions {
	/** Edit the manifest before it goes into the zip. */
	manifest?: (m: Record<string, any>) => void;
	/** Files to add or replace (name -> bytes). */
	extra?: Record<string, Uint8Array | string>;
	/** Include build output's transpiled/ folder (the installer must ignore it). */
	withTranspiled?: boolean;
}

/** A .zplugin from a built loadable folder. */
export function pack(dir: string, o: PackOptions = {}): Uint8Array {
	const files = walk(dir).filter((f) => o.withTranspiled || !f.name.startsWith("transpiled/"));
	const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
	o.manifest?.(m);
	const byName = new Map(files.map((f) => [f.name, f]));
	byName.set("manifest.json", { name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(m)) });
	for (const [name, data] of Object.entries(o.extra ?? {})) byName.set(name, { name, data: typeof data === "string" ? new TextEncoder().encode(data) : data });
	return writeZip([...byName.values()]);
}

/** The zinc handlers of this area, loaded by path (so a test does not pull in other areas' modules). */
export async function myZincHandlers(): Promise<ImportHandler[]> {
	const names = ["app", "plugins", "prefs", "secrets", "l10n", "log", "timers", "permissions"];
	return (await Promise.all(names.map((n) => loadHandlerModule(join(importsDir, `${n}.zinc.ts`))))).flat();
}

/** Services + supervisor in a temporary plugins folder. */
export async function newRuntime(root: string, o: RuntimeOptions = {}) {
	const rt = await createPluginRuntime({
		handlers: await myZincHandlers(),
		...o,
		manager: { root, runner: RUNNER, ...o.manager },
		supervisor: { callTimeoutMs: 6000, runner: RUNNER, ...o.supervisor },
	});
	const lines = (id: string) => rt.services.logs.recent({ plugin: id, limit: 5000 }).map((l) => l.message);
	return { ...rt, lines };
}

export async function until(cond: () => boolean, ms = 4000, what = "condition") {
	const t0 = Date.now();
	while (!cond()) {
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(10);
	}
}
