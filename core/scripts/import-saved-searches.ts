// Copies Zotero's saved searches into a zotero-next library (table saved_searches).
//   bun core/scripts/import-saved-searches.ts --zotero C:/Users/abora/Zotero --db <library.sqlite> [--apply]
// Zotero's DB is only ever read from a snapshot copy (zotero.sqlite + -wal + -shm in a temp dir).
// Without --apply it prints what would be imported (dry run); with --apply it adds the searches to
// --db (searches with an existing name are skipped, so it is safe to re-run).
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb } from "../src/db";
import { createSavedSearch, listSavedSearches } from "../src/searches/store";
import { readZoteroSavedSearches, type ZoteroSavedSearch } from "../src/searches/zotero-import";

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

const zoteroDir = arg("zotero");
const dbPath = arg("db");
const apply = process.argv.includes("--apply");
if (!zoteroDir || !dbPath) {
	console.error("usage: bun core/scripts/import-saved-searches.ts --zotero <zotero data dir> --db <library.sqlite> [--apply]");
	process.exit(2);
}

const src = join(resolve(zoteroDir), "zotero.sqlite");
if (!existsSync(src)) {
	console.error(`zotero.sqlite not found in ${zoteroDir}`);
	process.exit(1);
}
const tmp = mkdtempSync(join(tmpdir(), "zn-savedsearches-"));
let found: ZoteroSavedSearch[] = [];
try {
	for (const ext of ["", "-wal", "-shm"]) {
		if (existsSync(src + ext)) copyFileSync(src + ext, join(tmp, `zotero.sqlite${ext}`));
	}
	const snap = new Database(join(tmp, "zotero.sqlite"), { readonly: true });
	try {
		found = readZoteroSavedSearches(snap);
	} finally {
		snap.close(true);
	}
} finally {
	rmSync(tmp, { recursive: true, force: true });
}

console.log(`${found.length} saved search(es) in Zotero:`);
for (const s of found) {
	console.log(`  ${s.name}: ${s.conditions.length} condition(s), match ${s.options.match}`);
	for (const k of s.skipped) console.log(`      skipped ${k}`);
}

if (apply) {
	const target = resolve(dbPath);
	if (!existsSync(target)) {
		console.error(`library database not found: ${target}`);
		process.exit(1);
	}
	const db = openDb(target);
	try {
		const have = new Set(listSavedSearches(db).map((s) => s.name.toLowerCase()));
		let added = 0;
		for (const s of found) {
			if (have.has(s.name.toLowerCase())) {
				console.log(`  exists, skipped: ${s.name}`);
				continue;
			}
			if (s.conditions.length === 0) {
				console.log(`  no convertible conditions, skipped: ${s.name}`);
				continue;
			}
			createSavedSearch(db, { name: s.name, conditions: s.conditions, options: s.options });
			added++;
		}
		console.log(`imported ${added} saved search(es) into ${target}`);
	} finally {
		db.close(true);
	}
} else {
	console.log("dry run: pass --apply to write into --db");
}
