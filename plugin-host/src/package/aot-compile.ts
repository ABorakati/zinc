// Run under the Bun CANARY (stable Bun has no `compile.aot`): bun aot-compile.ts <entry.ts> <outfile> [--explain]
// Compiles one plugin's entry (plugin-runtime + jco glue + core .wasm files, all static) into an executable with machine code for the
// JS and for every imported .wasm. Started by aot.ts; see phase2-aot.md.
const [entry, outfile] = process.argv.slice(2);
if (!entry || !outfile) throw new Error("usage: bun aot-compile.ts <entry.ts> <outfile>");
const target = `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const t0 = performance.now();
const r = await Bun.build({
	entrypoints: [entry],
	target: "bun",
	compile: {
		target,
		outfile,
		aot: true,
		autoloadBunfig: false,
		autoloadDotenv: false,
		autoloadTsconfig: false,
		autoloadPackageJson: false,
		...(process.argv.includes("--explain") ? { aotExplain: ["text"] } : {}),
	} as never,
});
for (const l of r.logs) console.error(String((l as { message?: string }).message ?? l));
if (!r.success) process.exit(1);
console.log(`aot ${((performance.now() - t0) / 1000).toFixed(1)} s`);
export {};
