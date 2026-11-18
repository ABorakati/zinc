// Every `wasi:*` import of a plugin component lands here. Plugins get NO WASI: no environment, no files, no sockets, no
// terminal, no blocking. Nothing from @bytecodealliance/preview2-shim is used. What a Rust (wasm32-wasip2) or QuickJS guest needs
// just to start (random seed for HashMap, the clock, stderr for a panic message) is answered with harmless values; everything else
// is empty ("no environment", "no preopened directory") or traps with a clear message when called.
import { ifaceName } from "./names";

export class WasiDenied extends Error {
	constructor(what: string) {
		super(`WASI is not available to Zinc plugins (${what}). Use the zinc:plugin interfaces.`);
		this.name = "WasiDenied";
	}
}

function deny(what: string) {
	// A regular function (not an arrow): jco's glue may use it as a class (`instanceof`, `.prototype`).
	return function denied(): never {
		throw new WasiDenied(what);
	};
}

class Pollable {}
class IoError {
	toDebugString() {
		return "error";
	}
}
class InputStream {
	read(): Uint8Array {
		return new Uint8Array();
	}
	blockingRead(): Uint8Array {
		return new Uint8Array();
	}
	subscribe() {
		return new Pollable();
	}
}
class TerminalInput {}
class TerminalOutput {}
class Descriptor {}
class DirectoryEntryStream {}

type Sink = (stream: "stdout" | "stderr", text: string) => void;

function makeOutputStream(name: "stdout" | "stderr", sink: Sink) {
	let pending = "";
	const decoder = new TextDecoder();
	const push = (bytes: Uint8Array) => {
		pending += decoder.decode(bytes, { stream: true });
		let i: number;
		while ((i = pending.indexOf("\n")) >= 0) {
			sink(name, pending.slice(0, i).replace(/\r$/, ""));
			pending = pending.slice(i + 1);
		}
	};
	const flush = () => {
		if (pending) sink(name, pending);
		pending = "";
	};
	return {
		checkWrite: () => 65536n,
		write: push,
		blockingWriteAndFlush: (b: Uint8Array) => (push(b), flush()),
		flush,
		blockingFlush: flush,
		writeZeroes() {},
		blockingWriteZeroesAndFlush() {},
		subscribe: () => new Pollable(),
		[Symbol.dispose]() {},
	};
}

function now() {
	return BigInt(Math.round(performance.now() * 1e6));
}

/** The `wasi:*` import object for one plugin. Keys are interface names without version. */
export function createWasiStubs(sink: Sink): (name: string) => unknown {
	// One OutputStream class: the guest receives instances of it from get-stdout / get-stderr.
	class OutputStream {}
	const out = makeOutputStream("stdout", sink);
	const err = makeOutputStream("stderr", sink);
	const stdout = Object.setPrototypeOf(out, OutputStream.prototype);
	const stderr = Object.setPrototypeOf(err, OutputStream.prototype);

	const known: Record<string, Record<string, unknown>> = {
		"wasi:cli/environment": { getEnvironment: () => [], getArguments: () => [], initialCwd: () => undefined },
		"wasi:cli/exit": {
			exit: () => {
				throw new WasiDenied("the plugin called exit");
			},
			exitWithCode: () => {
				throw new WasiDenied("the plugin called exit");
			},
		},
		"wasi:cli/stdin": { getStdin: () => new InputStream() },
		"wasi:cli/stdout": { getStdout: () => stdout },
		"wasi:cli/stderr": { getStderr: () => stderr },
		"wasi:cli/terminal-input": { TerminalInput },
		"wasi:cli/terminal-output": { TerminalOutput },
		"wasi:cli/terminal-stdin": { getTerminalStdin: () => undefined },
		"wasi:cli/terminal-stdout": { getTerminalStdout: () => undefined },
		"wasi:cli/terminal-stderr": { getTerminalStderr: () => undefined },
		"wasi:clocks/monotonic-clock": {
			now,
			resolution: () => 1000n,
			subscribeInstant: deny("clock subscription"),
			subscribeDuration: deny("clock subscription"),
		},
		"wasi:clocks/wall-clock": {
			now: () => {
				const ms = Date.now();
				return { seconds: BigInt(Math.floor(ms / 1000)), nanoseconds: (ms % 1000) * 1_000_000 };
			},
			resolution: () => ({ seconds: 0n, nanoseconds: 1_000_000 }),
		},
		"wasi:random/random": {
			getRandomBytes: (n: bigint) => crypto.getRandomValues(new Uint8Array(Number(n))),
			getRandomU64: () => crypto.getRandomValues(new BigUint64Array(1))[0],
		},
		"wasi:random/insecure": {
			getInsecureRandomBytes: (n: bigint) => crypto.getRandomValues(new Uint8Array(Number(n))),
			getInsecureRandomU64: () => crypto.getRandomValues(new BigUint64Array(1))[0],
		},
		"wasi:random/insecure-seed": { insecureSeed: () => crypto.getRandomValues(new BigUint64Array(2)) as unknown as [bigint, bigint] },
		// No preopened directory: std::fs fails with "not found" and nothing else is reachable.
		"wasi:filesystem/preopens": { getDirectories: () => [] },
		"wasi:filesystem/types": { Descriptor, DirectoryEntryStream, filesystemErrorCode: () => undefined },
		"wasi:io/error": { Error: IoError },
		"wasi:io/poll": { Pollable, poll: deny("poll") },
		"wasi:io/streams": { InputStream, OutputStream },
	};

	const cache = new Map<string, unknown>();
	return (name: string) => {
		const key = ifaceName(name);
		let v = cache.get(key);
		if (!v) {
			const table = known[key] ?? {};
			// Anything not listed (sockets, http, ...) is a function that traps when called.
			v = new Proxy(table, {
				get(t, prop) {
					if (typeof prop !== "string" || prop === "then") return undefined;
					return prop in t ? t[prop] : deny(`${key}#${prop}`);
				},
				has: () => true,
			});
			cache.set(key, v);
		}
		return v;
	};
}
