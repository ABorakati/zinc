// A Host that talks to the C# test harness (word/harness) over a loopback TCP socket: the same JSON requests the
// WebView2 sidebar sends, served by the add-in's Bridge against a private invisible Word.
import { join } from "node:path";
import type { Host } from "../src/host";

/** Build output the tests use: ZN_WORD_DIST (a scratch build, laid out like word/dist) or the repo's word/dist. */
export const WORD_DIST = process.env.ZN_WORD_DIST || join(import.meta.dir, "..", "..", "dist");
export const HARNESS_EXE = join(WORD_DIST, "harness", "ZoteroNextWord.Harness.exe");
export const SIDEBAR_DIR = join(WORD_DIST, "addin", "sidebar");

type Sock = { write(data: string): number; end(): void };

function freePort(): number {
	const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
	const p = s.port;
	s.stop(true);
	return p;
}

export class HarnessHost implements Host {
	private proc!: ReturnType<typeof Bun.spawn>;
	private sock!: Sock;
	private seq = 0;
	private buf = "";
	private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
	private handlers = new Map<string, ((d: any) => void)[]>();

	static async start(args: { db: string; settings: string; cache: string }): Promise<HarnessHost> {
		const h = new HarnessHost();
		const port = freePort();
		h.proc = Bun.spawn([HARNESS_EXE, "--db", args.db, "--settings", args.settings, "--cache", args.cache, "--port", String(port)], {
			env: { ...process.env, ZN_SIDEBAR_DIR: SIDEBAR_DIR },
			stdin: "ignore",
			stdout: "inherit",
			stderr: "inherit",
		});
		let lastErr: unknown;
		for (let i = 0; i < 100; i++) {
			try {
				h.sock = (await Bun.connect({
					hostname: "127.0.0.1",
					port,
					socket: {
						data: (_s, data) => h.onData(Buffer.from(data).toString("utf8")),
						close: () => h.failAll("harness connection closed"),
						error: (_s, e) => h.failAll(String(e)),
					},
				})) as unknown as Sock;
				return h;
			} catch (e) {
				lastErr = e;
				await new Promise((r) => setTimeout(r, 100));
			}
		}
		h.proc.kill();
		throw new Error("could not connect to the harness: " + String(lastErr));
	}

	private onData(chunk: string) {
		this.buf += chunk;
		let nl: number;
		while ((nl = this.buf.indexOf("\n")) >= 0) {
			const line = this.buf.slice(0, nl).trim();
			this.buf = this.buf.slice(nl + 1);
			if (!line) continue;
			let m: any;
			try {
				m = JSON.parse(line);
			} catch {
				continue;
			}
			const p = this.pending.get(m.id);
			if (!p) continue;
			this.pending.delete(m.id);
			if (m.error) p.reject(new Error(m.error.message));
			else p.resolve(m.result);
		}
	}

	private failAll(msg: string) {
		for (const p of this.pending.values()) p.reject(new Error(msg));
		this.pending.clear();
	}

	call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		const id = ++this.seq;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.sock.write(JSON.stringify({ id, method, params }) + "\n");
		});
	}

	on(event: string, cb: (d: any) => void) {
		const l = this.handlers.get(event) ?? [];
		l.push(cb);
		this.handlers.set(event, l);
	}

	/** Ask Word to quit, then make sure the harness process is gone. */
	async stop(): Promise<void> {
		try {
			await Promise.race([this.call("h.quit"), new Promise((r) => setTimeout(r, 20000))]);
		} catch {}
		try {
			this.sock.end();
		} catch {}
		const code = await Promise.race([this.proc.exited, new Promise<number>((r) => setTimeout(() => r(-1), 8000))]);
		if (code === -1) this.proc.kill();
	}
}
