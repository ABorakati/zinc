// Better BibTeX exports: Better BibTeX, Better BibLaTeX, Better CSL JSON, Better CSL YAML.
import type { Database } from "bun:sqlite";
import { keyMap } from "../keys";
import { getSettings } from "../settings";
import { BBT_FORMATS, type BbtExportFormat } from "../types";
import { exportBetterBib, type BbtExportItem, type BibOptions } from "./bibtex";
import { exportBetterCslJson, exportBetterCslYaml } from "./csl";

export { BBT_FORMATS, type BbtExportFormat };
export type { BbtExportItem, BibOptions };

export const isBbtFormat = (f: unknown): f is BbtExportFormat => typeof f === "string" && Object.hasOwn(BBT_FORMATS, f);

/** The citation keys of exported items, in order (an item without a key, which cannot happen for regular items, gets its item key). */
export function keysFor(db: Database, items: { data: { key: string } }[]): string[] {
	const keys = keyMap(
		db,
		items.map((i) => i.data.key),
	);
	return items.map((i) => keys.get(i.data.key) ?? i.data.key);
}

/** Serialise items (as gathered by io/export.ts gatherItems) in a Better format, using their citation keys. */
export function exportBetterFormat(
	db: Database,
	format: BbtExportFormat,
	items: { data: BbtExportItem["data"]; tags: string[]; noteHtml?: string[]; files?: string[] }[],
	opts: BibOptions = {},
): string {
	const st = getSettings(db);
	const keys = keysFor(db, items);
	const list: BbtExportItem[] = items.map((i) => ({ data: i.data, tags: i.tags, noteHtml: i.noteHtml, files: i.files }));
	switch (format) {
		case "betterbibtex":
			return exportBetterBib(list, keys, "bibtex", st, opts);
		case "betterbiblatex":
			return exportBetterBib(list, keys, "biblatex", st, opts);
		case "bettercsljson":
			return exportBetterCslJson(list, keys);
		case "bettercslyaml":
			return exportBetterCslYaml(list, keys);
	}
}
