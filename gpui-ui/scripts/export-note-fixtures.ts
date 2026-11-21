// Write the ProseMirror JSON of every synthetic note in src/notes/native/fixtures/*.html (parsed with Zotero's own schema, citation
// display text left out, citation / image node ids renumbered so the output is deterministic) as pretty-printed JSON, one file per
// note with the same basename. The GPUIX fork's richtext-core tests read them.
//   bun scripts/export-note-fixtures.ts <gpuix>/packages/richtext-core/tests/fixtures
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadNoteParser } from "../src/notes/native/parse";
import { stableDoc } from "../src/notes/native/serialize";

const src = new URL("../src/notes/native/fixtures/", import.meta.url);
const out = process.argv[2];
if (!out) throw new Error("usage: bun scripts/export-note-fixtures.ts <gpuix>/packages/richtext-core/tests/fixtures");
const parser = (await loadNoteParser())!;
mkdirSync(out, { recursive: true });
for (const f of readdirSync(src)
	.filter((f) => f.endsWith(".html"))
	.sort()) {
	const doc = stableDoc(parser.parse(readFileSync(new URL(f, src), "utf8")));
	writeFileSync(join(out, f.replace(/\.html$/, ".json")), JSON.stringify(doc, null, 2) + "\n");
	console.log("wrote", f.replace(/\.html$/, ".json"));
}
