// Routes under /api/cite/. Contract and semantics: ./types.ts. Returns null for other paths.
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ZoteroItemData } from "../api-types";
import { HttpError } from "../db";
import { type FetchFn, StyleStore, formatItems, previewItems } from "./engine";
import {
	type CiteFormat,
	type CiteFormatRequest,
	type CiteFormatResult,
	type CiteMode,
	type CiteSettings,
	type CiteStylePreview,
	DEFAULT_SETTINGS,
	type QuickCopySettings,
} from "./types";

const MAX_KEYS = 5000;
const MODES: CiteMode[] = ["bibliography", "citation"];
const FORMATS: CiteFormat[] = ["html", "text", "rtf"];

export interface CiteService {
	store: StyleStore;
	settingsFile: string;
	getSettings(): CiteSettings;
	putSettings(patch: unknown): CiteSettings;
	format(db: Database, req: CiteFormatRequest): Promise<CiteFormatResult>;
	preview(db: Database, style: string, keys: string[], locale?: string): Promise<CiteStylePreview>;
}

const services = new WeakMap<Database, CiteService>();

/** The cite service for a library DB (data lives next to the DB file). `dir`/`fetch` are for tests. */
export function citeService(db: Database, opts: { dir?: string; fetch?: FetchFn } = {}): CiteService {
	const cached = services.get(db);
	if (cached && !opts.dir && !opts.fetch) return cached;
	const file = (db as unknown as { filename?: string }).filename;
	const dir = opts.dir ?? (file && file !== ":memory:" ? dirname(file) : join(process.env.TEMP ?? ".", "zotero-next-cite"));
	mkdirSync(dir, { recursive: true });
	const store = new StyleStore(dir, opts.fetch);
	const settingsFile = join(dir, "cite-settings.json");
	const svc: CiteService = {
		store,
		settingsFile,
		getSettings: () => loadSettings(settingsFile),
		putSettings: (patch) => {
			const next = mergeSettings(loadSettings(settingsFile), patch);
			writeFileSync(settingsFile, JSON.stringify(next, null, 2));
			return next;
		},
		format: (d, req) => formatRequest(d, svc, req),
		preview: (d, style, keys, locale) => previewRequest(d, svc, style, keys, locale),
	};
	services.set(db, svc);
	return svc;
}

function loadSettings(file: string): CiteSettings {
	let raw: unknown = null;
	if (existsSync(file)) {
		try {
			raw = JSON.parse(readFileSync(file, "utf8"));
		} catch {}
	}
	return mergeSettings({ quickCopy: { ...DEFAULT_SETTINGS.quickCopy } }, raw, false);
}

function mergeSettings(base: CiteSettings, patch: unknown, strict = true): CiteSettings {
	const qc: QuickCopySettings = { ...base.quickCopy };
	const p = (patch as { quickCopy?: Record<string, unknown> } | null)?.quickCopy;
	if (strict && patch !== null && typeof patch === "object" && !p && Object.keys(patch).length) {
		throw new HttpError(400, "expected {quickCopy: {...}}");
	}
	if (p && typeof p === "object") {
		const bad = (f: string) => {
			if (strict) throw new HttpError(400, `invalid quickCopy.${f}`);
		};
		if (p.style !== undefined) {
			if (typeof p.style === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(p.style)) qc.style = p.style;
			else bad("style");
		}
		if (p.locale !== undefined) {
			if (typeof p.locale === "string" && (p.locale === "" || /^[a-z]{2,3}(-[A-Z0-9]{2,4})?$/.test(p.locale))) qc.locale = p.locale;
			else bad("locale");
		}
		if (p.mode !== undefined) {
			if (MODES.includes(p.mode as CiteMode)) qc.mode = p.mode as CiteMode;
			else bad("mode");
		}
		if (p.format !== undefined) {
			if (FORMATS.includes(p.format as CiteFormat)) qc.format = p.format as CiteFormat;
			else bad("format");
		}
	}
	return { quickCopy: qc };
}

/** Top-level item data for each key, in order; children resolve to their parent; duplicates, missing and trashed dropped. */
export function loadItems(db: Database, keys: string[]): ZoteroItemData[] {
	const out: ZoteroItemData[] = [];
	const seen = new Set<string>();
	type Row = { key: string; item_type: string; parent_key: string | null; data: string; deleted: number };
	const get = db.query("SELECT key, item_type, parent_key, data, deleted FROM items WHERE key = ?");
	for (const k of keys) {
		let row = get.get(k) as Row | null;
		if (row?.parent_key) row = get.get(row.parent_key) as Row | null;
		if (!row || row.deleted || row.item_type === "note" || seen.has(row.key)) continue;
		seen.add(row.key);
		const data = JSON.parse(row.data) as ZoteroItemData;
		data.key = row.key;
		out.push(data);
	}
	return out;
}

async function formatRequest(db: Database, svc: CiteService, req: CiteFormatRequest): Promise<CiteFormatResult> {
	if (!Array.isArray(req?.keys) || req.keys.some((k) => typeof k !== "string"))
		throw new HttpError(400, "keys must be an array of strings");
	if (req.keys.length === 0) throw new HttpError(400, "keys must not be empty");
	if (req.keys.length > MAX_KEYS) throw new HttpError(400, `at most ${MAX_KEYS} items per request`);
	const qc = svc.getSettings().quickCopy;
	const mode = req.mode ?? "bibliography";
	if (!MODES.includes(mode)) throw new HttpError(400, "mode must be 'bibliography' or 'citation'");
	const formats = Array.isArray(req.format) ? req.format : [req.format ?? "html"];
	if (formats.length === 0 || formats.some((f) => !FORMATS.includes(f))) throw new HttpError(400, "format must be html, text or rtf");
	const items = loadItems(db, req.keys);
	if (items.length === 0) throw new HttpError(404, "none of the items exist (or they are notes / in the trash)");
	const res = await formatItems(svc.store, {
		items,
		style: req.style || qc.style,
		locale: req.locale ?? qc.locale,
		mode,
		formats: [...new Set(formats)],
	});
	const out: CiteFormatResult = { keys: items.map((i) => i.key) };
	for (const f of formats) out[f] = res[f];
	return out;
}

async function previewRequest(db: Database, svc: CiteService, style: string, keys: string[], locale?: string): Promise<CiteStylePreview> {
	if (!style) throw new HttpError(400, "id required");
	if (keys.length > MAX_KEYS) throw new HttpError(400, `at most ${MAX_KEYS} items`);
	let items = keys.length ? loadItems(db, keys.slice(0, 50)).slice(0, MAX_PREVIEW) : [];
	let sample = false;
	if (items.length === 0) items = librarySamples(db);
	if (items.length === 0) {
		items = SAMPLE_ITEMS;
		sample = true;
	}
	const info = await svc.store.styleInfo(style);
	const r = await previewItems(svc.store, { items, style, locale: locale || svc.getSettings().quickCopy.locale || undefined });
	return {
		id: style,
		title: info.title,
		note: r.note,
		installed: info.installed,
		citations: r.citations,
		bibliography: r.bibliography,
		keys: items.map((i) => i.key),
		sample,
	};
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
}

const flag = (v: string | null): boolean => v === "1" || v === "true";

async function installBody(svc: CiteService, b: any) {
	if (typeof b?.id !== "string" || !b.id) throw new HttpError(400, "id required");
	return svc.store.install(b.id);
}

const MAX_PREVIEW = 3;

/** Built-in references, used when the library has nothing suitable to show. */
const SAMPLE_ITEMS = [
	{
		key: "SAMPLE01",
		itemType: "journalArticle",
		title: "Enhanced recovery after surgery in liver transplantation",
		creators: [
			{ creatorType: "author", firstName: "Jane", lastName: "Smith" },
			{ creatorType: "author", firstName: "Alan B", lastName: "Jones" },
		],
		publicationTitle: "Journal of Transplant Medicine",
		journalAbbreviation: "J Transplant Med",
		volume: "38",
		issue: "5",
		pages: "123-130",
		date: "2020-03-15",
		DOI: "10.1000/xyz123",
	},
	{
		key: "SAMPLE02",
		itemType: "book",
		title: "Principles of Clinical Research",
		creators: [{ creatorType: "author", firstName: "Maria", lastName: "Garcia" }],
		publisher: "Academic Press",
		place: "London",
		date: "2018",
		edition: "3",
	},
	{
		key: "SAMPLE03",
		itemType: "journalArticle",
		title: "Citation practices across scientific disciplines",
		creators: [
			{ creatorType: "author", firstName: "Chen", lastName: "Wei" },
			{ creatorType: "author", firstName: "Robert", lastName: "Miller" },
			{ creatorType: "author", firstName: "Aisha", lastName: "Khan" },
		],
		publicationTitle: "Scholarly Communication Review",
		volume: "12",
		issue: "2",
		pages: "45-61",
		date: "2022-06",
		DOI: "10.1000/abc456",
	},
] as unknown as ZoteroItemData[];

const PREFERRED_TYPES = ["journalArticle", "book", "bookSection", "conferencePaper", "webpage", "report"];

/** A few varied, well-filled library items to show a style on. */
function librarySamples(db: Database): ZoteroItemData[] {
	let rows: { key: string; data: string }[] = [];
	try {
		rows = db
			.query(
				"SELECT key, data FROM items WHERE deleted = 0 AND parent_key IS NULL AND item_type NOT IN ('note','attachment','annotation') ORDER BY rowid DESC LIMIT 120",
			)
			.all() as typeof rows;
	} catch {
		return [];
	}
	const good: ZoteroItemData[] = [];
	for (const r of rows) {
		try {
			const d = JSON.parse(r.data) as ZoteroItemData;
			d.key = r.key;
			if (d.title && (d.creators?.length ?? 0) > 0 && d.date) good.push(d);
		} catch {}
	}
	const picked: ZoteroItemData[] = [];
	for (const t of PREFERRED_TYPES) {
		const hit = good.find((d) => d.itemType === t && !picked.includes(d));
		if (hit) picked.push(hit);
		if (picked.length === MAX_PREVIEW) return picked;
	}
	for (const d of good) {
		if (picked.length === MAX_PREVIEW) break;
		if (!picked.includes(d)) picked.push(d);
	}
	return picked;
}

export async function handleCiteApi(req: Request, db: Database): Promise<Response | null> {
	const url = new URL(req.url);
	if (!url.pathname.startsWith("/api/cite/")) return null;
	try {
		const parts = url.pathname.split("/").filter(Boolean).slice(2);
		const svc = citeService(db);
		const m = req.method;
		const body = async (): Promise<any> => {
			try {
				return await req.json();
			} catch {
				throw new HttpError(400, "invalid JSON body");
			}
		};
		if (parts[0] === "styles" && parts.length === 2 && parts[1] === "install") {
			if (m !== "POST") throw new HttpError(405, "method not allowed");
			return json(await installBody(svc, await body()));
		}
		if (parts[0] === "styles" && parts.length === 2 && parts[1] === "preview") {
			if (m !== "GET") throw new HttpError(405, "method not allowed");
			const sp = url.searchParams;
			const keys = (sp.get("items") ?? "")
				.split(",")
				.map((k) => k.trim())
				.filter(Boolean);
			return json(await svc.preview(db, sp.get("id") ?? "", keys, sp.get("locale") ?? undefined));
		}
		if (parts[0] === "styles" && parts.length === 2 && m === "GET") {
			// a style's CSL XML (the Office.js Word add-in formats in its task pane): installed styles from disk, others through
			// the preview cache, so looking at a style never installs it
			const id = decodeURIComponent(parts[1]!);
			return json({ id, xml: await svc.store.styleXml(id, "preview") });
		}
		if (parts[0] === "locales" && parts.length === 2) {
			if (m !== "GET") throw new HttpError(405, "method not allowed");
			const lang = decodeURIComponent(parts[1]!);
			return json({ lang, xml: await svc.store.locale(lang) });
		}
		if (parts[0] === "styles" && parts.length === 2) {
			if (m !== "DELETE") throw new HttpError(405, "method not allowed");
			const id = decodeURIComponent(parts[1]!);
			if (svc.getSettings().quickCopy.style === id)
				throw new HttpError(409, `"${id}" is the Quick Copy style; choose another style first`);
			svc.store.remove(id);
			return json({ id, removed: true });
		}
		if (parts.length === 1 && parts[0] === "styles") {
			if (m === "GET") {
				const sp = url.searchParams;
				const r = await svc.store.searchStyles({
					q: sp.get("q") ?? "",
					format: sp.get("format") || undefined,
					field: sp.get("field") || undefined,
					installed: flag(sp.get("installed")),
					quick: flag(sp.get("quick")),
					limit: Number(sp.get("limit")) || 50,
					offset: Number(sp.get("offset")) || 0,
				});
				return json(r.styles, 200, { "X-Total": String(r.total), "X-Styles-Index": r.index });
			}
			if (m === "POST") return json(await installBody(svc, await body()));
			throw new HttpError(405, "method not allowed");
		}
		if (parts.length === 1 && parts[0] === "format") {
			if (m !== "POST") throw new HttpError(405, "method not allowed");
			return json(await svc.format(db, await body()));
		}
		if (parts.length === 1 && parts[0] === "settings") {
			if (m === "GET") return json(svc.getSettings());
			if (m === "PUT") return json(svc.putSettings(await body()));
			throw new HttpError(405, "method not allowed");
		}
		throw new HttpError(404, "not found");
	} catch (e) {
		if (e instanceof HttpError) return json({ error: e.message }, e.status);
		return json({ error: e instanceof Error ? e.message : String(e) }, 500);
	}
}
