#!/usr/bin/env bun
// Pack a BUILT plugin folder into <id>-<version>.zplugin (a zip: manifest.json, plugin.wasm, locale/, icons/, assets/).
// Validates the manifest against plugin-api/manifest.schema.json and the permission rules first, checks plugin.wasm against
// main.sha256, and leaves out transpiled/ and target/ (the installer ignores a shipped transpiled/ from older builds).
//
//   bun pack.ts <built dir> [--out <file or dir>]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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
	throw new Error("cannot find the Zinc root: set ZINC_ROOT or run from inside the checkout");
}
const zinc = findZinc();
const pkg: any = await import(pathToFileURL(join(zinc, "plugin-host", "src", "package", "index.ts")).href);
const { validateManifest } = await import(pathToFileURL(join(zinc, "plugin-host", "src", "package", "validate.ts")).href);

const args = process.argv.slice(2);
const oi = args.indexOf("--out");
const outArg = oi >= 0 ? args.splice(oi, 2)[1] : undefined;
const dir = args[0] ? resolve(args[0]) : undefined;
if (!dir) {
	console.error("usage: bun pack.ts <built dir> [--out <file or dir>]");
	process.exit(2);
}
const fail = (m: string): never => {
	console.error("pack: " + m);
	process.exit(1);
};
if (!existsSync(join(dir, "manifest.json"))) fail(`${dir}/manifest.json not found (build first: this packs the build output, not the source folder)`);
const manifest = await Bun.file(join(dir, "manifest.json")).json();
const issues: string[] = validateManifest(manifest);
if (issues.length) fail("manifest.json is not valid:\n  " + issues.join("\n  "));
const wasmPath = join(dir, manifest.main?.wasm ?? "plugin.wasm");
if (!existsSync(wasmPath)) fail(`${wasmPath} not found`);
const wasm = new Uint8Array(await Bun.file(wasmPath).arrayBuffer());
const sha = new Bun.CryptoHasher("sha256").update(wasm).digest("hex");
if (manifest.main?.sha256 && manifest.main.sha256 !== sha) fail("main.sha256 does not match plugin.wasm: rebuild");

const SKIP = new Set(["transpiled", "target", "node_modules", ".git", "dist"]);
const entries: { name: string; data: Uint8Array }[] = [];
const walk = (d: string) => {
	for (const f of readdirSync(d).sort()) {
		const p = join(d, f);
		if (statSync(p).isDirectory()) {
			if (!SKIP.has(f)) walk(p);
			continue;
		}
		const name = relative(dir, p).replace(/\\/g, "/");
		if (name.startsWith(".") || name.endsWith(".zplugin")) continue;
		entries.push({ name, data: new Uint8Array(readFileSync(p)) });
	}
};
walk(dir);
const total = entries.reduce((n, e) => n + e.data.length, 0);
if (total > 128 * 1024 * 1024) fail(`package is ${(total / 1048576).toFixed(0)} MiB; the installer refuses entries over 128 MiB`);

const file = `${manifest.id}-${manifest.version}.zplugin`;
let out = outArg ? resolve(outArg) : join(dir, "..", file);
if (existsSync(out) && statSync(out).isDirectory()) out = join(out, file);
const bytes: Uint8Array = pkg.writeZip(entries);
await Bun.write(out, bytes);
// read it back with the installer's own (hostile-input) zip reader
const back = pkg.readZip(bytes);
if (!back.some((f: { name: string }) => f.name === "manifest.json")) fail("written zip has no manifest.json");
console.log(`packed ${back.length} files (${(bytes.length / 1024).toFixed(0)} KiB) -> ${out}`);
for (const e of entries) console.log("  " + e.name);
