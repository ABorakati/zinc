// Copies Zotero's coloured tags into a zotero-next library (meta 'tagColors').
//   bun core/scripts/import-tag-colors.ts --zotero C:/Users/abora/Zotero --db <library.sqlite> [--apply]
// Zotero's DB is only ever read from a snapshot copy (zotero.sqlite + -wal + -shm in a temp dir).
// Without --apply it prints the colours (dry run); with --apply it writes only meta 'tagColors'.
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readZoteroTagColors } from "../src/import/zotero";

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

const zoteroDir = arg("zotero");
const dbPath = arg("db");
const apply = process.argv.includes("--apply");
if (!zoteroDir || !dbPath) {
	console.error("usage: bun core/scripts/import-tag-colors.ts --zotero <zotero data dir> --db <library.sqlite> [--apply]");
	process.exit(2);
}

const src = join(resolve(zoteroDir), "zotero.sqlite");
if (!existsSync(src)) {
	console.error(`zotero.sqlite not found in ${zoteroDir}`);
	process.exit(1);
}
const tmp = mkdtempSync(join(tmpdir(), "zn-tagcolors-"));
let colors: ReturnType<typeof readZoteroTagColors> = [];
try {
	for (const ext of ["", "-wal", "-shm"]) {
		if (existsSync(src + ext)) copyFileSync(src + ext, join(tmp, `zotero.sqlite${ext}`));
	}
	const snap = new Database(join(tmp, "zotero.sqlite"));
	try {
		colors = readZoteroTagColors(snap);
	} finally {
		snap.close(true);
	}
} finally {
	rmSync(tmp, { recursive: true, force: true });
}

console.log(`${colors.length} coloured tag(s) in Zotero:`);
for (const c of colors) console.log(`  ${String(c.position + 1).padStart(2)}  ${c.color}  ${c.name}`);

if (apply) {
	const target = resolve(dbPath);
	if (!existsSync(target)) {
		console.error(`target db not found: ${target}`);
		process.exit(1);
	}
	const db = new Database(target);
	try {
		db.query("INSERT INTO meta(name, value) VALUES('tagColors', ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").run(
			JSON.stringify(colors),
		);
	} finally {
		db.close(true);
	}
	console.log(`wrote meta 'tagColors' to ${target}`);
} else {
	console.log("dry run (pass --apply to write)");
}
