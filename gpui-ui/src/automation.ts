// Opt-in automation of the running app, for the UI harness (gpui-ui/test/ui): the packaged app, with the renderer that ships, driven
// over its standard input and output with GPUIX's automation protocol (@gpuix/native/automation). Off unless ZN_AUTOMATION=stdio is set
// by whoever starts the process; a normal start never reads stdin or exposes anything.
//
//   ZN_AUTOMATION=stdio          serve the protocol on stdin/stdout (the app's own console output goes to stderr instead)
//   ZN_AUTOMATION_DESKTOP=<name> Windows: open the window on that background desktop, where it is drawn and takes input but cannot be seen
//                                or take the focus (the harness uses one desktop for all its processes)

export const automationWanted = (): boolean => typeof process !== "undefined" && process.env?.ZN_AUTOMATION === "stdio";

/** ZN_AUTOMATION_WINDOW=<w>x<h> (with ZN_AUTOMATION=stdio only): the window's inside in logical pixels, for scenarios that assume one size. */
export function automationWindow(): { width: number; height: number } | undefined {
	if (!automationWanted()) return undefined;
	const m = /^(\d+)x(\d+)$/.exec(process.env.ZN_AUTOMATION_WINDOW ?? "");
	return m ? { width: Number(m[1]), height: Number(m[2]) } : undefined;
}

/** The app's clipboard while it is driven: in memory, so that a copy never reaches the clipboard of the person at the machine. */
let clipboard = "";

let prepared = false;
let served = false;

/** Before the first window: move to the background desktop when asked, and keep stdout for the protocol. */
export function prepareAutomation(): void {
	if (prepared || !automationWanted()) return;
	prepared = true;
	// stdout carries the protocol: anything else written there would be read as part of it
	const toErr = (...a: unknown[]) => process.stderr.write(`${a.map((x) => (typeof x === "string" ? x : Bun.inspect(x))).join(" ")}\n`);
	console.log = toErr;
	console.info = toErr;
	console.debug = toErr;
	const desktop = process.env.ZN_AUTOMATION_DESKTOP;
	if (desktop && process.platform === "win32") moveToDesktop(desktop);
}

/**
 * What the harness may ask of the app besides GPUIX's own methods: store reads and the few store actions the scenarios use, by name
 * (`zn.<name>`). Nothing else, and no way to run code. A result is plain data (a Set is an array, a signal is read). The harness uses
 * the same table in-process, so that both modes answer alike.
 */
export const ZN_METHODS = [
	"ping",
	"activeTab",
	"total",
	"view",
	"sortLevels",
	"selected",
	"tabs",
	"revealItem",
	"refreshItems",
	"focusIndex",
	"viewMode",
	"selectedItem",
	"peek",
	"groups",
	"refresh",
	"api",
	"clipboard",
	"setClipboard",
] as const;
export type ZnMethod = (typeof ZN_METHODS)[number];

const plain = (v: unknown): unknown =>
	v === undefined ? null : JSON.parse(JSON.stringify(v, (_k, x) => (x instanceof Set ? [...x] : x instanceof Map ? [...x] : x)));

/** Run one allowlisted method against the store (loaded by the caller, lazily). */
export async function callZn(store: Record<string, any>, name: string, args: unknown[] = []): Promise<unknown> {
	if (!(ZN_METHODS as readonly string[]).includes(name)) throw new Error(`not an automation method: zn.${name}`);
	if (name === "ping") return "pong";
	if (name === "clipboard") return clipboard;
	if (name === "setClipboard") return void (clipboard = String(args[0] ?? ""));
	if (name === "api") return callApi(args as [string, string, unknown?]);
	const f = store[name];
	if (typeof f !== "function") throw new Error(`the store has no ${name}`);
	return plain(await f(...args));
}

/**
 * A click that is not the first of a series (`clickCount` 2 for the second click of a double click): GPUIX's protocol has no click
 * count, so it goes to the renderer here, which tells the app as a window does. False for a first click: GPUIX's handler takes those.
 */
function repeatClick(renderer: unknown, params: unknown): boolean {
	const p = (params ?? {}) as { x?: unknown; y?: unknown; button?: unknown; modifiers?: unknown; clickCount?: unknown };
	const count = Number(p.clickCount);
	if (!Number.isInteger(count) || count < 2 || typeof p.x !== "number" || typeof p.y !== "number") return false;
	const r = renderer as { simulateClick: (...a: unknown[]) => void; tick?: () => void };
	r.simulateClick(p.x, p.y, typeof p.button === "number" ? p.button : 0, typeof p.modifiers === "string" ? p.modifiers : undefined, count);
	r.tick?.();
	return true;
}

/** Once the renderer exists: answer the harness, GPUIX's methods and the zn.* ones on the same channel. */
export async function serveAutomation(renderer: unknown): Promise<void> {
	if (served || !automationWanted() || !renderer) return;
	served = true;
	const m = await import("@gpuix/native/automation");
	Object.assign(renderer as object, { writeToClipboard: (t: string) => void (clipboard = t), readFromClipboard: () => clipboard });
	const backend = new m.InProcessBackend(m.liveRendererAsTest(renderer as never));
	let storeIn: Promise<Record<string, any>> | undefined;
	const loadStore = () => (storeIn ??= import("./store").then((x) => x.store as unknown as Record<string, any>));
	const send = (s: string) => void process.stdout.write(s);
	const fail = (id: unknown, e: unknown) =>
		m.encodeSse({ id, error: { code: "Protocol", message: e instanceof Error ? e.message : String(e) } } as never);

	async function answer(message: { id?: unknown; method?: unknown; params?: unknown }): Promise<void> {
		const method = String(message.method ?? "");
		try {
			if (method === "click" && repeatClick(renderer, message.params)) return send(m.encodeSse({ id: message.id, result: { ok: true } } as never));
			if (!method.startsWith("zn.")) return send(await m.handleAutomationRequest(message, backend));
			const args = (message.params as { args?: unknown[] } | undefined)?.args ?? [];
			const result = await callZn(await loadStore(), method.slice(3), args);
			send(m.encodeSse({ id: message.id, result } as never));
		} catch (e) {
			send(fail(message.id, e));
		}
	}

	// SSE frames as GPUIX writes them: "data: <json>" ended by a blank line (its own decoder refuses the names it does not know)
	let buffer = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk: string) => {
		buffer += chunk;
		for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
			const frame = buffer.slice(0, end);
			buffer = buffer.slice(end + 2);
			for (const line of frame.split(/\r?\n/)) {
				if (!line.startsWith("data:")) continue;
				try {
					const message = JSON.parse(line.slice(5).trim());
					if (message && typeof message === "object" && "method" in message) void answer(message);
				} catch {
					/* not a request: ignored */
				}
			}
		}
	});
}

/**
 * Runs the app again as a child process that starts on the background desktop, and waits for it. Moving only this thread there is not
 * enough: windows that other threads or child processes open (the renderer's own thread among them) go to the desktop the process started
 * on, which is the user's screen. A process started on the desktop has all its threads, and its children, there. The child inherits the
 * standard handles (the harness talks to it directly) and is in a job that ends it when this process ends. Fails closed: if any step
 * fails, nothing is started.
 */
function moveToDesktop(name: string): void {
	if (process.env.ZN_AUTOMATION_ON_DESKTOP === name) return; // this is the child, already there
	const fail = (what: string): never => {
		process.stderr.write(`automation: ${what}; not opening a window\n`);
		process.exit(3);
	};
	// bun:ffi is loaded only here: the app does not need it otherwise
	const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi");
	const H = FFIType.u64,
		P = FFIType.ptr,
		U32 = FFIType.u32,
		I = FFIType.i32;
	const user32 = dlopen("user32.dll", { CreateDesktopW: { args: [P, P, P, U32, U32, P], returns: H } }).symbols;
	const kernel32 = dlopen("kernel32.dll", {
		GetStdHandle: { args: [U32], returns: H },
		SetHandleInformation: { args: [H, U32, U32], returns: I },
		CreateJobObjectW: { args: [P, P], returns: H },
		SetInformationJobObject: { args: [H, U32, P, U32], returns: I },
		CreateProcessW: { args: [P, P, P, P, I, U32, P, P, P, P], returns: I },
		AssignProcessToJobObject: { args: [H, H], returns: I },
		ResumeThread: { args: [H], returns: U32 },
		TerminateProcess: { args: [H, U32], returns: I },
		OpenProcess: { args: [U32, I, U32], returns: H },
		WaitForMultipleObjects: { args: [U32, P, I, U32], returns: U32 },
		GetExitCodeProcess: { args: [H, P], returns: I },
	}).symbols;
	const GENERIC_ALL = 0x10000000;
	// the desktop exists while a handle to it is open: this one stays open until this process ends
	if (!Number(user32.CreateDesktopW(Buffer.from(`${name}\0`, "utf16le"), null, null, 0, GENERIC_ALL, null)))
		fail(`Windows gave no background desktop "${name}"`);

	// a job that ends the child when this process ends (however it ends)
	const job = kernel32.CreateJobObjectW(null, null);
	const limits = new Uint8Array(144); // JOBOBJECT_EXTENDED_LIMIT_INFORMATION (x64)
	new DataView(limits.buffer).setUint32(16, 0x2000, true); // LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if (!Number(job) || !kernel32.SetInformationJobObject(job, 9 /* JobObjectExtendedLimitInformation */, limits, limits.length))
		fail("could not make a job for the app");

	// the standard handles (the harness's pipes), passed on as they are
	const std = [-10, -11, -12].map((n) => kernel32.GetStdHandle(n >>> 0));
	for (const h of std) if (Number(h) > 0) kernel32.SetHandleInformation(h, 1 /* HANDLE_FLAG_INHERIT */, 1);

	const desktopName = Buffer.from(`WinSta0\\${name}\0`, "utf16le");
	const si = new Uint8Array(104); // STARTUPINFOW (x64)
	const sv = new DataView(si.buffer);
	sv.setUint32(0, si.length, true);
	sv.setBigUint64(16, BigInt(ptr(desktopName)), true); // lpDesktop
	sv.setUint32(60, 0x100, true); // dwFlags: STARTF_USESTDHANDLES
	std.forEach((h, i) => sv.setBigUint64(80 + i * 8, BigInt(h), true));
	const pi = new Uint8Array(24); // PROCESS_INFORMATION
	const env = { ...process.env, ZN_AUTOMATION_ON_DESKTOP: name } as Record<string, string | undefined>;
	const block = Buffer.from(
		`${Object.entries(env)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0))
			.map(([k, v]) => `${k}=${v}\0`)
			.join("")}\0`,
		"utf16le",
	);
	const commandLine = Buffer.from(`"${process.execPath}"\0`, "utf16le");
	const CREATE_SUSPENDED = 0x4,
		CREATE_UNICODE_ENVIRONMENT = 0x400;
	if (!kernel32.CreateProcessW(null, commandLine, null, null, 1, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, block, null, si, pi))
		fail("could not start the app on the background desktop");
	const pv = new DataView(pi.buffer);
	const child = pv.getBigUint64(0, true),
		thread = pv.getBigUint64(8, true);
	// in the job before it runs a single instruction: it never outlives this process
	if (!kernel32.AssignProcessToJobObject(job, child)) {
		kernel32.TerminateProcess(child, 3);
		fail("could not put the app in its job");
	}
	kernel32.ResumeThread(thread);
	// wait for the app, or for whoever started this process (the harness): if that ends, so does the app (a killed parent does not end
	// its children on Windows, and the harness may be killed)
	const starter = kernel32.OpenProcess(0x00100000 /* SYNCHRONIZE */, 0, process.ppid);
	const handles = new BigUint64Array(Number(starter) ? [BigInt(child), BigInt(starter)] : [BigInt(child)]);
	const woke = kernel32.WaitForMultipleObjects(handles.length, handles, 0, 0xffffffff);
	if (woke === 1) {
		kernel32.TerminateProcess(child, 1);
		process.exit(1);
	}
	const code = new Uint32Array(1);
	kernel32.GetExitCodeProcess(child, code);
	process.exit(code[0] ?? 0);
}

/** `zn.api`: one request to the core's own API, as the app's UI makes them (what a scenario checks "was saved" with). */
async function callApi([method, path, body]: [string, string, unknown?]): Promise<{ status: number; text: string }> {
	if (typeof path !== "string" || !path.startsWith("/")) throw new Error("zn.api takes a path of the core API");
	const { apiFetch } = await import("./api");
	const r = await apiFetch(path, {
		method,
		headers: body == null ? undefined : { "Content-Type": "application/json" },
		body: body == null ? undefined : JSON.stringify(body),
	});
	return { status: r.status, text: await r.text() };
}
