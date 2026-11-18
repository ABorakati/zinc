// The installer's build step: plugin.wasm (a component) -> transpiled/ (jco, JSPI, async imports and exports derived from the WIT).
// The same call scripts/build-plugin.ts makes, so an installed plugin has exactly the layout of a built one (src/manifest.ts).
//
// The installer ALWAYS runs this on the package's own plugin.wasm and never uses a `transpiled/` folder that came in the package:
// that folder is JavaScript that runs in the plugin host's Worker with none of WebAssembly's sandbox around it.
import { componentWit, transpile } from "@bytecodealliance/jco";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { TRANSPILED_ENTRY } from "../manifest";
import { asyncLists, readInterfaceFunctions, worldInterfaces } from "../wit";

export const DEFAULT_WIT_DIR = resolve(import.meta.dir, "..", "..", "..", "plugin-api", "wit");

export type TranspileFn = (wasm: Uint8Array, outDir: string) => Promise<void>;

export function createTranspiler(witDir: string = DEFAULT_WIT_DIR): TranspileFn {
	let lists: Promise<InterfaceLists> | undefined;
	return async (wasm, outDir) => {
		lists ??= readInterfaceFunctions(witDir).then((fns) => ({ fns }));
		const { fns } = await lists;
		const l = asyncLists(fns, worldInterfaces(await componentWit(wasm)));
		const result = await transpile(wasm, {
			name: "plugin",
			instantiation: "async",
			asyncMode: "jspi",
			asyncImports: l.asyncImports,
			asyncExports: l.asyncExports,
			noTypescript: true,
			quiet: true,
			// 5x smaller (a UI plugin: 199 MB -> 39 MB of JS) and 2x faster to import; does not change the first-call compile time (phase2-integrate.md)
			minify: true,
		});
		await rm(outDir, { recursive: true, force: true });
		await mkdir(outDir, { recursive: true });
		for (const [name, bytes] of Object.entries(result.files)) {
			const target = join(outDir, name);
			await mkdir(join(target, ".."), { recursive: true });
			await Bun.write(target, bytes);
		}
		if (!(await stat(join(outDir, "plugin.js")).then(() => true, () => false))) throw new Error(`jco produced no ${TRANSPILED_ENTRY}`);
	};
}

type InterfaceLists = { fns: Awaited<ReturnType<typeof readInterfaceFunctions>> };

/** SHA-256 over the relative names and contents of every file under `dir` (sorted). Pins the transpiled output. */
export async function hashTree(dir: string): Promise<string> {
	const h = createHash("sha256");
	const walk = async (d: string, prefix: string): Promise<void> => {
		const names = (await readdir(d, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
		for (const e of names) {
			const rel = prefix ? `${prefix}/${e.name}` : e.name;
			if (e.isDirectory()) await walk(join(d, e.name), rel);
			else {
				h.update(rel + "\0");
				h.update(new Uint8Array(await Bun.file(join(d, e.name)).arrayBuffer()));
				h.update("\0");
			}
		}
	};
	await walk(dir, "");
	return h.digest("hex");
}

export const sha256Hex = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
