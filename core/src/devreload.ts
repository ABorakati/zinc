// Development live reload: watch the static mount folders and tell open pages to reload when their files change.
// HTML pages get a small script (see inject) that listens on /__dev/reload for changes under their own mount,
// so a rebuilt reader reloads its tab without restarting or reinstalling the app.
import { watch, type FSWatcher } from "node:fs";
import type { Mount } from "./server";

const norm = (p: string) => (p.startsWith("/") ? p : "/" + p).replace(/\/?$/, "/");

export function createDevReload(mounts: Mount[], debounceMs = 500) {
	const clients = new Set<{ prefix: string; send: (msg: string) => void }>();
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	const watchers: FSWatcher[] = [];

	const changed = (prefix: string) => {
		// a build writes many files (and empties the folder first): wait until it has gone quiet
		clearTimeout(timers.get(prefix));
		timers.set(prefix, setTimeout(() => {
			for (const c of clients) if (c.prefix === prefix) c.send("data: reload\n\n");
		}, debounceMs));
	};
	const watchMount = (m: Mount) => {
		try {
			const w = watch(m.dir, { recursive: true }, () => changed(norm(m.prefix)));
			w.on("error", () => { w.close(); setTimeout(() => watchMount(m), 2000); });
			watchers.push(w);
		}
		catch { setTimeout(() => watchMount(m), 2000); } // folder missing mid-build: try again
	};
	for (const m of mounts) watchMount(m);

	return {
		/** GET /__dev/reload?prefix=/reader-next/ -> server-sent events, one "reload" per change. */
		handle(req: Request): Response | null {
			const url = new URL(req.url);
			if (url.pathname !== "/__dev/reload") return null;
			const prefix = norm(url.searchParams.get("prefix") ?? "/");
			let client: { prefix: string; send: (msg: string) => void } | undefined;
			let ping: ReturnType<typeof setInterval> | undefined;
			const stream = new ReadableStream<string>({
				start(ctrl) {
					client = { prefix, send: (msg) => { try { ctrl.enqueue(msg); } catch { /* closed */ } } };
					clients.add(client);
					ctrl.enqueue(": connected\n\n");
					ping = setInterval(() => client!.send(": ping\n\n"), 20000);
				},
				cancel() { clearInterval(ping); if (client) clients.delete(client); },
			});
			return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
		},
		/** Add the reload listener to an HTML page served from `prefix`. */
		async inject(res: Response, prefix: string): Promise<Response> {
			if (!(res.headers.get("Content-Type") ?? "").startsWith("text/html")) return res;
			const script = `<script>(()=>{const go=()=>{const es=new EventSource("/__dev/reload?prefix=${encodeURIComponent(norm(prefix))}");`
				+ `es.onmessage=()=>location.reload();es.onerror=()=>{es.close();setTimeout(go,2000)}};go()})()</script>`;
			const html = await res.text();
			const out = html.includes("</body>") ? html.replace("</body>", script + "</body>") : html + script;
			return new Response(out, { status: res.status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
		},
		close() { for (const w of watchers) w.close(); for (const t of timers.values()) clearTimeout(t); },
	};
}
