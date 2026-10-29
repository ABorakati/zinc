import { BrowserWindow, Utils } from "electrobun/main";
import { normalize } from "node:path";

// Phase 0 spike: serve Zotero's reader (dev build) and document-worker from a
// local Bun server, open it in a WebView2 window, and let an injected probe
// report whether PDF rendering and Reading Mode work.
const ROOT = process.env.ZN_ROOT ?? "C:/Users/abora/zotero-next";
const PORT = 23120; // 23119 is Zotero's own port
const AUTOQUIT = process.env.ZN_SPIKE_AUTOQUIT === "1";

// Longest prefix first: the document worker lives under the reader's URL space
// because the dev reader loads it relative to reader.html.
const MOUNTS: [string, string][] = [
	["/reader/document-worker/", `${ROOT}/vendor/document-worker/build/`],
	["/reader/", `${ROOT}/vendor/reader/build/dev/`],
];

// Cross-origin isolation lets onnxruntime-web use threaded WASM.
const HEADERS = {
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Embedder-Policy": "require-corp",
};

async function serveFile(pathname: string): Promise<Response> {
	for (const [prefix, dir] of MOUNTS) {
		if (!pathname.startsWith(prefix)) continue;
		const rel = decodeURIComponent(pathname.slice(prefix.length)) || "index.html";
		const full = normalize(dir + rel);
		if (!full.startsWith(normalize(dir))) break;
		const file = Bun.file(full);
		if (!(await file.exists())) break;
		if (rel === "reader.html") {
			const html = (await file.text()).replace("<head>", '<head><script src="/spike/probe.js"></script>');
			return new Response(html, { headers: { ...HEADERS, "Content-Type": "text/html" } });
		}
		return new Response(file, { headers: HEADERS });
	}
	return new Response("not found", { status: 404, headers: HEADERS });
}

Bun.serve({
	hostname: "127.0.0.1",
	port: PORT,
	async fetch(req) {
		const { pathname } = new URL(req.url);
		if (pathname === "/spike/probe.js") {
			return new Response(Bun.file(`${ROOT}/spikes/probe.js`), {
				headers: { ...HEADERS, "Content-Type": "text/javascript" },
			});
		}
		if (pathname === "/spike/report" && req.method === "POST") {
			const report = await req.json();
			await Bun.write(`${ROOT}/spikes/electrobun-result.json`, JSON.stringify(report, null, 2));
			console.log("spike report:", JSON.stringify(report));
			if (AUTOQUIT) setTimeout(() => Utils.quit(0), 500);
			return new Response("ok", { headers: HEADERS });
		}
		return serveFile(pathname);
	},
});

new BrowserWindow({
	title: "zotero-next spike",
	url: `http://127.0.0.1:${PORT}/reader/reader.html?type=pdf`,
	frame: { width: 1200, height: 900, x: 100, y: 100 },
	hidden: process.env.ZN_SPIKE_HIDDEN === "1",
});
