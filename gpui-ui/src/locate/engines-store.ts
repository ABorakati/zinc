// The user's Locate engines, kept in zotero-next's own ui-state.json (key "locate.engines"), never in the Zotero folder: Zotero's
// locate/engines.json is only ever read (importFromZotero). First run starts from Zotero's default set.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { persisted } from "../shell/prefs";
import {
	coerceEngines, defaultEngines, mergeEngines, moveEngine as move, parseZoteroEngines, upsertEngine, type LocateEngine,
} from "./engines";

export const [engines, setEngines] = persisted<LocateEngine[]>("locate.engines", defaultEngines(), coerceEngines);

/** Engines the Locate menu shows, in order. */
export const enabledEngines = (): LocateEngine[] => engines().filter((e) => e.enabled);

export const addEngine = (e: LocateEngine) => setEngines(upsertEngine(engines(), e));
export const removeEngine = (index: number) => setEngines(engines().filter((_, i) => i !== index));
export const moveEngine = (index: number, delta: number) => setEngines(move(engines(), index, delta));
export const setEngineEnabled = (index: number, enabled: boolean) => setEngines(engines().map((e, i) => (i === index ? { ...e, enabled } : e)));
export const restoreDefaultEngines = () => setEngines(defaultEngines());

/** Zotero's engines.json under a data folder (default ~/Zotero). */
export const zoteroEnginesPath = (dataDir?: string | null): string => join(dataDir || join(homedir(), "Zotero"), "locate", "engines.json");

/**
 * Read (never write) Zotero's locate/engines.json and merge its engines into ours: a same-named engine is replaced in place, new
 * ones are appended. Throws when the file is missing or malformed. `read` is injectable for tests.
 */
export function importFromZotero(
	dataDir?: string | null, read: (path: string) => string = (p) => readFileSync(p, "utf8"),
): { added: number; replaced: number; path: string } {
	const path = zoteroEnginesPath(dataDir);
	let text: string;
	try { text = read(path); } catch { throw new Error(`No Zotero engines found at ${path}`); }
	const imported = parseZoteroEngines(text.replace(/^﻿/, ""));
	if (!imported.length) throw new Error("That file holds no usable engines");
	const r = mergeEngines(engines(), imported);
	setEngines(r.list);
	return { added: r.added, replaced: r.replaced, path };
}
