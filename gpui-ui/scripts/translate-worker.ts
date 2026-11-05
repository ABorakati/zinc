// Pre-bundles the Zotero translation worker (core/src/translate/worker.ts) into ONE js file for the packaged app:
//   bun scripts/translate-worker.ts <outfile>
// The worker cannot ride inside the exe like the rest of the core: jsdom, wicked-good-xpath and w3c-xmlserializer are loaded through
// createRequire() in runtime/dom.ts (invisible to the bundler), and the Zotero framework + translators are read from disk. So the
// bundle is built here (target bun) and shipped next to the exe as translate-worker.js; package.ts also ships vendor/zotero, and
// src/packaged.ts points the core at both (ZN_TRANSLATE_WORKER, ZN_ZOTERO_VENDOR).
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const core = resolve(here, "..", "..", "core");
const outfile = resolve(process.argv[2] ?? join(here, "..", "out", "translate-worker.js"));

const domPath = join(core, "src", "translate", "runtime", "dom.ts");
const result = await Bun.build({
	entrypoints: [join(core, "src", "translate", "worker.ts")],
	target: "bun",
	format: "esm",
	minify: false,
	sourcemap: "none",
	// optional native peer of jsdom (try { require("canvas") }): leave it out, jsdom then runs without canvas support
	external: ["canvas"],
	plugins: [{
		name: "translate-dom-static-require",
		setup(build) {
			build.onLoad({ filter: /dom\.ts$/ }, async ({ path }) => {
				if (resolve(path) !== domPath) return undefined;
				// req("jsdom") is a createRequire() call the bundler cannot see: make the three requires static
				const src = (await Bun.file(path).text()).replace(/\breq\(("jsdom"|"wicked-good-xpath"|"w3c-xmlserializer")\)/g, "require($1)");
				return { contents: src, loader: "ts" };
			});
		},
	}],
});
if (!result.success) {
	for (const m of result.logs) console.error(m);
	throw new Error("translate worker bundle failed");
}
const [out] = result.outputs;
await Bun.write(outfile, out);
console.log(`translate worker: ${outfile} (${(out.size / 1048576).toFixed(1)} MB)`);
