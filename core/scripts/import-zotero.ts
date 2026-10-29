// Usage: bun core/scripts/import-zotero.ts --zotero C:/Users/abora/Zotero --out data/library.sqlite [--replace]
import { dirname, join } from "node:path";
import { importZotero } from "../src/import/zotero";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
};

const zoteroDir = opt("zotero");
const out = opt("out");
if (!zoteroDir || !out) {
	console.error("usage: bun core/scripts/import-zotero.ts --zotero <zotero data dir> --out <library.sqlite> [--replace]");
	process.exit(2);
}

const schemaPath = join(dirname(import.meta.dir), "schema.sql");
let last = "";
const report = await importZotero({
	zoteroDir,
	targetDbPath: out,
	schemaPath,
	replace: args.includes("--replace"),
	onProgress: (p) => {
		const line = p.message ?? `${p.phase}${p.done !== undefined ? ` ${p.done}/${p.total ?? "?"}` : ""}`;
		if (line !== last) console.log(`[import] ${line}`);
		last = line;
	},
});
console.log(JSON.stringify(report, null, 2));
