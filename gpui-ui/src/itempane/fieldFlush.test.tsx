// bun test src/itempane/fieldFlush.test.tsx -- the real item pane model and the real inline-edit Field (through the Abstract section):
// text typed into a field that is removed before its blur arrives (the pane switches to another item) is saved to the item it was
// typed in. The pane's detail() is undefined during a switch and a new object on every reload.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createRoot, createSignal, For, Show } from "solid-js";
import type { HostElement } from "@gpuix/solid";
import type * as HeaderMod from "./Header";
import type * as InfoMod from "./Info";
import type * as KitMod from "./kit";
import type * as ModelMod from "./model";
import type * as NetMod from "./net";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function findAll(node: HostElement | undefined, pred: (n: HostElement) => boolean, out: HostElement[] = []): HostElement[] {
	if (!node) return out;
	if (pred(node)) out.push(node);
	for (const c of node.children) if (c.kind === "element") findAll(c, pred, out);
	return out;
}

describe("inline field edit flushed when the field goes away", () => {
	let Header: typeof HeaderMod;
	let Info: typeof InfoMod;
	let kit: typeof KitMod;
	let model: typeof ModelMod;
	let net: typeof NetMod;
	let envBefore: string | undefined;
	let writes: string[] = [];
	let saved: Record<string, unknown>;
	let cleanups: (() => void)[] = [];
	let realFetch: typeof fetch;

	beforeAll(async () => {
		envBefore = process.env.ZN_UI_STATE;
		process.env.ZN_UI_STATE = "off";
		realFetch = globalThis.fetch; // a saved item makes the list refetch: no network in this test
		globalThis.fetch = (() => Promise.reject(new Error("no network in this test"))) as unknown as typeof fetch;
		net = await import("./net");
		model = await import("./model");
		Header = await import("./Header");
		Info = await import("./Info");
		kit = await import("./kit");
		const api = net.ipApi as unknown as Record<string, unknown>;
		saved = { item: api.item, patchItem: api.patchItem, schema: api.schema, tagColors: api.tagColors };
		api.schema = async () => ({ itemTypes: [] });
		api.tagColors = async () => [];
		api.item = async (key: string) => {
			await sleep(2);
			return { data: { key, itemType: "journalArticle", abstractNote: `abstract of ${key}`, creators: [{ creatorType: "author", lastName: `Last ${key}`, firstName: "First" }] }, children: [] };
		};
		api.patchItem = async (key: string, data: Record<string, unknown>) => {
			writes.push(`${key}<-${JSON.stringify(data)}`);
			return { data: { key, itemType: "journalArticle", ...data }, children: [] };
		};
	});
	afterAll(() => {
		Object.assign(net.ipApi as unknown as Record<string, unknown>, saved);
		globalThis.fetch = realFetch;
		if (envBefore === undefined) delete process.env.ZN_UI_STATE;
		else process.env.ZN_UI_STATE = envBefore;
	});
	afterEach(async () => {
		for (const f of cleanups.splice(0)) f();
		await sleep(10);
		writes = [];
	});

	function mount(first: string) {
		const [key, setKey] = createSignal<string | null>(first);
		let root!: HostElement;
		let pane!: ModelMod.PaneModel;
		cleanups.push(
			createRoot((d) => {
				pane = model.createPaneModel(key);
				root = (
					<div>
						<model.PaneContext.Provider value={pane}>
							<Show when={pane.detail()}>
								<Header.AbstractSection />
							</Show>
						</model.PaneContext.Provider>
					</div>
				) as unknown as HostElement;
				return d;
			}),
		);
		const resting = () => findAll(root, (n) => n.props.get("role") === "textbox")[0];
		const area = () => findAll(root, (n) => n.type === "textarea")[0];
		return {
			setKey,
			pane,
			resting,
			area,
			open: () => (resting()!.props.get("onClick") as () => void)(),
			type: (v: string) => (area()!.props.get("onChange") as (e: unknown) => void)({ value: v }),
			blur: () => (area()!.props.get("onBlur") as () => void)(),
			press: (k: string) => (area()!.props.get("onKeyDown") as (e: unknown) => void)({ key: k }),
		};
	}

	test("an edit typed just before an item switch is saved to the item it was typed in", async () => {
		const m = mount("AAAAAAAA");
		await sleep(20);
		m.open();
		m.type("edited in A");
		m.setKey("BBBBBBBB");
		await sleep(40);
		expect(writes).toEqual([`AAAAAAAA<-{"abstractNote":"edited in A"}`]);
	});

	test("a blur that does arrive saves once, and the later teardown does not save again", async () => {
		const m = mount("AAAAAAAA");
		await sleep(20);
		m.open();
		m.type("blurred");
		m.blur();
		m.setKey("BBBBBBBB");
		await sleep(40);
		expect(writes).toEqual([`AAAAAAAA<-{"abstractNote":"blurred"}`]);
	});

	test("an edit cancelled with Escape is not saved on teardown", async () => {
		const m = mount("AAAAAAAA");
		await sleep(20);
		m.open();
		m.type("nope");
		m.press("escape");
		m.setKey("BBBBBBBB");
		await sleep(40);
		expect(writes).toEqual([]);
	});

	test("a reload of the same item (a new detail object) neither saves nor drops the edit", async () => {
		const m = mount("AAAAAAAA");
		await sleep(20);
		m.open();
		m.type("kept through a reload");
		await m.pane.reload();
		expect(writes).toEqual([]);
		expect(m.area()).toBeDefined();
		m.setKey("BBBBBBBB");
		await sleep(40);
		expect(writes).toEqual([`AAAAAAAA<-{"abstractNote":"kept through a reload"}`]);
	});

	function mountWith(body: () => unknown) {
		const [key, setKey] = createSignal<string | null>("AAAAAAAA");
		let root!: HostElement;
		cleanups.push(
			createRoot((d) => {
				const pane = model.createPaneModel(key);
				root = (
					<div>
						<model.PaneContext.Provider value={pane}>
							<Show when={pane.detail()}>{body() as never}</Show>
						</model.PaneContext.Provider>
					</div>
				) as unknown as HostElement;
				return d;
			}),
		);
		return {
			setKey,
			edit: (v: string) => {
				const box = findAll(root, (n) => n.props.get("role") === "textbox")[0]!;
				(box.props.get("onClick") as () => void)();
				(findAll(root, (n) => n.type === "input")[0]!.props.get("onChange") as (e: unknown) => void)({ value: v });
			},
		};
	}

	test("a creator being edited when the pane switches is saved into that item's own list, and costs it none", async () => {
		function Creators() {
			const entries = Info.useInfoEntries();
			return <For each={entries().filter((e) => e.id === "c:0")}>{(e) => e.render() as never}</For>;
		}
		const m = mountWith(() => <Creators />);
		await sleep(20);
		m.edit("Typed");
		m.setKey("BBBBBBBB");
		await sleep(40);
		expect(writes.filter((w) => w.includes("creators"))).toEqual([
			`AAAAAAAA<-${JSON.stringify({ creators: [{ creatorType: "author", lastName: "Typed", firstName: "First" }] })}`,
		]);
	});

	test("a field whose handler acts on the current item is not run for the item that was left", async () => {
		const acted: unknown[] = [];
		function Row() {
			return <kit.Field value="old" onSave={(v) => acted.push(v)} />;
		}
		const m = mountWith(() => <Row />);
		await sleep(20);
		m.edit("pin this");
		m.setKey("BBBBBBBB");
		await sleep(40);
		expect(acted).toEqual([]);
	});

	test("opening the editor and leaving without a change saves nothing", async () => {
		const m = mount("AAAAAAAA");
		await sleep(20);
		m.open();
		m.setKey("BBBBBBBB");
		await sleep(40);
		expect(writes).toEqual([]);
	});
});
