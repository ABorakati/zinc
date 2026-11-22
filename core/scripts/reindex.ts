// Rebuild the FTS5 search index of a library database.
// Usage: bun core/scripts/reindex.ts <path/to/library.sqlite>   (the path is required: this writes to the library it is given)
import { openDb } from "../src/db";
import { rebuildSearchIndex, search } from "../src/search";

const path = process.argv[2];
if (!path) {
	console.error("usage: bun core/scripts/reindex.ts <path/to/library.sqlite>");
	process.exit(2);
}
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
