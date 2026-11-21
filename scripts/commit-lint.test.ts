// The commit message rules (scripts/commit-lint.ts). CI runs this file in the "commit messages" job.
import { describe, expect, test } from "bun:test";
import { cleanMessage, lintMessage } from "./commit-lint";

describe("lintMessage", () => {
	test("accepts the formats in CONTRIBUTING.md", () => {
		expect(lintMessage("fix: restore the window size on start")).toEqual([]);
		expect(lintMessage("feat(itempane): fit the attachment preview to the pane's width")).toEqual([]);
		expect(lintMessage("feat(api)!: drop the v1 endpoints")).toEqual([]);
		// capitals are allowed: subjects name Word, Settings, macOS
		expect(lintMessage("fix(word): stop a refresh freezing Word on a looping tracked-changes list")).toEqual([]);
		expect(lintMessage("docs: add CHANGELOG.md\n\nThe body explains why.\n\nRefs: #12")).toEqual([]);
	});

	test("rejects a first line without a type", () => {
		expect(lintMessage("Layouts: clear feedback while holding and dragging a pane")[0]).toContain(
			'the first line must be "type: subject"',
		);
		expect(lintMessage("feature(layouts): clear feedback while dragging a pane")).toEqual([
			'"feature" is not a type; use one of build, chore, ci, docs, feat, fix, perf, refactor, revert, style, test',
		]);
		expect(lintMessage("Fix switches and checkboxes that ignored clicks")[0]).toContain('the first line must be "type: subject"');
		expect(lintMessage("fix:missing space")[0]).toContain('the first line must be "type: subject"');
		expect(lintMessage("")[0]).toContain('the first line must be "type: subject"');
	});

	test("rejects a full stop at the end of the subject", () => {
		expect(lintMessage("fix: restore the window size.")).toEqual(["the subject must not end with a full stop"]);
	});

	test("first line at most 80 characters, body lines at most 100 (URLs excepted)", () => {
		const subject = `fix: ${"a".repeat(75)}`;
		expect(lintMessage(subject)).toEqual([]);
		expect(lintMessage(`${subject}b`)).toEqual(["the first line has 81 characters; at most 80"]);
		expect(lintMessage(`fix: x\n\n${"b".repeat(100)}`)).toEqual([]);
		expect(lintMessage(`fix: x\n\n${"b".repeat(101)}`)).toEqual(["line 3 has 101 characters; at most 100"]);
		expect(lintMessage(`fix: x\n\nSee https://example.org/${"c".repeat(100)}`)).toEqual([]);
	});

	test("requires a blank line between the first line and the body", () => {
		expect(lintMessage("fix: x\nbody")).toEqual(["a blank line must separate the first line from the body"]);
	});

	test("does not check the messages git writes itself", () => {
		expect(lintMessage("Merge branch 'fix/linux-system-theme' into merged")).toEqual([]);
		expect(lintMessage('Revert "fix: restore the window size"\n\nThis reverts commit 1234.')).toEqual([]);
		expect(lintMessage("fixup! fix: restore the window size")).toEqual([]);
		expect(lintMessage("squash! fix: restore the window size")).toEqual([]);
	});
});

describe("cleanMessage", () => {
	test("drops comment lines and the diff below the scissors line, as git does", () => {
		const raw = [
			"fix: restore the window size",
			"",
			"Body.",
			"# Please enter the commit message for your changes.",
			"# ------------------------ >8 ------------------------",
			"diff --git a/x b/x",
			"+" + "d".repeat(200),
		].join("\n");
		expect(cleanMessage(raw)).toBe("fix: restore the window size\n\nBody.");
		expect(lintMessage(raw)).toEqual([]);
	});

	test("ignores CRLF line ends and trailing blank lines", () => {
		expect(cleanMessage("fix: x\r\n\r\nBody.\r\n\r\n")).toBe("fix: x\n\nBody.");
	});
});
