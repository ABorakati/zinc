// Better BibTeX settings, stored as JSON values in the bbt_settings table (local to this machine).
import type { Database } from "bun:sqlite";
import { DEFAULT_SKIP_WORDS } from "./text";
import type { BbtSettings } from "./types";

export const DEFAULT_FORMULA = "auth.lower + shorttitle(3,3) + year";

export const DEFAULT_SETTINGS: BbtSettings = {
	citekeyFormat: DEFAULT_FORMULA,
	citekeyFold: true,
	citekeyUnsafeChars: "\\\"#%'(),={}~",
	skipWords: DEFAULT_SKIP_WORDS,
	postfix: "%(a)s",
	keyCaseInsensitive: true,
	asciiBibTeX: true,
	asciiBibLaTeX: false,
	exportBraceProtection: true,
	doiAndUrl: "both",
	exportNotes: false,
	exportExtraAsNote: false,
	quickCopy: "latex",
	citeCommand: "cite",
	autoExportDelay: 5,
	autoExportIdle: 30,
};

const cache = new WeakMap<Database, { at: number; value: BbtSettings }>();

export function getSettings(db: Database): BbtSettings {
	const rows = db.query("SELECT name, value FROM bbt_settings").all() as { name: string; value: string }[];
	const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
	for (const r of rows) {
		if (!(r.name in DEFAULT_SETTINGS)) continue;
		try {
			const v = JSON.parse(r.value);
			if (typeof v === typeof (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[r.name]) out[r.name] = v;
		} catch {
			// ignore a corrupt value: the default stays
		}
	}
	const value = out as unknown as BbtSettings;
	cache.set(db, { at: Date.now(), value });
	return value;
}

/** Validate and store a partial settings object. Unknown keys and wrong types are rejected with an Error. */
export function setSettings(db: Database, patch: Partial<BbtSettings>): BbtSettings {
	const defaults = DEFAULT_SETTINGS as unknown as Record<string, unknown>;
	db.transaction(() => {
		for (const [k, v] of Object.entries(patch)) {
			if (!(k in defaults)) throw new Error(`unknown setting: ${k}`);
			if (typeof v !== typeof defaults[k]) throw new Error(`setting ${k} must be a ${typeof defaults[k]}`);
			if (k === "doiAndUrl" && !["both", "doi", "url"].includes(v as string)) throw new Error("doiAndUrl must be both, doi or url");
			if ((k === "autoExportDelay" || k === "autoExportIdle") && !(Number(v) >= 0 && Number(v) <= 86400)) throw new Error(`${k} must be 0-86400 seconds`);
			db.query("INSERT INTO bbt_settings(name, value) VALUES(?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").run(k, JSON.stringify(v));
		}
	})();
	return getSettings(db);
}
