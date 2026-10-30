// Library-wide tag maintenance: rename / merge, delete, delete automatic tags.
// Writes go through item_tags + items.data so sync triggers mark every affected item dirty.

import type { Database } from "bun:sqlite";
import type { TagColor } from "../api-types";
import { getTagColors, HttpError, nowIso, setTagColors } from "../db";
import { indexItem } from "../search";

// Same shape as db.ts syncDataTags (not exported there): items.data.tags mirrors item_tags.
function syncDataTags(db: Database, itemKey: string): void {
	const rows = db.query("SELECT tag, type FROM item_tags WHERE item_key = ? ORDER BY tag").all(itemKey) as { tag: string; type: number }[];
	const now = nowIso();
	db.query("UPDATE items SET data = json_set(data, '$.tags', json(?), '$.dateModified', ?), date_modified = ? WHERE key = ?").run(
		JSON.stringify(rows.map((r) => (r.type ? { tag: r.tag, type: r.type } : { tag: r.tag }))),
		now,
		now,
		itemKey,
	);
}

function finish(db: Database, itemKeys: string[]): void {
	for (const k of itemKeys) {
		syncDataTags(db, k);
		indexItem(db, k);
	}
}

const itemsWithTag = (db: Database, tag: string) =>
	(db.query("SELECT item_key FROM item_tags WHERE tag = ?").all(tag) as { item_key: string }[]).map((r) => r.item_key);

export interface TagRenameReport {
	items: number; // items that carried the old tag
	merged: boolean; // the new name already existed
}

export function renameTag(db: Database, fromRaw: unknown, toRaw: unknown): TagRenameReport {
	if (typeof fromRaw !== "string" || typeof toRaw !== "string") throw new HttpError(400, "from and to are required");
	const from = fromRaw;
	const to = toRaw.trim();
	if (!from) throw new HttpError(400, "from is required");
	if (!to) throw new HttpError(400, "new tag name cannot be empty");
	if (from === to) return { items: 0, merged: false };
	let report: TagRenameReport = { items: 0, merged: false };
	db.transaction(() => {
		const keys = itemsWithTag(db, from);
		const merged = !!db.query("SELECT 1 FROM item_tags WHERE tag = ? LIMIT 1").get(to);
		for (const k of keys) {
			const dup = db.query("SELECT type FROM item_tags WHERE item_key = ? AND tag = ?").get(k, to) as { type: number } | null;
			if (dup) {
				// Item already has the target: drop the old row; a manual tag wins over automatic.
				const old = db.query("SELECT type FROM item_tags WHERE item_key = ? AND tag = ?").get(k, from) as { type: number };
				db.query("DELETE FROM item_tags WHERE item_key = ? AND tag = ?").run(k, from);
				if (dup.type && !old.type) db.query("UPDATE item_tags SET type = 0 WHERE item_key = ? AND tag = ?").run(k, to);
			} else {
				db.query("UPDATE item_tags SET tag = ? WHERE item_key = ? AND tag = ?").run(to, k, from);
			}
		}
		finish(db, keys);
		// Colours: the new name keeps its own colour when it has one, otherwise inherits the old one.
		const colors = getTagColors(db);
		const old = colors.find((c) => c.name === from);
		if (old) {
			const rest = colors.filter((c) => c.name !== from);
			const next: TagColor[] = rest.some((c) => c.name === to)
				? rest
				: colors.map((c) => (c.name === from ? { ...c, name: to } : c));
			setTagColors(db, next.map((c) => ({ name: c.name, color: c.color })));
		}
		report = { items: keys.length, merged };
	})();
	return report;
}

export interface TagDeleteReport {
	tags: number; // distinct tag names removed
	items: number; // items that lost at least one tag
}

function deleteTagRows(db: Database, tags: string[], onlyAutomatic: boolean): TagDeleteReport {
	const affected = new Set<string>();
	const names = new Set<string>();
	db.transaction(() => {
		for (const tag of tags) {
			const rows = db
				.query(`SELECT item_key FROM item_tags WHERE tag = ?${onlyAutomatic ? " AND type = 1" : ""}`)
				.all(tag) as { item_key: string }[];
			if (!rows.length) continue;
			names.add(tag);
			for (const r of rows) affected.add(r.item_key);
			db.query(`DELETE FROM item_tags WHERE tag = ?${onlyAutomatic ? " AND type = 1" : ""}`).run(tag);
		}
		finish(db, [...affected]);
		// Drop colours of tags that no longer exist anywhere.
		const colors = getTagColors(db);
		const gone = colors.filter((c) => names.has(c.name) && !db.query("SELECT 1 FROM item_tags WHERE tag = ? LIMIT 1").get(c.name));
		if (gone.length) {
			const g = new Set(gone.map((c) => c.name));
			setTagColors(db, colors.filter((c) => !g.has(c.name)).map((c) => ({ name: c.name, color: c.color })));
		}
	})();
	return { tags: names.size, items: affected.size };
}

export function deleteTags(db: Database, tags: unknown): TagDeleteReport {
	if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string")) throw new HttpError(400, "tags must be an array of strings");
	return deleteTagRows(db, [...new Set(tags as string[])], false);
}

export function automaticTags(db: Database): { tag: string; count: number }[] {
	return db
		.query(
			`SELECT t.tag, count(*) AS count FROM item_tags t JOIN items i ON i.key = t.item_key
			 WHERE t.type = 1 AND i.deleted = 0 GROUP BY t.tag ORDER BY t.tag COLLATE NOCASE`,
		)
		.all() as { tag: string; count: number }[];
}

export function deleteAutomaticTags(db: Database): TagDeleteReport {
	const names = (db.query("SELECT DISTINCT tag FROM item_tags WHERE type = 1").all() as { tag: string }[]).map((r) => r.tag);
	return deleteTagRows(db, names, true);
}
