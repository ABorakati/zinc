// NDJSON stdio transport between the Zinc app process and `zhw` (`plugin-host-wasmtime/`).
// Wire contract: docs/developer-guide/wasm-plugins/protocol-ndjson.md.
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { FromHost, LogBatchEntry, ToHost, WireResult } from "./protocol";

const EXE = process.platform === "win32" ? "zhw.exe" : "zhw";

/** True when `dir` is inside Bun's compiled single-file virtual filesystem (`/$bunfs/...` or `B:/~BUN/...`). */
export function isCompiledBunfs(dir: string): boolean {
	return /^(\/\$bunfs|[A-Za-z]:[\\/]+~BUN)([\\/]|$)/i.test(dir);
}

/** Locate the `zhw` binary in priority order (explicit -> env -> packaged -> newest dev build). */
export function resolveZhwPath(explicit?: string, opts: { execPath?: string; moduleDir?: string } = {}): string {
	if (explicit) return explicit;
	if (process.env.ZHW) return process.env.ZHW;
	if (process.env.ZN_ZHW) return process.env.ZN_ZHW;

	const execDir = dirname(opts.execPath ?? process.execPath);
	for (const packaged of [join(execDir, EXE), join(execDir, "..", "Resources", EXE)]) {
		if (existsSync(packaged)) return packaged;
	}

	const moduleDir = opts.moduleDir ?? import.meta.dir;
	if (isCompiledBunfs(moduleDir)) {
		return join(execDir, EXE);
	}

	const devCandidates = [
		resolve(moduleDir, "..", "..", "plugin-host-wasmtime", "target", "release", EXE),
		resolve(moduleDir, "..", "..", "gpui-ui", "out", EXE),
		process.env.CARGO_TARGET_DIR ? join(process.env.CARGO_TARGET_DIR, "release", EXE) : undefined,
		process.platform === "win32" ? "C:/dev/cache/cargo-target/release/zhw.exe" : undefined,
	]
		.filter((c): c is string => !!c && existsSync(c))
		.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

	if (devCandidates.length > 0) return devCandidates[0]!;

	return (
		(process.env.CARGO_TARGET_DIR ? join(process.env.CARGO_TARGET_DIR, "release", EXE) : undefined) ??
		resolve(moduleDir, "..", "..", "plugin-host-wasmtime", "target", "release", EXE)
	);
}

/** Encode a JS WIT runtime value for NDJSON (`bigint` -> `{"$big"}`, `Uint8Array` -> `{"$bytes"}`, `undefined` -> `null`). */
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

/** Decode an NDJSON WIT value back into jco's JS shape (`{"$big"}` -> `BigInt`, `{"$bytes"}` -> `Uint8Array`, `null` -> `undefined`). */
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
		for (const [k, val] of Object.entries(o)) {
			out[k] = decodeWire(val);
		}
		return out;
	}
	return v;
}

export function encodeWireResult(r: WireResult): WireResult {
	if (r.ok) return { ok: true, value: encodeWire(r.value) };
	if (r.error.kind === "wit") return { ok: false, error: { kind: "wit", payload: encodeWire(r.error.payload) } };
	return r;
}

export function decodeWireResult(r: WireResult): WireResult {
	if (!r || typeof r !== "object") return { ok: false, error: { kind: "internal", message: "malformed WireResult" } };
	if (r.ok) return { ok: true, value: decodeWire(r.value) };
	if (r.error?.kind === "wit") return { ok: false, error: { kind: "wit", payload: decodeWire(r.error.payload) } };
	return r;
}

function prepareOutbound(m: ToHost): unknown {
	switch (m.t) {
		case "call":
			return { ...m, args: m.args.map(encodeWire) };
		case "import-reply":
		case "call-reply":
			return { ...m, result: encodeWireResult(m.result) };
		default:
			return m;
	}
}

function cleanLogEntry(e: Record<string, unknown>): LogBatchEntry {
	return {
		plugin: typeof e.plugin === "string" ? e.plugin : undefined,
		level: (e.level as LogBatchEntry["level"]) ?? "info",
		message: String(e.message ?? ""),
		stack: typeof e.stack === "string" ? e.stack : undefined,
		isError: e.isError === true ? true : undefined,
		dropped: typeof e.dropped === "number" ? e.dropped : undefined,
	};
}

function prepareInbound(raw: Record<string, unknown>): FromHost {
	switch (raw.t) {
		case "reply":
			return { t: "reply", id: Number(raw.id), result: decodeWireResult(raw.result as WireResult) };
		case "import":
			return {
				t: "import",
				id: Number(raw.id),
				plugin: String(raw.plugin ?? ""),
				iface: String(raw.iface ?? ""),
				fn: String(raw.fn ?? ""),
				args: Array.isArray(raw.args) ? raw.args.map(decodeWire) : [],
			};
		case "call":
			return {
				t: "call",
				id: Number(raw.id),
				plugin: String(raw.plugin ?? ""),
				iface: String(raw.iface ?? ""),
				fn: String(raw.fn ?? ""),
				args: Array.isArray(raw.args) ? raw.args.map(decodeWire) : [],
				timeoutMs: typeof raw.timeoutMs === "number" ? raw.timeoutMs : undefined,
			};
		case "log": {
			const e = cleanLogEntry(raw);
			return { t: "log", ...e };
		}
		case "log-batch":
			return {
				t: "log-batch",
				entries: Array.isArray(raw.entries) ? raw.entries.map((x) => cleanLogEntry((x ?? {}) as Record<string, unknown>)) : [],
			};
		case "plugin-exit":
			return {
				t: "plugin-exit",
				plugin: String(raw.plugin ?? ""),
				kind: raw.kind === "timeout" || raw.kind === "trap" ? raw.kind : undefined,
				message: String(raw.message ?? ""),
			};
		default:
			return raw as unknown as FromHost;
	}
}

export interface WasmtimeTransportOptions {
	zhwPath?: string;
	maxMemoryMb?: number;
	hostStderr?: "ignore" | "inherit";
	onMessage: (msg: FromHost) => void;
	onExit: (code: number | null) => void;
}

export interface WasmtimeTransport {
	readonly pid: number;
	readonly exited: Promise<number>;
	send(msg: ToHost): void;
	kill(): void;
}

export function spawnWasmtimeTransport(opts: WasmtimeTransportOptions): WasmtimeTransport {
	const zhwPath = resolveZhwPath(opts.zhwPath);
	if ((zhwPath.includes("/") || zhwPath.includes("\\")) && !existsSync(zhwPath)) {
		throw new Error(`zhw plugin host binary not found at ${zhwPath}`);
	}
	const args = [zhwPath, "run", ...(opts.maxMemoryMb ? ["--max-memory-mb", String(opts.maxMemoryMb)] : [])];
	let closed = false;
	let exitCode: number | null = null;

	const proc = Bun.spawn(args, {
		stdin: "pipe",
		stdout: "pipe",
		stderr: opts.hostStderr ?? "ignore",
		onExit: (_p, code) => {
			closed = true;
			exitCode = code ?? null;
		},
	});

	const stdoutDone = (async () => {
		const reader = proc.stdout.getReader();
		const decoder = new TextDecoder();
		let buf = "";
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				let nl: number;
				while ((nl = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, nl).trim();
					buf = buf.slice(nl + 1);
					if (!line) continue;
					let parsed: Record<string, unknown>;
					try {
						parsed = JSON.parse(line) as Record<string, unknown>;
					} catch {
						continue;
					}
					opts.onMessage(prepareInbound(parsed));
				}
			}
			buf += decoder.decode();
			const tail = buf.trim();
			if (tail) {
				try {
					opts.onMessage(prepareInbound(JSON.parse(tail) as Record<string, unknown>));
				} catch {
					/* ignore truncated tail */
				}
			}
		} catch {
			/* stream closed */
		} finally {
			try {
				reader.releaseLock();
			} catch {
				/* already released */
			}
		}
	})();

	void proc.exited
		.catch(() => -1)
		.then(async (code) => {
			closed = true;
			await stdoutDone.catch(() => {});
			opts.onExit(exitCode ?? code);
		});

	return {
		get pid() {
			return proc.pid;
		},
		get exited() {
			return proc.exited;
		},
		send(msg: ToHost) {
			if (closed) return;
			const wire = prepareOutbound(msg);
			try {
				proc.stdin.write(JSON.stringify(wire) + "\n");
				proc.stdin.flush();
			} catch {
				/* host exited; onExit triggers restart */
			}
		},
		kill() {
			closed = true;
			try {
				proc.stdin.end();
			} catch {
				/* ignore */
			}
			try {
				proc.kill();
			} catch {
				/* ignore */
			}
		},
	};
}
