// Time of the Bun path's build step (jco transpile with the options of plugin-host/scripts/build-plugin.ts, output kept in memory)
// against the Wasmtime path's (`zhw precompile`), on each plugin.wasm under the fixtures folder. Usage: bun bench/transpile-time.ts
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { asyncLists, readInterfaceFunctions, worldInterfaces } from "../../plugin-host/src/wit";
import { scratch, zhwBin, now } from "./lib";

const { transpile, componentWit } = (await import(Bun.resolveSync("@bytecodealliance/jco", join(import.meta.dir, "..", "..", "plugin-host")))) as typeof import("../../plugin-host/node_modules/@bytecodealliance/jco");
const apiWit = resolve(import.meta.dir, "..", "..", "plugin-api", "wit");
const fixtures = join(scratch, "fixtures");
for (const name of readdirSync(fixtures)) {
	const wasm = join(fixtures, name, "plugin.wasm");
	if (!existsSync(wasm)) continue;
	const component = new Uint8Array(await Bun.file(wasm).arrayBuffer());
	const lists = asyncLists(await readInterfaceFunctions(apiWit), worldInterfaces(await componentWit(component)));
	const t = now();
	const r = await transpile(component, { name: "plugin", instantiation: "async", asyncMode: "jspi", asyncImports: lists.asyncImports, asyncExports: lists.asyncExports, noTypescript: true, quiet: true, minify: true });
	const jcoMs = now() - t;
	const bytes = Object.values(r.files).reduce((a, f) => a + (f as Uint8Array).length, 0);
	const p = Bun.spawn([zhwBin, "precompile", wasm, join(scratch, "tmp.cwasm")], { stdout: "pipe" });
	const j = JSON.parse(await new Response(p.stdout).text());
	console.log(`${name.padEnd(16)} wasm ${(component.length / 1e6).toFixed(2)} MB | jco transpile ${(jcoMs / 1000).toFixed(1)} s -> ${(bytes / 1e6).toFixed(1)} MB JS+wasm | precompile ${(j.precompileMs / 1000).toFixed(2)} s -> ${(j.cwasmBytes / 1e6).toFixed(1)} MB cwasm`);
}
process.exit(0);
