#!/usr/bin/env bun
// bun plugin-api/sdk/js/scripts/build.ts <plugin dir> [--out <dir>] [--entry <file>]
//
// Builds a JS (QuickJS) plugin: bundles the entry (default <dir>/src/main.js, then src/index.js|ts, plugin.js) and everything it
// imports from the SDK into one ES module (componentize-qjs resolves only what is under the entry's folder, so the SDK has to be
// inlined; the `zinc:plugin/*` imports stay as they are), then hands it to plugin-host/scripts/build-plugin.ts, which runs
// componentize-qjs and jco and writes <out>/{manifest.json,plugin.wasm,transpiled/}. Default <out>: <dir>/dist.
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildPlugin } from "../../../../plugin-host/scripts/build-plugin";

const sdk = resolve(import.meta.dir, "..");

export async function buildJsPlugin(o: { dir: string; out?: string; entry?: string; log?: (l: string) => void }) {
	const dir = resolve(o.dir);
	const log = o.log ?? (() => {});
	if (!(await Bun.file(join(sdk, "src", "generated", "exports.ts")).exists())) {
		log("generating SDK types");
		const p = Bun.spawn(["bun", join(sdk, "scripts", "gen-types.ts")], { stdout: "pipe", stderr: "pipe" });
		if ((await p.exited) !== 0) throw new Error("gen-types failed: " + (await new Response(p.stderr).text()));
	}
	const candidates = [o.entry, join(dir, "src", "main.js"), join(dir, "src", "main.ts"), join(dir, "src", "index.js"), join(dir, "src", "index.ts"), join(dir, "plugin.js")];
	let entry: string | undefined;
	for (const c of candidates) if (c && (await Bun.file(resolve(c)).exists())) { entry = resolve(c); break; }
	if (!entry) throw new Error(`no entry (src/main.js, src/index.js, plugin.js) in ${dir}`);

	const scratch = join(process.env.TEMP ?? process.env.TMPDIR ?? "/tmp", `zn-wasm-jsbundle-${process.pid}-${Date.now()}`);
	await mkdir(scratch, { recursive: true });
	try {
		const r = await Bun.build({ entrypoints: [entry], outdir: scratch, naming: "plugin.js", format: "esm", target: "browser", external: ["zinc:*"], minify: false });
		if (!r.success) throw new Error("bundle failed:\n" + r.logs.map(String).join("\n"));
		const bundledPath = join(scratch, "plugin.js");
		// Globals QuickJS lacks (Date.now()/new Date()/performance.now() trap without a clock; no console, setTimeout, TextEncoder): see src/prelude.js.
		const prelude = (await Bun.file(join(sdk, "src", "prelude.js")).text()).replace(/^export /gm, "");
		const bundledCode = await Bun.file(bundledPath).text();
		await Bun.write(bundledPath, `import __zp_timers from "zinc:plugin/timers@0.1.0";\nimport __zp_log from "zinc:plugin/log@0.1.0";\n${prelude}\ninstallPrelude(globalThis, { timers: __zp_timers, log: __zp_log });\n${bundledCode}`);
		const code = await Bun.file(bundledPath).text();
		if (code.includes("__zincOpenDialog")) {
			await Bun.write(bundledPath, `import __sdk_zui from "zinc:plugin/ui@0.1.0";\nglobalThis.__zincOpenDialog = __sdk_zui.openDialog;\n${code}`);
		}
		// Worlds with `mcp-handler` need that export. A plugin written before it (it exports everything but mcpHandler) gets the default:
		// no tools, every call answers not-found.
		const world = (JSON.parse(await Bun.file(join(dir, "manifest.json")).text()) as { main?: { world?: string } }).main?.world ?? "plugin";
		if (["plugin", "plugin-mcp"].includes(world) && !/export[^{};]*[{][^}]*mcpHandler[^}]*[}]/.test(await Bun.file(bundledPath).text())) {
			const cur = await Bun.file(bundledPath).text();
			await Bun.write(bundledPath, cur + `
export const mcpHandler = { onMcpCall(tool) { throw { tag: "not-found", val: "no tool named " + tool }; } };
`);
		}
		log(`bundled ${entry}`);
		return await buildPlugin({ dir, out: o.out, js: bundledPath, log });
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const take = (flag: string) => {
		const i = args.indexOf(flag);
		return i >= 0 ? args.splice(i, 2)[1] : undefined;
	};
	const out = take("--out");
	const entry = take("--entry");
	const dir = args[0];
	if (!dir) {
		console.error("usage: bun scripts/build.ts <plugin dir> [--out <dir>] [--entry <file>]");
		process.exit(2);
	}
	const r = await buildJsPlugin({ dir, out, entry, log: (l) => console.error(l) });
	console.log(`built ${r.manifest.id} ${r.manifest.version} -> ${r.out}`);
}
