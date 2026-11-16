// The translators updater: local folder and tarball sources (no real GitHub), and the data-dir copy it writes.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { updateTranslators } from "../../src/translate/update";
import { listTranslators, VENDORED_TRANSLATORS_DIR } from "../../src/translate/translators";
import { tempDir } from "../fixture";

/** A minimal ustar archive: GitHub-style, every file under "<repo>-<sha>/". */
function tarOf(entries: [string, Uint8Array][]): Uint8Array {
	const chunks: Uint8Array[] = [];
	const enc = new TextEncoder();
	for (const [name, body] of entries) {
		const h = new Uint8Array(512);
		h.set(enc.encode(name).subarray(0, 100), 0);
		h.set(enc.encode("0000644\0"), 100);
		h.set(enc.encode("0000000\0"), 108);
		h.set(enc.encode("0000000\0"), 116);
		h.set(enc.encode(body.length.toString(8).padStart(11, "0") + "\0"), 124);
		h.set(enc.encode("00000000000\0"), 136);
		h.set(enc.encode("        "), 148);
		h[156] = "0".charCodeAt(0);
		h.set(enc.encode("ustar\0" + "00"), 257);
		const sum = h.reduce((a, b) => a + b, 0);
		h.set(enc.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
		chunks.push(h, body, new Uint8Array((512 - (body.length % 512)) % 512));
	}
	chunks.push(new Uint8Array(1024));
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	let off = 0;
	for (const c of chunks) {
		out.set(c, off);
		off += c.length;
	}
	return out;
}

const servers: Bun.Server<unknown>[] = [];
afterAll(() => servers.forEach((s) => s.stop(true)));

describe("update-translators", () => {
	test("from a local folder: writes <data>/translators and records the source", async () => {
		const data = tempDir();
		const r = await updateTranslators({ dataDir: data, source: VENDORED_TRANSLATORS_DIR });
		expect(r.dir).toBe(join(data, "translators"));
		expect(r.count).toBeGreaterThan(700);
		expect(listTranslators(r.dir).length).toBe(r.count);
		expect(JSON.parse(readFileSync(join(r.dir, ".source.json"), "utf8")).count).toBe(r.count);
		// a second run replaces the folder without leaving staging folders behind
		await updateTranslators({ dataDir: data, source: VENDORED_TRANSLATORS_DIR });
		expect(readdirSync(data).filter((n) => n.startsWith("translators"))).toEqual(["translators"]);
	});

	test("from a GitHub-style tarball URL, taking the commit from the root folder name", async () => {
		const files = readdirSync(VENDORED_TRANSLATORS_DIR)
			.filter((n) => n.endsWith(".js"))
			.map((n): [string, Uint8Array] => [
				`zotero-translators-abc1234/${n}`,
				new Uint8Array(readFileSync(join(VENDORED_TRANSLATORS_DIR, n))),
			]);
		files.push(["zotero-translators-abc1234/nested/ignored.js", new TextEncoder().encode("x")]);
		const gz = gzipSync(tarOf(files));
		const srv = Bun.serve({ port: 0, fetch: () => new Response(gz, { headers: { "content-type": "application/gzip" } }) });
		servers.push(srv);
		const data = tempDir();
		const r = await updateTranslators({ dataDir: data, source: `http://127.0.0.1:${srv.port}/tarball/master` });
		expect(r.commit).toBe("abc1234");
		expect(r.count).toBeGreaterThan(700);
		expect(existsSync(join(r.dir, "ignored.js"))).toBe(false);
	});

	test("a source that is not the translators repo leaves the current set alone", async () => {
		const data = tempDir();
		await updateTranslators({ dataDir: data, source: VENDORED_TRANSLATORS_DIR });
		const small = tempDir();
		await Bun.write(
			join(small, "x.js"),
			`{"translatorID":"a","label":"A","translatorType":4,"priority":1,"lastUpdated":"2020-01-01 00:00:00"}\n`,
		);
		await expect(updateTranslators({ dataDir: data, source: small })).rejects.toThrow(/not replacing/);
		expect(listTranslators(join(data, "translators")).length).toBeGreaterThan(700);
	});
});
