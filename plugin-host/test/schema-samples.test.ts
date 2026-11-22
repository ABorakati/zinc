// Every manifest the repository ships (samples, SDK template, test fixtures) must pass the installer's validator, and the rules the
// schema states with `if`/`then` and `contains` must be enforced by it.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManager } from "../src/package/installer";
import { validateManifest } from "../src/package/validate";
import { validateSchema } from "../src/package/json-schema";

const repo = join(import.meta.dir, "..", "..");
// (gpui-ui/scripts/fixtures/wasm-reader names a test-only world and was never valid against the schema; it is loaded as a folder, not installed)
const shipped = [
	"plugin-api/samples/highlight-export",
	"plugin-api/samples/mcp-tools",
	"plugin-api/samples/quick-tags",
	"plugin-api/samples/word-count",
	"plugin-api/sdk/js/template",
	"plugin-api/sdk/js/test/fixtures/globals-probe",
	"plugin-host-wasmtime/bench/guest",
	"plugin-host/test/data/fixtures/e2e-js",
	"plugin-host/test/fixtures/hello-js",
	"plugin-host/test/fixtures/hello-rust",
	"plugin-host/test/fixtures/spin-rust",
	"plugin-host/test/pkg/fixtures/e2e-js",
	"gpui-ui/src/wasmplugins/ui/test/fixture-ui-js",
	"gpui-ui/test/wasm-extend-fixture",
];

describe("shipped manifests", () => {
	for (const dir of shipped) {
		test(`${dir} is valid`, () => {
			expect(validateManifest(JSON.parse(readFileSync(join(repo, dir, "manifest.json"), "utf8")))).toEqual([]);
		});
	}
});

describe("if / then and contains", () => {
	const base = () => ({
		manifest_version: 1,
		id: "x@example.org",
		name: "X",
		version: "1.0.0",
		zinc: { api_version: "0.1" },
		main: { wasm: "plugin.wasm" },
		permissions: { capabilities: ["library.read"] },
	});
	const tool = { name: "t", description: "d", input_schema: { type: "object" } };
	test("mcp tools need the mcp.expose permission", () => {
		const m: any = base();
		m.mcp = { tools: [tool] };
		const errs = validateManifest(m);
		expect(errs.length).toBeGreaterThan(0);
		expect(errs.join("|")).toContain("mcp.expose");
		m.permissions.capabilities.push("mcp.expose");
		expect(validateManifest(m)).toEqual([]);
		delete m.permissions;
		expect(validateManifest(m).join("|")).toContain("permissions");
	});
	test("no tools, no rule", () => {
		const m: any = base();
		expect(validateManifest(m)).toEqual([]);
		m.mcp = {};
		expect(validateManifest(m)).toEqual([]);
	});
	test("the checker: if/then/else and contains on their own", () => {
		const schema = { if: { properties: { a: { const: 1 } }, required: ["a"] }, then: { required: ["b"] }, else: { required: ["c"] } };
		expect(validateSchema(schema, { a: 1, b: 2 })).toEqual([]);
		expect(validateSchema(schema, { a: 1 })).not.toEqual([]);
		expect(validateSchema(schema, { a: 2, c: 3 })).toEqual([]);
		expect(validateSchema(schema, { a: 2 })).not.toEqual([]);
		const c = { type: "array", contains: { const: "x" } };
		expect(validateSchema(c, ["y", "x"])).toEqual([]);
		expect(validateSchema(c, ["y"])).not.toEqual([]);
		expect(validateSchema(c, [])).not.toEqual([]);
	});
});

describe("a plugin installed before the rule", () => {
	test("is still listed and enabled: only an install validates the manifest", () => {
		const root = mkdtempSync(join(tmpdir(), "zn-old-manifest-"));
		try {
			const id = "old-tools@example.org";
			const manifest = { manifest_version: 1, id, name: "Old", version: "1.0.0", zinc: { api_version: "0.1" }, main: { wasm: "plugin.wasm" }, mcp: { tools: [{ name: "t", description: "d", input_schema: { type: "object" } }] } };
			expect(validateManifest(manifest)).not.toEqual([]); // a new install of it is refused
			const mgr = new PluginManager({ root, precompile: false });
			mkdirSync(mgr.layout.installed(id), { recursive: true });
			writeFileSync(join(mgr.layout.installed(id), "manifest.json"), JSON.stringify(manifest));
			writeFileSync(mgr.layout.stateFile, JSON.stringify({ version: 1, plugins: { [id]: { version: "1.0.0", enabled: true, installedAt: 0 } } }));
			mgr.init();
			expect(mgr.list().map((p) => [p.id, p.state])).toEqual([[id, "enabled"]]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
