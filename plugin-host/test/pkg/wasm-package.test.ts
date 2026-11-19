// Single-file plugins: a .wasm with the package (manifest, strings, icons) in its "zinc:package" custom section. The format on its own,
// then an install from such a file through the real manager and supervisor (plugin e2e-js), compared with the .zplugin install.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InstallError } from "../../src/package/installer";
import { embedPackage, extractPackage, isWasm, PACKAGE_SECTION, stripPackage } from "../../src/package/wasm-package";
import { readZip, writeZip } from "../../src/package/zip";
import { sha256Hex } from "../../src/package/hash";
import { buildE2e, newRuntime, pack, rmTree, scratch } from "./helpers";

const ID = "e2e-js@zinc.test";
const enc = new TextEncoder();
// a minimal module: header + one custom section "x" (payload "hi")
const tiny = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x00, 0x04, 0x01, 0x78, 0x68, 0x69]);
const files = [
	{ name: "manifest.json", data: enc.encode(JSON.stringify({ id: "a@b", main: { wasm: "plugin.wasm" } })) },
	{ name: "locale/en-US/plugin.ftl", data: enc.encode("hello = Hello\n") },
];

describe("the format", () => {
	test("embed then extract gives back the files and the binary byte for byte", () => {
		const one = embedPackage(tiny, files);
		expect(isWasm(one)).toBe(true);
		expect(new TextDecoder().decode(one).includes(PACKAGE_SECTION)).toBe(true);
		const back = extractPackage(one)!;
		expect(back.map((f) => f.name).sort()).toEqual(["locale/en-US/plugin.ftl", "manifest.json", "plugin.wasm"]);
		expect(back.find((f) => f.name === "plugin.wasm")!.data).toEqual(tiny);
		expect(stripPackage(one)).toEqual(tiny);
	});

	test("embedding again replaces the section instead of adding a second one", () => {
		const twice = embedPackage(embedPackage(tiny, files), files.slice(0, 1));
		const back = extractPackage(twice)!;
		expect(back.map((f) => f.name).sort()).toEqual(["manifest.json", "plugin.wasm"]);
		expect(stripPackage(twice)).toEqual(tiny);
	});

	test("a plain component has no package; non-wasm and truncated input are refused", () => {
		expect(extractPackage(tiny)).toBeUndefined();
		expect(extractPackage(enc.encode("PK not wasm"))).toBeUndefined();
		const one = embedPackage(tiny, files);
		expect(() => extractPackage(one.subarray(0, one.length - 10))).toThrow();
	});

	test("a plugin.wasm inside the embedded zip is ignored: the code is always the outer binary", () => {
		// a section built by hand (embedPackage itself never puts one in): name length, name, then a zip holding a different plugin.wasm
		const evil = new Uint8Array([...tiny.subarray(0, 8), 0x00, 0x01, 0x01, 0x79]);
		const zip = writeZip([...files, { name: "plugin.wasm", data: evil }]);
		const name = enc.encode(PACKAGE_SECTION);
		const size = 1 + name.length + zip.length;
		const leb: number[] = [];
		for (let n = size; ; ) {
			const b = n & 0x7f;
			n = Math.floor(n / 128);
			leb.push(n ? b | 0x80 : b);
			if (!n) break;
		}
		const sneaky = new Uint8Array([...tiny, 0x00, ...leb, name.length, ...name, ...zip]);
		const back = extractPackage(sneaky)!;
		expect(back.filter((f) => f.name === "plugin.wasm").length).toBe(1);
		expect(back.find((f) => f.name === "plugin.wasm")!.data).toEqual(tiny);
	});
});

describe("install from a single .wasm", () => {
	let built = "";
	let root = "";
	let rt: Awaited<ReturnType<typeof newRuntime>> | undefined;
	beforeAll(async () => {
		built = await buildE2e();
		root = scratch("wasmpkg");
		rt = await newRuntime(root, { manager: { zincVersion: "0.5.0" } });
	}, 120_000);
	afterAll(async () => {
		rt?.services.dispose();
		await rt?.supervisor.shutdown().catch(() => {});
		rmTree(root);
	});

	test("installs and runs like the .zplugin; the installed plugin.wasm has no package section", async () => {
		const zip = readZip(pack(built));
		const code = zip.find((f) => f.name === "plugin.wasm")!.data;
		const single = embedPackage(code, zip.filter((f) => f.name !== "plugin.wasm"));
		let asked: string[] = [];
		const r = await rt!.services.manager.installPackage(single, {
			approve: (req) => {
				asked = req.required;
				return { grant: req.required };
			},
		});
		expect(r.started).toBe(true);
		expect(asked.sort()).toEqual(["library.read", "prefs.app-read"]);
		const installed = new Uint8Array(readFileSync(join(rt!.services.manager.layout.installed(ID), "plugin.wasm")));
		expect(sha256Hex(installed)).toBe(sha256Hex(code));
		expect(rt!.services.manager.get(ID)?.state).toBe("enabled");
	}, 60_000);

	test("a plain component without the section is refused with a clear reason", async () => {
		const code = readZip(pack(built)).find((f) => f.name === "plugin.wasm")!.data;
		const err = await rt!.services.manager.installPackage(code).catch((e) => e);
		expect(err).toBeInstanceOf(InstallError);
		expect((err as InstallError).code).toBe("invalid-package");
		expect(String(err.message)).toContain("no embedded manifest");
	});

	test("a changed binary is caught by the hash in the embedded manifest", async () => {
		const zip = readZip(pack(built));
		const code = zip.find((f) => f.name === "plugin.wasm")!.data.slice();
		code[code.length - 1] ^= 0xff; // flip a byte of the code (the last section's payload)
		const single = embedPackage(code, zip.filter((f) => f.name !== "plugin.wasm"));
		const err = await rt!.services.manager.installPackage(single, { approve: (req) => ({ grant: req.required }) }).catch((e) => e);
		expect((err as InstallError).code).toBe("hash-mismatch");
	});
});
