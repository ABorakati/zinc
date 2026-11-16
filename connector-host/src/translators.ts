// Serves translator metadata and code to the extension from the translators bundled with Zinc (the same folder the
// app uses: <library folder>/translators when the app has updated them, else core/vendor/zotero/translators).
//
// The extension asks "the client" (getTranslators, getTranslatorCode) before it falls back to repo.zotero.org, so
// answering here means detection works offline and on first run without a download of the whole repository index,
// and the translator code comes from disk instead of one HTTPS request per translator.
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listTranslators, translatorsDirFor, type TranslatorInfo } from "../../core/src/translate/translators";

// In the compiled exe core's own "vendored" path points into the exe, so look for the checkout / install as well
// (ZN_ZOTERO_VENDOR for a packaged app, else ZNH_REPO, default <home>/zotero-next, like the PDF worker in dispatch.ts).
const REPO = (process.env.ZNH_REPO ?? join(process.env.USERPROFILE ?? homedir(), "zotero-next")).replace(/[\/]+$/, "");
const FALLBACKS = [
	process.env.ZN_ZOTERO_VENDOR && join(process.env.ZN_ZOTERO_VENDOR, "translators"),
	`${REPO}/core/vendor/zotero/translators`,
].filter(Boolean) as string[];

/** The translators folder in use, or null when there is none. translatorsDirFor only reads the library's file name, so the library need not be opened. */
function dirFor(dbPath: string | null): string | null {
	const r = translatorsDirFor({ filename: dbPath ?? ":memory:" } as unknown as Database);
	if (r.source !== "vendored" || existsSync(r.dir)) return r.dir;
	return FALLBACKS.find((d) => existsSync(d)) ?? null;
}

const bodies = new WeakMap<TranslatorInfo[], string>();

/** The JSON array getTranslators answers: each translator's metadata header (no code). */
export function translatorMetadata(dbPath: string | null): string | null {
	const dir = dirFor(dbPath);
	if (!dir) return null;
	const list = listTranslators(dir);
	let body = bodies.get(list);
	if (body === undefined) {
		body = JSON.stringify(list.map(({ fileName: _f, ...meta }) => meta));
		bodies.set(list, body);
	}
	return body;
}

/** The full source of one translator, or null when there is none with that id. */
export function translatorCode(dbPath: string | null, translatorID: string): string | null {
	const dir = dirFor(dbPath);
	if (!dir) return null;
	const hit = listTranslators(dir).find((t) => t.translatorID === translatorID);
	return hit ? readFileSync(join(dir, hit.fileName), "utf8") : null;
}
