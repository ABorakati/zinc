// What a scenario drives the app with. All input goes through GPUI (hit testing, focus, key dispatch), none through the store: a row
// that ignores clicks fails here as it does for a user. Assertions read what was painted, and what the core saved.
import type { TestRenderer } from "@gpuix/solid/testing";
import type { TreeNode } from "@gpuix/solid/automation";

type Store = (typeof import("../../src/store"))["store"];
type ApiFetch = (typeof import("../../src/api"))["apiFetch"];

interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface FindOptions {
	/** The whole text has to match (default: it contains the string). */
	exact?: boolean;
	/** Which of the matches that are on screen, from the top left (default 0). */
	nth?: number;
	/** Only matches whose centre is inside this part of the window. */
	area?: Area;
}

/** The parts of the window, by where the standard layout puts them. */
export type Area = "top" | "sidebar" | "list" | "pane" | Box;

export interface Found {
	id: number;
	text: string;
	box: Box;
	x: number;
	y: number;
}

/** Only as data: what a saved item looks like. */
export interface SavedItem {
	key: string;
	title: string;
	creators: string[];
	[field: string]: unknown;
}

interface Indexed {
	node: TreeNode;
	parent: Indexed | null;
}

const centre = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const inside = (b: Box, x: number, y: number) => x >= b.x && y >= b.y && x < b.x + b.width && y < b.y + b.height;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class Ui {
	/** What the scenario did, for the report of a failure. */
	readonly steps: string[] = [];
	private shots = 0;

	constructor(
		readonly renderer: TestRenderer,
		readonly store: Store,
		private readonly apiFetch: ApiFetch,
		readonly size: { width: number; height: number },
		private readonly outDir: string,
	) {}

	// ---- time --------------------------------------------------------------------------------------------------------------------

	/** One turn of the loop: native events to the app, the app's changes to GPUI, a frame. */
	private async turn(ms: number): Promise<void> {
		this.renderer.dispatchNativeEvents();
		await Bun.sleep(ms);
		this.renderer.advanceTime(Math.max(16, ms));
		this.renderer.flush();
		this.renderer.dispatchNativeEvents();
		this.renderer.flush();
	}

	/** Let what the last action started finish. */
	async settle(ms = 240): Promise<void> {
		const until = performance.now() + ms;
		do await this.turn(20);
		while (performance.now() < until);
	}

	/** Until `check` holds; fails with `what` after `timeoutMs`. */
	async waitFor(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
		const until = performance.now() + timeoutMs;
		for (;;) {
			if (await check()) return;
			if (performance.now() > until) throw new Error(`waited ${timeoutMs} ms for: ${what}`);
			await this.turn(40);
		}
	}

	/** `read()` becomes `wanted`; a failure says what it was instead. */
	async expect<T>(what: string, read: () => T | Promise<T>, wanted: T, timeoutMs = 3000): Promise<void> {
		this.steps.push(`expect ${what}`);
		const until = performance.now() + timeoutMs;
		for (;;) {
			const got = await read();
			if (same(got, wanted)) return;
			if (performance.now() > until) throw new Error(`${what}\n  expected ${JSON.stringify(wanted)}\n  got      ${JSON.stringify(got)}`);
			await this.turn(50);
		}
	}

	/** `read()` is still `wanted` after the app had time to do something wrong. */
	async expectStill<T>(what: string, read: () => T | Promise<T>, wanted: T, ms = 700): Promise<void> {
		await this.settle(ms);
		await this.expect(what, read, wanted, 0);
	}

	// ---- what is on screen -------------------------------------------------------------------------------------------------------

	private index(): { all: Indexed[]; byId: Map<number, Indexed> } {
		this.renderer.flush();
		const all: Indexed[] = [];
		const byId = new Map<number, Indexed>();
		const parsed = JSON.parse(this.renderer.getAutomationTree()) as { tree?: TreeNode | null } & Partial<TreeNode>;
		const root = (parsed?.tree ?? parsed) as TreeNode | null;
		const walk = (node: TreeNode, parent: Indexed | null) => {
			const here = { node, parent };
			all.push(here);
			byId.set(node.id, here);
			for (const c of node.children ?? []) walk(c, here);
		};
		if (root && typeof root.id === "number") walk(root, null);
		return { all, byId };
	}

	private boxOf(n: Indexed | null): Box | null {
		for (let at = n, up = 0; at && up < 3; at = at.parent, up++) {
			const b = at.node.bounds ?? this.renderer.getElementBounds(at.node.id);
			if (b && b.width > 0 && b.height > 0) return b;
		}
		return null;
	}

	private area(a: Area): Box {
		if (typeof a !== "string") return a;
		const { width: w, height: h } = this.size;
		if (a === "top") return { x: 0, y: 0, width: w, height: 80 };
		if (a === "sidebar") return { x: 0, y: 72, width: w * 0.18, height: h - 72 };
		if (a === "list") return { x: w * 0.18, y: 72, width: w * 0.53, height: h - 72 };
		return { x: w * 0.71, y: 72, width: w * 0.29, height: h - 72 };
	}

	private related(a: Indexed, b: Indexed): boolean {
		for (let p: Indexed | null = a; p; p = p.parent) if (p === b) return true;
		for (let p: Indexed | null = b; p; p = p.parent) if (p === a) return true;
		return false;
	}

	private matches(text: string, o: FindOptions): { found: (Found & { node: Indexed })[]; byId: Map<number, Indexed> } {
		const { all, byId } = this.index();
		const within = o.area ? this.area(o.area) : { x: 0, y: 0, ...this.size };
		const found: (Found & { node: Indexed })[] = [];
		for (const n of all) {
			const t = n.node.text;
			if (!t || (o.exact ? t.trim() !== text : !t.includes(text))) continue;
			const box = this.boxOf(n);
			if (!box) continue;
			const c = centre(box);
			if (!inside({ x: 0, y: 0, ...this.size }, c.x, c.y) || !inside(within, c.x, c.y)) continue;
			if (found.some((f) => same(f.box, box))) continue; // a text node and the element around it
			found.push({ id: n.node.id, text: t, box, ...c, node: n });
		}
		found.sort((a, b) => a.y - b.y || a.x - b.x);
		return { found, byId };
	}

	/** Every match on screen, from the top left. */
	findAll(text: string, o: FindOptions = {}): Found[] {
		return this.matches(text, o).found;
	}

	visible(text: string, o: FindOptions = {}): boolean {
		return this.findAll(text, o).length > 0;
	}

	async see(text: string, o: FindOptions = {}, timeoutMs = 5000): Promise<Found> {
		this.steps.push(`see "${text}"`);
		await this.waitFor(`"${text}" on screen`, () => this.findAll(text, o).length > (o.nth ?? 0), timeoutMs);
		return this.findAll(text, o)[o.nth ?? 0]!;
	}

	async gone(text: string, o: FindOptions = {}, timeoutMs = 5000): Promise<void> {
		this.steps.push(`gone "${text}"`);
		await this.waitFor(`"${text}" to leave the screen`, () => !this.visible(text, o), timeoutMs);
	}

	/** Everything in the last frame, as text. */
	painted(): string[] {
		this.renderer.flush();
		return this.renderer.getPaintedText();
	}

	// ---- input -------------------------------------------------------------------------------------------------------------------

	/** Click where `text` is. Fails when something else lies on top of it, as a click of the user would land there. */
	async click(text: string, o: FindOptions & { button?: number; modifiers?: string; count?: number } = {}): Promise<void> {
		await this.see(text, o);
		const { found, byId } = this.matches(text, o);
		const f = found[o.nth ?? 0];
		if (!f) throw new Error(`"${text}" left the screen before the click`);
		const top = this.renderer.getElementsAt(f.x, f.y)[0];
		const topNode = top === undefined ? undefined : byId.get(top);
		if (topNode && !this.related(topNode, f.node))
			throw new Error(`"${text}" is covered at ${Math.round(f.x)},${Math.round(f.y)} by element ${top} (${topNode.node.type} "${topNode.node.text ?? ""}")`);
		await this.clickAt(f.x, f.y, o);
	}

	async clickAt(x: number, y: number, o: { button?: number; modifiers?: string; count?: number } = {}): Promise<void> {
		this.steps.push(`click ${Math.round(x)},${Math.round(y)}${o.modifiers ? ` +${o.modifiers}` : ""}${o.button ? ` button ${o.button}` : ""}`);
		this.renderer.nativeSimulateMouseMove(x, y, undefined, o.modifiers);
		for (let i = 0; i < (o.count ?? 1); i++) this.renderer.nativeSimulateClick(x, y, o.button ?? 0, o.modifiers);
		await this.settle();
	}

	async rightClick(text: string, o: FindOptions = {}): Promise<void> {
		await this.click(text, { ...o, button: 2 });
	}

	/** The value beside a label of the item pane's Details. */
	async clickField(label: string): Promise<void> {
		const l = await this.see(label, { exact: true, area: "pane" });
		const valueX = this.area("pane");
		await this.clickAt(valueX.x + valueX.width * 0.4, l.y);
	}

	/** Keys in GPUI's syntax: "enter", "ctrl-a", "shift-down", several separated by spaces. */
	async press(keys: string): Promise<void> {
		this.steps.push(`press ${keys}`);
		this.renderer.simulateKeystrokes(keys);
		await this.settle(120);
	}

	async type(text: string): Promise<void> {
		this.steps.push(`type "${text}"`);
		for (const ch of text) {
			const key = ch === " " ? "space" : ch === "\n" ? "enter" : ch === "\t" ? "tab" : ch;
			this.renderer.simulateKeystrokes(key);
		}
		await this.settle(120);
	}

	/** Select what the focused field holds and type over it. */
	async replace(text: string): Promise<void> {
		await this.press(process.platform === "darwin" ? "cmd-a" : "ctrl-a");
		await this.type(text);
	}

	async drag(from: { x: number; y: number }, to: { x: number; y: number }, steps = 10): Promise<void> {
		this.steps.push(`drag ${Math.round(from.x)},${Math.round(from.y)} to ${Math.round(to.x)},${Math.round(to.y)}`);
		this.renderer.nativeSimulateMouseMove(from.x, from.y);
		this.renderer.nativeSimulateMouseDown(from.x, from.y);
		for (let i = 1; i <= steps; i++) {
			this.renderer.nativeSimulateMouseMove(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, 0);
			await this.turn(16);
		}
		this.renderer.nativeSimulateMouseUp(to.x, to.y);
		await this.settle();
	}

	async wheel(x: number, y: number, deltaY: number): Promise<void> {
		this.steps.push(`wheel ${deltaY} at ${Math.round(x)},${Math.round(y)}`);
		this.renderer.nativeSimulateMouseMove(x, y);
		this.renderer.nativeSimulateScrollWheel(x, y, 0, deltaY);
		await this.settle();
	}

	// ---- what was saved ----------------------------------------------------------------------------------------------------------

	async api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
		const r = await this.apiFetch(path, {
			method,
			headers: body === undefined ? undefined : { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await r.text();
		if (!r.ok) throw new Error(`${method} ${path} answered ${r.status}: ${text.slice(0, 300)}`);
		return (text ? JSON.parse(text) : undefined) as T;
	}

	/** The saved item with this title, creators as "Last, First". */
	async saved(title: string): Promise<SavedItem> {
		// (the plain words only: right-to-left text and emoji do not always survive a quick search as typed)
		const words = title.split(" ").filter((w) => /^[A-Za-z0-9]+$/.test(w)).join(" ");
		const page = await this.api<{ items: { key: string }[] }>("GET", `/items?limit=50&q=${encodeURIComponent(words)}`);
		for (const row of page.items) {
			const { data } = await this.api<{ data: any }>("GET", `/items/${row.key}`);
			if (!String(data.title ?? "").startsWith(title)) continue;
			const creators = (data.creators ?? []).map((c: any) => (c.name !== undefined ? c.name : `${c.lastName}, ${c.firstName}`));
			return { ...data, creators };
		}
		throw new Error(`no saved item is called "${title}"`);
	}

	/** Change the library as another program would (sync, Word, the connector), then let the app refresh. */
	async changeOutside(key: string, fields: Record<string, unknown>): Promise<void> {
		this.steps.push(`change ${key} from outside: ${Object.keys(fields).join(", ")}`);
		await this.api("PATCH", `/items/${key}`, { data: fields });
		this.store.refreshItems(Object.keys(fields));
		await this.settle(600);
	}

	selectedTitle(): string | null {
		const key = this.store.selectedItem();
		if (!key) return null;
		for (let i = 0; i < this.store.total(); i++) {
			const row = this.store.peek(i);
			if (row?.key === key) return row.title ?? "";
		}
		return key;
	}

	screenshot(name = `step-${++this.shots}`): string {
		const file = `${this.outDir}/${name}.png`;
		this.renderer.flush();
		this.renderer.captureScreenshot(file);
		return file;
	}
}
