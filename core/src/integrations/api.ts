// Install / uninstall the Word add-in and the browser connector from Settings, like Zotero's own buttons.
//   GET  /api/integrations                     -> IntegrationsStatus
//   POST /api/integrations/word/install|uninstall
//   POST /api/integrations/chrome/install|uninstall
//   POST /api/integrations/chrome/open          -> opens chrome://extensions and the extension's folder (the user
//                                                  clicks "Load unpacked": Chrome lets no program do that step)
// The installers are the per-user scripts in the repo (word/install.ps1, connector-host/install.ps1): HKCU only,
// no admin rights. Running them from the app (not a sandboxed shell) keeps their files in the real AppData.
import { existsSync } from "node:fs";
import { join } from "node:path";

let repo = process.env.ZN_REPO ?? "C:/Users/abora/zotero-next";
/** The checkout holding word/ and connector-host/ (the app passes its own). */
export function setIntegrationsRepo(path: string): void {
	repo = path;
}

const WORD_ADDIN_KEY = "HKCU\\Software\\Microsoft\\Office\\Word\\Addins\\ZoteroNext.WordAddIn";
const CHROME_HOST_KEY = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.zotero_next.connector_host";
const EDGE_HOST_KEY = "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.zotero_next.connector_host";
export const CONNECTOR_EXTENSION_ID = "pakgagonakcalfbmckaolkpidcojacaf";

export interface IntegrationsStatus {
	word: { installed: boolean; available: boolean; wordRunning: boolean; problem?: string };
	/** The browser connector (one extension and helper for Chrome and Edge). hostInstalled: for every browser found. */
	chrome: {
		hostInstalled: boolean; available: boolean; extensionDir: string; problem?: string;
		chromeFound: boolean; edgeFound: boolean; chromeHost: boolean; edgeHost: boolean;
	};
}

const paths = () => ({
	wordInstall: join(repo, "word", "install.ps1"),
	wordUninstall: join(repo, "word", "uninstall.ps1"),
	wordBuilt: join(repo, "word", "dist", "addin", "ZoteroNextWord.dll"),
	hostInstall: join(repo, "connector-host", "install.ps1"),
	hostUninstall: join(repo, "connector-host", "uninstall.ps1"),
	hostExe: join(repo, "connector-host", "dist", "zotero-next-host.exe"),
	extensionDir: join(repo, "..", "zotero-next-connector", "build", "manifestv3"),
});

type Browser = "chrome" | "edge";
function browserExe(b: Browser): string | null {
	const [vendor, product, exe] = b === "chrome" ? ["Google", "Chrome", "chrome.exe"] : ["Microsoft", "Edge", "msedge.exe"];
	for (const p of [
		join(process.env.ProgramFiles ?? "C:\\Program Files", vendor, product, "Application", exe),
		join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", vendor, product, "Application", exe),
		join(process.env.LOCALAPPDATA ?? "", vendor, product, "Application", exe),
	]) if (existsSync(p)) return p;
	return null;
}

async function run(cmd: string[], timeoutMs = 120_000): Promise<{ code: number; out: string }> {
	const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", windowsHide: true });
	const timer = setTimeout(() => p.kill(), timeoutMs);
	const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
	const code = await p.exited;
	clearTimeout(timer);
	return { code, out: (out + err).trim() };
}

const regKeyExists = async (key: string) => (await run(["reg", "query", key], 10_000)).code === 0;
const ps = (script: string) => run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script]);

async function wordRunning(): Promise<boolean> {
	const r = await run(["tasklist", "/FI", "IMAGENAME eq WINWORD.EXE", "/NH"], 10_000);
	return /WINWORD\.EXE/i.test(r.out);
}

export async function integrationsStatus(): Promise<IntegrationsStatus> {
	const p = paths();
	const [wordInstalled, chromeHost, edgeHost, running] = await Promise.all([regKeyExists(WORD_ADDIN_KEY), regKeyExists(CHROME_HOST_KEY), regKeyExists(EDGE_HOST_KEY), wordRunning()]);
	const chromeFound = browserExe("chrome") !== null, edgeFound = browserExe("edge") !== null;
	// installed = registered for every browser on this PC (an older install registered Chrome only)
	const hostInstalled = (chromeHost || !chromeFound) && (edgeHost || !edgeFound) && (chromeHost || edgeHost);
	const wordAvail = existsSync(p.wordInstall) && existsSync(p.wordBuilt);
	const chromeAvail = existsSync(p.hostInstall) && existsSync(p.hostExe) && existsSync(join(p.extensionDir, "manifest.json"));
	return {
		word: {
			installed: wordInstalled, available: wordAvail, wordRunning: running,
			...(wordAvail ? {} : { problem: `The add-in is not built (${p.wordBuilt}); run word\\build.ps1 in the repo.` }),
		},
		chrome: {
			hostInstalled, available: chromeAvail, extensionDir: p.extensionDir, chromeFound, edgeFound, chromeHost, edgeHost,
			...(chromeAvail ? {} : { problem: "The connector or its helper is not built (connector-host\\dist, zotero-next-connector\\build)." }),
		},
	};
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

/** Last lines of a script's output, for an error message. */
const tail = (s: string) => s.split(/\r?\n/).filter(Boolean).slice(-4).join(" · ").slice(0, 400);

export async function handleIntegrationsApi(req: Request): Promise<Response | null> {
	const { pathname } = new URL(req.url);
	if (!pathname.startsWith("/api/integrations")) return null;
	const parts = pathname.split("/").filter(Boolean).slice(2);
	if (parts.length === 0) {
		if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
		return json(await integrationsStatus());
	}
	if (req.method !== "POST" || parts.length !== 2) return json({ error: "not found" }, 404);
	const [what, action] = parts;
	const p = paths();

	if (what === "word" && (action === "install" || action === "uninstall")) {
		// Word holds the add-in's files and registry while it runs (as Zotero's own installer also requires)
		if (await wordRunning()) return json({ error: "Close Microsoft Word first, then try again." }, 409);
		if (action === "install" && !existsSync(p.wordBuilt)) return json({ error: "The Word add-in is not built yet (run word\\build.ps1)." }, 409);
		const r = await ps(action === "install" ? p.wordInstall : p.wordUninstall);
		if (r.code !== 0) return json({ error: `The ${action}er failed: ${tail(r.out)}` }, 500);
		return json({ ok: true, status: await integrationsStatus() });
	}
	if (what === "chrome" && (action === "install" || action === "uninstall")) {
		if (action === "install" && !existsSync(p.hostExe)) return json({ error: "The connector helper is not built yet (connector-host: bun run build)." }, 409);
		const r = await ps(action === "install" ? p.hostInstall : p.hostUninstall);
		if (r.code !== 0) return json({ error: `The ${action}er failed: ${tail(r.out)}` }, 500);
		return json({ ok: true, status: await integrationsStatus() });
	}
	if (what === "chrome" && action === "open") {
		// ?browser=edge|chrome (default: Edge if Chrome is missing)
		const asked = new URL(req.url).searchParams.get("browser");
		const browser: Browser = asked === "edge" || (asked !== "chrome" && !browserExe("chrome")) ? "edge" : "chrome";
		const exe = browserExe(browser);
		if (exe) Bun.spawn([exe, `${browser}://extensions`], { stdout: "ignore", stderr: "ignore" });
		if (existsSync(p.extensionDir)) Bun.spawn(["explorer.exe", p.extensionDir.replace(/\//g, "\\")], { stdout: "ignore", stderr: "ignore" });
		return json({ ok: true, browser, opened: !!exe, chromeOpened: !!exe, extensionDir: p.extensionDir });
	}
	return json({ error: "not found" }, 404);
}
