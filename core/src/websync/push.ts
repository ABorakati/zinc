// Push to zotero.org: the outbox (coalesced by sync/build.ts) goes out in sequential batches of 50 objects, each with
// If-Unmodified-Since-Version. Collections first, then items (parents before children) and annotations, then deletions.

import type { Database } from "bun:sqlite";
import type { EntityType, ZoteroJson, ZoteroWrite, ZoteroWriteResult } from "../sync/protocol";
import { buildPush, completePush, type PushPlan } from "../sync/build";
import { failure, libraryVersion, type ZoteroWebClient } from "./client";
import { annotationToRemote } from "./convert";
import { forgetVersions, knownVersions, recordVersions } from "./pull";
import { getState, setState } from "./state";

const BATCH = 50;

export interface PushContext {
	db: Database;
	client: ZoteroWebClient;
	userId: number;
	dataDir: string;
	ownStorageDir: string | null;
}

export interface PushResult {
	pushed: number;
	failed: number;
	/** A per-object 412: the object changed on zotero.org, a pull will bring it in. */
	conflicted: boolean;
	error?: string;
}

interface Payload {
	type: EntityType;
	key: string;
	body: ZoteroJson;
}

function chunk<T>(a: T[], n: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
	return out;
}

function payloadFor(w: ZoteroWrite, versions: Map<string, number>): Payload {
	const known = versions.get(w.key) ?? 0;
	if (w.type === "annotation") {
		const body = annotationToRemote(w.data ?? {}, w.key, String(w.data?.parentItem ?? ""));
		body.version = known;
		return { type: "annotation", key: w.key, body };
	}
	const body: ZoteroJson = { ...(w.data ?? {}), key: w.key, version: known };
	if (w.type === "item") {
		body.deleted = body.deleted ? 1 : 0; // 0 restores a trashed item
		delete body.path; // a local path means nothing on another machine
		// md5/mtime belong to an uploaded file: only an object zotero.org already knows may keep the ones it gave us
		if (!known) {
			delete body.md5;
			delete body.mtime;
		}
	}
	return { type: w.type, key: w.key, body };
}

function subPlan(plan: PushPlan, keys: Set<string>): PushPlan {
	return { ...plan, groups: plan.groups.filter((g) => keys.has(g.key)), dropped: [] };
}

function setServerVersions(db: Database, items: Map<string, number>, collections: Map<string, number>): void {
	db.transaction(() => {
		db.run("INSERT OR IGNORE INTO sync_flags(name) VALUES('suppress')");
		try {
			for (const [k, v] of items) db.query("UPDATE items SET version = ? WHERE key = ?").run(v, k);
			for (const [k, v] of collections) db.query("UPDATE collections SET version = ? WHERE key = ?").run(v, k);
		} finally {
			db.run("DELETE FROM sync_flags WHERE name = 'suppress'");
		}
	})();
}

/** Push everything queued. Throws PreconditionFailed (412) when the library moved: pull, then call again. */
export async function pushOnce(ctx: PushContext): Promise<PushResult> {
	const { db, client } = ctx;
	const out: PushResult = { pushed: 0, failed: 0, conflicted: false };
	const plan = buildPush(db, ctx.dataDir);
	// created and erased before ever reaching zotero.org: nothing to send
	completePush(db, { ...plan, writes: [], groups: [], base: new Map(), baseRemove: new Set(), files: new Map() }, [], null);

	const itemVersions = knownVersions(db, "item");
	const annVersions = knownVersions(db, "annotation");
	const collVersions = knownVersions(db, "collection");
	const collUp: Payload[] = [];
	const itemUp: Payload[] = [];
	const itemDel: string[] = [];
	const collDel: string[] = [];
	for (const w of plan.writes) {
		if (w.op === "upsert") {
			if (w.type === "collection") collUp.push(payloadFor(w, collVersions));
			else itemUp.push(payloadFor(w, w.type === "annotation" ? annVersions : itemVersions));
		} else if (w.op === "erase") (w.type === "collection" ? collDel : itemDel).push(w.key);
		// trash / restore travel as data.deleted inside the item's upsert
	}
	if (collUp.length + itemUp.length + itemDel.length + collDel.length === 0) return out;

	let v = Number(getState(db, "web_write_version") ?? getState(db, "web_library_version")) || 0;
	const u = `/users/${ctx.userId}`;
	const finish = (keys: string[], failed: Map<string, string>): void => {
		const results: ZoteroWriteResult[] = keys.map((key) => (failed.has(key) ? { key, ok: false, error: failed.get(key) } : { key, ok: true }));
		const done = completePush(db, subPlan(plan, new Set(keys)), results, ctx.ownStorageDir);
		out.pushed += done.done;
		out.failed += done.failed.length;
		if (done.failed.length && !out.error) out.error = `${done.failed.length} change(s) not accepted by zotero.org; ${done.failed[0].key}: ${done.failed[0].error}`;
	};

	for (const kind of ["collection", "item"] as const) {
		for (const batch of chunk(kind === "collection" ? collUp : itemUp, BATCH)) {
			const res = await client.request("POST", `${u}/${kind === "collection" ? "collections" : "items"}`, {
				headers: {
					"Content-Type": "application/json",
					"If-Unmodified-Since-Version": String(v),
					"Zotero-Write-Token": crypto.randomUUID().replaceAll("-", ""),
				},
				body: JSON.stringify(batch.map((p) => p.body)),
			});
			if (!res.ok) throw await failure(res);
			v = libraryVersion(res) ?? v;
			setState(db, "web_write_version", String(v));
			const body = (await res.json()) as {
				successful?: Record<string, { key?: string; version?: number; data?: { version?: number } }>;
				unchanged?: Record<string, unknown>;
				failed?: Record<string, { code?: number; message?: string }>;
			};
			const failed = new Map<string, string>();
			const seen: { type: EntityType; key: string; version: number }[] = [];
			const itemV = new Map<string, number>();
			const collV = new Map<string, number>();
			batch.forEach((p, i) => {
				const idx = String(i);
				const ok = body.successful?.[idx];
				const err = body.failed?.[idx];
				if (ok) {
					const version = Number(ok.version ?? ok.data?.version) || v;
					seen.push({ type: p.type, key: p.key, version });
					(p.type === "collection" ? collV : itemV).set(p.key, version);
				} else if (body.unchanged && idx in body.unchanged) {
					// already identical on the server: nothing to record
				} else {
					if (err?.code === 412) out.conflicted = true;
					failed.set(p.key, err?.message ?? `write failed${err?.code ? ` (${err.code})` : ""}`);
				}
			});
			recordVersions(db, seen);
			setServerVersions(db, itemV, collV);
			finish(
				batch.map((p) => p.key),
				failed,
			);
		}
	}

	for (const [kind, keys] of [
		["items", itemDel],
		["collections", collDel],
	] as const) {
		for (const batch of chunk(keys, BATCH)) {
			const res = await client.request("DELETE", `${u}/${kind}`, {
				query: kind === "items" ? { itemKey: batch.join(",") } : { collectionKey: batch.join(",") },
				headers: { "If-Unmodified-Since-Version": String(v) },
			});
			if (!res.ok && res.status !== 404) throw await failure(res);
			v = libraryVersion(res) ?? v;
			setState(db, "web_write_version", String(v));
			const types: EntityType[] = kind === "collections" ? ["collection"] : ["item", "annotation"];
			forgetVersions(
				db,
				batch.flatMap((key) => types.map((type) => ({ type, key }))),
			);
			finish(batch, new Map());
		}
	}
	return out;
}
