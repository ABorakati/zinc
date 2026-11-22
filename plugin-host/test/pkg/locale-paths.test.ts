// `locales.dir` and the locale tags are folder names taken from the manifest: the schema accepts plain names only, and the l10n service
// reads nothing from outside the plugin's folder even when a manifest on disk (an older install) or a link says otherwise.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginManifest } from "../../src/manifest";
import { L10nService } from "../../src/package/l10n";
import { validateManifest } from "../../src/package/validate";

const manifest = (locales: unknown) => ({
	manifest_version: 1,
	id: "x@example.org",
	name: "X",
	version: "1.0.0",
	zinc: { api_version: "0.1" },
	main: { wasm: "plugin.wasm" },
	locales,
});

describe("the schema", () => {
	test("accepts plain folder names and locale tags", () => {
		for (const l of [{ default: "en-US" }, { default: "fr", available: ["fr", "en-US", "zh-Hans", "pt-BR"], dir: "locale" }, { default: "en", dir: "i18n/strings" }, { default: "en", dir: "l10n.v2" }]) {
			expect(validateManifest(manifest(l))).toEqual([]);
		}
	});
	test("refuses a dir that leaves the package and tags that are not tags", () => {
		for (const dir of ["..", "../x", "a/../b", "/abs", "C:/x", "C:x", "a\b", "./a", "a//b", "a/", "...", ".", "a/./b", "a:b", ""]) {
			expect([dir, validateManifest(manifest({ default: "en", dir })).length > 0]).toEqual([dir, true]);
		}
		for (const tag of ["../x", "a/b", "a\b", "", "en US", "en-", "-en", "C:", "..", "pt_BR", "e", "12", "a".repeat(40)]) {
			expect([tag, validateManifest(manifest({ default: tag })).length > 0]).toEqual([tag, true]);
			expect([tag, validateManifest(manifest({ default: "en", available: ["en", tag] })).length > 0]).toEqual([tag, true]);
		}
	});
});

describe("L10nService reads only inside the plugin's folder", () => {
	let root: string;
	let plugin: string;
	let outside: string;
	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "zn-l10n-paths-"));
		plugin = join(root, "plugin");
		outside = join(root, "outside");
		mkdirSync(join(plugin, "locale", "en-US"), { recursive: true });
		writeFileSync(join(plugin, "locale", "en-US", "main.ftl"), "own = inside\n");
		mkdirSync(join(outside, "en-US"), { recursive: true });
		writeFileSync(join(outside, "en-US", "main.ftl"), "secret = outside\n");
		mkdirSync(join(outside, "fr"), { recursive: true });
		writeFileSync(join(outside, "fr", "main.ftl"), "secret = dehors\n");
	});
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	const service = (locales: unknown) => {
		const m = { manifest_version: 1, id: "x@example.org", name: "X", version: "1.0.0", main: { wasm: "p.wasm" }, locales } as unknown as PluginManifest;
		return new L10nService({ locale: () => "en-US", dirOf: () => plugin, manifestOf: () => m });
	};
	const secret = (s: L10nService) => s.format("x@example.org", { id: "secret", args: [] });

	test("the folder inside the plugin works", () => {
		const s = service({ default: "en-US" });
		expect(s.format("x@example.org", { id: "own", args: [] })).toBe("inside");
	});
	test("a dir that leads out of the plugin is not read", () => {
		for (const dir of ["../outside", "..", "locale/../../outside", "C:/Windows", "/etc"]) {
			const s = service({ default: "en-US", dir });
			expect([dir, secret(s)]).toEqual([dir, "secret"]);
			expect(s.pluginLocales("x@example.org")).toEqual([]);
		}
	});
	test("a tag that is a path is not read", () => {
		const s = service({ default: "en-US", available: ["en-US", "../../outside/en-US", "../outside/fr"] });
		expect(secret(s)).toBe("secret");
		expect(s.pluginLocales("x@example.org")).toEqual(["en-US"]);
		expect(s.rawBundles("x@example.org")?.bundles.map((b) => b.tag)).toEqual(["en-US"]);
	});
	test("a link or junction inside the plugin that points out is not followed", () => {
		const linked = join(plugin, "linked");
		mkdirSync(linked, { recursive: true });
		try {
			symlinkSync(join(outside, "en-US"), join(linked, "en-US"), "junction");
			symlinkSync(outside, join(plugin, "outside-link"), "junction");
		} catch {
			return; // no permission to make links here
		}
		for (const locales of [{ default: "en-US", dir: "linked" }, { default: "en-US", dir: "outside-link" }]) {
			const s = service(locales);
			expect(secret(s)).toBe("secret");
			expect(s.rawBundles("x@example.org")?.bundles.map((b) => b.ftl.includes("outside"))).not.toContain(true);
		}
	});
});
