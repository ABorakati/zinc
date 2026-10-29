// Rebuild the FTS5 search index of a library database.
// Usage: bun core/scripts/reindex.ts [path/to/library.sqlite]
import { openDb } from "../src/db";
import { rebuildSearchIndex, search } from "../src/search";

const path = process.argv[2] ?? "C:/Users/abora/zotero-next/data/library.sqlite";
const db = openDb(path);
let t = performance.now();
rebuildSearchIndex(db);
console.log(`indexed in ${Math.round(performance.now() - t)} ms`);
for (const q of ["liver transplant", "machine perfusion", "TRIPOD"]) {
	t = performance.now();
	const r = search(db, q, { limit: 3 });
	console.log(`"${q}": ${r.total} hits in ${(performance.now() - t).toFixed(1)} ms; top: ${r.hits[0]?.title ?? "-"}`);
}
db.close(true);
