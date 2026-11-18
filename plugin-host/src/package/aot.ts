// AOT step: transpiled/ (jco output) -> aot/plugin.exe, an executable that runs ONE plugin with its JS and its core WebAssembly modules
// compiled to machine code at install time (Bun canary `compile.aot`). Experimental and optional: see docs/developer-guide/wasm-plugins/phase2-aot.md.
//
// An AOT executable has no JIT and cannot load code at run time (anything built at run time is interpreted), so a plugin cannot be
// loaded into a shared AOT host. Each plugin becomes its own executable, run by the plugin host as a child process (worker.ts,
// `runner: "aot-process"`). The build runs under the canary Bun in a child process; the caller's Bun is not touched.
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { TRANSPILED_ENTRY } from "../manifest";
import { AOT_EXE } from "./aot-layout";

export { AOT_EXE };

/** SHA-256 of a file, streamed (an executable is 90 to 330 MB). */
export async function hashFile(path: string): Promise<string> {
	const h = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(path).stream()) h.update(chunk);
	return h.digest("hex");
}

const srcDir = resolve(import.meta.dir, "..");
const posix = (p: string) => p.replace(/\\/g, "/");

export interface AotResult {
	exe: string;
	bytes: number;
	ms: number;
	wasmModules: number;
}

/** The canary Bun: ZN_BUN_CANARY, or gpui-ui/scripts/_bun-canary.ts (the local Windows canary, else the pinned npm one). */
export async function findCanary(): Promise<string> {
	if (process.env.ZN_BUN_CANARY) return process.env.ZN_BUN_CANARY;
	const mod = (await import(posix(resolve(srcDir, "..", "..", "gpui-ui", "scripts", "_bun-canary.ts")))) as { canaryBun(): Promise<string> };
	return mod.canaryBun();
}

/** The entry source for one plugin: the template with absolute paths of the runtime, the glue and the core modules filled in. */
export async function aotEntrySource(pkgDir: string): Promise<{ source: string; wasmModules: number }> {
	const transpiled = join(pkgDir, "transpiled");
	const wasms = (await readdir(transpiled)).filter((f) => f.endsWith(".wasm")).sort();
	const tpl = await Bun.file(join(import.meta.dir, "aot-entry.template.ts")).text();
	const source = tpl
		.replace("__RUNTIME__", posix(join(srcDir, "plugin-runtime.ts")))
		.replace("__GLUE__", posix(join(pkgDir, TRANSPILED_ENTRY)))
		.replace("//__WASM_IMPORTS__", wasms.map((f, i) => `import w${i} from "${posix(join(transpiled, f))}";`).join("\n"))
		.replace("//__WASM_TABLE__", wasms.map((f, i) => `\t"${f}": w${i},`).join("\n"));
	return { source, wasmModules: wasms.length };
}

/** Build `<pkgDir>/aot/plugin.exe` from `<pkgDir>/transpiled/`. Throws with the canary's output when it fails; leaves nothing half-written. */
export async function buildAot(pkgDir: string, o: { log?: (l: string) => void; explain?: boolean } = {}): Promise<AotResult> {
	const log = o.log ?? (() => {});
	const t0 = Date.now();
	const canary = await findCanary();
	const scratch = join(process.env.TEMP ?? process.env.TMPDIR ?? "/tmp", `zn-wasm-aot-${process.pid}-${Date.now()}`);
	await mkdir(scratch, { recursive: true });
	const exe = join(pkgDir, AOT_EXE);
	const part = `${exe}.part${process.platform === "win32" ? ".exe" : ""}`;
	try {
		const { source, wasmModules } = await aotEntrySource(pkgDir);
		const entry = join(scratch, "entry.ts");
		await Bun.write(entry, source);
		await mkdir(join(pkgDir, "aot"), { recursive: true });
		await rm(part, { force: true });
		log(`aot: ${canary} (${wasmModules} wasm modules)`);
		const p = Bun.spawn([canary, join(import.meta.dir, "aot-compile.ts"), entry, part, ...(o.explain ? ["--explain"] : [])], { cwd: scratch, stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_BE_BUN: "1" } });
		const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
		if (code !== 0) throw new Error(`AOT build failed (${code}):\n${(err || out).slice(0, 2000)}`);
		if (o.explain) log(out + err);
		await rm(exe, { force: true });
		await rename(part, exe);
		return { exe, bytes: (await stat(exe)).size, ms: Date.now() - t0, wasmModules };
	} catch (e) {
		await rm(part, { force: true });
		await rm(join(pkgDir, "aot"), { recursive: true, force: true }).catch(() => {});
		throw e;
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}
