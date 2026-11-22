// The app is compiled once per run, not once per scenario. Two caches in out/ui-build, shared by every scenario's process:
//
//   solid/   each .tsx as GPUIX's Solid plugin compiles it (Babel), under a hash of its path, its text and the compiler
//   bun/     Bun's own transpiler cache, which otherwise lives in the user folder that every scenario replaces
//
// The scenarios' processes load this file as their preload (bunfig.toml here) in place of @gpuix/solid/preload, which would load
// Babel and compile all of it again in each of them. run.ts fills the cache before it starts the first one.
import { plugin, type BunPlugin } from "bun";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const GPUI = resolve(import.meta.dir, "..", "..");
const BUILD = join(GPUI, "out", "ui-build");
const COMPILED = join(BUILD, "solid");
/** For the children's environment (BUN_RUNTIME_TRANSPILER_CACHE_PATH). */
export const BUN_CACHE = join(BUILD, "bun");

const TSX = /^(?!.*[/\\]node_modules[/\\]).*\.[cm]?[jt]sx(?:[?#].*)?$/;
const SOLID_SERVER = /[/\\]node_modules[/\\]solid-js[/\\](?:store[/\\])?dist[/\\]server\.js(?:[?#].*)?$/;
const plain = (path: string) => path.split(/[?#]/, 1)[0]!;

// a change of the compiler (an upgrade, a patch) makes every entry stale
const COMPILER = join(GPUI, "node_modules", "@gpuix", "solid", "dist", "bun-plugin.js");
let compilerId: string | undefined;
const keyOf = (file: string, source: string): string => {
	compilerId ??= createHash("sha256").update(readFileSync(COMPILER)).update(readFileSync(join(GPUI, "bun.lock"))).digest("hex");
	return createHash("sha256").update(compilerId).update("\0").update(file).update("\0").update(source).digest("hex").slice(0, 40);
};

type Load = (args: { path: string }) => Promise<{ contents: string }>;
let compiler: Promise<Load> | undefined;
/** GPUIX's own .tsx handler, loaded (with Babel) only when something is not in the cache. */
function loadCompiler(): Promise<Load> {
	return (compiler ??= import("@gpuix/solid/bun-plugin").then(({ createSolidPlugin }) => {
		let found: Load | undefined;
		void (createSolidPlugin() as BunPlugin).setup({
			onLoad(o: { filter: RegExp }, load: Load) {
				if (o.filter.test("C:/app/probe.tsx")) found = load;
			},
		} as never);
		if (!found) throw new Error("UI test: GPUIX's Solid plugin has no .tsx handler any more (test/ui/compiled.ts)");
		return found;
	}));
}

/** One file, compiled: from the cache, else compiled and put there. */
export async function compiled(path: string): Promise<string> {
	const file = plain(path);
	const out = join(COMPILED, `${keyOf(file, readFileSync(file, "utf8"))}.js`);
	if (existsSync(out)) return readFileSync(out, "utf8");
	const { contents } = await (await loadCompiler())({ path: file });
	mkdirSync(COMPILED, { recursive: true });
	const tmp = `${out}.${process.pid}`;
	writeFileSync(tmp, contents);
	try {
		renameSync(tmp, out); // another process may be writing the same entry: whole files only
	} catch {
		rmSync(tmp, { force: true });
	}
	return contents;
}

/** Compile the whole app (run.ts, before the first scenario). Returns how many files that is. */
export async function compileApp(): Promise<number> {
	let n = 0;
	mkdirSync(BUN_CACHE, { recursive: true });
	for (const dir of ["src", "test/ui"]) {
		for (const f of new Bun.Glob("**/*.tsx").scanSync({ cwd: join(GPUI, dir), absolute: true })) {
			if (relative(GPUI, f).includes("node_modules") || f.endsWith(".test.tsx")) continue;
			await compiled(resolve(f));
			n++;
		}
	}
	return n;
}

/** What @gpuix/solid/preload registers, reading from the cache. */
export function installCompiledApp(): void {
	plugin({
		name: "zinc-ui-test-compiled",
		setup(build) {
			build.onLoad({ filter: SOLID_SERVER }, ({ path }) => {
				const file = plain(path);
				const client = /[/\\]store[/\\]dist[/\\]/.test(file) ? "store.js" : "solid.js";
				return { contents: readFileSync(file.replace(/server\.js$/, client), "utf8"), loader: "js" };
			});
			build.onLoad({ filter: TSX }, async ({ path }) => ({ contents: await compiled(resolve(plain(path))), loader: "js" }));
		},
	});
}
