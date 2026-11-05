// Builds the global `Zotero` the translate framework expects, the way translation-server's src/zotero.js,
// utilities.js and translators.js do, from the vendored zotero/translate + zotero/utilities + zotero-schema.
// Runs inside the translation worker only (it installs globals).
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installDomGlobals } from "./dom";
import { installHttp } from "./http";
import { SandboxManager } from "./sandbox";

const req = createRequire(import.meta.url);
// ZN_ZOTERO_VENDOR: the vendor/zotero folder shipped beside the packaged exe (the pre-bundled worker has no repo tree around it)
export const VENDOR_DIR = process.env.ZN_ZOTERO_VENDOR || join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "vendor", "zotero");

const TRANSLATOR_TYPES: Record<string, number> = { import: 1, export: 2, web: 4, search: 8 };
const INFO_RE = /^\s*{[\S\s]*?}\s*?[\r\n]/;

let booted = false;
let loadedDir: string | null = null;
let loadedCount = 0;

const rt = (p: string) => req(join(VENDOR_DIR, "translate", "src", p));
const ut = (p: string) => req(join(VENDOR_DIR, "utilities", p));

export function bootRuntime(): any {
	if (booted) return (globalThis as any).Zotero;
	booted = true;
	const g = globalThis as any;
	installDomGlobals();

	const prefs = new Map<string, unknown>([["downloadAssociatedFiles", false], ["automaticSnapshots", false]]);
	const Zotero: any = (g.Zotero = {
		isNode: true,
		isServer: true,
		locale: "en-US",
		version: "5.0.97",
		debug(message: unknown, level?: number) {
			Zotero.Debug.log(message, level);
		},
		logError(err: unknown) {
			Zotero.debug(err);
		},
		setTimeout,
		Prefs: {
			get: (k: string) => prefs.get(k),
			set: (k: string, v: unknown) => void prefs.set(k, v),
			clear: (k: string) => void prefs.delete(k),
		},
	});
	Zotero.requireTranslate = rt;
	Zotero.requireUtilities = ut;

	Zotero.Promise = rt("promise");
	Zotero.Debug = rt("debug");
	Zotero.Debug.init(process.env.ZN_TRANSLATE_DEBUG === "1");
	Zotero.Translators = {};
	// utilities.js (translation-server's wiring)
	Zotero.OpenURL = ut("openurl");
	Zotero.Date = ut("date");
	Zotero.Utilities = {
		...ut("utilities"),
		XRegExp: ut("xregexp-all"),
		Item: ut("utilities_item"),
	};
	Zotero.Utilities.Translate = rt("utilities_translate");
	ut("xregexp-unicode-zotero")(Zotero.Utilities.XRegExp);
	Zotero.Schema = ut("schema.js");
	Zotero.Schema.init(JSON.parse(readFileSync(join(VENDOR_DIR, "zotero-schema", "schema.json"), "utf8")));
	Zotero.Date.init(ut("resource/dateFormats.json"));
	Zotero.Translators = Object.assign(rt("translators"), makeTranslators(Zotero));
	Zotero.Translator = rt("translator");
	installHttp(Zotero);

	const Translate = rt("translation/translate");
	Zotero.Translate = Translate;
	Object.assign(Zotero.Translate, { SandboxManager });
	// itemSaver/itemGetter as translation-server's translate_item.js: items stay objects, nothing is written anywhere
	Zotero.Translate.ItemSaver = function () {};
	Zotero.Translate.ItemSaver.ATTACHMENT_MODE_IGNORE = 0;
	Zotero.Translate.ItemSaver.ATTACHMENT_MODE_DOWNLOAD = 1;
	Zotero.Translate.ItemSaver.ATTACHMENT_MODE_FILE = 2;
	Zotero.Translate.ItemSaver.prototype.saveCollection = function (collection: unknown) {
		((globalThis as any).__znCollections ||= []).push(collection);
	};
	Zotero.Translate.ItemSaver.prototype.saveItems = async function (jsonItems: unknown[]) {
		this.items = (this.items || []).concat(jsonItems);
		return jsonItems;
	};
	Zotero.Translate.ItemGetter = function (this: any) {
		this._itemsLeft = null;
		this._itemID = 1;
	};
	Zotero.Translate.ItemGetter.prototype = {
		setItems(items: any[]) {
			this._itemsLeft = items;
			this.numItems = items.length;
		},
		get numItemsRemaining() {
			return this._itemsLeft.length;
		},
		nextItem() {
			if (!this._itemsLeft.length) return false;
			let item = this._itemsLeft.shift();
			if (this.legacy) item = Zotero.Utilities.Item.itemToLegacyExportFormat(item);
			item.attachments ||= [];
			item.notes ||= [];
			for (const c of item.creators ?? []) {
				if (c.name) {
					c.lastName = c.name;
					c.firstName = "";
					delete c.name;
					c.fieldMode = 1;
				}
			}
			item.itemID = this._itemID++;
			return item;
		},
		nextCollection: () => false,
		exportFiles() {},
	};

	g.TLDS = rt("tlds"); // proxy.js reads it as a global
	Zotero.Proxies = rt("proxy").Proxies;
	Zotero.Proxy = rt("proxy").Proxy;
	const $rdf = rt("rdf/init");
	if (Zotero.RDF) Zotero.RDF.AJAW = $rdf;
	else Zotero.RDF = { AJAW: $rdf };
	Object.assign(Zotero, ut("cachedTypes"));
	Zotero.setTypeSchema(ut("resource/zoteroTypeSchemaData"));
	return Zotero;
}

/** Translators loaded from a folder of .js files (metadata header + code), as translation-server's translators.js. */
function makeTranslators(Zotero: any) {
	let cache: Record<string, any[]> = { import: [], export: [], web: [], search: [] };
	let byId: Record<string, any> = {};
	let initialized = false;

	const T = {
		async init(translators: any[]) {
			cache = { import: [], export: [], web: [], search: [] };
			byId = {};
			initialized = true;
			Zotero.Translators._cache = cache;
			Zotero.Translators._initialized = true;
			for (const info of translators) {
				try {
					const t = new Zotero.Translator(info);
					byId[t.translatorID] = t;
					for (const type in TRANSLATOR_TYPES) if (t.translatorType & TRANSLATOR_TYPES[type]!) cache[type]!.push(t);
				} catch (e) {
					Zotero.logError(e);
				}
			}
			for (const type in cache) cache[type]!.sort((a, b) => a.priority - b.priority || 0);
			Zotero.debug(`Translators initialized with ${translators.length} loaded`);
		},
		get(id: string) {
			if (!initialized) throw new Error("translators not initialised");
			return byId[id] ?? false;
		},
		async getAllForType(type: string) {
			const list = cache[type]!.slice();
			await new Zotero.Translators.CodeGetter(list).getAll();
			return list;
		},
		getCodeForTranslator: Zotero.Promise.method(function (translator: any) {
			if (translator.code) return translator.code;
			throw new Error(`Code for translator ${translator.translatorID} is missing`);
		}),
		serialize(translator: any, properties: string[]): any {
			if (translator.length !== undefined) return Array.from(translator, (t) => T.serialize(t, properties));
			const out: Record<string, unknown> = {};
			for (const p of properties) out[p] = translator[p];
			return out;
		},
	};
	return T;
}

/** Reads every translator in `dir` (header JSON + code) and loads them into Zotero.Translators (once per folder). */
export async function loadTranslatorsDir(dir: string): Promise<number> {
	const Zotero = bootRuntime();
	if (loadedDir === dir) return loadedCount;
	const infos: any[] = [];
	for (const name of readdirSync(dir)) {
		if (name[0] === "." || !name.endsWith(".js")) continue;
		let data = readFileSync(join(dir, name), "utf8");
		if (data[0] === "﻿") data = data.slice(1);
		const at = data.indexOf('"lastUpdated"');
		if (at === -1) continue;
		const m = INFO_RE.exec(data.slice(0, at + 50));
		if (!m) continue;
		try {
			const info = JSON.parse(m[0]);
			info.code = data;
			info.cacheCode = true;
			info.fileName = name;
			infos.push(info);
		} catch {
			/* header is not JSON: skip, like Zotero */
		}
	}
	await Zotero.Translators.init(infos);
	loadedDir = dir;
	loadedCount = infos.length;
	return infos.length;
}
