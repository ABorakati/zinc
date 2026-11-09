// Times save round trips through the host (temp library, never the real one).
//   bun test/bench.ts            (uses the compiled exe, or ZNH_DEV=1 for the sources)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../core/src/db";
import { HostClient } from "./client";

const dir = mkdtempSync(join(tmpdir(), "znh-bench-"));
const dbPath = join(dir, "library.sqlite");
openDb(dbPath).close(true);

const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
const fmt = (n: number) => n.toFixed(1).padStart(7) + " ms";
const item = (i: number) => ({
	id: `b${i}`, itemType: "journalArticle", title: `Bench article ${i}`, creators: [{ firstName: "A", lastName: "B", creatorType: "author" }],
	date: "2024", publicationTitle: "J", DOI: `10.1/bench-${i}`, url: `https://example.org/${i}`, tags: ["x"], notes: [], attachments: [], seeAlso: [],
});

const t0 = performance.now();
const c = new HostClient({ ZN_DB: dbPath });
const ping0 = await c.call("ping", { http: "GET" });
const cold = performance.now() - t0;
if (ping0.status !== 200) throw new Error("ping failed " + ping0.status);

const time = async (n: number, f: (i: number) => Promise<unknown>) => {
	const ts: number[] = [];
	for (let i = 0; i < n; i++) {
		const s = performance.now();
		await f(i);
		ts.push(performance.now() - s);
	}
	return med(ts);
};
const ping = await time(100, () => c.call("ping", { json: {} }));
const hostnames = await time(50, () => c.call("getClientHostnames", { json: {} }));
const selected = await time(30, () => c.call("getSelectedCollection", { json: {} }));
const save = await time(30, async (i) => {
	const sid = `s${i}`;
	await c.call("saveItems", { json: { sessionID: sid, uri: "https://example.org", items: [item(i)] } });
	await c.call("updateSession", { json: { sessionID: sid, target: "L1", tags: "", note: "" } });
});
const translators = await c.call("getTranslators", { json: {} });
console.log(`cold start -> first ping       ${fmt(cold)}`);
console.log(`ping (median of 100)           ${fmt(ping)}`);
console.log(`getClientHostnames (median 50) ${fmt(hostnames)}`);
console.log(`getSelectedCollection (med 30) ${fmt(selected)}`);
console.log(`saveItems+updateSession (med 30) ${fmt(save)}`);
console.log(`getTranslators: status ${translators.status}, ${translators.bytes.length} bytes`);
await c.close();
rmSync(dir, { recursive: true, force: true });
