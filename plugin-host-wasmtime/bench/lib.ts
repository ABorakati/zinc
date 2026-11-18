// Harness for the native Wasmtime host (`zhw`): spawns `zhw run`, speaks the Phase 3 NDJSON protocol (`protocol-ndjson.md`),
// dispatches forwarded imports to an in-process `HandlerTable` + `runHandler` (no Bun bridge process!), and exposes the
// `Runner` interface shared by `bench/run.ts` and `bench/host.test.ts`.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createPluginSupervisor, type PluginSupervisor } from "../../plugin-host/src/supervisor";
import {
	HandlerTable,
	WitError,
	defineHandler,
	loadHandlerModule,
	type Grants,
	type HandlerContext,
	type ImportHandler,
} from "../../plugin-host/src/imports/registry";
import { runHandler } from "../../plugin-host/src/router";
import { PluginError } from "../../plugin-host/src/protocol";

export const root = join(import.meta.dir, "..");
const EXE = process.platform === "win32" ? "zhw.exe" : "zhw";

function findZhwBin(): string {
	if (process.env.ZHW) return process.env.ZHW;
	if (process.env.CARGO_TARGET_DIR) return join(process.env.CARGO_TARGET_DIR, "release", EXE);
	const local = join(root, "target", "release", EXE);
	const cached = "C:/dev/cache/cargo-target/release/zhw.exe";
	if (existsSync(local) && existsSync(cached)) {
		return statSync(local).mtimeMs >= statSync(cached).mtimeMs ? local : cached;
	}
	if (existsSync(local)) return local;
	return cached;
}

export const zhwBin = findZhwBin();
export const prefsHostModule = join(import.meta.dir, "..", "..", "plugin-host", "test", "handlers", "prefs.host.ts");
const origTemp = process.env.TEMP ?? process.env.TMP ?? "/tmp";
export const scratch = join(origTemp, "zn-p3-runner", "b1");

export const now = () => performance.now();

export function encodeWire(v: unknown): unknown {
	if (v === undefined || v === null) return null;
	if (typeof v === "bigint") return { $big: v.toString() };
	if (v instanceof Uint8Array) return { $bytes: Buffer.from(v).toString("base64") };
	if (Array.isArray(v)) return v.map(encodeWire);
	if (typeof v === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
			if (val !== undefined) out[k] = encodeWire(val);
		}
		return out;
	}
	return v;
}

export function decodeWire(v: unknown): unknown {
	if (v === null || v === undefined) return undefined;
	if (Array.isArray(v)) return v.map(decodeWire);
	if (typeof v === "object") {
		const o = v as Record<string, unknown>;
		const keys = Object.keys(o);
		if (keys.length === 1 && "$big" in o && (typeof o.$big === "string" || typeof o.$big === "number")) {
			return BigInt(o.$big);
		}
		if (keys.length === 1 && "$bytes" in o && typeof o.$bytes === "string") {
			return new Uint8Array(Buffer.from(o.$bytes, "base64"));
		}
		const out: Record<string, unknown> = {};
		for (const [k, val] of Object.entries(o)) out[k] = decodeWire(val);
		return out;
	}
	return v;
}

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

/** Answers of the stand-in Zinc process for imports no in-process handler claims. */
export function defaultImport(m: { iface: string; fn: string }): unknown {
	if (m.iface === "zinc:plugin/timers" && (m.fn === "set-timeout" || m.fn === "set-interval")) return 7;
	return undefined;
}

export type WireResult = { ok: true; value: any } | { ok: false; error: { kind: string; [k: string]: any } };

export interface Runner {
	name: string;
	start(): Promise<number>;
	load(dir: string): Promise<{ id: string; ms: number; detail?: any }>;
	startup(id: string): Promise<WireResult>;
	call(id: string, iface: string, fn: string, args: unknown[], timeoutMs?: number): Promise<WireResult>;
	pids(): number[];
	counts(): { logLines: number; imports: number };
	close(): Promise<void>;
}

// ---- Wasmtime host (`zhw`) ---------------------------------------------------------------------------------------------

export interface WtOptions {
	aot?: boolean;
	maxMemoryMb?: number;
	maxImportCalls?: number;
	/** CLI `--native` flag value (when omitted, `zhw` defaults to all 6 families). */
	native?: string;
	/** Optional `init.native` array (overrides CLI `--native`, even when `[]`). */
	initNative?: string[];
	heartbeatMs?: number;
	debugEnabled?: boolean;
	app?: Record<string, unknown>;
	/** In-process `ImportHandler`s dispatched via `HandlerTable` + `runHandler`. */
	handlers?: ImportHandler[];
	/** Extra handler module paths loaded via `loadHandlerModule` in-process. */
	hostModules?: string[];
	coreUrl?: string;
	/** Fallback/custom handler for forwarded `import` messages. */
	onImport?: (m: any, ctx: HandlerContext | undefined) => unknown | Promise<unknown>;
	env?: Record<string, string>;
}

export interface LoadOverrides {
	id?: string;
	cwasm?: string;
	grants?: Grants;
	prefs?: {
		defaults?: Record<string, boolean | number | string>;
		user?: Record<string, boolean | number | string>;
		secrets?: string[];
	};
	l10n?: {
		defaultLocale?: string;
		bundles?: Array<{ tag: string; ftl: string }>;
	};
}

export class WtHost implements Runner {
	name = "wasmtime";
	proc!: ReturnType<typeof Bun.spawn>;
	private nextId = 1;
	private pending = new Map<number, (r: WireResult) => void>();
	table = new HandlerTable([]);
	logs: any[] = [];
	logBatches: any[] = [];
	exits: any[] = [];
	heartbeats: any[] = [];
	timerCounts: Array<{ plugin: string; count: number }> = [];
	waitingEvents: Array<{ plugin: string; n: number }> = [];
	logLines = 0;
	imports = 0;
	pid = 0;
	readyInfo: any;
	private readyResolve?: (m: any) => void;
	private specs = new Map<string, any>();

	constructor(public opts: WtOptions = {}) {}

	async start() {
		const modHandlers = this.opts.hostModules ? (await Promise.all(this.opts.hostModules.map(loadHandlerModule))).flat() : [];
		this.table = new HandlerTable([...(this.opts.handlers ?? []), ...modHandlers]);

		const t0 = now();
		const args = ["run"];
		if (this.opts.aot) args.push("--aot");
		if (this.opts.maxMemoryMb !== undefined) args.push("--max-memory-mb", String(this.opts.maxMemoryMb));
		if (this.opts.maxImportCalls !== undefined) args.push("--max-import-calls", String(this.opts.maxImportCalls));
		if (this.opts.native !== undefined) args.push("--native", this.opts.native);

		this.proc = Bun.spawn([zhwBin, ...args], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "inherit",
			env: { ...process.env, ...this.opts.env },
		});
		this.pid = this.proc.pid;
		const ready = new Promise<any>((r) => (this.readyResolve = r));
		void this.readLoop();

		const initMsg: Record<string, unknown> = {
			t: "init",
			heartbeatMs: this.opts.heartbeatMs ?? 1000,
		};
		if (this.opts.maxMemoryMb !== undefined) initMsg.maxMemoryMb = this.opts.maxMemoryMb;
		if (this.opts.maxImportCalls !== undefined) initMsg.maxImportCalls = this.opts.maxImportCalls;
		if (this.opts.initNative !== undefined) initMsg.native = this.opts.initNative;
		if (this.opts.debugEnabled !== undefined) initMsg.debugEnabled = this.opts.debugEnabled;
		if (this.opts.app !== undefined) initMsg.app = this.opts.app;
		this.send(initMsg);

		this.readyInfo = await ready;
		return now() - t0;
	}

	send(m: unknown) {
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

	private contextFor(pluginId: string): HandlerContext | undefined {
		const spec = this.specs.get(pluginId);
		if (!spec) return undefined;
		const has = (p: string) => spec.grants.capabilities.includes(p);
		return {
			pluginId: spec.id,
			pluginDir: spec.dir,
			manifest: spec.manifest,
			get grants() {
				return spec.grants;
			},
			where: "zinc",
			coreUrl: this.opts.coreUrl,
			has,
			require(p: string) {
				if (!has(p)) throw new WitError("permission-denied", p);
			},
			callExport: async (iface, fn, args = [], opts) => {
				const r = await this.call(spec.id, iface, fn, args, opts?.timeoutMs);
				if (!r.ok) throw new PluginError(r.error as any);
				return r.value;
			},
			log: (level, message) => {
				this.logLines++;
				if (this.logs.length < 5000) this.logs.push({ plugin: spec.id, level, message });
			},
			resource: (name, state) => this.table.createResource(spec.id, name, state),
		};
	}

	private async handleImport(raw: any) {
		this.imports++;
		const ctx = this.contextFor(raw.plugin);
		const decodedArgs = Array.isArray(raw.args) ? raw.args.map(decodeWire) : [];

		if (ctx && this.table.has(raw.iface, raw.fn)) {
			const res = await runHandler(this.table, ctx, raw.iface, raw.fn, decodedArgs, (msg) => {
				this.logs.push({ plugin: raw.plugin, level: "error", message: msg });
			});
			const wireRes = res.ok
				? { ok: true, value: encodeWire(res.value) }
				: res.error.kind === "wit"
					? { ok: false, error: { kind: "wit", payload: encodeWire(res.error.payload) } }
					: res;
			this.send({ t: "import-reply", id: raw.id, result: wireRes });
			return;
		}

		try {
			const v = this.opts.onImport ? await this.opts.onImport({ ...raw, args: decodedArgs }, ctx) : defaultImport(raw);
			this.send({ t: "import-reply", id: raw.id, result: { ok: true, value: encodeWire(v) } });
		} catch (e: any) {
			if (e instanceof WitError) {
				this.send({ t: "import-reply", id: raw.id, result: { ok: false, error: { kind: "wit", payload: encodeWire(e.payload) } } });
			} else if (e instanceof PluginError) {
				this.send({ t: "import-reply", id: raw.id, result: { ok: false, error: e.error } });
			} else {
				this.send({
					t: "import-reply",
					id: raw.id,
					result: { ok: false, error: { kind: "wit", payload: { tag: "internal", val: String(e?.message ?? e) } } },
				});
			}
		}
	}

	private onLine(line: string) {
		const raw = JSON.parse(line);
		switch (raw.t) {
			case "ready":
				this.readyResolve?.(raw);
				break;
			case "heartbeat":
				this.heartbeats.push(raw);
				break;
			case "reply": {
				const parsed = JSON.parse(line, reviver);
				this.pending.get(parsed.id)?.(parsed.result);
				this.pending.delete(parsed.id);
				break;
			}
			case "log":
				this.logLines++;
				if (this.logs.length < 5000) this.logs.push(raw);
				break;
			case "log-batch":
				this.logBatches.push(raw);
				for (const e of raw.entries ?? []) {
					this.logLines++;
					if (this.logs.length < 5000) this.logs.push(e);
				}
				break;
			case "timers-count":
				this.timerCounts.push({ plugin: raw.plugin, count: raw.count });
				break;
			case "waiting":
				this.waitingEvents.push({ plugin: raw.plugin, n: raw.n });
				break;
			case "import":
				void this.handleImport(raw);
				break;
			case "plugin-exit":
				this.exits.push(raw);
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

	async load(dir: string, over: LoadOverrides = {}) {
		const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
		const id = over.id ?? manifest.id;
		const grants: Grants = over.grants ?? {
			capabilities: [...(manifest.permissions?.capabilities ?? [])],
			netHosts: [...(manifest.permissions?.net?.hosts ?? [])],
		};
		const spec: Record<string, any> = { id, dir, manifest, grants };
		if (over.cwasm !== undefined) spec.cwasm = over.cwasm;
		if (over.prefs !== undefined) spec.prefs = over.prefs;
		if (over.l10n !== undefined) spec.l10n = over.l10n;
		this.specs.set(id, spec);

		const t0 = now();
		const r = await this.request({ t: "load", plugin: spec });
		if (!r.ok) throw new Error(`load ${id}: ${JSON.stringify(r.error)}`);
		return { id, ms: now() - t0, detail: r.value };
	}

	async unload(id: string) {
		const ctx = this.contextFor(id);
		const r = await this.request({ t: "unload", plugin: id });
		this.specs.delete(id);
		if (ctx) await this.table.dropPlugin(ctx);
		return r;
	}

	startup(id: string) {
		const s = this.specs.get(id);
		return this.call(id, "lifecycle", "startup", [{ id, version: s.manifest.version }, "app-startup"]);
	}

	call(id: string, iface: string, fn: string, args: unknown[], timeoutMs?: number, maxImportCalls?: number) {
		const req: Record<string, unknown> = { t: "call", plugin: id, iface, fn, args: args.map(encodeWire) };
		if (timeoutMs !== undefined) req.timeoutMs = timeoutMs;
		if (maxImportCalls !== undefined) req.maxImportCalls = maxImportCalls;
		return this.request(req);
	}

	pushGrants(plugin: string, grants: Grants) {
		const spec = this.specs.get(plugin);
		if (spec) spec.grants = grants;
		this.send({ t: "grants", plugin, grants });
	}

	pushPrefs(m: {
		plugin?: string;
		defaults?: Record<string, boolean | number | string>;
		user?: Record<string, boolean | number | string>;
		secrets?: string[];
		appPrefs?: Record<string, boolean | number | string | null>;
	}) {
		this.send({ t: "prefs", ...m });
	}

	pushL10n(m: {
		plugin?: string;
		locale?: string;
		timeZone?: string;
		defaultLocale?: string;
		bundles?: Array<{ tag: string; ftl: string }>;
	}) {
		this.send({ t: "l10n", ...m });
	}

	pushApp(m: Record<string, unknown>) {
		this.send({ t: "app", ...m });
	}

	pushLogConfig(debugEnabled: boolean) {
		this.send({ t: "log-config", debugEnabled });
	}

	clearTimers(plugin?: string) {
		this.send(plugin ? { t: "timers-clear", plugin } : { t: "timers-clear" });
	}

	async stats() {
		const r = await this.request({ t: "stats" });
		return (r as any).value;
	}

	pids() {
		return [this.pid];
	}

	counts() {
		return { logLines: this.logLines, imports: this.imports };
	}

	async close() {
		try {
			this.send({ t: "exit" });
		} catch {}
		const code = await Promise.race([this.proc.exited, Bun.sleep(300).then(() => null)]);
		if (code === null) {
			try {
				this.proc.kill();
			} catch {}
			await this.proc.exited;
		}
	}
}

// ---- Bun Worker baseline (fallback supervisor runner: "worker") ---------------------------------------------------------

export class BunHost implements Runner {
	name = "bun";
	sup!: PluginSupervisor;
	logLines = 0;
	restarts: any[] = [];
	constructor(private opts: { hostStderr?: "inherit" | "ignore" } = {}) {}
	async start() {
		const t0 = now();
		this.sup = createPluginSupervisor({
			runner: "worker",
			importHandlers: [
				defineHandler({
					interface: "zinc:plugin/log",
					where: "zinc",
					functions: { write: () => void this.logLines++, "debug-enabled": () => false },
				}),
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

export async function workingSet(pids: number[]): Promise<number> {
	let sum = 0;
	for (const pid of pids) {
		const p = Bun.spawn(["tasklist", "/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
		});
		const out = await new Response(p.stdout).text();
		const m = /"([\d,]+) K"/.exec(out);
		if (m) sum += Number(m[1].replace(/,/g, "")) * 1024;
	}
	return sum;
}

export function stats(xs: number[]) {
	const s = [...xs].sort((a, b) => a - b);
	const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
	return {
		n: s.length,
		min: s[0],
		median: q(0.5),
		p95: q(0.95),
		max: s[s.length - 1],
		mean: s.reduce((a, b) => a + b, 0) / s.length,
	};
}

export const fx = {
	data: (name: string) => join(scratch, name),
};
