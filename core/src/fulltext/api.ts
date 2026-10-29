// Find Full Text routes (/api/fulltext/*). Contract: core/src/api-types.ts.
//   POST /api/fulltext/find                {keys, openAccessOnly?}  -> {jobId}
//   GET  /api/fulltext/jobs/:id            -> FullTextJob
//   GET  /api/fulltext/jobs/:id/events     -> text/event-stream of FullTextJob snapshots (closes when done)
//   POST /api/fulltext/jobs/:id/cancel     -> {ok: true}
//   POST /api/fulltext/sign-in             -> FullTextSignInResult   (warm-up window of the configured institution)
//   GET  /api/fulltext/sign-in/status      -> FullTextSignInStatus
//   GET  /api/fulltext/institutions?q=     -> FullTextInstitutionHit[]
//   GET  /api/fulltext/settings            -> FullTextSettingsView
//   PUT  /api/fulltext/settings            FullTextSettingsPatch -> FullTextSettingsView
// The engine is the zotero-fulltext WebAssembly core, hosted by ./host.ts and driven by ./service.ts.

import type { Database } from "bun:sqlite";
import type { FullTextJob } from "../api-types";
import { HttpError } from "../db";
import { fulltextService } from "./service";

const MAX_KEYS = 5000;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

export async function handleFulltextApi(req: Request, db: Database): Promise<Response | null> {
	const url = new URL(req.url);
	if (!url.pathname.startsWith("/api/fulltext/")) return null;
	try {
		let parts: string[];
		try {
			parts = url.pathname.split("/").filter(Boolean).slice(2).map(decodeURIComponent);
		} catch {
			throw new HttpError(400, "malformed URL");
		}
		const svc = fulltextService(db);
		const m = req.method;
		if (parts[0] === "find" && parts.length === 1) {
			if (m !== "POST") throw new HttpError(405, "method not allowed");
			let body: any;
			try {
				body = await req.json();
			} catch {
				throw new HttpError(400, "invalid JSON body");
			}
			const keys = body?.keys;
			if (!Array.isArray(keys) || keys.some((k) => typeof k !== "string")) throw new HttpError(400, "keys must be an array of strings");
			if (keys.length === 0) throw new HttpError(400, "keys must not be empty");
			if (keys.length > MAX_KEYS) throw new HttpError(400, `at most ${MAX_KEYS} items per request`);
			const jobId = await svc.start(Array.from(new Set(keys as string[])), body?.openAccessOnly === true);
			return json({ jobId }, 202);
		}
		if (parts[0] === "sign-in") {
			if (parts.length === 1) {
				if (m !== "POST") throw new HttpError(405, "method not allowed");
				return json(await svc.signIn());
			}
			if (parts.length === 2 && parts[1] === "status") {
				if (m !== "GET") throw new HttpError(405, "method not allowed");
				return json(await svc.signInStatus());
			}
		}
		if (parts[0] === "institutions" && parts.length === 1) {
			if (m !== "GET") throw new HttpError(405, "method not allowed");
			return json(await svc.searchInstitutions(url.searchParams.get("q") ?? ""));
		}
		if (parts[0] === "settings" && parts.length === 1) {
			if (m === "GET") return json(svc.settingsView());
			if (m !== "PUT") throw new HttpError(405, "method not allowed");
			let body: any;
			try {
				body = await req.json();
			} catch {
				throw new HttpError(400, "invalid JSON body");
			}
			return json(svc.updateSettings(body));
		}
		if (parts[0] === "jobs" && parts[1]) {
			const id = parts[1];
			if (parts.length === 2) {
				if (m !== "GET") throw new HttpError(405, "method not allowed");
				const job = svc.getJob(id);
				if (!job) throw new HttpError(404, "job not found");
				return json(job);
			}
			if (parts.length === 3 && parts[2] === "events") {
				if (m !== "GET") throw new HttpError(405, "method not allowed");
				return events(svc, id, req.signal);
			}
			if (parts.length === 3 && parts[2] === "cancel") {
				if (m !== "POST") throw new HttpError(405, "method not allowed");
				if (!svc.cancel(id)) throw new HttpError(404, "job not found");
				return json({ ok: true });
			}
		}
		return json({ error: "not found" }, 404);
	} catch (e) {
		if (e instanceof HttpError) return json({ error: e.message }, e.status);
		console.error(e);
		return json({ error: e instanceof Error ? e.message : "internal error" }, 500);
	}
}

function events(svc: ReturnType<typeof fulltextService>, id: string, signal: AbortSignal): Response {
	const first = svc.getJob(id);
	if (!first) throw new HttpError(404, "job not found");
	const enc = new TextEncoder();
	let cleanup = () => {};
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			let hb: ReturnType<typeof setInterval> | null = null;
			let unsub: (() => void) | null = null;
			const close = () => {
				if (closed) return;
				closed = true;
				if (hb) clearInterval(hb);
				unsub?.();
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			};
			const send = (job: FullTextJob) => {
				if (closed) return;
				try {
					controller.enqueue(enc.encode(`data: ${JSON.stringify(job)}\n\n`));
				} catch {
					close();
					return;
				}
				if (job.done) close();
			};
			cleanup = close;
			send(first);
			if (closed) return;
			unsub = svc.subscribe(id, send);
			// Bun closes idle connections; a comment line every few seconds keeps the stream open.
			hb = setInterval(() => {
				try {
					controller.enqueue(enc.encode(": keep-alive\n\n"));
				} catch {
					close();
				}
			}, 5000);
			signal.addEventListener("abort", close, { once: true });
		},
		cancel() {
			cleanup();
		},
	});
	return new Response(stream, {
		headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
	});
}
