#!/usr/bin/env bun
// bun scripts/build-plugin.ts <plugin dir> [--out <dir>] [--world <name>] [--js <file>]
//
// Builds a plugin into a loadable folder (see src/manifest.ts):
//   Rust guest  (<dir>/Cargo.toml): cargo build --release --target wasm32-wasip2; the .wasm is found through `cargo metadata`.
//   JS guest    (<dir>/plugin.js or src/index.js, or --js): componentize-qjs against plugin-api/wit (or <dir>/wit), --sync --opt-size.
// then `jco transpile` with JSPI, async imports for every zinc:plugin import and async exports for every export, both derived
// from the WIT files and the component's own world. Output: <out>/manifest.json, <out>/plugin.wasm, <out>/transpiled/.
//
// If <dir>/wit/ exists it is the guest's own WIT package (a world that uses zinc:plugin); a fresh copy of plugin-api/wit is put in
// <dir>/wit/deps/zinc-plugin/ first (git-ignored), which is what wit-bindgen and componentize-qjs both read.
import { transpile, componentWit } from "@bytecodealliance/jco";
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { TRANSPILED_ENTRY, type PluginManifest } from "../src/manifest";
import { asyncLists, readInterfaceFunctions, worldInterfaces } from "../src/wit";

const root = resolve(import.meta.dir, "..");
const apiWit = resolve(root, "..", "plugin-api", "wit");
const exists = (p: string) => stat(p).then(() => true, () => false);

export interface BuildOptions {
	dir: string;
	out?: string;
	world?: string;
	js?: string;
	log?: (line: string) => void;
}

export interface BuildResult {
	out: string;
	manifest: PluginManifest;
	asyncImports: number;
	asyncExports: number;
}

async function run(cmd: string[], cwd: string, log: (l: string) => void): Promise<string> {
	const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	if (code !== 0) throw new Error(`${cmd.join(" ")} failed (${code}):\n${err || out}`);
	if (err.trim()) log(err.trim());
	return out;
}

async function buildRust(dir: string, log: (l: string) => void): Promise<Uint8Array> {
	log(`cargo build --release --target wasm32-wasip2 (${dir})`);
	await run(["cargo", "build", "--release", "--target", "wasm32-wasip2"], dir, log);
	const meta = JSON.parse(await run(["cargo", "metadata", "--format-version", "1", "--no-deps"], dir, log));
	const pkg = meta.packages[0];
	const lib = pkg.targets.find((t: { crate_types: string[] }) => t.crate_types.includes("cdylib")) ?? pkg.targets[0];
	const file = join(meta.target_directory, "wasm32-wasip2", "release", `${String(lib.name).replace(/-/g, "_")}.wasm`);
	return new Uint8Array(await Bun.file(file).arrayBuffer());
}

async function buildJs(dir: string, entry: string, witDir: string, world: string, scratch: string, log: (l: string) => void) {
	const bin = join(root, "node_modules", ".bin", process.platform === "win32" ? "componentize-qjs.exe" : "componentize-qjs");
	const outFile = join(scratch, "plugin.wasm");
	log(`componentize-qjs ${entry} (world ${world})`);
	// --sync: no component-model async ABI (jco's JSPI mode does the suspending). --stub-wasi: the component has no WASI imports at all.
	await run([bin, "--wit", witDir, "--js", entry, "--world", world, "--sync", "--opt-size", "--stub-wasi", "-o", outFile], dir, log);
	return new Uint8Array(await Bun.file(outFile).arrayBuffer());
}

export async function buildPlugin(o: BuildOptions): Promise<BuildResult> {
	const log = o.log ?? (() => {});
	const dir = resolve(o.dir);
	const out = resolve(o.out ?? join(dir, "dist"));
	const manifest = (await Bun.file(join(dir, "manifest.json")).json()) as PluginManifest;
	const ownWit = join(dir, "wit");
	if (await exists(ownWit)) {
		await rm(join(ownWit, "deps", "zinc-plugin"), { recursive: true, force: true });
		await mkdir(join(ownWit, "deps", "zinc-plugin"), { recursive: true });
		for (const f of (await readdir(apiWit)).filter((f) => f.endsWith(".wit"))) await cp(join(apiWit, f), join(ownWit, "deps", "zinc-plugin", f));
	}
	const scratch = join(process.env.TEMP ?? process.env.TMPDIR ?? "/tmp", `zn-wasm-build-${basename(dir)}-${process.pid}`);
	await mkdir(scratch, { recursive: true });
	let component: Uint8Array;
	let language: string;
	try {
		if (await exists(join(dir, "Cargo.toml"))) {
			language = "rust";
			component = await buildRust(dir, log);
		} else {
			language = "js";
			const entry = o.js ? resolve(o.js) : [join(dir, "plugin.js"), join(dir, "src", "index.js")].find((f) => Bun.file(f).size > 0);
			if (!entry) throw new Error(`no Cargo.toml and no plugin.js or src/index.js in ${dir}`);
			const world = o.world ?? manifest.main.world ?? "plugin";
			component = await buildJs(dir, entry, (await exists(ownWit)) ? ownWit : apiWit, world, scratch, log);
		}
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}

	const lists = asyncLists(await readInterfaceFunctions(apiWit), worldInterfaces(await componentWit(component)));
	log(`jco transpile: ${lists.asyncImports.length} async imports, ${lists.asyncExports.length} async exports`);
	const result = await transpile(component, {
		name: "plugin",
		instantiation: "async",
		asyncMode: "jspi",
		asyncImports: lists.asyncImports,
		asyncExports: lists.asyncExports,
		noTypescript: true,
		quiet: true,
		// 5x smaller (a UI plugin: 199 MB -> 39 MB of JS) and 2x faster to import; does not change the first-call compile time (phase2-integrate.md)
		minify: true,
	});

	await rm(out, { recursive: true, force: true });
	await mkdir(join(out, "transpiled"), { recursive: true });
	for (const [name, bytes] of Object.entries(result.files)) await Bun.write(join(out, "transpiled", name), bytes);
	await Bun.write(join(out, "plugin.wasm"), component);
	for (const extra of ["locale", "icons", "assets"]) if (await exists(join(dir, extra))) await cp(join(dir, extra), join(out, extra), { recursive: true });

	const sha256 = new Bun.CryptoHasher("sha256").update(component).digest("hex");
	const built: PluginManifest = { ...manifest, main: { ...manifest.main, wasm: "plugin.wasm", language, sha256 } };
	await Bun.write(join(out, "manifest.json"), JSON.stringify(built, null, "\t") + "\n");
	if (!(await exists(join(out, TRANSPILED_ENTRY)))) throw new Error(`jco produced no ${TRANSPILED_ENTRY}`);
	return { out, manifest: built, asyncImports: lists.asyncImports.length, asyncExports: lists.asyncExports.length };
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const take = (flag: string) => {
		const i = args.indexOf(flag);
		return i >= 0 ? args.splice(i, 2)[1] : undefined;
	};
	const out = take("--out");
	const world = take("--world");
	const js = take("--js");
	const dir = args[0];
	if (!dir) {
		console.error("usage: bun scripts/build-plugin.ts <plugin dir> [--out <dir>] [--world <name>] [--js <file>]");
		process.exit(2);
	}
	const r = await buildPlugin({ dir, out, world, js, log: (l) => console.error(l) });
	console.log(`built ${r.manifest.id} ${r.manifest.version} -> ${r.out}`);
}
