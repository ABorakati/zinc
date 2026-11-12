// The offscreen document of the browser library (offscreen.html, created by the extension's service worker on {zincEnsureDb: true}, see
// CONTRACT.md). It owns the one database worker and is the extension's only door to it: the library tab and the connector connect a
// port named "zinc-db" (chrome.runtime.connect) and speak the native host's frames over it; this page forwards each frame to the
// worker (db-worker.ts) and each reply back to the port it belongs to, and sends `changed` notices to every port.
declare const chrome: {
	runtime: {
		onConnect: { addListener(f: (port: Port) => void): void };
	};
};
interface Port {
	name: string;
	postMessage(m: unknown): void;
	onMessage: { addListener(f: (m: unknown) => void): void };
	onDisconnect: { addListener(f: () => void): void };
}

const ports = new Map<number, Port>();
let nextPort = 1;
let state: { t: "starting" } | { t: "ready" } | { t: "failed"; error: string } = { t: "starting" };
let lastChanged: unknown = null;

const worker = new Worker(new URL("db-worker.js", location.href), { type: "module" });
worker.onmessage = (e: MessageEvent) => {
	const d = e.data as { p?: number; m?: unknown; t?: string; error?: string };
	if (d.p !== undefined) { ports.get(d.p)?.postMessage(d.m); return; }
	if (d.t === "ready") state = { t: "ready" };
	else if (d.t === "failed") state = { t: "failed", error: String(d.error) };
	else if (d.t === "changed") {
		lastChanged = d;
		for (const p of ports.values()) p.postMessage(d);
	}
};
worker.onerror = (e) => { state = { t: "failed", error: e.message || "the database worker stopped" }; };

chrome.runtime.onConnect.addListener((port) => {
	if (port.name !== "zinc-db") return;
	const id = nextPort++;
	ports.set(id, port);
	port.onMessage.addListener((m) => worker.postMessage({ p: id, m }));
	port.onDisconnect.addListener(() => { ports.delete(id); worker.postMessage({ p: id, gone: true }); });
});

// for automated checks (the offscreen document's own page)
(globalThis as Record<string, unknown>).znOffscreen = { ports, get state() { return state; }, get lastChanged() { return lastChanged; } };
