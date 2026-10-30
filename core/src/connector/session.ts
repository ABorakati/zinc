// Save sessions: everything one Connector save created, so the progress window can still change the target
// collection, tags and note afterwards (/connector/updateSession), and attachments can find their parent item.
import type { Database } from "bun:sqlite";
import { createItem, getItemDetail, patchItem } from "../db";
import { indexItem } from "../search";
import { userNoteToHtml } from "./items";
import { bumpRev, updateRecents } from "./state";
import type { ProxyInfo } from "./proxy";
import { resolveTarget } from "./targets";

export type SessionAction = "saveItems" | "saveSnapshot" | "saveStandaloneAttachment" | "import";

export interface SerializedSession {
	id: string;
	action: SessionAction;
	created: number;
	items: [string, string][];
	targetId: string;
	tags: string[];
	note: string;
	userNotes: [string, string][];
	proxy?: ProxyInfo | null;
}

export class SaveSession {
	readonly created = Date.now();
	/** the extension's key (item.id, page URL, attachment URL) -> library key */
	items = new Map<string, string>();
	targetId = "L1";
	tags: string[] = [];
	note = "";
	/** top-level item key -> the note the user typed in the progress window */
	private userNotes = new Map<string, string>();
	/** standalone PDF: resolves when "retrieve metadata" finished */
	autoRecognize: Promise<unknown> | null = null;
	/** the proxy the saved page came through: attachment URLs of this save are stored without it */
	proxy: ProxyInfo | null = null;

	constructor(readonly id: string, readonly action: SessionAction) {}

	/** Plain-data form, so a session can outlive the process that created it (the native-messaging host). */
	toJSON(): SerializedSession {
		return {
			id: this.id,
			action: this.action,
			created: this.created,
			items: [...this.items],
			targetId: this.targetId,
			tags: this.tags,
			note: this.note,
			userNotes: [...this.userNotes],
			proxy: this.proxy,
		};
	}

	static fromJSON(d: SerializedSession): SaveSession {
		const s = new SaveSession(d.id, d.action);
		(s as { created: number }).created = d.created;
		s.items = new Map(d.items);
		s.targetId = d.targetId;
		s.tags = d.tags;
		s.note = d.note;
		s.userNotes = new Map(d.userNotes);
		s.proxy = d.proxy ?? null;
		return s;
	}

	getItem(connectorKey: unknown): string | undefined {
		return this.items.get(String(connectorKey));
	}

	addItem(db: Database, connectorKey: string, key: string): void {
		this.items.set(String(connectorKey), key);
		this.applyTo(db, [key]);
	}

	/** Change target / tags / note and re-apply them to everything saved so far. */
	update(db: Database, targetId: string, tags?: string[], note?: string): void {
		this.targetId = targetId;
		this.tags = (tags ?? []).map((t) => String(t).trim()).filter(Boolean);
		this.note = note ?? "";
		this.applyTo(db, [...this.items.values()]);
		updateRecents(targetId, this.id);
	}

	/** Item keys that stand for the saved items: the parent when "retrieve metadata" gave an attachment one. */
	topLevelKeys(db: Database): string[] {
		const out = new Set<string>();
		for (const key of this.items.values()) {
			const row = db.query("SELECT parent_key, deleted FROM items WHERE key = ?").get(key) as { parent_key: string | null; deleted: number } | null;
			if (!row) continue;
			const top = row.parent_key ?? key;
			const t = row.parent_key ? (db.query("SELECT deleted FROM items WHERE key = ?").get(top) as { deleted: number } | null) : row;
			if (t && !t.deleted) out.add(top);
		}
		return [...out];
	}

	private applyTo(db: Database, keys: string[]): void {
		const target = resolveTarget(db, this.targetId);
		const collectionKey = target.ok ? target.collectionKey : null;
		const wanted = new Set<string>();
		for (const k of keys) {
			const row = db.query("SELECT parent_key FROM items WHERE key = ?").get(k) as { parent_key: string | null } | null;
			if (row) wanted.add(row.parent_key ?? k);
		}
		for (const key of wanted) {
			const d = getItemDetail(db, key);
			if (!d || d.data.deleted) continue;
			const tagNames = new Set(this.tags);
			const auto = d.tags.filter((t) => t.type === 1 && !tagNames.has(t.tag));
			const tags = [...auto.map((t) => ({ tag: t.tag, type: 1 })), ...this.tags.filter((t, i, a) => a.indexOf(t) === i).map((tag) => ({ tag }))];
			const same =
				tags.length === d.tags.length &&
				tags.every((t) => d.tags.some((x) => x.tag === t.tag && (x.type || 0) === (("type" in t ? t.type : 0) as number)));
			const wantedCollections = collectionKey ? [collectionKey] : [];
			const sameColl = d.collections.length === wantedCollections.length && d.collections.every((c, i) => c === wantedCollections[i]);
			if (!same || !sameColl) patchItem(db, key, { tags, collections: wantedCollections });
			this.applyNote(db, key);
			indexItem(db, key);
		}
		bumpRev();
	}

	/** Create, update or remove the user's note child (Zotero: typed-and-erased notes are deleted). */
	private applyNote(db: Database, itemKey: string): void {
		const html = userNoteToHtml(this.note);
		const existing = this.userNotes.get(itemKey);
		const row = existing ? (db.query("SELECT deleted FROM items WHERE key = ?").get(existing) as { deleted: number } | null) : null;
		if (html) {
			if (existing && row && !row.deleted) patchItem(db, existing, { note: html });
			else this.userNotes.set(itemKey, createItem(db, { itemType: "note", note: html, parentItem: itemKey }).data.key);
		} else if (existing) {
			if (row && !row.deleted) patchItem(db, existing, { deleted: 1 });
			this.userNotes.delete(itemKey);
		}
	}
}

const sessions = new Map<string, SaveSession>();

function gc(): void {
	const ttl = sessions.size >= 50 ? 10 * 60_000 : 30 * 60_000;
	const before = Date.now() - ttl;
	for (const [id, s] of sessions) if (s.created < before) sessions.delete(id);
}

export const SessionManager = {
	get: (id: unknown): SaveSession | undefined => (typeof id === "string" ? sessions.get(id) : undefined),
	/** Throws when the ID is taken (the endpoints answer 409 SESSION_EXISTS). */
	create(id: string | undefined, action: SessionAction): SaveSession {
		const sid = id === undefined || id === null || id === "" ? crypto.randomUUID().replace(/-/g, "").slice(0, 8) : String(id);
		if (sessions.has(sid)) throw new Error(`Session ID ${sid} exists`);
		const s = new SaveSession(sid, action);
		sessions.set(sid, s);
		gc();
		return s;
	},
	remove: (id: string) => void sessions.delete(id),
	/** Every live session as plain data (see SaveSession.toJSON). */
	exportAll: (): SerializedSession[] => {
		gc();
		return [...sessions.values()].map((s) => s.toJSON());
	},
	/** Adopt sessions saved by another process; sessions already here win (their state is newer). */
	importAll(list: SerializedSession[]): void {
		for (const d of list) if (d && typeof d.id === "string" && !sessions.has(d.id)) sessions.set(d.id, SaveSession.fromJSON(d));
		gc();
	},
	/** Tests only. */
	clear: () => sessions.clear(),
};
