// Client for /api/cite/* (contract: core/src/cite/types.ts) and clipboard helpers.
import { createSignal } from "solid-js";
import type {
	CiteFormat, CiteFormatResult, CiteMode, CiteSettings, CiteStyleInfo, CiteStylePreview,
} from "../../../core/src/cite/types";

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

async function reqRaw(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
	const res = await fetch("/api/cite" + path, {
		method,
		headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined,
		signal,
	});
	if (!res.ok) {
		let msg = res.statusText;
		try { msg = (await res.json()).error ?? msg; } catch { /* keep status text */ }
		throw new Error(msg);
	}
	return res;
}

async function req<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
	return (await reqRaw(method, path, body, signal)).json() as Promise<T>;
}

export const citeApi = {
	/** Search installed styles and the Zotero Style Repository. */
	searchStyles: async (o: StyleQuery, signal?: AbortSignal): Promise<StylePage> => {
		const p = new URLSearchParams();
		if (o.q) p.set("q", o.q);
		if (o.format) p.set("format", o.format);
		if (o.field) p.set("field", o.field);
		if (o.installed) p.set("installed", "1");
		if (o.quick) p.set("quick", "1");
		p.set("limit", String(o.limit ?? 100));
		if (o.offset) p.set("offset", String(o.offset));
		const res = await reqRaw("GET", `/styles?${p}`, undefined, signal);
		const styles = (await res.json()) as CiteStyleInfo[];
		return { styles, total: Number(res.headers.get("X-Total")) || styles.length, index: res.headers.get("X-Styles-Index") ?? "none" };
	},
	/** The default and installed styles (for quick pickers). */
	styles: (limit = 60) => citeApi.searchStyles({ quick: true, limit }).then((r) => r.styles),
	install: (id: string) => req<CiteStyleInfo>("POST", "/styles/install", { id }),
	remove: (id: string) => req<{ id: string; removed: boolean }>("DELETE", `/styles/${encodeURIComponent(id)}`),
	preview: (id: string, keys: string[] = [], signal?: AbortSignal) =>
		req<CiteStylePreview>("GET", `/styles/preview?id=${encodeURIComponent(id)}${keys.length ? `&items=${encodeURIComponent(keys.slice(0, 3).join(","))}` : ""}`, undefined, signal),
	format: (b: { keys: string[]; style?: string; locale?: string; mode?: CiteMode; format?: CiteFormat | CiteFormat[] }) =>
		req<CiteFormatResult>("POST", "/format", b),
	settings: () => req<CiteSettings>("GET", "/settings"),
	putSettings: (quickCopy: Partial<CiteSettings["quickCopy"]>) => req<CiteSettings>("PUT", "/settings", { quickCopy }),
};

/** Put HTML + plain text on the clipboard (rich paste into Word etc., plain paste elsewhere). */
export async function copyRich(html: string, text: string): Promise<void> {
	try {
		if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
			await navigator.clipboard.write([
				new ClipboardItem({
					"text/html": new Blob([html], { type: "text/html" }),
					"text/plain": new Blob([text], { type: "text/plain" }),
				}),
			]);
			return;
		}
	} catch { /* fall through to the execCommand path */ }
	const onCopy = (e: ClipboardEvent) => {
		e.preventDefault();
		e.clipboardData?.setData("text/html", html);
		e.clipboardData?.setData("text/plain", text);
	};
	document.addEventListener("copy", onCopy, true);
	const sel = document.createElement("textarea");
	sel.value = " ";
	sel.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
	document.body.appendChild(sel);
	sel.select();
	try {
		if (!document.execCommand("copy")) throw new Error("the browser refused the copy");
	} finally {
		document.removeEventListener("copy", onCopy, true);
		sel.remove();
	}
}

/** Trigger a file download from text via a temporary link. */
export function downloadText(filename: string, content: string, mime: string): void {
	const url = URL.createObjectURL(new Blob([content], { type: mime + ";charset=utf-8" }));
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
