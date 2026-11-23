// `process` and `Bun` for the browser demo: just enough of each for the app's modules to load and run on the demo library.
// Its own entry in web/build.ts: the page loads it before main.js (src/main.tsx), so it runs before any app module reads them.
import { Buffer } from "buffer"; // Bun's browser polyfill (web/build.ts leaves `buffer` to it)
import * as fs from "./shims/fs";

const g = globalThis as Record<string, unknown>;
g.Buffer ??= Buffer; // some of the reader's code uses the global, as under Bun
const noop = () => {};
const env: Record<string, string | undefined> = {
	ZN_WEB_DEMO: "1",
	APPDATA: "/appdata",
	LOCALAPPDATA: "/localappdata",
	USERPROFILE: "/home/demo",
	HOME: "/home/demo",
	TEMP: "/tmp",
};

if (!g.process) {
	const proc: Record<string, unknown> = {
		env,
		platform: "win32",
		arch: "x64",
		argv: ["bun", "web-demo"],
		execArgv: [],
		execPath: "/bun",
		pid: 1,
		ppid: 0,
		version: "v22.0.0",
		versions: { bun: "1.4.5", node: "22.0.0" },
		release: { name: "node" },
		title: "zotero-next-demo",
		exitCode: 0,
		cwd: () => "/",
		chdir: noop,
		exit: noop,
		kill: noop,
		umask: () => 0,
		on() {
			return proc;
		},
		once() {
			return proc;
		},
		off() {
			return proc;
		},
		addListener() {
			return proc;
		},
		removeListener() {
			return proc;
		},
		removeAllListeners() {
			return proc;
		},
		emit: () => false,
		listeners: () => [],
		nextTick: (f: (...a: unknown[]) => void, ...a: unknown[]) => queueMicrotask(() => f(...a)),
		hrtime: Object.assign(
			(prev?: [number, number]) => {
				const t = performance.now();
				const s = Math.floor(t / 1000),
					n = Math.floor((t % 1000) * 1e6);
				return prev ? [s - prev[0], n - prev[1]] : [s, n];
			},
			{ bigint: () => BigInt(Math.round(performance.now() * 1e6)) },
		),
		memoryUsage: Object.assign(() => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }), { rss: () => 0 }),
		cpuUsage: () => ({ user: 0, system: 0 }),
		uptime: () => performance.now() / 1000,
		resourceUsage: () => ({}),
		// no stdin: GPUIX turns on its stdin automation channel when it sees one (runtime.js createNativeRenderer)
		stdout: { write: noop, isTTY: false, columns: 120, on: noop },
		stderr: { write: noop, isTTY: false, on: noop },
		emitWarning: noop,
		binding: () => ({}),
		features: {},
	};
	g.process = proc;
}

if (!g.Bun) {
	const file = (p: string) => ({
		name: p,
		get size() {
			try {
				return fs.statSync(p).size;
			} catch {
				return 0;
			}
		},
		exists: async () => fs.existsSync(p),
		text: async () => fs.readFileSync(p, "utf8"),
		json: async () => JSON.parse(fs.readFileSync(p, "utf8")),
		arrayBuffer: async () => (fs.readFileSync(p) as Uint8Array).buffer,
		bytes: async () => fs.readFileSync(p) as Uint8Array,
		write: async (d: unknown) => fs.writeFileSync(p, d),
		delete: async () => fs.rmSync(p),
	});
	g.Bun = {
		version: "1.4.5",
		revision: "web",
		env,
		main: "/web-demo",
		file,
		write: async (p: unknown, d: unknown) => {
			fs.writeFileSync(typeof p === "string" ? p : (p as { name: string }).name, d);
			return 0;
		},
		sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
		sleepSync: noop,
		nanoseconds: () => Math.round(performance.now() * 1e6),
		gc: noop,
		which: () => null,
		hash: Object.assign(
			(s: string | Uint8Array) => {
				let h = 0x811c9dc5;
				for (const b of typeof s === "string" ? new TextEncoder().encode(s) : s) {
					h ^= b;
					h = Math.imul(h, 0x01000193) >>> 0;
				}
				return h;
			},
			{ wyhash: (s: string) => s.length },
		),
		spawn: () => {
			throw new Error("processes are not available in the browser demo");
		},
		spawnSync: () => ({ exitCode: 1, stdout: new Uint8Array(), stderr: new Uint8Array(), success: false }),
		serve: () => {
			throw new Error("servers are not available in the browser demo");
		},
		secrets: { get: async () => null, set: async () => {}, delete: async () => false },
		inspect: (v: unknown) => String(v),
		deepEquals: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b),
	};
}
