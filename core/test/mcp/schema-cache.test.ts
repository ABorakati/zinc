// Compiled tool schemas are cached by content (the schema object is rebuilt on every request), and the cache is bounded.
import { describe, expect, spyOn, test } from "bun:test";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { validateArgs, validatorCacheSize } from "../../src/mcp/plugin-tools";

const schema = (n: number) => ({ type: "object", properties: { [`p${n}`]: { type: "string" } }, required: [`p${n}`] });

describe("validateArgs cache", () => {
	test("equal schemas given as different objects are compiled once, and still validate", () => {
		const spy = spyOn(AjvJsonSchemaValidator.prototype, "getValidator");
		try {
			const s = schema(1000001);
			expect(validateArgs({ ...s }, { p1000001: "x" })).toBeUndefined();
			expect(validateArgs({ ...s }, {})).toBeString();
			expect(validateArgs(JSON.parse(JSON.stringify(s)), { p1000001: "y" })).toBeUndefined();
			expect(spy.mock.calls.length).toBe(1);
		} finally {
			spy.mockRestore();
		}
	});

	test("the cache does not grow without bound", () => {
		for (let i = 0; i < 500; i++) validateArgs(schema(i), { [`p${i}`]: "v" });
		expect(validatorCacheSize()).toBeLessThanOrEqual(64);
		// still correct after eviction
		expect(validateArgs(schema(0), {})).toBeString();
		expect(validateArgs(schema(0), { p0: "v" })).toBeUndefined();
	});
});
