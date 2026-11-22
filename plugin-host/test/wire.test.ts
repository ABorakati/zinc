import { describe, expect, test } from "bun:test";
import { nestedOption } from "../src/imports/library.host";
import { decodeWire, encodeWire } from "../src/transport-wasmtime";

// The three values of an `option<option<collection-key>>` as zhw writes them (plugin-host-wasmtime/src/conv.rs), read the way
// the supervisor reads them: through JSON and `decodeWire`.
const fromZhw = (json: string) => decodeWire(JSON.parse(json));

describe("option<option<T>> over the wire", () => {
	test("none, some(none) and some(value) stay apart", () => {
		expect(nestedOption(fromZhw("null"))).toBe("keep");
		expect(nestedOption(fromZhw('{"tag":"some","val":null}'))).toBeNull();
		expect(nestedOption(fromZhw('{"tag":"some","val":"ABCD2345"}'))).toBe("ABCD2345");
	});

	test("a record keeps the parent field for some(none) and has none for none", () => {
		const keep = fromZhw('{"key":"C1"}') as any;
		const clear = fromZhw('{"key":"C1","parent":{"tag":"some","val":null}}') as any;
		const move = fromZhw('{"key":"C1","parent":{"tag":"some","val":"P1"}}') as any;
		expect(nestedOption(keep.parent)).toBe("keep");
		expect(nestedOption(clear.parent)).toBeNull();
		expect(nestedOption(move.parent)).toBe("P1");
	});

	test("the other spellings still read as before", () => {
		expect(nestedOption(undefined)).toBe("keep");
		expect(nestedOption(null)).toBeNull();
		expect(nestedOption("P1")).toBe("P1");
		expect(nestedOption({ tag: "none" })).toBeNull();
		expect(nestedOption({ tag: "some" })).toBeNull();
		expect(nestedOption({ tag: "some", val: "P1" })).toBe("P1");
		expect(nestedOption(42)).toBe("keep");
	});

	test("it survives encodeWire, which drops undefined", () => {
		const sent = JSON.parse(JSON.stringify(encodeWire({ key: "C1", parent: { tag: "some", val: undefined } })));
		expect(nestedOption((decodeWire(sent) as any).parent)).toBeNull();
	});
});
