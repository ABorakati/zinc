// What a scenario drives the app with. All input goes through GPUI (hit testing, focus, key dispatch), none through the store: a row
// that ignores clicks fails here as it does for a user. Assertions read what was painted, and what the core saved.
//
// The app is behind a Backend (backend.ts): in this process on GPUI's test renderer, or the packaged executable over a pipe. Everything
// that reads the app is async for that reason; a scenario is written once and runs in both.
import type { TestRenderer } from "@gpuix/solid/testing";
import type { TreeNode } from "@gpuix/solid/automation";
import type { Backend, Box } from "./backend";

type Store = (typeof import("../../src/store"))["store"];
type Row = ReturnType<Store["peek"]>;

/**
 * The store as the harness sees it, in both modes: every call is async and answers plain data (a Set comes as an array, an
 * undefined as null). Only what src/automation.ts allows.
 */
export interface StoreView {
	activeTab(): Promise<ReturnType<Store["activeTab"]>>;
	total(): Promise<number>;
	view(): Promise<ReturnType<Store["view"]>>;
	sortLevels(): Promise<ReturnType<Store["sortLevels"]>>;
	/** The selected item keys (an array, not a Set: use .length). */
	selected(): Promise<string[]>;
	tabs(): Promise<ReturnType<Store["tabs"]>>;
	revealItem(key: string): Promise<boolean>;
	refreshItems(fields?: string[]): Promise<void>;
	focusIndex(): Promise<number>;
	viewMode(): Promise<ReturnType<Store["viewMode"]>>;
	selectedItem(): Promise<string | null>;
	/** The cached row, or null when its page is not loaded. */
	peek(i: number): Promise<NonNullable<Row> | null>;
	groups(): Promise<ReturnType<Store["groups"]>>;
	refresh(): Promise<void>;
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
	/** The store, async in both modes (see StoreView). */
	readonly store: StoreView;

	constructor(
		readonly backend: Backend,
		readonly size: { width: number; height: number },
		private readonly outDir: string,
	) {
		this.store = new Proxy({} as StoreView, {
			get: (_t, name) => {
				if (typeof name !== "string" || name === "then") return undefined;
				return (...args: unknown[]) => this.backend.store(name, args);
			},
		});
	}

	/** true: the app runs in this process. */
	get inProcess(): boolean {
		return this.backend.inProcess;
	}

	/** GPUI's test renderer itself: in-process mode only (a scenario that needs it is declared `inProcessOnly`). */
	get renderer(): TestRenderer {
		const r = (this.backend as { renderer?: TestRenderer }).renderer;
		if (!r) throw new Error("ui.renderer exists only in the in-process mode: declare the scenario inProcessOnly, or use the async driver methods");
		return r;
	}

	// ---- time --------------------------------------------------------------------------------------------------------------------

	/** One turn of the loop: native events to the app, the app's changes to GPUI, a frame (the real app runs by itself: this waits). */
	private turn(ms: number): Promise<void> {
		return this.backend.turn(ms);
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

	/** Make sure the last changes are drawn (replaces ui.renderer.flush()). */
	async flush(): Promise<void> {
		await this.backend.flush();
	}

	/** The automation tree's root (replaces JSON.parse(ui.renderer.getAutomationTree()), which gave { tree: root }), or null. */
	async tree(): Promise<TreeNode | null> {
		return this.backend.tree();
	}

	/** The element that has the keys, as a node of the automation tree (its children left out), or null when none has. */
	async focused(): Promise<Omit<TreeNode, "children"> | null> {
		const id = (await this.backend.store("focused")) as number | null;
		if (id == null) return null;
		const find = (n: TreeNode): TreeNode | undefined =>
			n.id === id ? n : (n.children ?? []).reduce<TreeNode | undefined>((hit, c) => hit ?? find(c as TreeNode), undefined);
		const root = await this.backend.tree();
		const n = root ? find(root) : undefined;
		if (!n) return { id } as Omit<TreeNode, "children">;
		const { children: _c, ...rest } = n as TreeNode & { children?: unknown };
		return rest;
	}

	/** The box of an element (replaces ui.renderer.getElementBounds(id)), or null. */
	async bounds(id: number): Promise<Box | null> {
		return this.backend.bounds(id);
	}

	/** The elements under a point, topmost first (replaces ui.renderer.getElementsAt). In-process only: the real app gives null. */
	async elementsAt(x: number, y: number): Promise<number[] | null> {
		return this.backend.elementsAt(x, y);
	}

	/** The text a node shows: its own, or an input's value, else the placeholder it paints in its place. */
	private async shownText(node: TreeNode): Promise<string | undefined> {
		if (node.text) return node.text;
		if (node.type !== "input" && node.type !== "textarea") return undefined;
		// the real app's automation tree carries a field's value and placeholder; in-process they are on the renderer's element
		const inTree = (node as { customProps?: { value?: unknown; placeholder?: unknown } }).customProps;
		const { value, placeholder } = inTree ?? (await this.backend.inputProps(node.id)) ?? {};
		if (typeof value === "string" && value) return value;
		return typeof placeholder === "string" && placeholder ? placeholder : undefined;
	}

	private async index(): Promise<{ all: Indexed[]; byId: Map<number, Indexed> }> {
		const all: Indexed[] = [];
		const byId = new Map<number, Indexed>();
		const root = await this.backend.tree();
		const walk = (node: TreeNode, parent: Indexed | null) => {
			const here = { node, parent };
			all.push(here);
			byId.set(node.id, here);
			for (const c of node.children ?? []) walk(c, here);
		};
		if (root) walk(root, null);
		return { all, byId };
	}

	private async boxOf(n: Indexed | null): Promise<Box | null> {
		for (let at = n, up = 0; at && up < 3; at = at.parent, up++) {
			const b = at.node.bounds ?? (await this.backend.bounds(at.node.id));
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

	private async matches(text: string, o: FindOptions): Promise<{ found: (Found & { node: Indexed })[]; byId: Map<number, Indexed> }> {
		const { all, byId } = await this.index();
		const within = o.area ? this.area(o.area) : { x: 0, y: 0, ...this.size };
		const found: (Found & { node: Indexed })[] = [];
		for (const n of all) {
			const t = await this.shownText(n.node);
			if (!t || (o.exact ? t.trim() !== text : !t.includes(text))) continue;
			const box = await this.boxOf(n);
			if (!box) continue;
			const c = centre(box);
			if (!inside({ x: 0, y: 0, ...this.size }, c.x, c.y) || !inside(within, c.x, c.y)) continue;
			if (found.some((f) => same(f.box, box))) continue; // a text node and the element around it
			found.push({ id: n.node.id, text: t, box, ...c, node: n });
		}
		found.sort((a, b) => a.y - b.y || a.x - b.x);
		return { found, byId };
	}

	/**
	 * Which of `texts` are shown in an area (each as part of a text), read in one pass: findAll reads the screen once per call. Only
	 * the texts that hold one of them are measured, which is the slow part.
	 */
	async shownOf(texts: readonly string[], a: Area): Promise<Set<string>> {
		const { all } = await this.index();
		const within = this.area(a);
		const out = new Set<string>();
		for (const n of all) {
			const t = await this.shownText(n.node);
			if (!t) continue;
			const hits = texts.filter((w) => !out.has(w) && t.includes(w));
			if (!hits.length) continue;
			const box = await this.boxOf(n);
			if (!box) continue;
			const c = centre(box);
			if (inside({ x: 0, y: 0, ...this.size }, c.x, c.y) && inside(within, c.x, c.y)) for (const w of hits) out.add(w);
		}
		return out;
	}

	/** Every match on screen, from the top left. */
	async findAll(text: string, o: FindOptions = {}): Promise<Found[]> {
		return (await this.matches(text, o)).found;
	}

	async visible(text: string, o: FindOptions = {}): Promise<boolean> {
		return (await this.findAll(text, o)).length > 0;
	}

	async see(text: string, o: FindOptions = {}, timeoutMs = 5000): Promise<Found> {
		this.steps.push(`see "${text}"`);
		await this.waitFor(`"${text}" on screen`, async () => (await this.findAll(text, o)).length > (o.nth ?? 0), timeoutMs);
		return (await this.findAll(text, o))[o.nth ?? 0]!;
	}

	async gone(text: string, o: FindOptions = {}, timeoutMs = 5000): Promise<void> {
		this.steps.push(`gone "${text}"`);
		await this.waitFor(`"${text}" to leave the screen`, async () => !(await this.visible(text, o)), timeoutMs);
	}

	/** Everything in the last frame, as text. */
	async painted(): Promise<string[]> {
		return this.backend.paintedText();
	}

	// ---- input -------------------------------------------------------------------------------------------------------------------

	/** Click where `text` is. Fails when something else lies on top of it, as a click of the user would land there (in-process only). */
	async click(text: string, o: FindOptions & { button?: number; modifiers?: string; count?: number } = {}): Promise<void> {
		await this.see(text, o);
		const { found, byId } = await this.matches(text, o);
		const f = found[o.nth ?? 0];
		if (!f) throw new Error(`"${text}" left the screen before the click`);
		let top: number | undefined;
		for (const id of (await this.backend.elementsAt(f.x, f.y)) ?? []) {
			const n = byId.get(id);
			if (!n || (await this.reaches(n, f.x, f.y))) {
				top = id;
				break;
			}
		}
		const topNode = top === undefined ? undefined : byId.get(top);
		if (topNode && !this.related(topNode, f.node))
			throw new Error(`"${text}" is covered at ${Math.round(f.x)},${Math.round(f.y)} by element ${top} (${topNode.node.type} "${topNode.node.text ?? ""}")`);
		await this.clickAt(f.x, f.y, o);
	}

	/**
	 * Whether a click at (x, y) can land on this element. GPUIX's elementsAt applies `overflow`, but not the clip of a virtual list: the
	 * rows of a scrolled list (the reader's pages) are listed above the list, over the toolbar, where GPUI's own hit test does not send a
	 * click to them.
	 */
	private async reaches(n: Indexed, x: number, y: number): Promise<boolean> {
		for (let p = n.parent; p; p = p.parent) {
			const overflow = p.node.style?.overflow ?? p.node.style?.overflowY;
			if (p.node.type !== "virtual-list" && overflow !== "hidden" && overflow !== "scroll") continue;
			const b = await this.boxOf(p);
			if (b && !inside(b, x, y)) return false;
		}
		return true;
	}

	async clickAt(x: number, y: number, o: { button?: number; modifiers?: string; count?: number } = {}): Promise<void> {
		this.steps.push(`click ${Math.round(x)},${Math.round(y)}${o.modifiers ? ` +${o.modifiers}` : ""}${o.button ? ` button ${o.button}` : ""}`);
		await this.backend.click(x, y, { button: o.button ?? 0, modifiers: o.modifiers, clickCount: o.count ?? 1 });
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
		await this.backend.keystrokes(keys);
		await this.settle(120);
	}

	async type(text: string): Promise<void> {
		this.steps.push(`type "${text}"`);
		for (const ch of text) {
			const key = ch === " " ? "space" : ch === "\n" ? "enter" : ch === "\t" ? "tab" : ch;
			await this.backend.keystrokes(key);
		}
		await this.settle(120);
	}

	/** Select what the focused field holds and type over it. */
	async replace(text: string): Promise<void> {
		await this.press(process.platform === "darwin" ? "cmd-a" : "ctrl-a");
		await this.type(text);
	}

	/** Move the pointer, no settling (replaces ui.renderer.nativeSimulateMouseMove(x, y); follow it with ui.settle() where a hover has to show). */
	async mouseMove(x: number, y: number, o: { pressedButton?: number; modifiers?: string } = {}): Promise<void> {
		await this.backend.mouseMove(x, y, o);
	}

	/** Press a mouse button there and hold it (replaces ui.renderer.nativeSimulateMouseDown); no settling. */
	async mouseDown(x: number, y: number, o: { button?: number; modifiers?: string } = {}): Promise<void> {
		this.steps.push(`mouse down at ${Math.round(x)},${Math.round(y)}`);
		await this.backend.mouseDown(x, y, o);
	}

	/** Release a mouse button there (replaces ui.renderer.nativeSimulateMouseUp); no settling. */
	async mouseUp(x: number, y: number, o: { button?: number; modifiers?: string } = {}): Promise<void> {
		this.steps.push(`mouse up at ${Math.round(x)},${Math.round(y)}`);
		await this.backend.mouseUp(x, y, o);
	}

	async drag(from: { x: number; y: number }, to: { x: number; y: number }, steps = 10): Promise<void> {
		this.steps.push(`drag ${Math.round(from.x)},${Math.round(from.y)} to ${Math.round(to.x)},${Math.round(to.y)}`);
		await this.backend.mouseMove(from.x, from.y);
		await this.backend.mouseDown(from.x, from.y);
		for (let i = 1; i <= steps; i++) {
			await this.backend.mouseMove(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, { pressedButton: 0 });
			await this.turn(16);
		}
		await this.backend.mouseUp(to.x, to.y);
		await this.settle();
	}

	/** Move the pointer there and turn the wheel, then settle. */
	async wheel(x: number, y: number, deltaY: number): Promise<void> {
		this.steps.push(`wheel ${deltaY} at ${Math.round(x)},${Math.round(y)}`);
		await this.backend.mouseMove(x, y);
		await this.backend.wheel(x, y, 0, deltaY);
		await this.settle();
	}

	/** One wheel event with both deltas and modifiers, no pointer move and no settling (replaces ui.renderer.nativeSimulateScrollWheel). */
	async wheelAt(x: number, y: number, deltaX: number, deltaY: number, modifiers?: string): Promise<void> {
		await this.backend.wheel(x, y, deltaX, deltaY, modifiers);
	}

	// ---- clipboard (in memory in both modes) -------------------------------------------------------------------------------------

	/** The app's clipboard text (replaces ui.renderer.readFromClipboard()). */
	async clipboard(): Promise<string> {
		return this.backend.clipboard();
	}

	/** Put text on the app's clipboard (replaces ui.renderer.writeToClipboard(text)). */
	async setClipboard(text: string): Promise<void> {
		await this.backend.setClipboard(text);
	}

	// ---- what was saved ----------------------------------------------------------------------------------------------------------

	async api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
		const r = await this.backend.api(method, path, body);
		if (r.status < 200 || r.status >= 300) throw new Error(`${method} ${path} answered ${r.status}: ${r.text.slice(0, 300)}`);
		return (r.text ? JSON.parse(r.text) : undefined) as T;
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
		await this.store.refreshItems(Object.keys(fields));
		await this.settle(600);
	}

	async selectedTitle(): Promise<string | null> {
		const key = await this.store.selectedItem();
		if (!key) return null;
		const total = await this.store.total();
		for (let i = 0; i < total; i++) {
			const row = await this.store.peek(i);
			if (row?.key === key) return row.title ?? "";
		}
		return key;
	}

	/** Writes a PNG of the window into the run's folder and gives its path. */
	async screenshot(name = `step-${++this.shots}`): Promise<string> {
		const file = `${this.outDir}/${name}.png`;
		await this.backend.screenshot(file);
		return file;
	}
}
