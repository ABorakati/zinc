// Prepare the plugin folders the benchmark uses, all under %TEMP%\zn-wasm-wasmtime\fixtures (nothing is written inside the repo):
//   - copies the already built fixtures other agents left in %TEMP% (hello-rust, hello-js, ui-fixture, extend-fixture) and samples
//     built into %TEMP%\zn-wasm-wasmtime\samples (quick-tags ...)
//   - builds the bench guest (Rust, `hello` world) with plugin-host/scripts/build-plugin.ts (cargo + jco), timing it
//   - runs `zhw precompile` on every plugin.wasm (timing, sizes) -> plugin.cwasm beside it
// Usage: bun bench/prepare.ts [--skip-build]
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildPlugin } from "../../plugin-host/scripts/build-plugin";
import { scratch, zhwBin, now } from "./lib";

const T = process.env.TEMP ?? "/tmp";
export const fixturesDir = join(scratch, "fixtures");

const copies: Record<string, string> = {
	"hello-rust": join(T, "zn-wasm-fixtures", "hello-rust"),
	"hello-js": join(T, "zn-wasm-fixtures", "hello-js"),
	"ui-fixture": join(T, "zn-wasm-ui-fixture", "plugin"),
	"extend-fixture": join(T, "zn-wasm-extend-fixture-test"),
	"quick-tags": join(scratch, "samples", "quick-tags"),
	"word-count": join(scratch, "samples", "word-count"),
	"highlight-export": join(scratch, "samples", "highlight-export"),
};

async function dirSize(dir: string): Promise<number> {
	let n = 0;
	for (const e of await readdir(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		n += e.isDirectory() ? await dirSize(p) : (await stat(p)).size;
	}
	return n;
}

const report: Record<string, any> = {};
await mkdir(fixturesDir, { recursive: true });

for (const [name, src] of Object.entries(copies)) {
	if (!existsSync(join(src, "plugin.wasm"))) {
		report[name] = { missing: src };
		console.log(`missing: ${name} (${src})`);
		continue;
	}
	const dst = join(fixturesDir, name);
	if (!existsSync(join(dst, "plugin.wasm"))) {
		// manifest + wasm always; transpiled/ only when it exists (the Bun baseline needs it)
		await mkdir(dst, { recursive: true });
		await cp(join(src, "manifest.json"), join(dst, "manifest.json"));
		await cp(join(src, "plugin.wasm"), join(dst, "plugin.wasm"));
		if (existsSync(join(src, "transpiled"))) await cp(join(src, "transpiled"), join(dst, "transpiled"), { recursive: true });
	}
}

if (!process.argv.includes("--skip-build") && !existsSync(join(fixturesDir, "bench-guest", "plugin.wasm"))) {
	const t = now();
	const r = await buildPlugin({ dir: join(scratch, "benchguest"), out: join(fixturesDir, "bench-guest"), log: (l) => console.log("  " + l.split("\n")[0]) });
	report["bench-guest"] = { buildMs: now() - t, asyncImports: r.asyncImports, asyncExports: r.asyncExports };
	console.log(`bench-guest built in ${((now() - t) / 1000).toFixed(1)} s`);
}

console.log("\nprecompile:");
for (const name of await readdir(fixturesDir)) {
	const dir = join(fixturesDir, name);
	if (!existsSync(join(dir, "plugin.wasm"))) continue;
	const out: string[] = [];
	for (let i = 0; i < 3; i++) {
		const p = Bun.spawn([zhwBin, "precompile", join(dir, "plugin.wasm"), join(dir, "plugin.cwasm")], { stdout: "pipe", stderr: "pipe" });
		const text = await new Response(p.stdout).text();
		if ((await p.exited) !== 0) throw new Error(`precompile ${name}: ${await new Response(p.stderr).text()}`);
		out.push(text);
	}
	const runs = out.map((o) => JSON.parse(o));
	const ms = runs.map((r) => r.precompileMs).sort((a, b) => a - b);
	const transpiled = existsSync(join(dir, "transpiled")) ? await dirSize(join(dir, "transpiled")) : undefined;
	report[name] = { ...(report[name] ?? {}), wasmBytes: runs[0].wasmBytes, cwasmBytes: runs[0].cwasmBytes, precompileMs: { min: ms[0], median: ms[1], max: ms[2] }, transpiledBytes: transpiled };
	console.log(`  ${name.padEnd(18)} wasm ${(runs[0].wasmBytes / 1e6).toFixed(2)} MB  cwasm ${(runs[0].cwasmBytes / 1e6).toFixed(2)} MB  precompile ${ms[1].toFixed(0)} ms (min ${ms[0].toFixed(0)}, max ${ms[2].toFixed(0)})  transpiled ${transpiled ? (transpiled / 1e6).toFixed(1) + " MB" : "-"}`);
}
await Bun.write(join(scratch, "prepare.json"), JSON.stringify(report, null, 2));
