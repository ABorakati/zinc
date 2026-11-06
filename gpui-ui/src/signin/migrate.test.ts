import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateOldProfile } from "./migrate";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "zn-mig-"));
	const from = join(root, "old", "EBWebView");
	mkdirSync(join(from, "Default", "Network"), { recursive: true });
	writeFileSync(join(from, "Local State"), '{"os_crypt":{"encrypted_key":"x"}}');
	writeFileSync(join(from, "Default", "Network", "Cookies"), "cookie-db");
	return { root, from, to: join(root, "new", "EBWebView") };
}
const listing = (dir: string): string[] => readdirSync(dir, { recursive: true }).map((p) => `${p}:${statSync(join(dir, String(p))).isFile() ? readFileSync(join(dir, String(p)), "utf8") : "d"}`).sort();

describe("migrateOldProfile", () => {
	test("copies the whole folder once, leaves the source untouched, never overwrites", () => {
		const { from, to } = fixture();
		const before = listing(from);
		expect(migrateOldProfile({ from, to, minFreeBytes: 0 })).toEqual({ status: "copied" });
		expect(listing(to)).toEqual(before);
		expect(existsSync(`${to}.migrating`)).toBe(false);
		expect(listing(from)).toEqual(before);
		// a sign-in made in the new profile later is not replaced
		writeFileSync(join(to, "Local State"), "newer");
		expect(migrateOldProfile({ from, to, minFreeBytes: 0 })).toEqual({ status: "exists" });
		expect(readFileSync(join(to, "Local State"), "utf8")).toBe("newer");
	});

	test("nothing to copy / not enough disk space", () => {
		const { root, from, to } = fixture();
		expect(migrateOldProfile({ from: join(root, "missing"), to, minFreeBytes: 0 }).status).toBe("no-source");
		expect(migrateOldProfile({ from, to, minFreeBytes: Number.MAX_SAFE_INTEGER }).status).toBe("no-space");
		expect(existsSync(to)).toBe(false);
	});

	test("an unfinished copy of an earlier run is replaced", () => {
		const { from, to } = fixture();
		mkdirSync(`${to}.migrating`, { recursive: true });
		writeFileSync(join(`${to}.migrating`, "half"), "x");
		expect(migrateOldProfile({ from, to, minFreeBytes: 0 }).status).toBe("copied");
		expect(existsSync(join(to, "half"))).toBe(false);
		expect(existsSync(join(to, "Local State"))).toBe(true);
	});
});
