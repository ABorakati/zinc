// A Host for the LibreOffice end-to-end tests: doc.* (and the harness's own h.*) go to libreoffice/test/harness.py, which
// drives a private headless LibreOffice through the extension's document code (zinc_lo.LoDoc); everything else (library,
// styles, settings) is the in-memory mock host. That is the split the real LibreOffice pane makes too: the pane answers
// lib.* / style.* itself and hands doc.* to the extension inside LibreOffice.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Host } from "../src/host";
import { createMockHost, type MockOptions } from "../src/mockhost";

/** LibreOffice's program folder (soffice.exe and its bundled python.exe): ZN_LO_PROGRAM. */
export const LO_PROGRAM = process.env.ZN_LO_PROGRAM ?? "";
const exe = (name: string) => join(LO_PROGRAM, process.platform === "win32" ? name + ".exe" : name);
export const LO_PYTHON = exe("python");
export const LO_SOFFICE = exe("soffice");
export const HARNESS_PY = join(import.meta.dir, "..", "..", "..", "libreoffice", "test", "harness.py");
const FIX = join(import.meta.dir, "..", "..", "..", "core", "test", "cite", "fixtures");

export function loAvailable(): boolean {
	return !!LO_PROGRAM && existsSync(LO_PYTHON) && existsSync(LO_SOFFICE);
}

/** Styles and locales for the mock library host: the core test fixtures, plus any extra style given by id. */
export function fixtureStyles(extra: Record<string, string> = {}): Pick<MockOptions, "styleXml" | "localeXml"> {
	return {
		styleXml: async (id) => extra[id] ?? readFileSync(join(FIX, `${id}.csl`), "utf8"),
		localeXml: async (lang) => {
			const p = join(FIX, `locales-${lang}.xml`);
			return existsSync(p) ? readFileSync(p, "utf8") : null;
		},
	};
}

export class LoHarnessHost implements Host {
	private proc!: ReturnType<typeof Bun.spawn>;
	private seq = 0;
	private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
	private handlers = new Map<string, ((d: any) => void)[]>();
	readonly lib: ReturnType<typeof createMockHost>;
	/** doc.* calls made, in order (to count round trips) */
	readonly docCalls: string[] = [];

	private constructor(opts: MockOptions) {
		this.lib = createMockHost(opts);
	}

	static async start(profile: string, opts: MockOptions = {}): Promise<LoHarnessHost> {
		const h = new LoHarnessHost(opts);
		h.proc = Bun.spawn([LO_PYTHON, HARNESS_PY, "--soffice", LO_SOFFICE, "--profile", profile], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "inherit",
		});
		void h.read();
		return h;
	}

	private async read() {
		const dec = new TextDecoder();
		let buf = "";
		for await (const chunk of this.proc.stdout as ReadableStream<Uint8Array>) {
			buf += dec.decode(chunk, { stream: true });
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
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
		for (const p of this.pending.values()) p.reject(new Error("harness exited"));
		this.pending.clear();
	}

	/** A request to the harness itself (h.*) or to the document (doc.*). */
	raw<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		const id = ++this.seq;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			const stdin = this.proc.stdin as import("bun").FileSink;
			stdin.write(JSON.stringify({ id, method, params }) + "\n");
			stdin.flush();
		});
	}

	async call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		if (method.startsWith("doc.")) {
			this.docCalls.push(method);
			return this.raw<T>(method, params);
		}
		const r = await this.lib.call(method, params);
		// as the LibreOffice pane answers host.info: citations are reference marks here
		if (method === "host.info") return { ...r, fieldType: "ReferenceMark" } as T;
		return r as T;
	}

	on(event: string, cb: (d: any) => void) {
		const l = this.handlers.get(event) ?? [];
		l.push(cb);
		this.handlers.set(event, l);
	}

	async stop(): Promise<void> {
		try {
			await Promise.race([this.raw("h.quit"), new Promise((r) => setTimeout(r, 30000))]);
		} catch {}
		try {
			(this.proc.stdin as import("bun").FileSink).end();
		} catch {}
		const code = await Promise.race([this.proc.exited, new Promise<number>((r) => setTimeout(() => r(-1), 15000))]);
		if (code === -1) this.proc.kill();
	}
}
