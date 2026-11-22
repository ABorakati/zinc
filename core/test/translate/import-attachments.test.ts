// Files named by an import translator are copied only from the folder the import file came from.
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openDb } from "../../src/db";
import { hooks } from "../../src/additems/files";
import { saveImported } from "../../src/translate/service";
import { tempDir } from "../fixture";

let db: Database;
let base: string;
let outside: string;
const origAfterImport = hooks.afterImport;

beforeEach(() => {
	const root = tempDir();
	db = openDb(join(root, "lib.sqlite"));
	base = join(root, "import");
	outside = join(root, "elsewhere");
	mkdirSync(join(base, "files"), { recursive: true });
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(base, "files", "ok.pdf"), "%PDF-1.4 inside");
	writeFileSync(join(outside, "secret.pdf"), "%PDF-1.4 outside");
	hooks.afterImport = () => {};
});
afterEach(() => {
	hooks.afterImport = origAfterImport;
	db.close(true);
});

const attachmentTitles = (): string[] =>
	(db.query("SELECT title FROM items WHERE item_type = 'attachment' ORDER BY title").all() as { title: string }[]).map((r) => r.title);

function run(attachment: Record<string, unknown>) {
	return saveImported(
		db,
		{ items: [{ id: "1", itemType: "book", title: "Book", attachments: [attachment] }], collections: [], translator: {} as never },
		{ collectionKey: null, collectionName: null, basePath: base },
	);
}

describe("attachments of a translator import", () => {
	test("a file inside the import folder is copied", () => {
		const r = run({ title: "inside", path: "files/ok.pdf", mimeType: "application/pdf" });
		expect(r.errors).toEqual([]);
		expect(r.attachments).toBe(1);
		expect(attachmentTitles()).toEqual(["inside"]);
	});

	test("a file: URL inside the import folder is copied", () => {
		const r = run({ title: "inside url", path: pathToFileURL(join(base, "files", "ok.pdf")).href, mimeType: "application/pdf" });
		expect(r.errors).toEqual([]);
		expect(r.attachments).toBe(1);
	});

	test("an absolute path outside the import folder is refused", () => {
		const r = run({ title: "abs", path: join(outside, "secret.pdf") });
		expect(r.attachments).toBe(0);
		expect(r.errors.join("\n")).toContain("outside the folder");
		expect(attachmentTitles()).toEqual([]);
	});

	test("a file: URL outside the import folder is refused", () => {
		const r = run({ title: "url", path: pathToFileURL(join(outside, "secret.pdf")).href });
		expect(r.attachments).toBe(0);
		expect(r.errors.join("\n")).toContain("outside the folder");
		expect(attachmentTitles()).toEqual([]);
	});

	test("a ../ path out of the import folder is refused", () => {
		const r = run({ title: "up", path: "../elsewhere/secret.pdf" });
		expect(r.attachments).toBe(0);
		expect(r.errors.join("\n")).toContain("outside the folder");
	});

	test("a link inside the import folder that points outside is refused", () => {
		try {
			symlinkSync(outside, join(base, "link"), "junction");
		} catch {
			return; // no permission to make links on this machine
		}
		const r = run({ title: "link", path: "link/secret.pdf" });
		expect(r.attachments).toBe(0);
		expect(r.errors.join("\n")).toContain("links to a file outside");
		expect(attachmentTitles()).toEqual([]);
	});

	test("network and device paths are refused", () => {
		const r = run({ title: "unc", path: "//server/share/x.pdf" });
		expect(r.attachments).toBe(0);
		expect(r.errors.join("\n")).toContain("network and device paths");
	});
});
