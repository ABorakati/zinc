// Citation keys (Better BibTeX): generation from the formula, duplicate disambiguation, pins, regeneration.
//
// Where keys live:
//   pinned   items.data.citationKey (Zotero's own field, preferred like current BBT), else a `Citation Key: x` line in
//            Extra. Both sync (web sync / local Zotero sync) because they are ordinary item data.
//   generated  bbt_keys (a local table, like BBT's database; they are never synced). Each row records the formula
//            version and a hash of the fields the key was made from, so a key is only regenerated when something
//            relevant changed (or on an explicit Refresh).
// SQL triggers (schema.sql) put every changed regular item into bbt_dirty, whoever wrote it; the dirty set is drained
// lazily (flushDirty) before any read, so no write path needs a hook.
import type { Database } from "bun:sqlite";
import type { ZoteroItemData } from "../api-types";
import * as repo from "../db";
import schemaSql from "./schema.sql" with { type: "text" };
import { compile, formatPostfix, FormulaError, generate, MARK, validPostfix, type Compiled, type FormulaConfig } from "./formula";
import { getSettings } from "./settings";
import { parseExtra, stripCitationKeyLine } from "./text";
import type { BbtSettings, KeyInfo } from "./types";

export function ensureBbtSchema(db: Database): void {
	db.exec(schemaSql);
}

const REGULAR = "i.parent_key IS NULL AND i.item_type NOT IN ('note', 'attachment', 'annotation')";
const compiled = new Map<string, Compiled | FormulaError>();

function compileCached(formula: string): Compiled {
	let c = compiled.get(formula);
	if (!c) {
		try {
			c = compile(formula);
		} catch (e) {
			c = e instanceof FormulaError ? e : new FormulaError(String(e));
		}
		if (compiled.size > 50) compiled.clear();
		compiled.set(formula, c);
	}
	if (c instanceof FormulaError) throw c;
	return c;
}

/** The validation message for a formula, or null when it is valid. */
export function checkFormula(formula: string): { error: string; position: number } | null {
	try {
		compileCached(formula);
		return null;
	} catch (e) {
		return e instanceof FormulaError ? { error: e.message, position: e.position } : { error: String(e), position: -1 };
	}
}

export function formulaConfig(s: BbtSettings): FormulaConfig {
	return {
		skipWords: new Set(s.skipWords.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean)),
		fold: s.citekeyFold,
		unsafeChars: s.citekeyUnsafeChars,
		postfix: validPostfix(s.postfix) ? s.postfix : "%(a)s",
	};
}

/** The "formula version": changes whenever a setting that affects generated keys changes. */
export function formulaVersion(s: BbtSettings): string {
	return Bun.hash(JSON.stringify([s.citekeyFormat, s.citekeyFold, s.citekeyUnsafeChars, s.skipWords, s.postfix, s.keyCaseInsensitive])).toString(36);
}

interface ItemRow {
	key: string;
	item_type: string;
	parent_key: string | null;
	deleted: number;
	date_added: string;
	data: string;
}

function dataHash(d: ZoteroItemData): string {
	const { dateModified: _m, version: _v, tags: _t, collections: _c, relations: _r, deleted: _d, inPublications: _p, ...rest } = d as Record<string, unknown>;
	return Bun.hash(JSON.stringify(rest)).toString(36);
}

/** The pinned key of an item: the citationKey field, else `Citation Key:` in Extra; "" when not pinned. */
export function pinnedKeyOf(d: ZoteroItemData): string {
	const f = typeof d.citationKey === "string" ? d.citationKey.trim() : "";
	if (f) return f;
	return parseExtra(typeof d.extra === "string" ? d.extra : "").citationKey.trim();
}

/** Generate the key text (before duplicate disambiguation) for item data. Throws FormulaError for an invalid formula. */
export function generateKeyText(db: Database, d: ZoteroItemData, settings = getSettings(db)): { text: string; offset: number; template: string } {
	const g = generate(compileCached(settings.citekeyFormat), d, formulaConfig(settings));
	return { text: g.text, offset: g.postfix.offset, template: validPostfix(g.postfix.template) ? g.postfix.template : "%(a)s" };
}

function taken(db: Database, candidate: string, self: string, s: BbtSettings): boolean {
	const rows = db
		.query("SELECT k.key FROM bbt_keys k JOIN items i ON i.key = k.item_key WHERE k.key = ?1 COLLATE NOCASE AND k.item_key <> ?2 AND i.deleted = 0")
		.all(candidate, self) as { key: string }[];
	return s.keyCaseInsensitive ? rows.length > 0 : rows.some((r) => r.key === candidate);
}

function disambiguate(db: Database, self: string, g: { text: string; offset: number; template: string }, s: BbtSettings, fallback: string): string {
	const base = g.text.replace(MARK, "\u0000");
	const make = (post: string) => base.replace("\u0000", post);
	if (!g.text.replace(MARK, "")) return disambiguateRaw(db, self, fallback, s);
	// offset 0: the plain key first, then a, b, c...; offset n>=1: always postfixed, starting at the n-th letter
	let i = g.offset > 0 ? g.offset - 1 : -1;
	for (let guard = 0; guard < 100000; guard++, i++) {
		const candidate = make(i < 0 ? "" : formatPostfix(g.template, i));
		if (!taken(db, candidate, self, s)) return candidate;
	}
	return make(`-${self}`);
}

function disambiguateRaw(db: Database, self: string, base: string, s: BbtSettings): string {
	for (let i = -1; i < 100000; i++) {
		const c = i < 0 ? base : base + formatPostfix("%(a)s", i);
		if (!taken(db, c, self, s)) return c;
	}
	return base;
}

interface KeyRow {
	item_key: string;
	key: string;
	pinned: number;
	formula: string;
	data_hash: string;
}

const upsert = (db: Database, item: string, key: string, pinned: boolean, formula: string, hash: string) =>
	db
		.query(
			`INSERT INTO bbt_keys(item_key, key, pinned, formula, data_hash, updated) VALUES(?1, ?2, ?3, ?4, ?5, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
			 ON CONFLICT(item_key) DO UPDATE SET key = excluded.key, pinned = excluded.pinned, formula = excluded.formula,
			   data_hash = excluded.data_hash, updated = excluded.updated`,
		)
		.run(item, key, pinned ? 1 : 0, formula, hash);

/** Bring one item's key row up to date. `force` regenerates an unpinned key even if nothing changed. */
function syncOne(db: Database, itemKey: string, s: BbtSettings, fv: string, force = false): void {
	const row = db.query("SELECT key, item_type, parent_key, deleted, date_added, data FROM items i WHERE key = ?").get(itemKey) as ItemRow | null;
	if (!row || row.parent_key || ["note", "attachment", "annotation"].includes(row.item_type)) {
		db.query("DELETE FROM bbt_keys WHERE item_key = ?").run(itemKey);
		return;
	}
	const data = JSON.parse(row.data) as ZoteroItemData;
	const hash = dataHash(data);
	const pin = pinnedKeyOf(data);
	if (pin) {
		upsert(db, itemKey, pin, true, "", hash);
		return;
	}
	const cur = db.query("SELECT * FROM bbt_keys WHERE item_key = ?").get(itemKey) as KeyRow | null;
	if (cur && !cur.pinned && !force && cur.data_hash === hash && cur.formula === fv && !(row.deleted === 0 && taken(db, cur.key, itemKey, s))) return;
	const g = generateKeyText(db, data, s);
	const key = disambiguate(db, itemKey, g, s, itemKey.toLowerCase());
	upsert(db, itemKey, key, false, fv, hash);
}

/** Drain the dirty set (items written since the last call). Cheap when nothing changed. */
export function flushDirty(db: Database): number {
	const dirty = db.query("SELECT d.item_key FROM bbt_dirty d LEFT JOIN items i ON i.key = d.item_key ORDER BY i.date_added, i.rowid, d.item_key").all() as { item_key: string }[];
	if (!dirty.length) return 0;
	const s = getSettings(db);
	const fv = formulaVersion(s);
	let n = 0;
	db.transaction(() => {
		for (const { item_key } of dirty) {
			try {
				syncOne(db, item_key, s, fv);
				n++;
			} catch (e) {
				if (!(e instanceof FormulaError)) throw e;
				// an invalid formula (cannot happen via the API, which validates): leave the item dirty for later
				return;
			}
			db.query("DELETE FROM bbt_dirty WHERE item_key = ?").run(item_key);
		}
	})();
	return n;
}

/** Make sure every given item has a key row (items that were never seen, e.g. existing before this feature). */
export function ensureKeys(db: Database, itemKeys: string[]): void {
	flushDirty(db);
	if (!itemKeys.length) return;
	const have = new Set(
		(db.query("SELECT item_key FROM bbt_keys WHERE item_key IN (SELECT value FROM json_each(?))").all(JSON.stringify(itemKeys)) as { item_key: string }[]).map((r) => r.item_key),
	);
	const missing = itemKeys.filter((k) => !have.has(k));
	if (!missing.length) return;
	const s = getSettings(db);
	const fv = formulaVersion(s);
	db.transaction(() => {
		for (const k of missing) syncOne(db, k, s, fv);
	})();
}

export function getKeyInfo(db: Database, itemKey: string): KeyInfo | null {
	ensureKeys(db, [itemKey]);
	const r = db.query("SELECT key, pinned FROM bbt_keys WHERE item_key = ?").get(itemKey) as { key: string; pinned: number } | null;
	return r ? { key: r.key, pinned: !!r.pinned } : null;
}

export function getKeyInfos(db: Database, itemKeys: string[]): Record<string, KeyInfo | null> {
	ensureKeys(db, itemKeys);
	const out: Record<string, KeyInfo | null> = {};
	for (const k of itemKeys) out[k] = null;
	if (!itemKeys.length) return out;
	for (const r of db.query("SELECT item_key, key, pinned FROM bbt_keys WHERE item_key IN (SELECT value FROM json_each(?))").all(JSON.stringify(itemKeys)) as {
		item_key: string;
		key: string;
		pinned: number;
	}[]) {
		out[r.item_key] = { key: r.key, pinned: !!r.pinned };
	}
	return out;
}

/** Keys for many items as a Map (generating the missing ones); items without a key (notes...) are absent. */
export function keyMap(db: Database, itemKeys: string[]): Map<string, string> {
	const infos = getKeyInfos(db, itemKeys);
	const m = new Map<string, string>();
	for (const [k, v] of Object.entries(infos)) if (v) m.set(k, v.key);
	return m;
}

/** Item keys (Zotero keys) whose citation key is `citekey`, pinned ones first. */
export function itemsForCitekey(db: Database, citekey: string): string[] {
	flushDirty(db);
	return (
		db
			.query("SELECT k.item_key FROM bbt_keys k JOIN items i ON i.key = k.item_key WHERE k.key = ? COLLATE NOCASE AND i.deleted = 0 ORDER BY k.pinned DESC, i.date_added")
			.all(citekey) as { item_key: string }[]
	).map((r) => r.item_key);
}

function validKey(key: string): string {
	const k = key.replace(/\s+/g, "").trim();
	if (!k) throw new repo.HttpError(400, "citation key is empty");
	if (/[{}(),=#%\\"'~]/.test(k)) throw new repo.HttpError(400, "citation key contains characters that are not allowed in Bib(La)TeX keys");
	return k;
}

/** Pin a key: store it in the item's citationKey field (syncs); no `key` pins the current key. */
export function pinKey(db: Database, itemKey: string, key?: string): KeyInfo {
	const cur = key ? key : getKeyInfo(db, itemKey)?.key;
	if (!cur) throw new repo.HttpError(404, "item has no citation key (is it a regular item?)");
	const k = validKey(cur);
	const row = db.query("SELECT data FROM items WHERE key = ?").get(itemKey) as { data: string } | null;
	if (!row) throw new repo.HttpError(404, "item not found");
	const data = JSON.parse(row.data) as ZoteroItemData;
	const patch: Partial<ZoteroItemData> = { citationKey: k };
	// an old `Citation Key:` line in Extra would pin a different value: drop it so the field is the single source
	if (typeof data.extra === "string" && parseExtra(data.extra).citationKey) patch.extra = stripCitationKeyLine(data.extra);
	if (data.citationKey !== k || patch.extra !== undefined) repo.patchItem(db, itemKey, patch);
	flushDirty(db);
	return getKeyInfo(db, itemKey)!;
}

/** Remove the pin (field and Extra line) and generate a fresh key. */
export function unpinKey(db: Database, itemKey: string): KeyInfo {
	const row = db.query("SELECT data FROM items WHERE key = ?").get(itemKey) as { data: string } | null;
	if (!row) throw new repo.HttpError(404, "item not found");
	const data = JSON.parse(row.data) as ZoteroItemData;
	const patch: Partial<ZoteroItemData> = {};
	if (data.citationKey) patch.citationKey = "";
	if (typeof data.extra === "string" && parseExtra(data.extra).citationKey) patch.extra = stripCitationKeyLine(data.extra);
	if (Object.keys(patch).length) repo.patchItem(db, itemKey, patch);
	flushDirty(db);
	db.query("DELETE FROM bbt_keys WHERE item_key = ? AND pinned = 1").run(itemKey);
	refreshKeys(db, [itemKey]);
	return getKeyInfo(db, itemKey)!;
}

/** Regenerate the unpinned keys of the given items (all regular items when omitted); returns how many were visited. */
export function refreshKeys(db: Database, itemKeys?: string[]): number {
	flushDirty(db);
	const s = getSettings(db);
	const fv = formulaVersion(s);
	let n = 0;
	db.transaction(() => {
		let keys: string[];
		if (itemKeys) {
			keys = itemKeys;
			db.query("DELETE FROM bbt_keys WHERE pinned = 0 AND item_key IN (SELECT value FROM json_each(?))").run(JSON.stringify(itemKeys));
		} else {
			db.query("DELETE FROM bbt_keys WHERE pinned = 0").run();
			keys = (db.query(`SELECT i.key FROM items i WHERE ${REGULAR} ORDER BY i.date_added, i.rowid`).all() as { key: string }[]).map((r) => r.key);
		}
		// deterministic order regardless of what was asked for, so the earliest-added item keeps the plain key
		if (itemKeys) {
			const order = db
				.query("SELECT key FROM items WHERE key IN (SELECT value FROM json_each(?)) ORDER BY date_added, rowid")
				.all(JSON.stringify(itemKeys)) as { key: string }[];
			keys = order.map((r) => r.key);
		}
		for (const k of keys) {
			syncOne(db, k, s, fv, true);
			n++;
		}
	})();
	return n;
}

/** Number of generated keys made with an older formula/options than the current ones. */
export function staleKeyCount(db: Database): number {
	return (db.query("SELECT count(*) AS n FROM bbt_keys WHERE pinned = 0 AND formula <> ?").get(formulaVersion(getSettings(db))) as { n: number }).n;
}

/** What `formula` would give an item (no disambiguation): for the settings preview. */
export function previewFormula(db: Database, formula: string, itemKey?: string): { ok: boolean; error?: string; position?: number; preview?: string } {
	const bad = checkFormula(formula);
	if (bad) return { ok: false, error: bad.error, position: bad.position };
	let data: ZoteroItemData | null = null;
	if (itemKey) {
		const r = db.query("SELECT data FROM items WHERE key = ?").get(itemKey) as { data: string } | null;
		if (r) data = JSON.parse(r.data) as ZoteroItemData;
	}
	if (!data) {
		data = {
			key: "SAMPLE00",
			itemType: "journalArticle",
			title: "Deep learning for chest radiology: a systematic review",
			creators: [
				{ creatorType: "author", firstName: "Ann", lastName: "Smith" },
				{ creatorType: "author", firstName: "Bob", lastName: "Jones" },
			],
			date: "2020-05-01",
			publicationTitle: "Journal of Imaging",
		} as ZoteroItemData;
	}
	const s = { ...getSettings(db), citekeyFormat: formula };
	try {
		const g = generate(compileCached(formula), data, formulaConfig(s));
		return { ok: true, preview: g.text.replace(MARK, "") || (data.key as string) };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

/** Generate keys for every regular item that has none yet, so the Citation Key column and search see them all. */
export function backfillKeys(db: Database): number {
	flushDirty(db);
	const missing = (
		db
			.query(
				`SELECT i.key FROM items i LEFT JOIN bbt_keys k ON k.item_key = i.key
				 WHERE k.item_key IS NULL AND i.parent_key IS NULL AND i.item_type NOT IN ('note', 'attachment', 'annotation')
				 ORDER BY i.date_added, i.rowid`,
			)
			.all() as { key: string }[]
	).map((r) => r.key);
	if (missing.length) ensureKeys(db, missing);
	return missing.length;
}
