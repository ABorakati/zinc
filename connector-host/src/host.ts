// The native-messaging loop: frames in -> connector handlers -> frames out.
import type { Database } from "bun:sqlite";
import { openDb } from "../../core/src/db";
import { HOST_VERSION, ZOTERO_VERSION_HEADER, extractions, handleRequest, uploadIdsOf, type HostEnv, type WireRequest } from "./dispatch";
import { FrameReader, encodeFrame, responseFrames } from "./frames";
import { resolveDbPath } from "./store";

export interface HostOptions {
	dbPath?: string | null;
	/** zotero-next app port for reading the UI selection (0 disables; default ZN_PORT or 23120) */
	appPort?: number;
	/** how the library is opened (tests pass their own; default: core's openDb) */
	open?: (path: string) => Database;
	/** how long to wait for running full-text extractions when the input ends (default 45 s) */
	drainMs?: number;
	/** largest single upload, and most upload bytes held at once (defaults 512 MiB and 1 GiB): an upload over either is dropped */
	maxUploadBytes?: number;
	maxHeldUploadBytes?: number;
}

export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
export const MAX_HELD_UPLOAD_BYTES = 1024 * 1024 * 1024;

export async function runHost(input: AsyncIterable<Uint8Array>, write: (b: Buffer) => void | Promise<void>, opts: HostOptions = {}): Promise<void> {
	const dbPath = opts.dbPath === undefined ? resolveDbPath() : opts.dbPath;
	const appPort =
		opts.appPort ??
		(process.env.ZNH_APP_PORT !== undefined ? Number(process.env.ZNH_APP_PORT) || 0 : Number(process.env.ZN_PORT) || 23120);
	let db: Database | null = null;
	// Opened on the first call that needs it: ping and the translator calls are answered without the library.
	const getDb = (): Database => {
		if (db) return db;
		if (!dbPath) throw new Error("Zinc library not found (set ZN_DB or open the app once)");
		try {
			db = (opts.open ?? openDb)(dbPath);
			return db;
		} catch (e) {
			throw new Error(`cannot open ${dbPath}: ${e instanceof Error ? e.message : e}`);
		}
	};

	const reader = new FrameReader();
	const partial = new Map<string, Buffer[]>();
	const uploads = new Map<string, Uint8Array>();
	// An upload nobody claims (the extension timed out, the request failed first) is dropped after this long.
	const UPLOAD_TTL_MS = 10 * 60_000;
	const touched = new Map<string, number>();
	const sizes = new Map<string, number>(); // bytes held per upload (partial or complete)
	const refused = new Set<string>(); // uploads dropped for size: the rest of their chunks are ignored
	const maxUpload = opts.maxUploadBytes ?? MAX_UPLOAD_BYTES;
	const maxHeld = opts.maxHeldUploadBytes ?? MAX_HELD_UPLOAD_BYTES;
	const held = () => {
		let n = 0;
		for (const s of sizes.values()) n += s;
		return n;
	};
	const forget = (uid: string) => {
		partial.delete(uid);
		uploads.delete(uid);
		touched.delete(uid);
		sizes.delete(uid);
		refused.delete(uid);
	};
	const sweep = setInterval(() => {
		const cutoff = Date.now() - UPLOAD_TTL_MS;
		for (const [uid, at] of touched) if (at < cutoff) forget(uid);
	}, 60_000);
	sweep.unref?.();
	const inflight = new Set<Promise<void>>();

	// The write may wait (the pipe is full) or fail (Chrome closed it): either way this request's answer is done with.
	const send = async (frames: Buffer) => {
		try {
			await write(frames);
		} catch (e) {
			console.error("[host] write failed:", e);
		}
	};
	const failFrames = (id: string | number, status: number, error: string) =>
		responseFrames(
			id,
			status,
			{ "Content-Type": "application/json", "X-Zotero-Version": ZOTERO_VERSION_HEADER },
			Buffer.from(JSON.stringify({ error })),
		);

	const onRequest = async (msg: WireRequest) => {
		const env: HostEnv = { getDb, dbPath, appPort };
		let frames: Buffer;
		try {
			const r = await handleRequest(env, msg, uploads);
			frames = responseFrames(msg.id, r.status, r.headers, r.body);
		} catch (e) {
			console.error("[host] request failed:", e);
			frames = failFrames(msg.id, 500, e instanceof Error ? e.message : String(e));
		} finally {
			// whatever upload this request did not consume (it failed before reading its body) is not kept
			for (const uid of uploadIdsOf(msg.body)) forget(uid);
		}
		await send(frames);
	};

	for await (const chunk of input) {
		for (const m of reader.push(chunk) as Record<string, any>[]) {
			switch (m?.t) {
				case "hello":
					write(encodeFrame({ t: "hello", id: m.id, version: HOST_VERSION, db: dbPath, pid: process.pid, proto: 2 }));
					break;
				case "up": {
					const uid = String(m.uid);
					if (refused.has(uid)) {
						touched.set(uid, Date.now());
						break;
					}
					const piece = Buffer.from(String(m.data), "base64");
					const size = (sizes.get(uid) ?? 0) + piece.length;
					if (size > maxUpload || held() - (sizes.get(uid) ?? 0) + size > maxHeld) {
						console.error(`[host] upload ${uid} dropped: over the size limit`);
						forget(uid);
						refused.add(uid);
						touched.set(uid, Date.now());
						break;
					}
					const list = partial.get(uid) ?? [];
					list.push(piece);
					partial.set(uid, list);
					sizes.set(uid, size);
					touched.set(uid, Date.now());
					if (m.last) {
						// one chunk (the usual case) is used as it is, without a copy
						uploads.set(uid, list.length === 1 ? list[0]! : Buffer.concat(list));
						partial.delete(uid);
					}
					break;
				}
				case "drop":
					forget(String(m.uid));
					break;
				case "req": {
					const p = onRequest(m as WireRequest).finally(() => inflight.delete(p));
					inflight.add(p);
					break;
				}
			}
		}
	}
	clearInterval(sweep);
	await Promise.allSettled([...inflight]);
	// Let running full-text extractions finish (bounded: Chrome may stop waiting for us).
	const waitMs = opts.drainMs ?? 45_000;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const finished = await Promise.race([
		Promise.allSettled([...extractions]).then(() => true),
		new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), waitMs))),
	]);
	clearTimeout(timer);
	if (finished) (db as Database | null)?.close();
	// else: an extraction is still reading the library; closing it under that work would only make it fail, and the process ends now
	else console.error(`[host] ${extractions.size} full-text extraction(s) still running at exit; the library is left open`);
}
