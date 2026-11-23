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

function moveToDesktop(name: string): void {
	// bun:ffi is loaded only here: the app does not need it otherwise
	const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
	const user32 = dlopen("user32.dll", {
		CreateDesktopW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.u64 },
		SetThreadDesktop: { args: [FFIType.u64], returns: FFIType.i32 },
	}).symbols;
	const GENERIC_ALL = 0x10000000;
	const handle = user32.CreateDesktopW(Buffer.from(`${name}\0`, "utf16le"), null, null, 0, GENERIC_ALL, null);
	// fails closed: a window that could not be hidden is not opened on the user's screen
	if (!Number(handle) || !user32.SetThreadDesktop(handle)) {
		process.stderr.write(`automation: could not move to the background desktop "${name}"; not opening a window\n`);
		process.exit(3);
	}
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
