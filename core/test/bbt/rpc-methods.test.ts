// JSON-RPC method lookup: only the methods the table defines exist. Names that every object inherits ("constructor",
// "toString", "__proto__" ...) are unknown methods, with positional and with named parameters.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { handleRpc } from "../../src/bbt/rpc";
import { openDb } from "../../src/db";
import { tempDir } from "../fixture";

let db: Database;
beforeAll(() => {
	db = openDb(join(tempDir(), "lib.sqlite"));
});
afterAll(() => db.close());

const call = (method: string, params?: unknown) =>
	handleRpc(db, JSON.parse(`{"jsonrpc":"2.0","method":${JSON.stringify(method)},"params":${JSON.stringify(params ?? [])},"id":1}`)) as Promise<{
		result?: unknown;
		error?: { code: number; message: string };
	}>;

describe("handleRpc method lookup", () => {
	for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "isPrototypeOf"]) {
		test(`"${name}" is method-not-found, with a list and with named parameters`, async () => {
			for (const params of [[], { a: 1 }]) {
				const r = await call(name, params);
				expect(r.result).toBeUndefined();
				expect(r.error?.code).toBe(-32601);
			}
		});
	}
	test("a real method still answers, and so does its items.* alias with named parameters", async () => {
		expect((await call("api.ready")).error).toBeUndefined();
		const r = await call("items.search", { terms: "x" });
		expect(r.error).toBeUndefined();
		expect(Array.isArray(r.result)).toBe(true);
	});
});
