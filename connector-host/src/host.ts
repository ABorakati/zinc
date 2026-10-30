// The native-messaging loop: frames in -> connector handlers -> frames out.
import type { Database } from "bun:sqlite";
import { openDb } from "../../core/src/db";
import { HOST_VERSION, ZOTERO_VERSION_HEADER, extractions, handleRequest, type HostEnv, type WireRequest } from "./dispatch";
import { FrameReader, encodeFrame, responseFrames } from "./frames";
import { resolveDbPath } from "./store";

export interface HostOptions {
	dbPath?: string | null;
	/** zotero-next app port for reading the UI selection (0 disables; default ZN_PORT or 23120) */
	appPort?: number;
}

export async function runHost(input: AsyncIterable<Uint8Array>, write: (b: Buffer) => void, opts: HostOptions = {}): Promise<void> {
	const dbPath = opts.dbPath === undefined ? resolveDbPath() : opts.dbPath;
	const appPort = opts.appPort ?? (process.env.ZNH_APP_PORT !== undefined ? Number(process.env.ZNH_APP_PORT) || 0 : Number(process.env.ZN_PORT) || 23120);
	let db: Database | null = null;
	let dbError: string | null = null;
	const open = (): Database | null => {
		if (db) return db;
		if (!dbPath) {
			dbError = "zotero-next library not found (set ZN_DB or open the app once)";
			return null;
		}
		try {
			db = openDb(dbPath);
			return db;
		} catch (e) {
			dbError = `cannot open ${dbPath}: ${e instanceof Error ? e.message : e}`;
			return null;
		}
	};

	const reader = new FrameReader();
	const partial = new Map<string, Buffer[]>();
	const uploads = new Map<string, Uint8Array>();
	const inflight = new Set<Promise<void>>();

	const reply = (id: string | number, status: number, headers: Record<string, string>, body: Uint8Array) => write(responseFrames(id, status, headers, body));
	const fail = (id: string | number, status: number, error: string) =>
		reply(id, status, { "Content-Type": "application/json", "X-Zotero-Version": ZOTERO_VERSION_HEADER }, Buffer.from(JSON.stringify({ error })));

	const onRequest = async (msg: WireRequest) => {
		const d = open();
		if (!d || !dbPath) return fail(msg.id, 500, dbError ?? "no library");
		const env: HostEnv = { db: d, dbPath, appPort };
		try {
			const r = await handleRequest(env, msg, uploads);
			reply(msg.id, r.status, r.headers, r.body);
		} catch (e) {
			console.error("[host] request failed:", e);
			fail(msg.id, 500, e instanceof Error ? e.message : String(e));
		}
	};

	for await (const chunk of input) {
		for (const m of reader.push(chunk) as Record<string, any>[]) {
			switch (m?.t) {
				case "hello":
					write(encodeFrame({ t: "hello", id: m.id, version: HOST_VERSION, db: dbPath, pid: process.pid }));
					break;
				case "up": {
					const uid = String(m.uid);
					const list = partial.get(uid) ?? [];
					list.push(Buffer.from(String(m.data), "base64"));
					partial.set(uid, list);
					if (m.last) {
						uploads.set(uid, Buffer.concat(list));
						partial.delete(uid);
					}
					break;
				}
				case "drop":
					partial.delete(String(m.uid));
					uploads.delete(String(m.uid));
					break;
				case "req": {
					const p = onRequest(m as WireRequest).finally(() => inflight.delete(p));
					inflight.add(p);
					break;
				}
			}
		}
	}
	await Promise.allSettled([...inflight]);
	// Let running full-text extractions finish (bounded: Chrome may stop waiting for us).
	await Promise.race([Promise.allSettled([...extractions]), Bun.sleep(45_000)]);
	(db as Database | null)?.close();
}
