import type { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../../src/db";
import { SyncService, type SyncOptions } from "../../src/sync/engine";
import {
	type EntityType,
	type ZoteroJson,
	ZoteroLockedError,
	type ZoteroReader,
	type ZoteroWrite,
	type ZoteroWriteResult,
	type ZoteroWriter,
} from "../../src/sync/protocol";
import { tempDir } from "../fixture";

export interface Upsert {
	type: EntityType;
	key: string;
	data: ZoteroJson;
	dateModified: string;
}

export class FakeReader implements ZoteroReader {
	upserts: Upsert[] = [];
	deletes: { type: EntityType; key: string }[] = [];
	since: (string | null)[] = [];
	fail: string | null = null;
	private n = 0;
	async changesSince(since: string | null) {
		this.since.push(since);
		if (this.fail) throw new Error(this.fail);
		const out = { at: `at-${++this.n}`, upserts: this.upserts, deletes: this.deletes };
		this.upserts = [];
		this.deletes = [];
		return out;
	}
	item(key: string, data: ZoteroJson, dm = "2026-06-01T10:00:00Z"): void {
		this.upserts.push({
			type: "item",
			key,
			dateModified: dm,
			data: { key, dateAdded: "2026-01-01T00:00:00Z", dateModified: dm, tags: [], collections: [], relations: {}, ...data },
		});
	}
	collection(key: string, name: string, parent: string | false = false, dm = "2026-06-01T10:00:00Z"): void {
		this.upserts.push({ type: "collection", key, dateModified: dm, data: { key, name, parentCollection: parent } });
	}
	annotation(key: string, attachment: string, data: ZoteroJson, dm = "2026-06-01T10:00:00Z"): void {
		this.upserts.push({
			type: "annotation",
			key,
			dateModified: dm,
			data: {
				type: "highlight",
				color: "#ffd400",
				sortIndex: "00001|000000|00000",
				position: {},
				...data,
				id: key,
				parentItem: attachment,
				dateModified: dm,
			},
		});
	}
}

export class FakeWriter implements ZoteroWriter {
	canWriteValue = true;
	mode: "ok" | "locked" | "throw" | "partial" = "ok";
	failKey: string | null = null;
	batches: ZoteroWrite[][] = [];
	constructor(readonly dataDir: string) {}
	async canWrite() {
		return this.canWriteValue;
	}
	async apply(writes: ZoteroWrite[]) {
		if (this.mode === "locked") throw new ZoteroLockedError();
		if (this.mode === "throw") throw new Error("disk full");
		this.batches.push(writes);
		const results: ZoteroWriteResult[] = [];
		const seen = new Set<string>();
		for (const w of writes) {
			if (seen.has(w.key)) continue;
			seen.add(w.key);
			if (this.mode === "partial" && w.key === this.failKey) {
				results.push({ key: w.key, ok: false, error: "constraint failed" });
				continue;
			}
			const r: ZoteroWriteResult = { key: w.key, ok: true };
			if (w.file) {
				const dir = join(this.dataDir, "storage", w.key);
				mkdirSync(dir, { recursive: true });
				r.path = join(dir, w.file.filename);
				copyFileSync(w.file.path, r.path);
			}
			results.push(r);
		}
		return { backupPath: join(this.dataDir, "zotero-next-backups", "b.sqlite"), results };
	}
}

export interface Rig {
	db: Database;
	dir: string;
	zoteroDir: string;
	reader: FakeReader;
	writer: FakeWriter;
	svc: SyncService;
	running: { value: boolean };
}

export function makeRig(opts: Partial<SyncOptions> = {}): Rig {
	const dir = tempDir();
	const zoteroDir = join(dir, "Zotero");
	mkdirSync(join(zoteroDir, "storage"), { recursive: true });
	writeFileSync(join(zoteroDir, "zotero.sqlite"), "");
	const db = openDb(join(dir, "lib.sqlite"));
	const reader = new FakeReader();
	const writer = new FakeWriter(zoteroDir);
	const running = { value: false };
	const svc = new SyncService(db, {
		dataDir: zoteroDir,
		reader,
		writer,
		isZoteroRunning: async () => running.value,
		pollMs: 0,
		watch: false,
		...opts,
	});
	return { db, dir, zoteroDir, reader, writer, svc, running };
}

export function outbox(db: Database): string[] {
	return (db.query("SELECT type, key, op FROM sync_outbox ORDER BY seq").all() as { type: string; key: string; op: string }[]).map(
		(r) => `${r.type}:${r.key}:${r.op}`,
	);
}
