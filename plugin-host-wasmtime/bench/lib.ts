// Harness for the Wasmtime host spike: spawns `zhw run`, speaks the plugin-host protocol (NDJSON) and exposes the same small
// "Runner" surface as the existing Bun supervisor, so bench/run.ts can time both the same way.
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createPluginSupervisor, type PluginSupervisor } from "../../plugin-host/src/supervisor";
import { defineHandler } from "../../plugin-host/src/imports/registry";
import { PluginError } from "../../plugin-host/src/protocol";

export const root = join(import.meta.dir, "..");
export const targetDir = process.env.CARGO_TARGET_DIR ?? "C:/dev/cache/cargo-target";
export const zhwBin = process.env.ZHW ?? join(targetDir, "release", "zhw.exe");
export const bridgeTs = join(import.meta.dir, "bridge.ts");
export const prefsHostModule = join(import.meta.dir, "..", "..", "plugin-host", "test", "handlers", "prefs.host.ts");
export const scratch = join(process.env.TEMP ?? "/tmp", "zn-wasm-wasmtime");

export const now = () => performance.now();

export function replacer(_k: string, v: unknown) {
	if (typeof v === "bigint") return { $big: v.toString() };
	if (v instanceof Uint8Array) return { $bytes: Buffer.from(v).toString("base64") };
	return v;
}
export function reviver(_k: string, v: unknown) {
	if (v && typeof v === "object") {
		const o = v as Record<string, unknown>;
		if (typeof o.$big === "string") return BigInt(o.$big);
		if (typeof o.$bytes === "string") return new Uint8Array(Buffer.from(o.$bytes, "base64"));
	}
	return v;
}

/** Answers of the stand-in Zinc process for imports no host-side handler has. */
export function defaultImport(m: { iface: string; fn: string }): unknown {
	if (m.iface === "zinc:plugin/timers" && (m.fn === "set-timeout" || m.fn === "set-interval")) return 7;
	return undefined;
}

export type WireResult = { ok: true; value: any } | { ok: false; error: { kind: string; [k: string]: any } };

/** What the harness needs from either host. `call` resolves with a WireResult (never throws on plugin errors). */
export interface Runner {
	name: string;
	/** Spawn the host process and wait until it is up. Returns ms. */
	start(): Promise<number>;
	load(dir: string): Promise<{ id: string; ms: number; detail?: any }>;
	/** `startup` for a plugin. */
	startup(id: string): Promise<WireResult>;
	call(id: string, iface: string, fn: string, args: unknown[], timeoutMs?: number): Promise<WireResult>;
	/** Process ids that make up the host (for memory measurement). */
	pids(): number[];
	counts(): { logLines: number; imports: number };
	close(): Promise<void>;
}

// ---- Wasmtime host ----------------------------------------------------------------------------------------------------

export interface WtOptions {
	bridge?: boolean;
	aot?: boolean;
	maxMemoryMb?: number;
	/** value of --native; default "log.write" */
	native?: string;
	hostModules?: string[];
	discover?: boolean;
	/** answer to forwarded `import` messages (zinc-where handlers) */
	onImport?: (m: any) => unknown;
	env?: Record<string, string>;
}

export class WtHost implements Runner {
	name = "wasmtime";
	proc!: ReturnType<typeof Bun.spawn>;
	private nextId = 1;
	private pending = new Map<number, (r: WireResult) => void>();
	logs: any[] = [];
	exits: any[] = [];
	logLines = 0;
	imports = 0;
	pid = 0;
	bridgePid?: number;
	readyInfo: any;
	private readyResolve?: (m: any) => void;
	private specs = new Map<string, any>();
	constructor(public opts: WtOptions = {}) {}

	async start() {
		const t0 = now();
		const args = ["run"];
		if (this.opts.bridge !== false) args.push("--bridge", bridgeTs);
		if (this.opts.aot) args.push("--aot");
		if (this.opts.maxMemoryMb) args.push("--max-memory-mb", String(this.opts.maxMemoryMb));
		if (this.opts.native !== undefined) args.push("--native", this.opts.native);
		this.proc = Bun.spawn([zhwBin, ...args], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: { ...process.env, ...this.opts.env } });
		this.pid = this.proc.pid;
		const ready = new Promise<any>((r) => (this.readyResolve = r));
		void this.readLoop();
		this.send({ t: "init", hostModules: this.opts.hostModules ?? [], heartbeatMs: 1000, discover: this.opts.discover ?? false });
		this.readyInfo = await ready;
		return now() - t0;
	}

	private send(m: unknown) {
		const sink = this.proc.stdin as { write(s: string): number; flush(): void };
		sink.write(JSON.stringify(m, replacer) + "\n");
		sink.flush();
	}

	private async readLoop() {
		const dec = new TextDecoder();
		let buf = "";
		for await (const chunk of this.proc.stdout as unknown as AsyncIterable<Uint8Array>) {
			buf += dec.decode(chunk, { stream: true });
			let i: number;
			while ((i = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 1);
				if (line) this.onLine(line);
			}
		}
	}

	private onLine(line: string) {
		const m = JSON.parse(line, reviver);
		switch (m.t) {
			case "ready":
				this.readyResolve?.(m);
				break;
			case "reply":
				this.pending.get(m.id)?.(m.result);
				this.pending.delete(m.id);
				break;
			case "log":
				this.logLines++;
				if (this.logs.length < 2000) this.logs.push(m);
				break;
			case "import": {
				this.imports++;
				const v = this.opts.onImport?.(m) ?? defaultImport(m);
				this.send({ t: "import-reply", id: m.id, result: { ok: true, value: v } });
				break;
			}
			case "plugin-exit":
				this.exits.push(m);
				break;
		}
	}

	request(m: Record<string, unknown>): Promise<WireResult> {
		const id = this.nextId++;
		return new Promise((resolve) => {
			this.pending.set(id, resolve);
			this.send({ ...m, id });
		});
	}

	async load(dir: string) {
		const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
		const spec = { id: manifest.id, dir, manifest, grants: { capabilities: manifest.permissions?.capabilities ?? [], netHosts: [] } };
		this.specs.set(spec.id, spec);
		const t0 = now();
		const r = await this.request({ t: "load", plugin: spec });
		if (!r.ok) throw new Error(`load ${manifest.id}: ${JSON.stringify(r.error)}`);
		return { id: spec.id, ms: now() - t0, detail: r.value };
	}

	startup(id: string) {
		const s = this.specs.get(id);
		return this.call(id, "lifecycle", "startup", [{ id, version: s.manifest.version }, "app-startup"]);
	}

	call(id: string, iface: string, fn: string, args: unknown[], timeoutMs?: number) {
		return this.request({ t: "call", plugin: id, iface, fn, args, timeoutMs });
	}

	async stats() {
		const r = await this.request({ t: "stats" });
		return (r as any).value;
	}

	pids() {
		return [this.pid, ...(this.readyInfo?.bridgePid ? [this.readyInfo.bridgePid as number] : [])];
	}
	counts() {
		return { logLines: this.logLines, imports: this.imports };
	}

	async close() {
		try {
			this.send({ t: "exit" });
		} catch {}
		this.proc.kill();
		await this.proc.exited;
	}
}

// ---- Bun baseline (the existing supervisor) -----------------------------------------------------------------------------

export class BunHost implements Runner {
	name = "bun";
	sup!: PluginSupervisor;
	logLines = 0;
	restarts: any[] = [];
	constructor(private opts: { hostStderr?: "inherit" | "ignore" } = {}) {}
	async start() {
		const t0 = now();
		this.sup = createPluginSupervisor({
			importHandlers: [
				defineHandler({ interface: "zinc:plugin/log", where: "zinc", functions: { write: () => void this.logLines++, "debug-enabled": () => false } }),
				defineHandler({ interface: "zinc:plugin/timers", where: "zinc", functions: { "set-timeout": () => 7 } }),
				defineHandler({ interface: "zinc:plugin/extend", where: "zinc", functions: { "register-menu": () => undefined } }),
			],
			hostHandlerModules: [prefsHostModule],
			discoverHostHandlers: false,
			hostStderr: this.opts.hostStderr ?? "ignore",
		});
		this.sup.on("host-restart", (e) => this.restarts.push({ t: now(), ...e }));
		this.sup.on("host-restarted", (e) => this.restarts.push({ t: now(), ...e }));
		await this.sup.ready();
		return now() - t0;
	}
	async load(dir: string) {
		const t0 = now();
		const info = await this.sup.load(dir);
		return { id: info.id, ms: now() - t0 };
	}
	async startup(id: string): Promise<WireResult> {
		try {
			await this.sup.start(id);
			return { ok: true, value: undefined };
		} catch (e) {
			return toWire(e);
		}
	}
	async call(id: string, iface: string, fn: string, args: unknown[], timeoutMs?: number): Promise<WireResult> {
		try {
			return { ok: true, value: await this.sup.call(id, iface, fn, args, timeoutMs ? { timeoutMs } : undefined) };
		} catch (e) {
			return toWire(e);
		}
	}
	pids() {
		return this.sup.hostPid ? [this.sup.hostPid] : [];
	}
	counts() {
		return { logLines: this.logLines, imports: 0 };
	}
	async close() {
		await this.sup.shutdown();
	}
}

function toWire(e: unknown): WireResult {
	if (e instanceof PluginError) return { ok: false, error: e.error as any };
	return { ok: false, error: { kind: "internal", message: String((e as Error)?.message ?? e) } };
}

// ---- measurement helpers -------------------------------------------------------------------------------------------------

/** Working set of the given processes in bytes (Windows `tasklist`, which is fast and never waits for input). */
export async function workingSet(pids: number[]): Promise<number> {
	let sum = 0;
	for (const pid of pids) {
		const p = Bun.spawn(["tasklist", "/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
		const out = await new Response(p.stdout).text();
		// "zhw.exe","45920","Console","1","7,376 K"
		const m = /"([\d,]+) K"/.exec(out);
		if (m) sum += Number(m[1].replace(/,/g, "")) * 1024;
	}
	return sum;
}

export function stats(xs: number[]) {
	const s = [...xs].sort((a, b) => a - b);
	const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
	return { n: s.length, min: s[0], median: q(0.5), p95: q(0.95), max: s[s.length - 1], mean: s.reduce((a, b) => a + b, 0) / s.length };
}

export const fx = {
	data: (name: string) => join(process.env.TEMP ?? "/tmp", name),
};
