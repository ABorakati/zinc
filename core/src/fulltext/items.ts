// Library rows -> engine ItemSnapshot, and identifier helpers for the item pane.

import type { Database } from "bun:sqlite";
import type { ZoteroItemData } from "../api-types";
import { fileExists, pickPrimary } from "../db";
import { resolveStoredPath } from "../files/paths";
import type { ItemSnapshot } from "./proto";

const NOT_REGULAR = new Set(["attachment", "note", "annotation"]);

export interface ItemInfo {
	key: string;
	title: string;
	snapshot: ItemSnapshot;
}

function str(v: unknown): string {
	return typeof v === "string" ? v.trim() : "";
}

/** Build snapshots for the given keys. Keys that are not in the library are returned in `missing`. */
export function snapshotItems(db: Database, keys: string[], firstId = 1): { items: ItemInfo[]; missing: string[] } {
	const items: ItemInfo[] = [];
	const missing: string[] = [];
	let nextId = firstId;
	const q = db.query("SELECT data, deleted, item_type FROM items WHERE key = ?");
	const kids = db.query(
		// linked URLs have no file, so (as in Zotero) they never count as an attachment that satisfies Find Full Text
		`SELECT i.key, a.content_type, a.path FROM items i JOIN attachments a ON a.item_key = i.key
		 WHERE i.parent_key = ? AND i.item_type = 'attachment' AND i.deleted = 0 AND a.link_mode <> 'linked_url'
		 ORDER BY i.date_added, i.key`,
	);
	for (const key of keys) {
		const row = q.get(key) as { data: string; deleted: number; item_type: string } | null;
		if (!row) {
			missing.push(key);
			continue;
		}
		const data = JSON.parse(row.data) as ZoteroItemData;
		const regular = !NOT_REGULAR.has(row.item_type) && !row.deleted;
		let pdfs = 0;
		let best: ItemSnapshot["best_attachment"] = { kind: "none", exists: null };
		if (regular) {
			const children = kids.all(key) as { key: string; content_type: string | null; path: string | null }[];
			pdfs = children.filter((c) => c.content_type === "application/pdf").length;
			const primary = pickPrimary(children.map((c) => ({ key: c.key, contentType: c.content_type })));
			if (primary) {
				const c = children.find((x) => x.key === primary.key)!;
				// A linked_url attachment has no file at all: it does not count as a downloaded PDF.
				best = { kind: primary.contentType === "application/pdf" ? "pdf" : "other", exists: fileExists(resolveStoredPath(db, c.path)) };
			} else if (children.length) {
				best = { kind: "other", exists: false };
			}
		}
		const id = nextId++;
		const title = str(data.title) || "(untitled)";
		items.push({
			key,
			title,
			snapshot: {
				item: id,
				key: `1/${key}`,
				library: { id: 1, kind: "user", files_editable: true, name: "My Library" },
				regular,
				feed: false,
				item_type: row.item_type,
				title,
				fields: {
					doi: str(data.DOI),
					pmid: "",
					pmcid: "",
					url: str(data.url),
					archive_id: str((data as any).archiveID),
					extra: str(data.extra),
				},
				pdf_attachments: pdfs,
				best_attachment: best,
			},
		});
	}
	return { items, missing };
}
