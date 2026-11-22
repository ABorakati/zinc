// When the "is Zotero running" check itself cannot run (no tasklist / pgrep), writing is decided by the write probe alone: it is
// neither blocked for ever nor allowed over Zotero's lock. A synthetic database file in a temp folder; Bun.spawn is stubbed.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ZoteroDbWriter } from "../../src/zotero-db";
import { isZoteroProcessRunning } from "../../src/zotero-db/env";
import { tempDir } from "../fixture";

const realSpawn = Bun.spawn;
beforeEach(() => {
	(Bun as any).spawn = () => {
		throw Object.assign(new Error("spawn pgrep ENOENT"), { code: "ENOENT" });
	};
});
afterEach(() => {
	(Bun as any).spawn = realSpawn;
});

function dataDir(): string {
	const dir = tempDir();
	const db = new Database(join(dir, "zotero.sqlite"), { create: true });
	db.exec("CREATE TABLE libraries(libraryID INTEGER PRIMARY KEY); INSERT INTO libraries VALUES(1)");
	db.close(true);
	return dir;
}

describe("process check unavailable", () => {
	test("it reports not running rather than throwing", async () => {
		expect(await isZoteroProcessRunning()).toBe(false);
	});

	test("the write probe decides: writable when free, not writable while the file is locked", async () => {
		const dir = dataDir();
		const writer = new ZoteroDbWriter({ dataDir: dir, baseAttachmentPath: null });
		expect(await writer.canWrite()).toBe(true);
		const other = new Database(join(dir, "zotero.sqlite"), { readwrite: true });
		other.exec("BEGIN EXCLUSIVE");
		try {
			expect(await writer.canWrite()).toBe(false);
		} finally {
			other.exec("ROLLBACK");
			other.close(true);
		}
	});
});
