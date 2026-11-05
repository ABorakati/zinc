import { describe, expect, test } from "bun:test";
import { attachNewestLabel, describeOrganize, formatExtensions, parseExtensions, type OrganizeReport } from "./summary";

const report = (p: Partial<OrganizeReport> = {}): OrganizeReport => ({
	moved: 0, copied: 0, failed: [], leftBehind: [], onlineOnly: 0, locked: 0, skipped: 0, skippedSample: [], bytes: 0, ...p,
});

describe("describeOrganize", () => {
	test("counts the finished files by action", () => {
		expect(describeOrganize(report({ moved: 3 }), "move")).toEqual({ kind: "success", title: "3 files moved", description: undefined });
		expect(describeOrganize(report({ copied: 1 }), "copy").title).toBe("1 file copied");
		expect(describeOrganize(report({ moved: 2 }), "to-stored").title).toBe("2 files converted to stored files");
	});
	test("says why nothing happened", () => {
		const r = describeOrganize(report({ skipped: 1, skippedSample: [{ key: "A", path: "x", reason: "already in the right folder" }] }), "move");
		expect(r).toMatchObject({ kind: "info", title: "Nothing to do" });
		expect(r.description).toContain("already in the right folder");
		expect(describeOrganize(report(), "move").description).toBe("Every file is already in place.");
	});
	test("reports files that were left alone", () => {
		const r = describeOrganize(report({ moved: 1, locked: 2, onlineOnly: 1, leftBehind: [{ key: "A", path: "x" }], skipped: 3, skippedSample: [{ key: "B", path: "y", reason: "the file is open in another program" }] }), "move");
		expect(r.kind).toBe("success");
		expect(r.description).toContain("2 files open in another program skipped");
		expect(r.description).toContain("1 online-only OneDrive file skipped");
		expect(r.description).toContain("1 original could not be deleted");
	});
	test("a failure is an error and names the first cause", () => {
		const r = describeOrganize(report({ moved: 1, failed: [{ key: "A", from: "x", error: "disk on fire" }] }), "move");
		expect(r.kind).toBe("error");
		expect(r.description).toContain("disk on fire");
	});
});

describe("labels and fields", () => {
	test("attach newest names its folder", () => {
		expect(attachNewestLabel("C:\\Users\\me\\Downloads")).toBe("Attach Newest File from Downloads");
		expect(attachNewestLabel(null)).toBe("Attach Newest File…");
	});
	test("extensions", () => {
		expect(parseExtensions(".PDF, *.epub;docx  pdf")).toEqual(["pdf", "epub", "docx"]);
		expect(parseExtensions("")).toEqual([]);
		expect(formatExtensions(["pdf", "epub"])).toBe("pdf, epub");
	});
});
