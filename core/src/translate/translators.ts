// Which translators folder is used, and a light index of the translators in it (metadata headers only).
// The app uses <data dir>/translators (written by scripts/update-translators.ts) when it holds translators,
// else the copy vendored at core/vendor/zotero/translators. ZN_TRANSLATORS_DIR overrides both.
import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

// ZN_ZOTERO_VENDOR (packaged app: vendor/zotero beside the exe) replaces the repo copy
export const VENDORED_TRANSLATORS_DIR = process.env.ZN_ZOTERO_VENDOR
	? join(process.env.ZN_ZOTERO_VENDOR, "translators")
	: join(import.meta.dir, "..", "..", "vendor", "zotero", "translators");

export interface TranslatorInfo {
	translatorID: string;
	label: string;
	creator?: string;
	target?: string;
	translatorType: number;
	priority: number;
	lastUpdated?: string;
	fileName: string;
}

export const TYPE_IMPORT = 1;
export const TYPE_EXPORT = 2;
export const TYPE_WEB = 4;
export const TYPE_SEARCH = 8;

export function dataDirOf(db: Database): string | null {
	const file = (db as unknown as { filename?: string }).filename;
	return file && file !== ":memory:" ? dirname(file) : null;
}

function hasTranslators(dir: string): boolean {
	try {
		return existsSync(dir) && readdirSync(dir).some((n) => n.endsWith(".js"));
	} catch {
		return false;
	}
}

export function translatorsDirFor(db: Database): { dir: string; source: "env" | "data" | "vendored" } {
	const env = process.env.ZN_TRANSLATORS_DIR;
	if (env && hasTranslators(env)) return { dir: env, source: "env" };
	const data = dataDirOf(db);
	if (data) {
		const d = join(data, "translators");
		if (hasTranslators(d)) return { dir: d, source: "data" };
	}
	return { dir: VENDORED_TRANSLATORS_DIR, source: "vendored" };
}

const indexCache = new Map<string, { stamp: number; list: TranslatorInfo[] }>();

/** Metadata of every translator in `dir` (cached by the folder's mtime). */
export function listTranslators(dir: string): TranslatorInfo[] {
	const stamp = statSync(dir).mtimeMs;
	const hit = indexCache.get(dir);
	if (hit && hit.stamp === stamp) return hit.list;
	const list: TranslatorInfo[] = [];
	for (const name of readdirSync(dir)) {
		if (name[0] === "." || !name.endsWith(".js")) continue;
		let head = readFileSync(join(dir, name), "utf8").slice(0, 4000);
		if (head[0] === "﻿") head = head.slice(1);
		const m = /^\s*{[\S\s]*?}\s*?[\r\n]/.exec(head);
		if (!m) continue;
		try {
			const info = JSON.parse(m[0]);
			if (info.translatorID && info.label && typeof info.translatorType === "number") list.push({ ...info, fileName: name });
		} catch {
			/* not a translator */
		}
	}
	indexCache.set(dir, { stamp, list });
	return list;
}

export interface TranslatorCounts {
	web: number;
	import: number;
	export: number;
	search: number;
	total: number;
}

export function countTranslators(list: TranslatorInfo[]): TranslatorCounts {
	const c: TranslatorCounts = { web: 0, import: 0, export: 0, search: 0, total: list.length };
	for (const t of list) {
		if (t.translatorType & TYPE_WEB) c.web++;
		if (t.translatorType & TYPE_IMPORT) c.import++;
		if (t.translatorType & TYPE_EXPORT) c.export++;
		if (t.translatorType & TYPE_SEARCH) c.search++;
	}
	return c;
}

export interface FormatEntry {
	id: string;
	label: string;
	extension: string;
	/** true when core/src/io handles this format itself (the translator is the fallback). */
	native?: string;
}

// translator label (lowercase) -> native id in core/src/io, for the formats zotero-next handles itself
const NATIVE_EXPORT: Record<string, string> = {
	bibtex: "bibtex",
	biblatex: "biblatex",
	ris: "ris",
	"csl json": "csljson",
	csv: "csv",
	"zotero rdf": "rdf",
	mods: "mods",
};
const NATIVE_IMPORT: Record<string, string> = {
	bibtex: "bibtex",
	ris: "ris",
	"csl json": "csljson",
	"pubmed / medline (nbib)": "pubmed-nbib",
	"endnote xml": "endnote-xml",
	"zotero rdf": "rdf",
	mods: "mods",
};

function formats(list: TranslatorInfo[], bit: number, nativeMap: Record<string, string>, extra: boolean): FormatEntry[] {
	return list
		.filter((t) => t.translatorType & bit)
		.filter((t) => !extra || !(t.label.toLowerCase() in nativeMap))
		.map((t) => ({ id: t.translatorID, label: t.label, extension: String(t.target ?? ""), native: nativeMap[t.label.toLowerCase()] }))
		.sort((a, b) => a.label.localeCompare(b.label));
}

/** Export translators. By default the ones zotero-next already exports natively are left out. */
export const exportFormats = (list: TranslatorInfo[], includeNative = false): FormatEntry[] =>
	formats(list, TYPE_EXPORT, NATIVE_EXPORT, !includeNative);
export const importFormats = (list: TranslatorInfo[], includeNative = false): FormatEntry[] =>
	formats(list, TYPE_IMPORT, NATIVE_IMPORT, !includeNative);
