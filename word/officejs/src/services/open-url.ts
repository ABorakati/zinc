// app.openUrl: opens http(s) links only, via Office.context.ui.openBrowserWindow with fallback to window.open.

function hasControlOrSpace(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c <= 0x20 || c === 0x7f) return true;
	}
	return false;
}

export function validateExternalUrl(raw: unknown): string {
	const u = raw === null || raw === undefined ? "" : String(raw);
	if (!(u.startsWith("https://") || u.startsWith("http://"))) {
		throw new Error("only http(s) links can be opened");
	}
	if (u.length > 4096 || hasControlOrSpace(u)) {
		throw new Error("invalid url");
	}
	let parsed: URL;
	try {
		parsed = new URL(u);
	} catch {
		throw new Error("invalid url");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("only http(s) links can be opened");
	}
	return u;
}

export function openExternalUrl(p: Record<string, unknown>, opener?: (url: string) => void): { ok: true } {
	const url = validateExternalUrl(p.url);
	if (opener) {
		opener(url);
		return { ok: true };
	}
	const officeUi = (globalThis as { Office?: any }).Office?.context?.ui;
	if (officeUi && typeof officeUi.openBrowserWindow === "function") {
		officeUi.openBrowserWindow(url);
		return { ok: true };
	}
	const win = (globalThis as { window?: { open?: (u: string, target?: string, features?: string) => unknown } }).window;
	if (win && typeof win.open === "function") {
		win.open(url, "_blank", "noopener,noreferrer");
		return { ok: true };
	}
	const globalOpen = (globalThis as { open?: (u: string, target?: string, features?: string) => unknown }).open;
	if (typeof globalOpen === "function") {
		globalOpen(url, "_blank", "noopener,noreferrer");
		return { ok: true };
	}
	throw new Error("no browser opener available");
}
