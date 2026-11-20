// CSL styles and locales over Zinc core's /api/cite/* routes, matching word/addin/Styles.cs:
//   - style.search -> GET /api/cite/styles
//   - style.xml    -> GET /api/cite/styles/:id   (missing in core: documented in NOTES.md)
//   - locale.xml   -> GET /api/cite/locales/:lang (missing in core: documented in NOTES.md)

import type { CiteStyleInfo } from "../../../../core/src/cite/types";
import { CoreHttpError, type HttpClient } from "./http";

const STYLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const LOCALE_RE = /^[a-z]{2,3}(-[A-Z0-9]{2,4})?$/;

export interface StyleSearchRow {
	id: string;
	title: string;
	format: string | null;
	dependent: boolean;
	installed: boolean;
}

function int(v: unknown, def: number): number {
	if (v === null || v === undefined || v === "") return def;
	const n = typeof v === "number" ? v : Number(v);
	return Number.isFinite(n) ? Math.trunc(n) : def;
}

export async function searchStyles(http: HttpClient, p: Record<string, unknown>): Promise<StyleSearchRow[]> {
	const q = p.q === null || p.q === undefined ? "" : String(p.q);
	const limit = Math.min(Math.max(int(p.limit, 40), 1), 500);
	const trimmed = q.trim();
	const query = trimmed ? `/api/cite/styles?q=${encodeURIComponent(trimmed)}&limit=${limit}` : `/api/cite/styles?quick=1&limit=${limit}`;
	const styles = await http.getJson<CiteStyleInfo[]>(query);
	return styles.slice(0, limit).map((s) => ({
		id: s.id,
		title: s.title,
		format: s.format ?? null,
		dependent: Boolean(s.dependent),
		installed: Boolean(s.installed),
	}));
}

export async function getStyleXml(http: HttpClient, p: Record<string, unknown>): Promise<{ id: string; xml: string }> {
	const id = p.id === null || p.id === undefined ? "" : String(p.id);
	if (!STYLE_ID_RE.test(id)) throw new Error("invalid style id: " + id);
	const res = await http.getJson<{ id?: string; xml: string }>(`/api/cite/styles/${encodeURIComponent(id)}`);
	if (typeof res?.xml !== "string" || !/<style[\s>]/.test(res.xml)) {
		throw new Error("Zinc did not return a CSL style for " + id);
	}
	return { id, xml: res.xml };
}

export async function getLocaleXml(http: HttpClient, p: Record<string, unknown>): Promise<{ lang: string | null; xml: string | null }> {
	const lang = p.lang === null || p.lang === undefined ? null : String(p.lang);
	if (!lang || !LOCALE_RE.test(lang)) return { lang, xml: null };
	try {
		const res = await http.getJson<{ lang?: string; xml: string | null }>(`/api/cite/locales/${encodeURIComponent(lang)}`);
		return { lang, xml: typeof res?.xml === "string" ? res.xml : null };
	} catch (e) {
		// An unknown locale or offline GitHub mirrors Styles.cs returning xml: null; ZincUnavailableError still propagates.
		if (e instanceof CoreHttpError && (e.status === 404 || e.status === 502)) {
			return { lang, xml: null };
		}
		throw e;
	}
}
