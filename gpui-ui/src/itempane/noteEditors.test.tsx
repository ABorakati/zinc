// bun test src/itempane/noteEditors.test.tsx -- the real Markdown note editor (itempane/Notes.tsx), rendered without a window with the
// item pane's reactive shape around it: on a note switch the pane's detail() goes undefined, the editor unmounts, and its parent's
// accessor (d().data.key) throws from then on. The last edit must still be saved, to the note it was typed in.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createEffect, createRoot, createSignal, on, Show } from "solid-js";
import type { HostElement } from "@gpuix/solid";
import type * as NotesMod from "./Notes";
import type * as ModelMod from "./model";
import type * as NetMod from "./net";
import type * as SessionMod from "./noteSession";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wrap = (inner: string) => `<div data-schema-version="9">${inner}</div>`;

function findAll(node: HostElement | undefined, type: string, out: HostElement[] = []): HostElement[] {
	if (!node) return out;
	if (node.type === type) out.push(node);
	for (const c of node.children) if (c.kind === "element") findAll(c, type, out);
	return out;
}
const textOf = (node: unknown): string => {
	const n = node as { kind: string; text?: string; children: unknown[] };
	return n.kind === "text" ? (n.text ?? "") : n.children.map(textOf).join("");
};

describe("Markdown note editor", () => {
	let envBefore: string | undefined;
	let Notes: typeof NotesMod;
	let model: typeof ModelMod;
	let net: typeof NetMod;
	let sessions: typeof SessionMod;
	let stored: Record<string, string> = {};
	let writes: string[] = [];
	let failSaves = 0;
	let loadDelay: Record<string, number> = {};
	let failLoads = new Set<string>();
	let holdSave: Promise<void> | null = null;
	const origItem = () => net.ipApi.item;
	const origPatch = () => net.ipApi.patchItem;
	let saved: { item: unknown; patch: unknown };
	let cleanups: (() => void)[] = [];
	let refreshes = 0;

	beforeAll(async () => {
		envBefore = process.env.ZN_UI_STATE;
		process.env.ZN_UI_STATE = "off";
		net = await import("./net");
		model = await import("./model");
		sessions = await import("./noteSession");
		Notes = await import("./Notes");
		saved = { item: origItem(), patch: origPatch() };
		(net.ipApi as { item: unknown }).item = async (key: string) => {
			await sleep(loadDelay[key] ?? 1);
			if (failLoads.has(key)) throw new Error("load failed");
			return { data: { key, note: stored[key] ?? "" } };
		};
		(net.ipApi as { patchItem: unknown }).patchItem = async (key: string, data: { note?: string }) => {
			if (holdSave) await holdSave;
			if (failSaves > 0) {
				failSaves--;
				throw new Error("offline");
			}
			writes.push(`${key}<-${data.note}`);
			stored[key] = data.note ?? "";
			return { data: { key, ...data } };
		};
	});
	afterAll(async () => {
		await sessions.flushNoteSessions();
		(net.ipApi as { item: unknown }).item = saved.item;
		(net.ipApi as { patchItem: unknown }).patchItem = saved.patch;
		if (envBefore === undefined) delete process.env.ZN_UI_STATE;
		else process.env.ZN_UI_STATE = envBefore;
	});
	afterEach(async () => {
		for (const f of cleanups.splice(0)) f();
		await sleep(20);
		await sessions.flushNoteSessions();
		stored = {};
		writes = [];
		failSaves = 0;
		loadDelay = {};
		failLoads = new Set();
		holdSave = null;
		refreshes = 0;
	});

	const pane = () => ({ refreshList: () => void refreshes++ }) as unknown as ReturnType<typeof ModelMod.usePane>;

	/** The editor under the item pane's own structure: Show when={detail()} > NotePane (d().data.key) > editor. */
	function mountInPane(first: string) {
		const [key, setKey] = createSignal(first);
		const [detail, setDetail] = createSignal<{ data: { key: string } } | undefined>({ data: { key: first } });
		let root!: HostElement;
		let closed = 0;
		let onSavedCalls = 0;
		const dispose = createRoot((d) => {
			createEffect(
				on(
					key,
					async (k) => {
						setDetail(undefined); // the pane drops its detail while the next note loads
						await sleep(10);
						setDetail({ data: { key: k } });
					},
					{ defer: true },
				),
			);
			root = (
				<div>
					<model.PaneContext.Provider value={pane()}>
						<Show when={detail()}>
							{(() => {
								const dd = () => detail()!;
								return (
									<Notes.MarkdownNoteEditor
										noteKey={dd().data.key}
										startEditing
										onClose={() => void closed++}
										onSaved={() => void onSavedCalls++}
									/>
								);
							})()}
						</Show>
					</model.PaneContext.Provider>
				</div>
			) as unknown as HostElement;
			return d;
		});
		cleanups.push(dispose);
		const area = () => findAll(root, "textarea")[0];
		return {
			switchTo: setKey,
			area,
			type: (v: string) => (area()!.props.get("onChange") as (e: unknown) => void)({ value: v }),
			get closed() {
				return closed;
			},
			get onSaved() {
				return onSavedCalls;
			},
			root: () => root,
		};
	}

	test("an edit typed just before a note switch is saved to the note it was typed in", async () => {
		stored = { AAAAAAAA: wrap("<p>old A</p>"), BBBBBBBB: wrap("<p>B</p>") };
		const m = mountInPane("AAAAAAAA");
		await sleep(30);
		expect(m.area()).toBeDefined();
		m.type("typed in A");
		m.switchTo("BBBBBBBB"); // inside the 800 ms debounce
		await sleep(120);
		expect(writes).toHaveLength(1);
		expect(writes[0]!.startsWith("AAAAAAAA<-")).toBe(true);
		expect(writes[0]).toContain("typed in A");
		expect(stored.BBBBBBBB).toBe(wrap("<p>B</p>"));
		expect(refreshes).toBe(1);
	});

	test("unmounting (the pane's own teardown) saves the last edit", async () => {
		stored = { AAAAAAAA: wrap("<p>old</p>") };
		const m = mountInPane("AAAAAAAA");
		await sleep(30);
		m.type("closing words");
		cleanups.splice(0).forEach((f) => f());
		await sleep(60);
		expect(writes).toHaveLength(1);
		expect(writes[0]).toContain("closing words");
	});

	test("reopening the same note at once loads the saved text, not the stale copy", async () => {
		stored = { AAAAAAAA: wrap("<p>old</p>") };
		const first = mountInPane("AAAAAAAA");
		await sleep(30);
		let release!: () => void;
		holdSave = new Promise<void>((r) => (release = r));
		first.type("fresh text");
		cleanups.splice(0).forEach((f) => f()); // closed with the save still on its way
		const second = mountInPane("AAAAAAAA");
		await sleep(40);
		expect(second.area()).toBeUndefined(); // still loading: the store has the old text until the save lands
		release();
		await sleep(60);
		expect(second.area()?.props.get("value")).toBe("fresh text");
	});

	test("a failed save is not forgotten: the next editor of the note shows and saves the unsaved text", async () => {
		stored = { AAAAAAAA: wrap("<p>old</p>") };
		const first = mountInPane("AAAAAAAA");
		await sleep(30);
		failSaves = 2; // the close and the retry made by the reopening both fail
		first.type("unsaved text");
		cleanups.splice(0).forEach((f) => f());
		await sleep(40);
		expect(writes).toEqual([]);
		const second = mountInPane("AAAAAAAA");
		await sleep(80);
		expect(second.area()?.props.get("value")).toBe("unsaved text");
		await sessions.flushNoteSessions();
		expect(writes).toHaveLength(1);
		expect(writes[0]).toContain("unsaved text");
	});

	test("typing during a save: the text box keeps what was typed and the newer text is saved next", async () => {
		stored = { AAAAAAAA: wrap("<p>old</p>") };
		const m = mountInPane("AAAAAAAA");
		await sleep(30);
		let release!: () => void;
		holdSave = new Promise<void>((r) => (release = r));
		m.type("first");
		await sleep(900); // the debounce fired; the save is held
		m.type("first and second");
		release();
		await sleep(60);
		expect(m.area()?.props.get("value")).not.toBe("first"); // never replaced by the saved copy
		await sleep(900);
		expect(writes).toHaveLength(2);
		expect(writes[1]).toContain("first and second");
	});

	test("a load that fails never lets an empty note be saved over the real one", async () => {
		stored = { AAAAAAAA: wrap("<p>precious</p>") };
		failLoads.add("AAAAAAAA");
		const m = mountInPane("AAAAAAAA");
		await sleep(40);
		expect(m.area()).toBeUndefined();
		expect(textOf(m.root())).toContain("Could not load the note");
		cleanups.splice(0).forEach((f) => f());
		await sessions.flushNoteSessions();
		await sleep(30);
		expect(writes).toEqual([]);
		expect(stored.AAAAAAAA).toBe(wrap("<p>precious</p>"));
	});

	test("a slow load of the previous note does not replace the current note's text", async () => {
		stored = { AAAAAAAA: wrap("<p>A text</p>"), BBBBBBBB: wrap("<p>B text</p>") };
		loadDelay = { AAAAAAAA: 200, BBBBBBBB: 1 };
		const [k, setK] = createSignal("AAAAAAAA");
		let root!: HostElement;
		const dispose = createRoot((d) => {
			root = (
				<div>
					<model.PaneContext.Provider value={pane()}>
						<Notes.MarkdownNoteEditor noteKey={k()} startEditing />
					</model.PaneContext.Provider>
				</div>
			) as unknown as HostElement;
			return d;
		});
		cleanups.push(dispose);
		await sleep(5);
		setK("BBBBBBBB"); // A's slow load is still in flight
		await sleep(300);
		expect(findAll(root, "textarea")[0]?.props.get("value")).toBe("B text");
	});

	test("Close stays open when the save fails, so the text is not lost", async () => {
		stored = { AAAAAAAA: wrap("<p>old</p>") };
		const m = mountInPane("AAAAAAAA");
		await sleep(30);
		failSaves = 1;
		m.type("not saved yet");
		const close = findAll(m.root(), "div").find((d) => d.props.get("aria-label") === "Close")!;
		(close.props.get("onClick") as () => void)();
		await sleep(40);
		expect(m.closed).toBe(0); // the save failed: the editor is still there with the text
		(close.props.get("onClick") as () => void)();
		await sleep(40);
		expect(m.closed).toBe(1);
		expect(writes).toHaveLength(1);
		expect(writes[0]).toContain("not saved yet");
	});
});
