// Pull from zotero.org: list what changed since the last library version, fetch those objects, apply them.

import type { Database } from "bun:sqlite";
import { nowIso } from "../db";
import { applyChanges, type ApplyReport, type RemoteChanges } from "../sync/apply";
import type { EntityType, ZoteroJson } from "../sync/protocol";
import { failure, libraryVersion, type ZoteroWebClient } from "./client";
import { annotationFromRemote } from "./convert";
import { setWebVersions, userRef, webVersions, type LibraryRef } from "./library";

const BATCH = 50;
const MAX_RESTARTS = 4;

export interface PullContext {
	db: Database;
	client: ZoteroWebClient;
	userId: number;
	/** The library to pull (default: My Library, /users/<userId>). A group: groupRef(). */
	ref?: LibraryRef;
	/** Folder holding storage/ (the directory of the library database). */
	dataDir: string;
}

export interface PullResult extends ApplyReport {
	libraryVersion: number;
	fetched: number;
}

/** The server's library version moved while we were reading: start over from the old version. */
class VersionChanged extends Error {}

function chunk<T>(a: T[], n: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
	return out;
}

export function knownVersions(db: Database, type: EntityType): Map<string, number> {
	const rows = db.query("SELECT key, version FROM websync_versions WHERE type = ?").all(type) as { key: string; version: number }[];
	return new Map(rows.map((r) => [r.key, r.version]));
}

export function recordVersions(db: Database, rows: { type: EntityType; key: string; version: number }[]): void {
	const ins = db.query("INSERT INTO websync_versions(type, key, version) VALUES(?, ?, ?) ON CONFLICT(type, key) DO UPDATE SET version = excluded.version");
	db.transaction(() => {
		for (const r of rows) ins.run(r.type, r.key, r.version);
	})();
}

export function forgetVersions(db: Database, rows: { type: EntityType; key: string }[]): void {
	const del = db.query("DELETE FROM websync_versions WHERE type = ? AND key = ?");
	db.transaction(() => {
		for (const r of rows) del.run(r.type, r.key);
	})();
}

async function getJson<T>(ctx: PullContext, path: string, query: Record<string, string | number>, libV?: number): Promise<{ body: T; version: number }> {
	const res = await ctx.client.request("GET", path, { query });
	if (!res.ok) throw await failure(res);
	const version = libraryVersion(res) ?? 0;
	if (libV !== undefined && version !== libV) throw new VersionChanged();
	return { body: (await res.json()) as T, version };
}

async function attempt(ctx: PullContext): Promise<PullResult> {
	const { db } = ctx;
	const ref = ctx.ref ?? userRef(ctx.userId);
	const since = webVersions(db, ref.id).pull;
	const u = ref.prefix;
	const [iv, cv] = await Promise.all([
		getJson<Record<string, number>>(ctx, `${u}/items`, { since, format: "versions", includeTrashed: 1 }),
		getJson<Record<string, number>>(ctx, `${u}/collections`, { since, format: "versions" }),
	]);
	const libV = iv.version;
	if (cv.version !== libV) throw new VersionChanged();
	let deleted: { items?: string[]; collections?: string[] } = {};
	if (since > 0) deleted = (await getJson<typeof deleted>(ctx, `${u}/deleted`, { since }, libV)).body;

	const knownItems = knownVersions(db, "item");
	const knownAnn = knownVersions(db, "annotation");
	const knownColl = knownVersions(db, "collection");
	// versions we already hold (our own pushes come back in the list) need no fetch
	const itemKeys = Object.entries(iv.body)
		.filter(([k, v]) => (knownItems.get(k) ?? knownAnn.get(k) ?? -1) < v)
		.map(([k]) => k);
	const collKeys = Object.entries(cv.body)
		.filter(([k, v]) => (knownColl.get(k) ?? -1) < v)
		.map(([k]) => k);

	const fetched = await Promise.all([
		...chunk(itemKeys, BATCH).map((keys) => getJson<{ key: string; version: number; data: ZoteroJson }[]>(ctx, `${u}/items`, { itemKey: keys.join(","), includeTrashed: 1 }, libV)),
		...chunk(collKeys, BATCH).map((keys) => getJson<{ key: string; version: number; data: ZoteroJson }[]>(ctx, `${u}/collections`, { collectionKey: keys.join(",") }, libV)),
	]);

	const changes: RemoteChanges = { upserts: [], deletes: [] };
	const versions: { type: EntityType; key: string; version: number }[] = [];
	const itemBatches = Math.ceil(itemKeys.length / BATCH);
	fetched.forEach((f, i) => {
		const isItems = i < itemBatches;
		for (const o of f.body) {
			const version = Number(o.version ?? o.data?.version) || 0;
			const key = String(o.data?.key ?? o.key);
			const data: ZoteroJson = { ...o.data, key, version };
			if (isItems) {
				const isAnn = data.itemType === "annotation";
				const type: EntityType = isAnn ? "annotation" : "item";
				const dateModified = typeof data.dateModified === "string" ? data.dateModified : nowIso();
				changes.upserts.push({ type, key, data: isAnn ? annotationFromRemote(data) : data, dateModified });
				versions.push({ type, key, version });
			} else {
				// collections carry no dateModified: use the time we saw the change. Reduce them to the fields zotero-next
				// stores, so a collection that already matches locally is not reported as a conflict over `relations`.
				const coll: ZoteroJson = { key, name: data.name, parentCollection: data.parentCollection || false, version };
				changes.upserts.push({ type: "collection", key, data: coll, dateModified: nowIso() });
				versions.push({ type: "collection", key, version });
			}
		}
	});

	const gone: { type: EntityType; key: string }[] = [];
	for (const key of deleted.items ?? []) {
		const isAnn = !!db.query("SELECT 1 FROM annotations WHERE key = ?").get(key);
		gone.push({ type: isAnn ? "annotation" : "item", key });
	}
	for (const key of deleted.collections ?? []) gone.push({ type: "collection", key });
	changes.deletes.push(...gone);

	const report = applyChanges(db, changes, ctx.dataDir, ref.id);
	recordVersions(db, versions);
	forgetVersions(db, gone);
	setWebVersions(db, ref.id, { pull: libV, write: libV });
	return { ...report, libraryVersion: libV, fetched: versions.length };
}

/** One full pull. Restarts from the old version when the library changes under it. */
export async function pullOnce(ctx: PullContext): Promise<PullResult> {
	for (let i = 0; i < MAX_RESTARTS; i++) {
		try {
			return await attempt(ctx);
		} catch (e) {
			if (!(e instanceof VersionChanged)) throw e;
		}
	}
	throw new Error("the library on zotero.org kept changing during the pull; will retry");
}
