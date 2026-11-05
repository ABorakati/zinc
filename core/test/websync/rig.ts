import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { openDb } from "../../src/db";
import { configureWebSync } from "../../src/websync/api";
import { MemoryKeyStore } from "../../src/websync/keystore";
import { WebSyncService, type WebSyncOptions } from "../../src/websync/service";
import { tempDir } from "../fixture";
import { API_KEY, MockZotero } from "./mock";

export interface Rig {
	mock: MockZotero;
	db: Database;
	dir: string;
	keys: MemoryKeyStore;
	svc: WebSyncService;
	opts: WebSyncOptions;
	/** Pauses the code asked for (the fake clock advances instead of really waiting). */
	sleeps: number[];
	clock: { t: number };
	stop(): void;
}

const live: Rig[] = [];

/** A fresh temp library, a mock zotero.org on a random port, an in-memory key store and a fake clock. */
export function makeRig(): Rig {
	const mock = new MockZotero();
	process.env.ZN_ZOTERO_API = mock.url;
	const dir = tempDir();
	const db = openDb(join(dir, "lib.sqlite"));
	const keys = new MemoryKeyStore(null);
	const clock = { t: 1_800_000_000_000 };
	const sleeps: number[] = [];
	const opts: WebSyncOptions = {
		keyStore: keys,
		pollMs: 0,
		initialSync: false,
		now: () => clock.t,
		sleep: async (ms) => {
			sleeps.push(ms);
			clock.t += ms;
		},
	};
	configureWebSync(db, opts);
	const svc = new WebSyncService(db, opts);
	const rig: Rig = {
		mock,
		db,
		dir,
		keys,
		svc,
		opts,
		sleeps,
		clock,
		stop() {
			mock.stop();
			db.close();
		},
	};
	live.push(rig);
	return rig;
}

/** Make the rig's service ready: validate and store the key. */
export async function connect(r: Rig): Promise<void> {
	await r.svc.setKey(API_KEY);
}

export function stopAll(): void {
	for (const r of live.splice(0)) {
		try {
			r.stop();
		} catch {
			// already stopped
		}
	}
	delete process.env.ZN_ZOTERO_API;
}
