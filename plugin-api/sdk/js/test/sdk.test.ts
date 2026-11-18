// bun test plugin-api/sdk/js/test   (needs `bun scripts/gen-types.ts` first: src/generated is not committed)
import { describe, expect, test } from "bun:test";
import { definePlugin, ext, fill, hexColor, rgba, u32, ui } from "../src/index";
import { recordKeys } from "../src/defaults";

describe("fill", () => {
	test("adds missing required fields of a record, keeps given ones", () => {
		const c: any = fill("extend/ColumnRegistration", { dataKey: "k", label: { tag: "plain", val: "L" }, width: 50 });
		expect(c.dataKey).toBe("k");
		expect(c.width).toBe(50);
		expect(c.trees).toEqual([]);
		expect(c.sortReverse).toBe(false);
		expect(c.fixedWidth).toBe(false);
		expect(typeof c.sort).toBe("string");
		expect(c.flex).toBeUndefined(); // option fields stay absent
	});
	test("does not mutate its argument", () => {
		const v = { dataKey: "k" };
		fill("extend/ColumnRegistration", v);
		expect(v).toEqual({ dataKey: "k" });
	});
	test("fills nested records, in lists and in present optional fields", () => {
		const m: any = fill("extend/MenuRegistration", { menuId: "m", target: "library-item", entries: [{ id: "a", icon: { light: { tag: "builtin", val: "x" } }, visibleWhen: {} }] });
		const e = m.entries[0];
		expect(e.hooks).toEqual({}); // `flags` fields are optional: absent means off
		expect(e.visibleWhen.requireEditable).toBe(false);
		expect(e.visibleWhen.tabKinds).toEqual([]);
		expect(e.kind).toBe("item");
	});
	test("fills the record inside a variant case", () => {
		const t: any = fill("ui/Tree", { rev: 0n, root: 0, nodes: [{ props: {}, kind: { tag: "text", val: { runs: [{ text: { tag: "plain", val: "x" } }] } }, children: [] }], styles: [] });
		const node = t.nodes[0];
		expect(node.props.disabled).toBe(false);
		expect(node.props.events).toEqual([]);
		expect(node.props.style).toEqual({});
		expect(node.kind.val.selectable).toBe(false);
		expect(node.kind.val.runs[0].bold).toBe(false);
		expect(typeof node.kind.val.kind).toBe("string");
	});
	test("unknown record is an error", () => {
		expect(() => fill("nope/Nothing", {})).toThrow();
	});
	test("every table entry can be filled from an empty object without throwing", () => {
		for (const key of recordKeys()) expect(() => fill(key, {})).not.toThrow();
	});
});

describe("u32 workaround", () => {
	test("u32 gives the signed form of values at or above 2^31 and leaves smaller values", () => {
		expect(u32(0)).toBe(0);
		expect(u32(2147483647)).toBe(2147483647);
		expect(u32(2147483648)).toBe(-2147483648);
		expect(u32(3000000000)).toBe(-1294967296);
		expect(u32(4294967295)).toBe(-1);
		expect(() => u32(-1)).toThrow();
		expect(() => u32(2 ** 32)).toThrow();
		expect(() => u32(1.5)).toThrow();
	});
	test("the signed form has the same bits as the unsigned value", () => {
		for (const n of [2147483648, 3000000000, 4294967295]) expect(u32(n) >>> 0).toBe(n);
	});
	test("rgba / hexColor produce 0xRRGGBBAA with the red byte on top", () => {
		expect(rgba(255, 0, 0, 255)).toEqual({ tag: "rgba", val: -16776961 }); // 0xFF0000FF
		expect(rgba(255, 0, 0, 255).val >>> 0).toBe(0xff0000ff);
		expect(hexColor("#00ff00").val >>> 0).toBe(0x00ff00ff);
		expect(hexColor("#11223344").val).toBe(0x11223344);
	});
	test("colours in typed trees use it", () => {
		const tree: any = ui.toTree(ui.box({ style: { background: "#ff0000" } }));
		expect(tree.nodes[0].props.style.background.val >>> 0).toBe(0xff0000ff);
		expect(tree.nodes[0].props.style.background.val).toBeLessThan(0);
	});
});

describe("helpers and definePlugin return values", () => {
	test("ext helpers return complete records", () => {
		const col: any = ext.column("c", "Col");
		expect(col.pickerSubmenu).toBe(false);
		const sec: any = ext.section("s", "Sec", "icon");
		expect(sec.defaultOpen).toBe(true);
		expect(sec.header.label).toEqual({ tag: "plain", val: "Sec" });
		const pane: any = ext.prefPane("p", "Pane", [ext.settingToggle("t", "Toggle", "pref")]);
		expect(pane.openCloseHooks).toBe(false);
		expect(pane.content.val[0].keywords).toEqual([]);
		const reg: any = ext.menu("m", "library-item", [ext.entry("e", "Entry")]);
		expect(reg.entries[0].hooks.showing).toBe(false); // the helper sets all four
	});
	test("dialog and toast specs are complete", () => {
		const d: any = ui.dialogSpec("T", ui.text("hi"), [{ id: "ok", label: "OK" }]);
		expect(d.content.nodes.length).toBe(1);
		expect(d.buttons[0].disabled).toBe(false);
		const t: any = ui.toastSpec("T", "m");
		expect(t.actions).toEqual([]);
	});
	test("definePlugin completes records a callback returns", () => {
		const p: any = definePlugin({
			extendHandlers: {
				onColumnValues: (_k: string, keys: string[]) => keys.map(() => ({ body: { tag: "text", val: "1" } })),
			} as any,
			uiEvents: { mount: () => ({ content: { tag: "unchanged" } }) } as any,
		});
		const cells = p.extendHandlers.onColumnValues("c", ["A", "B"]);
		expect(cells.length).toBe(2);
		expect(cells[0].style).toBeDefined(); // text-style enum default
		expect(p.uiEvents.mount("i", {}).content).toEqual({ tag: "unchanged" });
	});
	test("definePlugin defaults still never trap for omitted callbacks", () => {
		const p: any = definePlugin({});
		expect(p.lifecycle.startup()).toBeUndefined();
		expect(p.extendHandlers.onTabClosing("t")).toBe(true);
		expect(p.uiEvents.renderRange("i", { start: 3 }).start).toBe(3);
	});
});
