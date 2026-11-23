// What the driver (driver.ts) needs of the app, behind one async interface, so that a scenario is the same in both modes:
//   InProcessBackend  the app in this process, on GPUI's test renderer (app.ts boots it), as the harness always worked
//   RemoteBackend     the packaged executable, with the renderer that ships, over its standard input and output (src/automation.ts serves it)
// The wire is GPUIX's automation protocol (SSE "data:" frames) plus the `zn.<name>` methods of src/automation.ts. GPUIX's own client
// is not used: it refuses method names it does not know.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { TestRenderer } from "@gpuix/solid/testing";
import type { TreeNode } from "@gpuix/solid/automation";
import { callZn } from "../../src/automation";
import { windowsOnScreen } from "./background";
import { resolve as resolvePath } from "node:path";

export interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface MouseOpts {
	button?: number;
	modifiers?: string;
}

export interface Backend {
	/** true: the app runs in this process (the scenario may use `ui.renderer`) */
	readonly inProcess: boolean;
	/** The window's inside, logical pixels. */
	readonly size: { width: number; height: number };

	/** Let time pass: the test renderer's loop in-process, plain waiting for the real app (which runs by itself). */
	turn(ms: number): Promise<void>;
	/** Make sure the last changes are drawn (a no-op for the real app). */
	flush(): Promise<void>;

	tree(): Promise<TreeNode | null>;
	bounds(id: number): Promise<Box | null>;
	/** An input's own props (value, placeholder): the automation tree leaves them out. In-process only; the real app gives undefined. */
	inputProps(id: number): Promise<{ value?: unknown; placeholder?: unknown } | undefined>;
	/** The elements under a point, topmost first. In-process only; the real app gives null (not known). */
	elementsAt(x: number, y: number): Promise<number[] | null>;
	paintedText(): Promise<string[]>;
	allText(): Promise<string[]>;
	screenshot(path: string): Promise<void>;

	click(x: number, y: number, o?: MouseOpts & { clickCount?: number }): Promise<void>;
	mouseDown(x: number, y: number, o?: MouseOpts): Promise<void>;
	mouseUp(x: number, y: number, o?: MouseOpts): Promise<void>;
	mouseMove(x: number, y: number, o?: { pressedButton?: number; modifiers?: string }): Promise<void>;
	wheel(x: number, y: number, deltaX: number, deltaY: number, modifiers?: string): Promise<void>;
	keystrokes(keys: string): Promise<void>;
	keyDown(key: string, isHeld?: boolean): Promise<void>;
	keyUp(key: string): Promise<void>;

	/** The store: one of the `zn.<name>` methods of src/automation.ts (plain data back). */
	store(name: string, args?: unknown[]): Promise<unknown>;
	/** One request to the core's API. */
	api(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }>;

	/** The app's clipboard (in memory in both modes: never the machine's). */
	clipboard(): Promise<string>;
	setClipboard(text: string): Promise<void>;

	close(): Promise<void>;
}

// ---- in this process ---------------------------------------------------------------------------------------------------------------

type StoreLike = Record<string, any>;

export class InProcessBackend implements Backend {
	readonly inProcess = true;

	constructor(
		readonly renderer: TestRenderer,
		private readonly appStore: StoreLike,
		private readonly apiFetch: (path: string, init?: RequestInit) => Promise<Response>,
		readonly size: { width: number; height: number },
	) {}

	async turn(ms: number): Promise<void> {
		this.renderer.dispatchNativeEvents();
		await Bun.sleep(ms);
		this.renderer.advanceTime(Math.max(16, ms));
		this.renderer.flush();
		this.renderer.dispatchNativeEvents();
		this.renderer.flush();
	}
	async flush(): Promise<void> {
		this.renderer.flush();
	}

	async tree(): Promise<TreeNode | null> {
		this.renderer.flush();
		const parsed = JSON.parse(this.renderer.getAutomationTree()) as { tree?: TreeNode | null } & Partial<TreeNode>;
		const root = (parsed?.tree ?? parsed) as TreeNode | null;
		return root && typeof root.id === "number" ? root : null;
	}
	async bounds(id: number): Promise<Box | null> {
		return this.renderer.getElementBounds(id) ?? null;
	}
	async inputProps(id: number) {
		return (this.renderer.getElement(id)?.customProps ?? undefined) as { value?: unknown; placeholder?: unknown } | undefined;
	}
	async elementsAt(x: number, y: number): Promise<number[]> {
		return this.renderer.getElementsAt(x, y);
	}
	async paintedText(): Promise<string[]> {
		this.renderer.flush();
		return this.renderer.getPaintedText();
	}
	async allText(): Promise<string[]> {
		this.renderer.flush();
		return this.renderer.getAllText();
	}
	async screenshot(path: string): Promise<void> {
		this.renderer.flush();
		this.renderer.captureScreenshot(path);
	}

	async click(x: number, y: number, o: MouseOpts & { clickCount?: number } = {}): Promise<void> {
		const r = this.renderer;
		r.nativeSimulateMouseMove(x, y, undefined, o.modifiers);
		const count = o.clickCount ?? 1;
		for (let i = 0; i < count; i++) this.clickOnce(x, y, o.button ?? 0, o.modifiers, i + 1);
	}
	/** One click of a series: the nth says so (clickCount), as a window does and the test renderer does not. */
	private clickOnce(x: number, y: number, button: number, modifiers: string | undefined, clickCount: number): void {
		if (clickCount === 1) return this.renderer.nativeSimulateClick(x, y, button, modifiers);
		const r = this.renderer as unknown as { dispatchEvent: (e: Record<string, unknown>) => void };
		const plain = r.dispatchEvent;
		r.dispatchEvent = (e) => plain(["click", "mouseDown", "mouseUp"].includes(String(e.eventType)) ? { ...e, clickCount } : e);
		try {
			this.renderer.nativeSimulateClick(x, y, button, modifiers);
		} finally {
			r.dispatchEvent = plain;
		}
	}
	async mouseDown(x: number, y: number, o: MouseOpts = {}): Promise<void> {
		this.renderer.nativeSimulateMouseDown(x, y, o.button, o.modifiers);
	}
	async mouseUp(x: number, y: number, o: MouseOpts = {}): Promise<void> {
		this.renderer.nativeSimulateMouseUp(x, y, o.button, o.modifiers);
	}
	async mouseMove(x: number, y: number, o: { pressedButton?: number; modifiers?: string } = {}): Promise<void> {
		this.renderer.nativeSimulateMouseMove(x, y, o.pressedButton, o.modifiers);
	}
	async wheel(x: number, y: number, deltaX: number, deltaY: number, modifiers?: string): Promise<void> {
		this.renderer.nativeSimulateScrollWheel(x, y, deltaX, deltaY, modifiers);
	}
	async keystrokes(keys: string): Promise<void> {
		this.renderer.simulateKeystrokes(keys);
	}
	async keyDown(key: string, isHeld?: boolean): Promise<void> {
		(this.renderer as unknown as { simulateKeyDown(k: string, h?: boolean): void }).simulateKeyDown(key, isHeld);
	}
	async keyUp(key: string): Promise<void> {
		(this.renderer as unknown as { simulateKeyUp(k: string): void }).simulateKeyUp(key);
	}

	async store(name: string, args: unknown[] = []): Promise<unknown> {
		if (name === "focused") return (this.renderer as { getFocusedElementId?: () => number | null }).getFocusedElementId?.() ?? null;
		return callZn(this.appStore, name, args); // the same table the real app serves: both modes answer alike
	}
	async api(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
		const r = await this.apiFetch(path, {
			method,
			headers: body === undefined ? undefined : { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: r.status, text: await r.text() };
	}
	async clipboard(): Promise<string> {
		return String((this.renderer as unknown as { readFromClipboard(): string }).readFromClipboard() ?? "");
	}
	async setClipboard(text: string): Promise<void> {
		(this.renderer as unknown as { writeToClipboard(t: string): void }).writeToClipboard(text);
	}
	async close(): Promise<void> {}
}

// ---- the packaged app ---------------------------------------------------------------------------------------------------------------

export interface RemoteOptions {
	/** The packaged executable. */
	exe: string;
	/** The scenario's folder: the app's user folders go inside it. */
	root: string;
	/** The scenario's library (makeLibrary). */
	db: string;
	size: { width: number; height: number };
	/** Environment of the harness process: only its system variables are passed on (no ZN_*). */
	baseEnv?: Record<string, string | undefined>;
	desktop?: string;
}

const REQUEST_TIMEOUT_MS = 30_000;

export class RemoteBackend implements Backend {
	readonly inProcess = false;
	size: { width: number; height: number };
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private buffer = "";
	private stderr = "";
	private exited: string | undefined;
	private readonly watchdog: ReturnType<typeof setInterval>;

	private constructor(
		private readonly child: ChildProcessWithoutNullStreams,
		size: { width: number; height: number },
		exe: string,
	) {
		this.size = size;
		// the app must never be seen: a window of it on the user's screen ends the run at once (src/automation.ts starts it elsewhere)
		this.watchdog = setInterval(() => {
			if (this.exited || windowsOnScreen(exe) === 0) return;
			this.gone("a window of the test app appeared on the user's screen; the app was stopped");
			try {
				this.child.kill();
			} catch {
				/* already gone */
			}
		}, 250);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.feed(chunk));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => void (this.stderr = (this.stderr + chunk).slice(-4000)));
		child.on("exit", (code) => this.gone(`the app exited (code ${code}). Its stderr ended: ${this.stderr.trim().split("\n").slice(-6).join("\n")}`));
		child.on("error", (e) => this.gone(`the app could not be run: ${e.message}`));
		child.stdin.on("error", () => {});
	}

	/** Start the app and wait until it answers. */
	static async launch(o: RemoteOptions): Promise<RemoteBackend> {
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(o.baseEnv ?? process.env)) if (v !== undefined && !/^(?:ZN_|ZNH_|ZOTERO_)/i.test(k)) env[k] = v;
		const home = `${o.root}/home`;
		Object.assign(env, {
			ZN_AUTOMATION: "stdio",
			ZN_AUTOMATION_DESKTOP: o.desktop ?? "zinc-ui-tests",
			ZN_AUTOMATION_WINDOW: `${o.size.width}x${o.size.height}`,
			ZN_DB: o.db,
			ZN_PORT: "0",
			ZN_SYNC: "0",
			ZN_ZPORT: "0",
			USERPROFILE: home,
			HOME: home,
			APPDATA: `${home}/AppData/Roaming`,
			LOCALAPPDATA: `${home}/AppData/Local`,
			TEMP: `${o.root}/tmp`,
			TMP: `${o.root}/tmp`,
		});
		// (no windowsHide: it starts the app with SW_HIDE, and a window that is told to hide is not drawn, so it answers no query. The exe is
		// a GUI program: no console; its window opens on the background desktop, src/automation.ts)
		const exe = resolvePath(o.exe);
		if (windowsOnScreen(exe) > 0) throw new Error(`a window of ${exe} is already on the user's screen: not starting another`);
		const child = spawn(exe, [], { env, stdio: ["pipe", "pipe", "pipe"] });
		const backend = new RemoteBackend(child, o.size, exe);
		try {
			// (its answer's window size is a stub: the window was asked for o.size, and app.ts checks the layout)
			await backend.request("initialize", { protocolVersion: 1, client: "zinc-ui-harness" }, 60_000);
		} catch (e) {
			await backend.close();
			throw e;
		}
		return backend;
	}

	private feed(chunk: string): void {
		this.buffer += chunk;
		for (let end = this.buffer.indexOf("\n\n"); end >= 0; end = this.buffer.indexOf("\n\n")) {
			const frame = this.buffer.slice(0, end);
			this.buffer = this.buffer.slice(end + 2);
			for (const line of frame.split(/\r?\n/)) {
				if (!line.startsWith("data:")) continue;
				let m: { id?: number; result?: unknown; error?: { message: string }; event?: string };
				try {
					m = JSON.parse(line.slice(5).trim());
				} catch {
					continue;
				}
				if (typeof m.id !== "number") continue; // an event
				const waiter = this.pending.get(m.id);
				if (!waiter) continue;
				this.pending.delete(m.id);
				if (m.error) waiter.reject(new Error(m.error.message));
				else waiter.resolve(m.result);
			}
		}
	}

	private gone(why: string): void {
		this.exited ??= why;
		if (/user's screen/.test(why)) this.exited = why;
		clearInterval(this.watchdog);
		for (const [, w] of this.pending) w.reject(new Error(this.exited));
		this.pending.clear();
	}

	private request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
		if (this.exited) return Promise.reject(new Error(this.exited));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} got no answer in ${timeoutMs} ms. The app's stderr ended: ${this.stderr.trim().split("\n").slice(-4).join("\n")}`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (v) => (clearTimeout(timer), resolve(v)),
				reject: (e) => (clearTimeout(timer), reject(e)),
			});
			this.child.stdin.write(`data: ${JSON.stringify({ id, method, params })}\n\n`);
		});
	}

	async turn(ms: number): Promise<void> {
		await Bun.sleep(ms);
		if (this.exited) throw new Error(this.exited);
	}
	async flush(): Promise<void> {}

	async tree(): Promise<TreeNode | null> {
		const { tree } = (await this.request("getTree", {})) as { tree: TreeNode | null };
		return tree;
	}
	async bounds(id: number): Promise<Box | null> {
		return ((await this.request("getBounds", { elementId: id })) as { bounds: Box | null }).bounds;
	}
	async inputProps(): Promise<undefined> {
		return undefined;
	}
	async elementsAt(): Promise<null> {
		return null;
	}
	async paintedText(): Promise<string[]> {
		return ((await this.request("getPaintedText", {})) as { text: string[] }).text;
	}
	async allText(): Promise<string[]> {
		return ((await this.request("getAllText", {})) as { text: string[] }).text;
	}
	async screenshot(path: string): Promise<void> {
		await this.request("screenshot", { path });
	}

	async click(x: number, y: number, o: MouseOpts & { clickCount?: number } = {}): Promise<void> {
		await this.request("mouseMove", { x, y, modifiers: o.modifiers });
		// each click of a series says its place in it (the app passes it on to the renderer: src/automation.ts repeatClick)
		for (let i = 0; i < (o.clickCount ?? 1); i++)
			await this.request("click", { x, y, button: o.button, modifiers: o.modifiers, ...(i > 0 ? { clickCount: i + 1 } : {}) });
	}
	async mouseDown(x: number, y: number, o: MouseOpts = {}): Promise<void> {
		await this.request("mouseDown", { x, y, button: o.button, modifiers: o.modifiers });
	}
	async mouseUp(x: number, y: number, o: MouseOpts = {}): Promise<void> {
		await this.request("mouseUp", { x, y, button: o.button, modifiers: o.modifiers });
	}
	async mouseMove(x: number, y: number, o: { pressedButton?: number; modifiers?: string } = {}): Promise<void> {
		await this.request("mouseMove", { x, y, pressedButton: o.pressedButton, modifiers: o.modifiers });
	}
	async wheel(x: number, y: number, deltaX: number, deltaY: number, modifiers?: string): Promise<void> {
		await this.request("scrollWheel", { x, y, deltaX, deltaY, modifiers });
	}
	async keystrokes(keys: string): Promise<void> {
		await this.request("keystrokes", { keys });
	}
	async keyDown(key: string, isHeld?: boolean): Promise<void> {
		await this.request("keyDown", { key, isHeld });
	}
	async keyUp(key: string): Promise<void> {
		await this.request("keyUp", { key });
	}

	async store(name: string, args: unknown[] = []): Promise<unknown> {
		return this.request(`zn.${name}`, { args });
	}
	async api(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
		return (await this.request("zn.api", { args: [method, path, body] })) as { status: number; text: string };
	}

	async clipboard(): Promise<string> {
		return (await this.request("zn.clipboard", { args: [] })) as string;
	}
	async setClipboard(text: string): Promise<void> {
		await this.request("zn.setClipboard", { args: [text] });
	}

	async close(): Promise<void> {
		for (const [, w] of this.pending) w.reject(new Error("closed"));
		this.pending.clear();
		this.exited ??= "closed";
		clearInterval(this.watchdog);
		try {
			this.child.kill();
		} catch {
			/* already gone */
		}
		await new Promise((r) => setTimeout(r, 1200)); // the app lets go of its library and logs as it exits
	}
}
