// bun test src/itempane/boxInput.test.tsx -- the real BoxInput (date parts, pickers): what it treats as already committed follows the
// value it is given, so retyping a value that a failed save had reverted is committed again.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import type { HostElement } from "@gpuix/solid";
import type * as KitMod from "./kit";

function findInput(node: HostElement): HostElement | undefined {
	if (node.type === "input") return node;
	for (const c of node.children) if (c.kind === "element") {
		const r = findInput(c);
		if (r) return r;
	}
	return undefined;
}

describe("BoxInput", () => {
	let kit: typeof KitMod;
	let envBefore: string | undefined;
	beforeAll(async () => {
		envBefore = process.env.ZN_UI_STATE;
		process.env.ZN_UI_STATE = "off";
		kit = await import("./kit");
	});
	afterAll(() => {
		if (envBefore === undefined) delete process.env.ZN_UI_STATE;
		else process.env.ZN_UI_STATE = envBefore;
	});

	function mount(first: string, echo: boolean) {
		const [value, setValue] = createSignal(first);
		const commits: string[] = [];
		let el!: HostElement;
		const dispose = createRoot((d) => {
			el = (
				<div>
					<kit.BoxInput value={value()} onCommit={(v) => void commits.push(v)} onInput={echo ? setValue : undefined} />
				</div>
			) as unknown as HostElement;
			return d;
		});
		const input = () => findInput(el)!;
		const type = (v: string) => (input().props.get("onChange") as (e: unknown) => void)({ value: v });
		const blur = () => (input().props.get("onBlur") as () => void)();
		return { value, setValue, commits, type, blur, dispose };
	}

	test("retyping a value that was reverted under it commits again", () => {
		const m = mount("2019", false);
		m.type("2020");
		m.blur();
		expect(m.commits).toEqual(["2020"]);
		m.setValue("2020"); // the optimistic update ...
		m.setValue("2019"); // ... and the save failed and the pane put the old value back
		m.type("2020");
		m.blur();
		expect(m.commits).toEqual(["2020", "2020"]);
		m.dispose();
	});

	test("an input whose value follows what is typed still commits it", () => {
		const m = mount("", true);
		m.type("2021");
		m.blur();
		expect(m.commits).toEqual(["2021"]);
		m.blur(); // nothing new
		expect(m.commits).toEqual(["2021"]);
		m.type("2022");
		m.blur();
		expect(m.commits).toEqual(["2021", "2022"]);
		m.dispose();
	});

	test("the same value arriving again does not turn a typed edit into a no-op", () => {
		const m = mount("2019", false);
		m.type("2023");
		m.setValue("2018"); // an unrelated change of the value while typing, then back
		m.setValue("2019");
		m.type("2023");
		m.blur();
		expect(m.commits).toEqual(["2023"]);
		m.dispose();
	});
});
