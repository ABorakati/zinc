import { describe, expect, test } from "bun:test";
import { camel, ifaceName, kebab, shortIface } from "../src/names";
import { HandlerTable } from "../src/imports/registry";

describe("names", () => {
	test("kebab, camel, interface names with and without version", () => {
		expect(camel("set-timeout")).toBe("setTimeout");
		expect(kebab("setTimeout")).toBe("set-timeout");
		expect(ifaceName("zinc:plugin/prefs@0.1.0")).toBe("zinc:plugin/prefs");
		expect(ifaceName("prefs")).toBe("zinc:plugin/prefs");
		expect(shortIface("zinc:plugin/extend-handlers@0.1.0")).toBe("extend-handlers");
	});
	test("handler tables accept kebab or camel function names and any interface spelling", async () => {
		const t = new HandlerTable([{ interface: "prefs", where: "host", functions: { "get-app": () => 1, setMany: () => 2 } }]);
		expect(await t.call({} as any, "zinc:plugin/prefs@0.1.0", "getApp", [])).toBe(1);
		expect(await t.call({} as any, "zinc:plugin/prefs", "set-many", [])).toBe(2);
		expect(t.has("zinc:plugin/prefs", "nope")).toBe(false);
		await expect(t.call({} as any, "zinc:plugin/prefs", "nope", [])).rejects.toThrow(/unavailable/);
	});
});
