// Routes under /api/cite/. Contract and semantics: ./types.ts. Returns null for other paths.
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ZoteroItemData } from "../api-types";
import { HttpError } from "../db";
import { type FetchFn, StyleStore, formatItems } from "./engine";
import {
	type CiteFormat,
	type CiteFormatRequest,
	type CiteFormatResult,
	type CiteMode,
	type CiteSettings,
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
	if (!Array.isArray(req?.keys) || req.keys.some((k) => typeof k !== "string")) throw new HttpError(400, "keys must be an array of strings");
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

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
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
		if (parts.length === 1 && parts[0] === "styles") {
			if (m === "GET") {
				const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
				return json(await svc.store.search(url.searchParams.get("q") ?? "", limit));
			}
			if (m === "POST") {
				const b = await body();
				if (typeof b?.id !== "string" || !b.id) throw new HttpError(400, "id required");
				return json(await svc.store.install(b.id));
			}
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
