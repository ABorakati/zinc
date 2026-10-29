// Loader and ABI wrapper for the zotero-fulltext WebAssembly core (ABI version 1, zero imports).
// Port of plugin/content/wasm-host.js of the zotero-fulltext plugin. All payloads are UTF-8 JSON, u64 results
// arrive as BigInt = (ptr << 32) | len, and JS frees every RETURNED buffer with fx_free.
//
//   fx_abi_version() -> u32
//   fx_alloc(len) -> ptr            fx_free(ptr, len)
//   fx_inspect(meta_ptr, meta_len, body_ptr, body_len) -> u64   Envelope<Inspection>   (callee frees inputs)
//   fx_step(in_ptr, in_len) -> u64                              Envelope<StepOut>      (callee frees input)
//   fx_reset()                      fx_last_panic() -> u64
//
// One compiled module, two instances: "pure" (stateless fx_inspect) and "engine" (stateful fx_step).
// A trap poisons the instance it happened in; the module is cached so re-instantiating is cheap.

import { isAbsolute, join } from "node:path";
import wasmPath from "../../vendor/fulltext-wasm/fulltext.wasm" with { type: "file" };
import type { Inspection, InspectMeta, LoginState, StepIn, StepOut } from "./proto";

// Unbundled, the import is an absolute path; bundled (Electrobun), it is relative to the bundle's folder.
const wasmFile = isAbsolute(wasmPath) ? wasmPath : join(import.meta.dir, wasmPath);

export const ABI_VERSION = 1;
const REQUIRED_EXPORTS = [
	"memory",
	"fx_abi_version",
	"fx_alloc",
	"fx_free",
	"fx_inspect",
	"fx_step",
	"fx_reset",
	"fx_last_panic",
	"fx_login_state",
];

/** The instance trapped (panic/unreachable/OOM) and is poisoned until re-instantiated. */
export class EngineTrap extends Error {
	constructor(
		message: string,
		public panic = "",
	) {
		super(message);
		this.name = "EngineTrap";
	}
}

/** The export answered {"err": ...}: the instance is still usable. */
export class EngineError extends Error {
	constructor(
		public code: string,
		message: string,
	) {
		super(`${code}: ${message}`);
		this.name = "EngineError";
	}
}

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8");

type Exports = Record<string, any> & { memory: WebAssembly.Memory };

export class WasmInstance {
	exports!: Exports;
	poisoned = false;
	traps = 0;
	constructor(
		private module: WebAssembly.Module,
		readonly role: "pure" | "engine",
	) {}

	init(): void {
		const x = new WebAssembly.Instance(this.module, {}).exports as unknown as Exports;
		for (const name of REQUIRED_EXPORTS) if (x[name] === undefined) throw new Error(`wasm module is missing export ${name}`);
		const abi = x.fx_abi_version();
		if (abi !== ABI_VERSION) throw new Error(`wasm ABI mismatch: got ${abi}, expected ${ABI_VERSION}`);
		this.exports = x;
		this.poisoned = false;
	}

	callJson<T>(name: string, input: unknown): T {
		const bytes = enc.encode(JSON.stringify(input));
		return this.run(() => {
			const ptr = this.put(bytes);
			return this.take<T>(this.exports[name](ptr, bytes.length));
		});
	}

	callMetaBody<T>(name: string, meta: unknown, body: Uint8Array): T {
		const a = enc.encode(JSON.stringify(meta));
		return this.run(() => this.callTwo<T>(name, a, body));
	}

	/** Two UTF-8 text buffers (fx_login_state: url, html). An empty string is passed as a null buffer of length 0. */
	callTexts<T>(name: string, a: string, b: string): T {
		const ba = enc.encode(a);
		const bb = enc.encode(b);
		return this.run(() => this.callTwo<T>(name, ba, bb));
	}

	reset(): void {
		this.run(() => {
			this.exports.fx_reset();
		});
	}

	lastPanic(): string {
		try {
			const packed = this.exports.fx_last_panic();
			if (typeof packed !== "bigint") return "";
			const len = Number(packed & 0xffffffffn);
			if (!len) return "";
			const ptr = Number(packed >> 32n);
			const text = dec.decode(new Uint8Array(this.exports.memory.buffer, ptr, len));
			try {
				const p = JSON.parse(text);
				return typeof p?.message === "string" ? p.message : text;
			} catch {
				return text;
			}
		} catch {
			return "";
		}
	}

	private run<T>(fn: () => T): T {
		if (this.poisoned) throw new EngineTrap(`wasm ${this.role} instance is poisoned by an earlier trap`, this.lastPanic());
		try {
			return fn();
		} catch (e) {
			if (e instanceof EngineError || e instanceof EngineTrap) throw e;
			this.poisoned = true;
			this.traps++;
			const panic = this.lastPanic();
			throw new EngineTrap(`wasm ${this.role} trap: ${(e as Error)?.message ?? e}${panic ? ` (${panic})` : ""}`, panic);
		}
	}

	private put(bytes: Uint8Array): number {
		if (bytes.length === 0) return 0;
		const ptr = this.exports.fx_alloc(bytes.length);
		if (!ptr) throw new EngineError("alloc_failed", `fx_alloc(${bytes.length}) returned 0`);
		// the view is created AFTER the alloc: memory may have grown
		new Uint8Array(this.exports.memory.buffer, ptr, bytes.length).set(bytes);
		return ptr;
	}

	private callTwo<T>(name: string, a: Uint8Array, b: Uint8Array): T {
		const pa = this.put(a);
		let pb: number;
		try {
			pb = this.put(b);
		} catch (e) {
			this.exports.fx_free(pa, a.length);
			throw e;
		}
		return this.take<T>(this.exports[name](pa, a.length, pb, b.length));
	}

	private take<T>(packed: unknown): T {
		if (typeof packed !== "bigint") throw new EngineError("bad_abi", "export did not return a u64");
		const ptr = Number(packed >> 32n);
		const len = Number(packed & 0xffffffffn);
		if (len === 0) throw new EngineError("empty_result", "export returned an empty buffer");
		let text: string;
		try {
			text = dec.decode(new Uint8Array(this.exports.memory.buffer, ptr, len));
		} finally {
			this.exports.fx_free(ptr, len);
		}
		const env = JSON.parse(text);
		if (!env || typeof env !== "object") throw new EngineError("bad_result", "result is not a JSON object");
		if (env.err) throw new EngineError(String(env.err.code || "error"), String(env.err.message || ""));
		if (!("ok" in env)) throw new EngineError("bad_result", "envelope has neither ok nor err");
		return env.ok as T;
	}
}

let modulePromise: Promise<WebAssembly.Module> | null = null;

/** Compile the vendored module once per process. */
export function loadModule(): Promise<WebAssembly.Module> {
	if (!modulePromise) {
		modulePromise = Bun.file(wasmFile)
			.arrayBuffer()
			.then((bytes) => WebAssembly.compile(bytes))
			.then((m) => {
				const imports = WebAssembly.Module.imports(m);
				if (imports.length) throw new Error(`wasm module must import nothing, found: ${imports.map((i) => `${i.module}.${i.name}`).join(", ")}`);
				return m;
			});
		modulePromise.catch(() => {
			modulePromise = null;
		});
	}
	return modulePromise;
}

/** What the runner uses: one engine instance plus one pure (inspector) instance. */
export class WasmHost {
	engine: WasmInstance;
	pure: WasmInstance;
	engineTraps = 0;
	pureTraps = 0;
	lastPanic = "";

	constructor(module: WebAssembly.Module) {
		this.engine = new WasmInstance(module, "engine");
		this.engine.init();
		this.pure = new WasmInstance(module, "pure");
		this.pure.init();
	}

	static async load(): Promise<WasmHost> {
		return new WasmHost(await loadModule());
	}

	/** @throws EngineTrap (instance poisoned: call resetEngine) or EngineError (step rejected, state unchanged) */
	step(input: StepIn): StepOut {
		const wasPoisoned = this.engine.poisoned;
		try {
			return this.engine.callJson<StepOut>("fx_step", input);
		} catch (e) {
			if (e instanceof EngineTrap && !wasPoisoned) {
				this.engineTraps++;
				if (e.panic) this.lastPanic = e.panic;
			}
			throw e;
		}
	}

	resetEngine(): void {
		if (!this.engine.poisoned) {
			try {
				this.engine.reset();
				return;
			} catch (e) {
				if (!(e instanceof EngineTrap)) throw e;
				this.engineTraps++;
			}
		}
		this.engine.init();
	}

	/** Classify a response. Never throws: a trap or bad input yields {expect: "failed"}. */
	inspect(meta: InspectMeta, body: Uint8Array): Inspection {
		const pure = this.pure;
		if (pure.poisoned) {
			try {
				pure.init();
			} catch {
				return { expect: "failed", reason: "pure_trap" };
			}
		}
		try {
			return pure.callMetaBody<Inspection>("fx_inspect", meta, body);
		} catch (e) {
			if (e instanceof EngineTrap) {
				this.pureTraps++;
				if (e.panic) this.lastPanic = e.panic;
				try {
					pure.init();
				} catch {
					/* stays poisoned; the next call retries */
				}
				return { expect: "failed", reason: "pure_trap" };
			}
			if (e instanceof EngineError) return { expect: "failed", reason: `inspect_error:${e.code}` };
			return { expect: "failed", reason: "inspect_error" };
		}
	}

	/**
	 * Sign-in window poll: fx_login_state(url, html) on the pure instance. Never throws: a trap or error envelope
	 * yields {state: "pending"} (port of wasm-host.js loginState).
	 */
	loginState(args: { url: string; html?: string }): LoginState {
		const pending: LoginState = { state: "pending" };
		const pure = this.pure;
		if (pure.poisoned) {
			try {
				pure.init();
			} catch {
				return pending;
			}
		}
		try {
			const out = pure.callTexts<LoginState>("fx_login_state", String(args?.url ?? ""), args?.html ? String(args.html) : "");
			return out && typeof out.state === "string" ? out : pending;
		} catch (e) {
			if (e instanceof EngineTrap) {
				this.pureTraps++;
				if (e.panic) this.lastPanic = e.panic;
				try {
					pure.init();
				} catch {
					/* stays poisoned; the next call retries */
				}
			}
			return pending;
		}
	}

	dispose(): void {
		/* instances are garbage collected */
	}
}
