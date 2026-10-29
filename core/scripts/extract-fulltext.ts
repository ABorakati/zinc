// Backfill full text for attachments that have none.
// Usage: bun core/scripts/extract-fulltext.ts --db <path> [--limit N] [--concurrency 2] [--force] [--timeout 60]
import { parseArgs } from "node:util";
import { openDb } from "../src/db";
import { configureExtractPool, ExtractError, extractFulltext, shutdownExtractPool } from "../src/extract";

const { values } = parseArgs({
	options: {
		db: { type: "string" },
		limit: { type: "string" },
		concurrency: { type: "string", default: "2" },
		timeout: { type: "string", default: "60" },
		force: { type: "boolean", default: false },
	},
});
if (!values.db) {
	console.error("usage: bun core/scripts/extract-fulltext.ts --db <path> [--limit N] [--concurrency 2] [--timeout 60] [--force]");
	process.exit(2);
}

const concurrency = Math.max(1, Number(values.concurrency) || 2);
configureExtractPool({ concurrency, timeoutMs: (Number(values.timeout) || 60) * 1000 });

const db = openDb(values.db);
const limit = values.limit ? Number(values.limit) : undefined;
const rows = db
	.query(
		`SELECT a.item_key AS key FROM attachments a JOIN items i ON i.key = a.item_key
		 WHERE i.deleted = 0 AND a.path IS NOT NULL
		   AND (lower(a.content_type) LIKE 'application/pdf%' OR lower(a.content_type) LIKE 'text/html%'
		        OR lower(a.content_type) LIKE 'application/xhtml+xml%'
		        OR (a.content_type IS NULL AND lower(a.path) LIKE '%.pdf'))
		   ${values.force ? "" : "AND NOT EXISTS (SELECT 1 FROM fulltext f WHERE f.attachment_key = a.item_key)"}
		 ORDER BY i.date_added DESC, a.item_key ${limit ? `LIMIT ${Math.trunc(limit)}` : ""}`,
	)
	.all() as { key: string }[];

console.log(`${rows.length} attachments to process (concurrency ${concurrency}${values.force ? ", force" : ""})`);

const stats = { done: 0, empty: 0, chars: 0, pages: 0, failed: 0 };
const skipped: Record<string, number> = {};
const failures: Record<string, number> = {};
const failExamples: string[] = [];
const t0 = performance.now();
let next = 0;
let finished = 0;

async function worker(): Promise<void> {
	while (next < rows.length) {
		const { key } = rows[next++];
		const start = performance.now();
		let note = "";
		try {
			const r = await extractFulltext(db, key, { force: values.force });
			if (r.skipped) {
				skipped[r.skipped] = (skipped[r.skipped] ?? 0) + 1;
				note = `skip ${r.skipped}`;
			} else {
				stats.done++;
				stats.chars += r.chars;
				stats.pages += r.pages ?? 0;
				if (r.chars === 0) stats.empty++;
				note = `${r.chars} chars${r.pages ? `, ${r.pages} pp` : ""}`;
			}
		} catch (e) {
			stats.failed++;
			const code = e instanceof ExtractError ? e.code : "error";
			failures[code] = (failures[code] ?? 0) + 1;
			const msg = e instanceof Error ? e.message : String(e);
			if (failExamples.length < 5) failExamples.push(`${key} [${code}] ${msg.slice(0, 120)}`);
			note = `FAIL ${code}`;
		}
		finished++;
		const secs = ((performance.now() - start) / 1000).toFixed(1);
		console.log(`[${finished}/${rows.length}] ${key} ${note} (${secs}s)`);
	}
}

await Promise.all(Array.from({ length: concurrency }, worker));

const secs = (performance.now() - t0) / 1000;
const processed = stats.done + stats.failed;
console.log("\n--- summary ---");
console.log(`extracted: ${stats.done} (${stats.empty} with no text layer), failed: ${stats.failed}`);
console.log(`skipped: ${JSON.stringify(skipped)}`);
console.log(`failures: ${JSON.stringify(failures)}`);
for (const f of failExamples) console.log(`  ${f}`);
console.log(`chars: ${stats.chars}, pages: ${stats.pages}`);
console.log(`time: ${secs.toFixed(1)}s, throughput: ${processed ? ((processed / secs) * 60).toFixed(1) : 0} files/min`);

shutdownExtractPool();
db.close(true);
process.exit(0);
