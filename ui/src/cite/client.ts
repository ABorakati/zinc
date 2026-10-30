// Client for /api/cite/* (contract: core/src/cite/types.ts) and clipboard helpers.
import type {
	CiteFormat, CiteFormatResult, CiteMode, CiteSettings, CiteStyleInfo,
} from "../../../core/src/cite/types";

export type { CiteFormat, CiteFormatResult, CiteMode, CiteSettings, CiteStyleInfo };

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch("/api/cite" + path, {
		method,
		headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	if (!res.ok) {
		let msg = res.statusText;
		try { msg = (await res.json()).error ?? msg; } catch { /* keep status text */ }
		throw new Error(msg);
	}
	return res.json() as Promise<T>;
}

export const citeApi = {
	styles: (q: string, limit = 40) => req<CiteStyleInfo[]>("GET", `/styles?q=${encodeURIComponent(q)}&limit=${limit}`),
	install: (id: string) => req<CiteStyleInfo>("POST", "/styles", { id }),
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
