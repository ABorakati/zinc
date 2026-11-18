// Routes for the change log and the atomic batch. Returns null for other paths.
//   GET  /api/changes?since=N&limit=&library=&wait=ms  -> ChangePage {head, cursor, reset, changes[]}
//        since defaults to 0. `wait` (max 30000) makes it a long poll: it answers as soon as something is newer than `since`,
//        or with an empty page after `wait` ms.
//   GET  /api/changes/head                              -> {head}
//   GET  /api/changes/stream?since=N&library=           -> text/event-stream; each `data:` line is a ChangePage with changes
//        in it (`event: changes`), `: ping` every 15 s. The stream starts at `since` (default: the current head).
//   POST /api/batch  {changes: {tag, val}[], origin?, skipNotify?} -> {created: string[], changed: number}
//        One SQLite transaction, all or nothing. A failure answers {error, index} with the HTTP status of the cause.
//        The change shapes are the WIT `change` variant of plugin-api/wit/library.wit in jco's JSON form (see batch.ts).
import type { Database } from "bun:sqlite";
import { HttpError } from "../db";
import { runBatch, BatchError } from "./batch";
import { changeHead, changesSince, pruneChangeLog } from "./log";
import { resolveLibrary } from "../libraries";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function num(v: string | null, d: number): number {
	if (v === null || v === "") return d;
	const n = Number(v);
	if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `invalid number: ${v}`);
	return n;
}

export async function handleChangesApi(req: Request, db: Database): Promise<Response | null> {
	const url = new URL(req.url);
	const p = url.pathname;
	if (p !== "/api/changes" && !p.startsWith("/api/changes/") && p !== "/api/batch") return null;
	try {
		if (p === "/api/batch") {
			if (req.method !== "POST") throw new HttpError(405, "method not allowed");
			let body: any;
			try {
				body = await req.json();
			} catch {
				throw new HttpError(400, "invalid JSON body");
			}
			if (!body || typeof body !== "object" || !Array.isArray(body.changes)) throw new HttpError(400, "changes must be an array");
			try {
				return json(runBatch(db, body.changes, { origin: typeof body.origin === "string" ? body.origin : undefined, skipNotify: body.skipNotify === true }));
			} catch (e) {
				if (e instanceof BatchError) return json({ error: e.message, index: e.index }, e.status);
				throw e;
			}
		}
		if (req.method !== "GET") throw new HttpError(405, "method not allowed");
		const q = url.searchParams;
		const library = q.has("library") ? resolveLibrary(db, q.get("library")) : undefined;
		if (p === "/api/changes/head") return json({ head: changeHead(db) });
		if (p === "/api/changes") {
			const since = num(q.get("since"), 0);
			const limit = num(q.get("limit"), 1000);
			const wait = Math.min(num(q.get("wait"), 0), 30_000);
			pruneChangeLog(db);
			let page = changesSince(db, since, limit, library);
			const until = Date.now() + wait;
			while (wait > 0 && page.changes.length === 0 && !page.reset && Date.now() < until && !req.signal.aborted) {
				await sleep(50);
				try {
					page = changesSince(db, since, limit, library);
				} catch (e) {
					if (req.signal.aborted || /closed database/i.test(String(e))) break; // the server is shutting down
					throw e;
				}
			}
			return json(page);
		}
		if (p === "/api/changes/stream") {
			let cursor = q.has("since") ? num(q.get("since"), 0) : changeHead(db);
			const enc = new TextEncoder();
			let timer: ReturnType<typeof setInterval> | undefined;
			let lastPing = Date.now();
			const stream = new ReadableStream<Uint8Array>({
				start(ctrl) {
					ctrl.enqueue(enc.encode(": open\n\n"));
					timer = setInterval(() => {
						try {
							const page = changesSince(db, cursor, 1000, library);
							if (page.changes.length > 0 || page.reset) {
								cursor = page.cursor;
								ctrl.enqueue(enc.encode(`event: changes\ndata: ${JSON.stringify(page)}\n\n`));
								lastPing = Date.now();
							} else if (Date.now() - lastPing > 15_000) {
								ctrl.enqueue(enc.encode(": ping\n\n"));
								lastPing = Date.now();
							}
						} catch {
							clearInterval(timer);
							try {
								ctrl.close();
							} catch {}
						}
					}, 100);
				},
				cancel() {
					clearInterval(timer);
				},
			});
			return new Response(stream, {
				headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
			});
		}
		return json({ error: "not found" }, 404);
	} catch (e) {
		if (e instanceof HttpError) return json({ error: e.message }, e.status);
		console.error(e);
		return json({ error: e instanceof Error ? e.message : "internal error" }, 500);
	}
}
