// bun test plugin-api/sdk/js/test   (needs `bun scripts/gen-types.ts` first: src/generated is not committed)
import { describe, expect, test } from "bun:test";
import { defineTool, definePlugin, ext, fail, fill, hexColor, mcpManifest, registerTools, rgba, toolDef, u32, ui } from "../src/index";
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
		const s: any = fill("extend/SettingRow", { id: "r", label: { tag: "plain", val: "L" }, control: { tag: "text", val: { pref: "p" } } });
		expect(s.keywords).toEqual([]);
		expect(s.control.val.secret).toBe(false);
		expect(s.control.val.multiline).toBe(false);
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
	test("tree builders emit JSON trees and patches", () => {
		const res = ui.render(ui.column({ style: { gap: 2, background: "#ff0000" } }, ui.text("hi")), { rev: 3 });
		expect(res.content.tag).toBe("json");
		const parsed = JSON.parse((res.content as { tag: "json"; val: string }).val);
		expect(parsed.rev).toBe(3);
		expect(parsed.root.type).toBe("box");
		expect(parsed.root.style.background).toBe("#ff0000");
		const p = ui.patch(3, 4, [{ op: "remove", key: "k1" }]);
		expect(p.content.tag).toBe("patch");
		expect(JSON.parse((p.content as { tag: "patch"; val: string }).val)).toEqual({ baseRev: 3, rev: 4, ops: [{ op: "remove", key: "k1" }] });
	});
});

describe("helpers, dialog promise and definePlugin return values", () => {
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
	test("dialog and toast specs are complete, dialog() resolves on close events", async () => {
		const d: any = ui.dialogSpec("T", ui.text("hi"), [{ id: "ok", label: "OK" }]);
		expect(JSON.parse(d.content).root.type).toBe("text");
		expect(d.buttons[0].disabled).toBe(false);
		const t: any = ui.toastSpec("T", "m");
		expect(t.actions).toEqual([]);

		const p: any = definePlugin({});
		const promise = ui.dialog(d, () => 42n);
		p.uiEvents.onEvent(42n, { handler: "ok", kind: "close", modifiers: {}, payload: { tag: "button", val: "ok" }, rev: 0n });
		p.uiEvents.onEvent(42n, { handler: "ok", kind: "close", modifiers: {}, payload: { tag: "form", val: [{ name: "tags", value: { tag: "text", val: "a, b" } }] }, rev: 0n });
		const outcome = await promise;
		expect(outcome.button).toBe("ok");
		expect(ui.fieldValue(outcome.values, "tags")).toBe("a, b");
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

describe("mcp tools", () => {
	const count = defineTool(
		{ name: "count_tagged", description: "Count items with a tag.", input: { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] }, annotations: { readOnly: true, idempotent: true } },
		({ tag }: { tag: string }) => ({ count: tag.length }),
	);
	const add = defineTool({ name: "add_tag", description: "Add a tag.", annotations: { destructive: false } }, (a: any) => (a.fail ? fail("not-found", "no such item") : undefined));
	const wipe = defineTool({ name: "wipe", description: "Dangerous." }, () => "gone");
	const boom = defineTool({ name: "boom", description: "Throws." }, () => {
		throw new Error("kaput");
	});
	const later = defineTool({ name: "later", description: "Async." }, async () => 1);

	test("defineTool checks the name, the description and the handler", () => {
		expect(() => defineTool({ name: "bad name", description: "x" }, () => 1)).toThrow();
		expect(() => defineTool({ name: "a".repeat(49), description: "x" }, () => 1)).toThrow();
		expect(() => defineTool({ name: "ok", description: " " }, () => 1)).toThrow();
		expect(() => defineTool({ name: "ok", description: "x" }, 5 as any)).toThrow();
	});

	test("toolDef sets every field; destructive follows MCP's defaults", () => {
		expect(toolDef(count)).toEqual({
			name: "count_tagged",
			description: "Count items with a tag.",
			inputSchema: JSON.stringify(count.spec.input),
			outputSchema: undefined,
			annotations: { readOnly: true, destructive: false, idempotent: true },
		});
		expect(toolDef(add).annotations).toEqual({ readOnly: false, destructive: false, idempotent: false });
		expect(toolDef(wipe).annotations).toEqual({ readOnly: false, destructive: true, idempotent: false });
		expect(toolDef(wipe).inputSchema).toBe('{"type":"object"}');
	});

	test("mcpManifest is the manifest's mcp block", () => {
		const m = mcpManifest([count, add]);
		expect(m.tools[0]).toEqual({
			name: "count_tagged",
			description: "Count items with a tag.",
			input_schema: count.spec.input,
			annotations: { read_only: true, destructive: false, idempotent: true },
		});
		expect(m.tools[1].annotations).toEqual({ read_only: false, destructive: false, idempotent: false });
	});

	test("registerTools calls mcp.registerTool once per tool", () => {
		const seen: string[] = [];
		registerTools({ registerTool: (d) => void seen.push(d.name) }, [count, add]);
		expect(seen).toEqual(["count_tagged", "add_tag"]);
	});

	test("definePlugin({ tools }) implements mcpHandler.onMcpCall", () => {
		const p: any = definePlugin({ tools: [count, add, wipe, boom, later] });
		expect(JSON.parse(p.mcpHandler.onMcpCall("count_tagged", '{"tag":"lung"}'))).toEqual({ count: 4 });
		expect(p.mcpHandler.onMcpCall("add_tag", "{}")).toBe("null"); // undefined result
		expect(p.mcpHandler.onMcpCall("wipe", "{}")).toBe('"gone"');
		const tag = (f: () => unknown) => {
			try {
				f();
			} catch (e: any) {
				return e.tag;
			}
		};
		expect(tag(() => p.mcpHandler.onMcpCall("nope", "{}"))).toBe("not-found");
		expect(tag(() => p.mcpHandler.onMcpCall("add_tag", '{"fail":true}'))).toBe("not-found"); // a fail() from the handler passes through
		expect(tag(() => p.mcpHandler.onMcpCall("count_tagged", "{not json"))).toBe("invalid-argument");
		expect(tag(() => p.mcpHandler.onMcpCall("boom", "{}"))).toBe("internal"); // a plain Error becomes `internal`, never a trap
		expect(tag(() => p.mcpHandler.onMcpCall("later", "{}"))).toBe("unavailable");
		expect(p.lifecycle.startup()).toBeUndefined(); // the rest keeps its defaults
	});

	test("without tools onMcpCall is an `unavailable` default; duplicate names and a clash are refused", () => {
		const p: any = definePlugin({});
		try { p.mcpHandler.onMcpCall("x", "{}"); expect(true).toBe(false); } catch (e: any) { expect(e.tag).toBe("not-found"); }
		expect(() => definePlugin({ tools: [count, count] })).toThrow("two tools");
		expect(() => definePlugin({ tools: [count], mcpHandler: { onMcpCall: () => "1" } })).toThrow("not both");
	});
});
