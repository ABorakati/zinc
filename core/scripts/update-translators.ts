// Refreshes the Zotero translators the app uses.
//   bun core/scripts/update-translators.ts [--data <data dir>] [--from <folder | tarball URL>]
// Writes <data dir>/translators (default data dir: $ZN_DATA_DIR, else <repo>/data). The app prefers that folder over
// the translators vendored in core/vendor/zotero/translators. Downloads the zotero/translators tarball from GitHub
// unless --from names a local folder of translator .js files or another tarball URL. Never touches library.sqlite.
import { join, resolve } from "node:path";
import { DEFAULT_SOURCE, updateTranslators } from "../src/translate/update";

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

const dataDir = resolve(arg("--data") ?? process.env.ZN_DATA_DIR ?? join(import.meta.dir, "..", "..", "data"));
const source = arg("--from") ?? DEFAULT_SOURCE;
console.log(`Updating translators in ${join(dataDir, "translators")} from ${source}`);
try {
	const r = await updateTranslators({ dataDir, source });
	console.log(`Done: ${r.count} translators${r.commit ? ` (zotero/translators ${r.commit})` : ""}.`);
} catch (e) {
	console.error(`Update failed: ${e instanceof Error ? e.message : e}`);
	process.exit(1);
}
