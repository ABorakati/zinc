// The browser library's database owner: a dedicated module worker, started by offscreen.ts. It opens the library through SQLite
// WebAssembly on the opfs-sahpool VFS (web/sqlite.ts installPool; no SharedArrayBuffer) and answers the native host's frame protocol
// (CONTRACT.md "Transport"), so the library tab and the connector only change how they connect.
//
// Messages in (from offscreen.ts):  {p, m}  m = a frame from the port numbered p: {t:"hello"|"req"|"up"|"drop", ...}; {p, gone: true} a port went away
// Messages out:  {t:"ready"} | {t:"failed", error} | {p, m}  m = {t:"res", id, status, headers, n} then n x {t:"rc", id, seq, data} (base64),
//                {t:"hello", ...}  | {t:"changed", dataVersion}  (no p: to every port)
// Built by web/build.ts as one self-contained module worker script next to sqlite3.wasm (no shared chunks, no blob: URLs).
import "../globals";
import { Database, installPool } from "../sqlite";
import { installDurableFs } from "../shims/fs";
import { createBlobBackend } from "./blobfs";
import { handleRequest, uploadIdsOf, ZOTERO_VERSION_HEADER, type WireRequest } from "./dispatch";

const LIBRARY = "/opfs/zinc/library.sqlite";
const FILES = "/opfs/zinc/files.sqlite";
/** Raw bytes per response chunk (connector-host/src/frames.ts RESPONSE_CHUNK_BYTES): base64 makes it 4/3 larger, under Chrome's 1 MB. */
const CHUNK = 600_000;

const post = (m: unknown) => (self as unknown as Worker).postMessage(m);
const toB64 = (b: Uint8Array): string => {
	let s = "";
	for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
	return btoa(s);
};

// the core is typed against bun:sqlite; in this build that module is web/sqlite.ts, so the library handle has the core's type
type CoreDb = import("bun:sqlite").Database;
let db: CoreDb | null = null;
const getDb = (): CoreDb => {
	if (!db) throw new Error("the browser library is not open yet");
	return db;
};

async function open(): Promise<void> {
	await installPool();
	// durable files: everything the core writes under /opfs/ goes to /opfs/zinc/files.sqlite (the same pool), before the core runs
	const filesDb = new Database(FILES);
	filesDb.exec("PRAGMA synchronous = NORMAL");
	installDurableFs(createBlobBackend(filesDb as never), "/opfs/");
	const { openDb } = await import("../../../core/src/db");
	db = openDb(LIBRARY);
}

const ready = open().then(
	() => post({ t: "ready" }),
	(e) => { post({ t: "failed", error: String(e instanceof Error ? e.message : e) }); throw e; },
);
ready.catch(() => {});

// uploads (`up` frames) belong to the port that sent them: two tabs may both use uid "lib1"
const uploadsOf = new Map<number, { done: Map<string, Uint8Array>; partial: Map<string, Uint8Array[]> }>();
const portState = (p: number) => {
	let s = uploadsOf.get(p);
	if (!s) uploadsOf.set(p, (s = { done: new Map(), partial: new Map() }));
	return s;
};

// for automated checks (web/browser-library-check.ts reads the journal mode and schema version through the DevTools protocol)
(globalThis as Record<string, unknown>).znDb = { get db() { return db; } };

let announced = 0;
/** After a request: rows changed since the last notice? (SQLite's total_changes() counts this connection's writes, which are all of them.) */
function announceChanges(): void {
	if (!db) return;
	const n = Number((db.query("SELECT total_changes() AS n").get() as { n: number }).n);
	if (n === announced) return;
	announced = n;
	post({ t: "changed", dataVersion: n });
}

async function serve(p: number, msg: WireRequest): Promise<void> {
	const reply = (id: string | number, status: number, headers: Record<string, string>, body: Uint8Array) => {
		const n = Math.ceil(body.length / CHUNK);
		post({ p, m: { t: "res", id, status, headers, n } });
		for (let i = 0; i < n; i++) post({ p, m: { t: "rc", id, seq: i, data: toB64(body.subarray(i * CHUNK, (i + 1) * CHUNK)) } });
	};
	const st = portState(p);
	try {
		await ready;
		const r = await handleRequest(getDb, msg, st.done);
		reply(msg.id, r.status, r.headers, r.body);
	} catch (e) {
		console.error("[browser-db] request failed:", e);
		reply(msg.id, e instanceof Error && /not open yet|storage/.test(e.message) ? 503 : 500, { "Content-Type": "application/json", "X-Zotero-Version": ZOTERO_VERSION_HEADER }, new TextEncoder().encode(JSON.stringify({ error: e instanceof Error ? e.message : String(e) })));
	} finally {
		// whatever upload this request did not consume is not kept
		for (const uid of uploadIdsOf(msg.body)) { st.done.delete(uid); st.partial.delete(uid); }
		try { announceChanges(); } catch { /* closing */ }
	}
}

self.onmessage = (e: MessageEvent) => {
	const { p, m, gone } = e.data as { p: number; m?: Record<string, any>; gone?: boolean };
	if (gone) { uploadsOf.delete(p); return; }
	switch (m?.t) {
		case "hello":
			post({ p, m: { t: "hello", id: m.id, version: "browser-0.1", db: LIBRARY, pid: 0, proto: 2 } });
			break;
		case "up": {
			const st = portState(p);
			const uid = String(m.uid);
			const list = st.partial.get(uid) ?? [];
			list.push(Uint8Array.from(atob(String(m.data)), (c) => c.charCodeAt(0)));
			st.partial.set(uid, list);
			if (m.last) {
				const size = list.reduce((n, c) => n + c.length, 0);
				const all = new Uint8Array(size);
				let at = 0;
				for (const c of list) { all.set(c, at); at += c.length; }
				st.done.set(uid, all);
				st.partial.delete(uid);
			}
			break;
		}
		case "drop":
			portState(p).done.delete(String(m.uid));
			portState(p).partial.delete(String(m.uid));
			break;
		case "req":
			void serve(p, m as WireRequest);
			break;
	}
};
