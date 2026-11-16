// Client for /api/cite/* (contract: core/src/cite/types.ts).
import { createSignal } from "solid-js";
import type {
	CiteFormat,
	CiteFormatResult,
	CiteMode,
	CiteSettings,
	CiteStyleInfo,
	CiteStylePreview,
} from "../../../../core/src/cite/types";
import { call, callRaw, get } from "../http";

export type { CiteFormat, CiteFormatResult, CiteMode, CiteSettings, CiteStyleInfo, CiteStylePreview };

/** Bumped whenever styles are installed/removed or the Quick Copy settings change, so other views can refresh. */
export const [citeRev, setCiteRev] = createSignal(0);
export const bumpCite = () => setCiteRev((n) => n + 1);

export interface StyleQuery {
	q?: string;
	format?: string;
	field?: string;
	installed?: boolean;
	quick?: boolean;
	limit?: number;
	offset?: number;
}
export interface StylePage {
	styles: CiteStyleInfo[];
	total: number;
	/** "fresh" | "cached" | "none": whether the Zotero Style Repository index could be loaded. */
	index: string;
}

function styleParams(o: StyleQuery): string {
	const p = new URLSearchParams();
	if (o.q) p.set("q", o.q);
	if (o.format) p.set("format", o.format);
	if (o.field) p.set("field", o.field);
	if (o.installed) p.set("installed", "1");
	if (o.quick) p.set("quick", "1");
	p.set("limit", String(o.limit ?? 100));
	if (o.offset) p.set("offset", String(o.offset));
	return p.toString();
}

export const citeApi = {
	/** Search installed styles and the Zotero Style Repository. */
	searchStyles: async (o: StyleQuery, signal?: AbortSignal): Promise<StylePage> => {
		const path = `/api/cite/styles?${styleParams(o)}`;
		try {
			const res = await callRaw("GET", path, signal);
			const styles = (await res.json()) as CiteStyleInfo[];
			return {
				styles,
				total: Number(res.headers.get("X-Total")) || styles.length,
				index: res.headers.get("X-Styles-Index") ?? "none",
			};
		} catch (e) {
			if (signal?.aborted) throw e;
			// no HTTP core (ZN_CORE_DIRECT): the list without the X-Total / X-Styles-Index headers
			const styles = await get<CiteStyleInfo[]>(path, signal);
			return { styles, total: styles.length, index: "fresh" };
		}
	},
	/** The default and installed styles (for quick pickers). */
	styles: (limit = 60) => citeApi.searchStyles({ quick: true, limit }).then((r) => r.styles),
	install: (id: string) => call<CiteStyleInfo>("POST", "/api/cite/styles/install", { id }),
	remove: (id: string) => call<{ id: string; removed: boolean }>("DELETE", `/api/cite/styles/${encodeURIComponent(id)}`),
	preview: (id: string, keys: string[] = [], signal?: AbortSignal) =>
		get<CiteStylePreview>(
			`/api/cite/styles/preview?id=${encodeURIComponent(id)}${keys.length ? `&items=${encodeURIComponent(keys.slice(0, 3).join(","))}` : ""}`,
			signal,
		),
	format: (b: { keys: string[]; style?: string; locale?: string; mode?: CiteMode; format?: CiteFormat | CiteFormat[] }) =>
		call<CiteFormatResult>("POST", "/api/cite/format", b),
	settings: () => get<CiteSettings>("/api/cite/settings"),
	putSettings: (quickCopy: Partial<CiteSettings["quickCopy"]>) => call<CiteSettings>("PUT", "/api/cite/settings", { quickCopy }),
};

export const LOCALES: [string, string][] = [
	["", "Style default"],
	["en-US", "English (US)"],
	["en-GB", "English (UK)"],
	["de-DE", "Deutsch"],
	["fr-FR", "Francais"],
	["es-ES", "Espanol"],
	["it-IT", "Italiano"],
	["nl-NL", "Nederlands"],
	["pt-BR", "Portugues (Brasil)"],
	["sv-SE", "Svenska"],
	["pl-PL", "Polski"],
	["ru-RU", "Russian"],
	["zh-CN", "Chinese (Simplified)"],
	["ja-JP", "Japanese"],
];
export const FILE: Record<CiteFormat, { ext: string; label: string }> = {
	html: { ext: "html", label: "HTML" },
	text: { ext: "txt", label: "Plain text" },
	rtf: { ext: "rtf", label: "Rich Text (RTF)" },
};
