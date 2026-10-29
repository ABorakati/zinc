import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildFileIndex,
	fileTitleNorm,
	findFile,
	normName,
	resolveAttachmentFile,
	zoteroRawPathFilename,
} from "../../src/import/resolve-files";

let root: string;
let storage: string;
let base: string;
let other: string;

const put = (p: string, body = "%PDF-1.4") => {
	mkdirSync(join(p, ".."), { recursive: true });
	writeFileSync(p, body);
};

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "zn-resolve-"));
	storage = join(root, "Zotero", "storage");
	base = join(root, "Library");
	other = join(root, "Mendeley");
	put(join(storage, "AAAAAAAA", "canon.pdf"));
	put(join(storage, "BBBBBBBB", "renamed-on-disk.pdf"));
	put(join(storage, "ZZZZZZZZ", "Moved - 2020 - Orphan folder file.pdf")); // key differs from DB row
	put(join(base, "Sub", "Smith et al. - 2021 - A study of surgical outcomes in elderly patients.pdf"));
	put(join(other, "Kleeff et al", "BJC", "kleeff2016.pdf"), "%PDF-kleeff");
	put(join(other, "Falconi et al", "RPM", "kleeff2016.pdf"), "%PDF-falconi-different");
	put(join(other, "Zhang et al", "J", "Zhang et al. - 2020 - Primary tumor location affects recurrence-free survival for patients.pdf"));
	put(join(other, "Papers", "Wu-Trends in the Incidence Treatment and Outcomes of Pa.pdf"));
	put(join(other, "Papers", "Cortez et al. - 2026 - Real-World Use of Normothermic Machine Perfusion in Liver Transplantation.pdf"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const idx = () => buildFileIndex([base, storage, other]);

describe("name helpers", () => {
	test("normName ignores case, punctuation and extension", () => {
		expect(normName("Foo, Bar - 2020 (x).PDF")).toBe("foobar2020x");
	});
	test("zoteroRawPathFilename", () => {
		expect(zoteroRawPathFilename("storage:a.pdf")).toBe("a.pdf");
		expect(zoteroRawPathFilename("attachments:dir\\sub/a.pdf")).toBe("a.pdf");
		expect(zoteroRawPathFilename("C:\\x\\y\\a.pdf")).toBe("a.pdf");
		expect(zoteroRawPathFilename(null)).toBeUndefined();
	});
	test("fileTitleNorm handles Zotero and Author-Title styles", () => {
		expect(fileTitleNorm("Smith et al. - 2021 - A study.pdf")).toBe("astudy");
		expect(fileTitleNorm("Wu-Trends in the Incidence.pdf")).toBe("trendsintheincidence");
	});
});

describe("resolveAttachmentFile", () => {
	const ctx = () => ({ storageDir: storage, baseAttach: base, index: idx });

	test("canonical storage path", () => {
		const m = resolveAttachmentFile({ key: "AAAAAAAA", rawPath: "storage:canon.pdf", filename: "canon.pdf" }, ctx());
		expect(m?.how).toBe("canonical");
	});
	test("canonical attachments: path", () => {
		const m = resolveAttachmentFile(
			{ key: "LINK0001", rawPath: "attachments:Sub/Smith et al. - 2021 - A study of surgical outcomes in elderly patients.pdf", filename: "x" },
			ctx(),
		);
		expect(m?.how).toBe("canonical");
	});
	test("storage folder exists but the file was renamed", () => {
		const m = resolveAttachmentFile({ key: "BBBBBBBB", rawPath: "storage:original-name.pdf", filename: "original-name.pdf" }, ctx());
		expect(m?.how).toBe("storage-dir");
		expect(m?.path.replaceAll("\\", "/")).toContain("BBBBBBBB/renamed-on-disk.pdf");
	});
	test("no storage folder for the key: found by file name in another folder (exact, case-insensitive)", () => {
		const m = resolveAttachmentFile(
			{ key: "NOFOLDER", rawPath: "storage:moved - 2020 - orphan folder file.PDF", filename: "moved - 2020 - orphan folder file.PDF" },
			ctx(),
		);
		expect(m?.how).toBe("exact");
		expect(m?.path.replaceAll("\\", "/")).toContain("ZZZZZZZZ");
	});
	test("linked file moved out of the base path", () => {
		const m = resolveAttachmentFile(
			{
				key: "LINK0002",
				rawPath: "attachments:Gone/Smith et al. - 2021 - A study of surgical outcomes in elderly patients.pdf",
				filename: "Smith et al. - 2021 - A study of surgical outcomes in elderly patients.pdf",
			},
			ctx(),
		);
		expect(m?.how).toBe("exact");
	});
	test("nothing found -> null", () => {
		expect(resolveAttachmentFile({ key: "NONE0000", rawPath: "storage:nope.pdf", filename: "nope.pdf" }, ctx())).toBeNull();
	});
});

describe("ambiguity and fuzzy matching", () => {
	test("same file name in two folders: disambiguated by first author surname in the path", () => {
		const m = findFile({ key: "K1", filename: "kleeff2016.pdf", parentAuthor: "Kleeff et al." }, idx());
		expect(m?.path).toContain("Kleeff et al");
	});
	test("same file name, different bytes, no author hint: refuse to guess", () => {
		expect(findFile({ key: "K2", filename: "kleeff2016.pdf" }, idx())).toBeNull();
	});
	test("title match finds a renamed copy (full title in file name)", () => {
		const m = findFile(
			{ key: "T1", filename: "gone.pdf", parentTitle: "Primary tumor location affects recurrence-free survival for patients" },
			idx(),
		);
		expect(m?.how).toBe("title");
		expect(m?.path).toContain("Zhang et al");
	});
	test("title match finds a truncated Author-Title file name", () => {
		const m = findFile(
			{ key: "T2", filename: "gone.pdf", parentTitle: "Trends in the Incidence, Treatment and Outcomes of Patients with Intrahepatic Cholangiocarcinoma" },
			idx(),
		);
		expect(m?.path).toContain("Wu-Trends");
	});
	test("a short title does not claim a longer, different paper", () => {
		expect(findFile({ key: "T3", filename: "gone.pdf", parentTitle: "Machine perfusion in liver transplantation" }, idx())).toBeNull();
	});
	test("fuzzy:false disables title matching", () => {
		const m = findFile(
			{ key: "T1", filename: "gone.pdf", parentTitle: "Primary tumor location affects recurrence-free survival for patients" },
			idx(),
			{ fuzzy: false },
		);
		expect(m).toBeNull();
	});
});
