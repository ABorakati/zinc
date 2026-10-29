// Integration against COPIES of the real Zotero library and the real zotero-next library.
// Skipped unless core/src/zotero-db provides the backends (createZoteroBackends(dataDir) or
// createZoteroReader/createZoteroWriter) and both source databases exist. Never touches the originals.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as repo from "../../src/db";
import { SyncService } from "../../src/sync/engine";
import type { ZoteroReader, ZoteroWriter } from "../../src/sync/protocol";
import { tempDir } from "../fixture";

const ZOTERO = process.env.ZN_TEST_ZOTERO_DIR ?? "C:/Users/abora/Zotero";
const LIBRARY = process.env.ZN_TEST_LIBRARY ?? "C:/Users/abora/zotero-next/data/library.sqlite";

async function loadBackends(dataDir: string): Promise<{ reader: ZoteroReader; writer: ZoteroWriter } | null> {
	try {
		const spec = "../../src/zotero-db/index";
		const m = (await import(spec)) as Record<string, any>;
		if (typeof m.createZoteroBackends === "function") return await m.createZoteroBackends(dataDir);
		if (m.createZoteroReader && m.createZoteroWriter) return { reader: await m.createZoteroReader(dataDir), writer: await m.createZoteroWriter(dataDir) };
	} catch {
		// not available yet
	}
	return null;
}

function copyDb(src: string, dst: string): void {
	for (const ext of ["", "-wal", "-shm"]) if (existsSync(src + ext)) copyFileSync(src + ext, dst + ext);
}

const present = existsSync(join(ZOTERO, "zotero.sqlite")) && existsSync(LIBRARY);

describe("real Zotero copy", () => {
	test.skipIf(!present)("pull is a no-op-ish, push writes a new item into the copy", async () => {
		const work = tempDir();
		const zdir = join(work, "Zotero");
		mkdirSync(join(zdir, "storage"), { recursive: true });
		copyDb(join(ZOTERO, "zotero.sqlite"), join(zdir, "zotero.sqlite"));
		const backends = await loadBackends(zdir);
		if (!backends) {
			console.log("zotero-db backends not available: integration test skipped");
			return;
		}
		copyDb(LIBRARY, join(work, "library.sqlite"));
		const db = repo.openDb(join(work, "library.sqlite"));
		const svc = new SyncService(db, { dataDir: zdir, ...backends, isZoteroRunning: async () => false, pollMs: 0, watch: false });
		await svc.pull();
		let st = await svc.status();
		expect(st.lastError).toBeUndefined();
		expect(st.pending).toBe(0);

		const key = repo.createItem(db, { itemType: "journalArticle", title: "zotero-next sync integration test" }).data.key;
		await svc.setEnabled(true);
		st = await svc.syncNow();
		expect(st.lastError).toBeUndefined();
		expect(st.pending).toBe(0);
		db.close(true);

		const z = new Database(join(zdir, "zotero.sqlite"), { readonly: true });
		const row = z.query("SELECT itemID FROM items WHERE key = ?").get(key);
		expect(row).not.toBeNull();
		expect(z.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
		z.close(true);
	}, 60_000); // a write session backs up the ~180 MB library first (~5 s)
});
