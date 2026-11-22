// Which master key the secrets store uses on Windows. The providers are injected: nothing here calls the real DPAPI, and the
// "protected key file" is a marker file with made-up bytes.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLayout } from "../../src/package/layout";
import { defaultKeyProvider, fileKeyProvider, SecretStore, type KeyProvider } from "../../src/package/secrets-store";
import { rmTree, scratch } from "./helpers";

const roots: string[] = [];
afterAll(() => roots.forEach(rmTree));

/** A stand-in for the DPAPI provider: its key is fixed, and it fails while `broken.on`. */
function fakeProtected(): { provider: KeyProvider; broken: { on: boolean }; calls: { n: number } } {
	const broken = { on: false };
	const calls = { n: 0 };
	const key = new Uint8Array(32).fill(7);
	return {
		broken,
		calls,
		provider: {
			protection: "dpapi",
			key() {
				calls.n++;
				if (broken.on) throw new Error("CryptUnprotectData failed");
				return key;
			},
		},
	};
}

function setup() {
	const root = scratch("secret-keys");
	roots.push(root);
	const layout = createLayout(root);
	mkdirSync(layout.secretsDir, { recursive: true });
	const fake = fakeProtected();
	const file = fileKeyProvider(layout.secretsDir);
	const keys = defaultKeyProvider(layout.secretsDir, { platform: "win32", windows: fake.provider, file });
	return { layout, fake, keys, store: new SecretStore(layout, keys), dpapiFile: join(layout.secretsDir, "master.key.dpapi"), plainFile: join(layout.secretsDir, "master.key") };
}

describe("a protected key file exists", () => {
	test("failing to open it is an error, never a new plain key; it works again once the key opens", () => {
		const s = setup();
		writeFileSync(s.dpapiFile, new Uint8Array([1, 2, 3])); // stands for the wrapped key
		s.fake.broken.on = true;
		expect(() => s.store.set("a@x.test", "token", "secret")).toThrow(/master\.key\.dpapi/);
		expect(existsSync(s.plainFile)).toBe(false); // no plaintext key was made
		expect(s.keys.protection).toBe("dpapi");
		s.fake.broken.on = false; // a hiccup that passed
		s.store.set("a@x.test", "token", "secret");
		expect(s.store.get("a@x.test", "token")).toBe("secret");
		expect(existsSync(s.plainFile)).toBe(false);
		expect(s.keys.protection).toBe("dpapi");
	});
});

describe("a plain key file exists and there is no protected one", () => {
	test("its secrets stay readable and no second key is made", () => {
		const s = setup();
		const old = new SecretStore(s.layout, fileKeyProvider(s.layout.secretsDir)); // made while DPAPI was unusable
		old.set("a@x.test", "token", "sealed-with-the-plain-key");
		const key = readFileSync(s.plainFile, "utf8");
		expect(s.store.get("a@x.test", "token")).toBe("sealed-with-the-plain-key"); // DPAPI works again: still the plain key
		expect(s.fake.calls.n).toBe(0);
		expect(existsSync(s.dpapiFile)).toBe(false);
		expect(readFileSync(s.plainFile, "utf8")).toBe(key);
		expect(s.keys.protection).toBe("file");
	});
});

describe("no key file yet", () => {
	test("DPAPI is used when it works", () => {
		const s = setup();
		s.store.set("a@x.test", "t", "v");
		expect(s.keys.protection).toBe("dpapi");
		expect(existsSync(s.plainFile)).toBe(false);
	});
	test("a plain key file is made only when DPAPI cannot be used at all", () => {
		const s = setup();
		s.fake.broken.on = true;
		s.store.set("a@x.test", "t", "v");
		expect(s.keys.protection).toBe("file");
		expect(existsSync(s.plainFile)).toBe(true);
		expect(s.store.get("a@x.test", "t")).toBe("v");
	});
});
