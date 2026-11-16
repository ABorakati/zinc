// The three jobs the translation worker runs: web (page -> items or a choice list), import (text -> items),
// export (items -> text). They follow translation-server's webSession / importEndpoint / exportEndpoint, minus
// Koa and minus the held-open selection session: a multi-item page is answered with the choice list, and the
// follow-up call re-runs the same translator with the chosen keys (Zotero.Translate's `selectedItems`).
import { beginRun, endRun, type CachedResponse, type RunLimits } from "./http";
import { bootRuntime, loadTranslatorsDir } from "./zotero";

export interface Choice {
	key: string;
	title: string;
	checked?: boolean;
}
export interface TranslatorRef {
	id: string;
	label: string;
}
export interface WebParams {
	url: string;
	translatorsDir: string;
	limits?: Partial<RunLimits>;
	cache?: CachedResponse[];
	/** Set on the follow-up call: the translator that offered the choices and the keys chosen. */
	translatorID?: string;
	selectedKeys?: string[];
	headers?: Record<string, string>;
}
export type WebResult =
	| {
			kind: "items";
			items: any[];
			collections: any[];
			translator: TranslatorRef | null;
			fallback?: "embedded" | "webpage";
			cache: CachedResponse[];
			log: string[];
	  }
	| { kind: "choices"; choices: Choice[]; translator: TranslatorRef; url: string; cache: CachedResponse[]; log: string[] };

export interface ImportParams {
	text: string;
	translatorsDir: string;
	translatorID?: string;
	limits?: Partial<RunLimits>;
}
export interface ImportResultJob {
	items: any[];
	collections: any[];
	translator: TranslatorRef;
}
export interface ExportParams {
	translatorsDir: string;
	translatorID: string;
	items: any[];
	displayOptions?: Record<string, boolean>;
	limits?: Partial<RunLimits>;
}

const EMBEDDED_METADATA = "951c027d-74ac-47d4-a107-9c3069ab7b48";
const log: string[] = [];

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null));
const ref = (t: any): TranslatorRef => ({ id: t.translatorID, label: t.label });

function noteLog(Z: any): void {
	// keep the framework's debug lines of the run (capped) so a failed page can be explained
	Z.Debug.log = (message: unknown) => {
		if (process.env.ZN_TRANSLATE_DEBUG === "1") console.error(String(message).slice(0, 300));
		if (log.length < 200) log.push(typeof message === "string" ? message.slice(0, 400) : String(message).slice(0, 400));
	};
}

export async function webJob(p: WebParams): Promise<WebResult> {
	const Z = bootRuntime();
	noteLog(Z);
	log.length = 0;
	await loadTranslatorsDir(p.translatorsDir);
	beginRun(p.limits, p.cache);
	(globalThis as any).__znCollections = [];
	try {
		const req = await Z.HTTP.request("GET", p.url, {
			headers: p.headers,
			responseTypeMap: new Map([
				["html", "document"],
				["application/xhtml+xml", "document"],
				["text/plain", "text"],
				["", "text"],
			]),
		});
		if (req.type !== "document") {
			// a direct link to an export file (RIS, BibTeX, ...): treat as an import
			const done = await importJob({ text: String(req.response), translatorsDir: p.translatorsDir, limits: p.limits });
			return {
				kind: "items",
				items: done.items,
				collections: done.collections,
				translator: done.translator,
				cache: endRun(),
				log: [...log],
			};
		}
		const doc = req.response;
		const translate = new Z.Translate.Web();
		translate.setDocument(doc);
		let translators: any[];
		if (p.translatorID) {
			const t = Z.Translators.get(p.translatorID);
			if (!t) throw new Error("translator not found: " + p.translatorID);
			translators = [t];
		} else {
			translators = await new Promise<any[]>((resolve, reject) => {
				translate.setHandler("translators", (_t: unknown, list: any[]) => resolve(list));
				translate.setHandler("error", (_t: unknown, e: unknown) => {
					Z.debug(e);
				});
				try {
					translate.getTranslators(true);
				} catch (e) {
					reject(e);
				}
			});
		}

		let choices: Choice[] | null = null;
		let chosen: any = null;
		translate.setHandler("select", (_t: unknown, offered: any, callback: (v: unknown) => void) => {
			const out: Choice[] = [];
			const entries = Array.isArray(offered) ? offered.map((v, i) => [String(i), v] as const) : Object.entries(offered);
			for (const [key, v] of entries) {
				if (v && typeof v === "object")
					out.push({ key, title: String((v as any).title ?? ""), checked: (v as any).checked ? true : undefined });
				else out.push({ key, title: String(v) });
			}
			if (p.selectedKeys) {
				// follow-up call: hand back the chosen part of what the translator offered
				const subset: Record<string, unknown> = {};
				for (const [key, v] of entries) if (p.selectedKeys.includes(key)) subset[key] = v;
				callback(subset);
				return;
			}
			choices = out;
			callback([]);
		});

		const attempt = async (t: any): Promise<any[] | "choices"> => {
			translate.setTranslator(t);
			choices = null;
			const items: any[] = await translate.translate({ libraryID: false });
			if (choices) return "choices";
			chosen = t;
			return items;
		};

		let items: any[] | null = null;
		let used: any = null;
		let lastError: unknown = null;
		for (const t of translators) {
			try {
				const r = await attempt(t);
				if (r === "choices")
					return { kind: "choices", choices: choices!, translator: ref(t), url: p.url, cache: endRun(), log: [...log] };
				if (r.length) {
					items = r;
					used = t;
					break;
				}
			} catch (e) {
				lastError = e;
				Z.debug("Translation using " + t.label + " failed: " + (e instanceof Error ? e.message : String(e)));
			}
		}
		// the follow-up call after a choice list has no fallback: say what went wrong instead of saving a webpage
		if (!items && p.translatorID)
			throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "the translator returned no items"));
		let fallback: "embedded" | "webpage" | undefined;
		if (!items) {
			// nothing detected or everything failed: Embedded Metadata forced, then a plain webpage item
			const em = p.translatorID ? false : Z.Translators.get(EMBEDDED_METADATA);
			if (em && !translators.some((t) => t.translatorID === EMBEDDED_METADATA)) {
				try {
					const r = await attempt(em);
					if (r !== "choices" && r.length) {
						items = r;
						used = em;
						fallback = "embedded";
					}
				} catch (e) {
					Z.debug("Embedded Metadata fallback failed: " + (e instanceof Error ? e.message : String(e)));
				}
			}
		}
		if (!items) {
			const head = doc.documentElement.querySelector("head");
			const description = head?.querySelector("meta[name=description]")?.getAttribute("content") ?? "";
			items = [
				{
					itemType: "webpage",
					url: doc.location.href,
					title: (doc.title || "").trim() || doc.location.href,
					abstractNote: description,
					accessDate: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
					creators: [],
					tags: [],
					notes: [],
					attachments: [],
				},
			];
			used = null;
			fallback = "webpage";
		}
		void chosen;
		return {
			kind: "items",
			items: clone(items),
			collections: clone((globalThis as any).__znCollections),
			translator: used ? ref(used) : null,
			fallback,
			cache: endRun(),
			log: [...log],
		};
	} catch (e) {
		endRun();
		throw e;
	}
}

export async function importJob(p: ImportParams): Promise<ImportResultJob> {
	const Z = bootRuntime();
	noteLog(Z);
	await loadTranslatorsDir(p.translatorsDir);
	beginRun(p.limits);
	(globalThis as any).__znCollections = [];
	try {
		const probe = new Z.Translate.Import();
		probe.setString(p.text);
		let translators: any[];
		if (p.translatorID) {
			const t = Z.Translators.get(p.translatorID);
			if (!t || !(t.translatorType & 1)) throw new Error("not an import translator: " + p.translatorID);
			translators = [t];
		} else {
			translators = await probe.getTranslators();
		}
		if (!translators.length) throw new Error("No suitable import translator found for this text");
		let lastError: unknown = null;
		for (const t of translators) {
			const translate = new Z.Translate.Import();
			translate.setString(p.text);
			translate.setTranslator(t);
			(globalThis as any).__znCollections = [];
			try {
				const items: any[] = await translate.translate({ libraryID: false });
				return { items: clone(items), collections: clone((globalThis as any).__znCollections), translator: ref(t) };
			} catch (e) {
				lastError = e;
				Z.debug("Import using " + t.label + " failed: " + (e instanceof Error ? e.message : String(e)));
			}
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "import failed"));
	} finally {
		endRun();
	}
}

export async function exportJob(p: ExportParams): Promise<{ text: string; translator: TranslatorRef }> {
	const Z = bootRuntime();
	noteLog(Z);
	await loadTranslatorsDir(p.translatorsDir);
	beginRun(p.limits);
	try {
		const t = Z.Translators.get(p.translatorID);
		if (!t || !(t.translatorType & 2)) throw new Error("not an export translator: " + p.translatorID);
		const legacy = Z.Utilities.semverCompare("4.0.27", t.metadata.minVersion) > 0;
		const items = clone(p.items);
		for (const item of items) {
			// no library behind these items: the translator sees a URI made of the key
			if (!item.uri) {
				item.uri = item.key;
				delete item.key;
			}
			if (legacy) {
				if (item.dateAdded) item.dateAdded = Z.Date.isoToSQL(item.dateAdded);
				if (item.dateModified) item.dateModified = Z.Date.isoToSQL(item.dateModified);
				if (item.accessDate) item.accessDate = Z.Date.isoToSQL(item.accessDate);
			}
		}
		const translate = new Z.Translate.Export();
		translate.setTranslator(p.translatorID);
		translate.setItems(items);
		if (p.displayOptions) translate.setDisplayOptions(p.displayOptions);
		await new Promise<void>((resolve, reject) => {
			let lastError: unknown = null;
			translate.setHandler("error", (_t: unknown, e: unknown) => {
				lastError = e;
			});
			translate.setHandler("done", (_o: unknown, ok: boolean) => {
				if (ok) resolve();
				else reject(lastError instanceof Error ? lastError : new Error(String(lastError ?? "export failed")));
			});
			translate.translate();
		});
		return { text: String(translate.string ?? ""), translator: ref(t) };
	} finally {
		endRun();
	}
}
