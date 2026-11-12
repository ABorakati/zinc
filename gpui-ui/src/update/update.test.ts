import { describe, expect, test } from "bun:test";
import { initialModel, type UpdateModel } from "../../../core/src/update/machine";
import type { Manifest } from "../../../core/src/update/manifest";
import { notesToLines } from "./notes";
import { updateStatus } from "./status";

const m = { version: "0.2.0+1a2b3c4d-20261201", releasedAt: "2026-12-01T09:00:00Z", notes: "", url: "https://e.org/a.exe", sha256: "a".repeat(64), size: 10, signature: "s" } as Manifest;
const o = { feed: true, possible: true, ago: (iso: string) => `ago(${iso})` };
const model = (state: UpdateModel["state"], extra: Partial<UpdateModel> = {}): UpdateModel => ({ ...initialModel(), state, ...extra });

describe("release notes", () => {
	test("markdown becomes plain lines", () => {
		expect(notesToLines("# 0.2.0\n\n- **Faster** search\n- see [docs](https://e.org)\n\n\n1. `one`\r\n")).toEqual(["0.2.0", "", "• Faster search", "• see docs", "", "1. one"]);
		expect(notesToLines("")).toEqual([]);
	});
});

describe("status line", () => {
	test("each state", () => {
		expect(updateStatus(initialModel(), { ...o, feed: false })).toContain("No update feed");
		expect(updateStatus(initialModel(), { ...o, possible: false })).toContain("cannot check");
		expect(updateStatus(initialModel(), o)).toBe("Not checked yet.");
		expect(updateStatus(initialModel({ at: "T", result: "up-to-date" }), o)).toBe("Last checked ago(T): up to date.");
		expect(updateStatus(model({ kind: "checking" }), o)).toBe("Checking…");
		expect(updateStatus(model({ kind: "available", manifest: m }), o)).toBe("0.2.0 (2026-12-01) is available.");
		expect(updateStatus(model({ kind: "available", manifest: m, manualOnly: true }), o)).toBe("0.2.0 (2026-12-01) is available, but it has to be installed by hand.");
		expect(updateStatus(model({ kind: "available", manifest: m, manualOnly: true, manualReason: "Not an AppImage." }), o)).toBe("0.2.0 (2026-12-01) is available, but it has to be installed by hand. Not an AppImage.");
		expect(updateStatus(model({ kind: "downloading", manifest: m, received: 5, total: 10 }), o)).toContain("50%");
		expect(updateStatus(model({ kind: "ready", manifest: m, file: "f" }, { installOnExit: true }), o)).toContain("installed when you quit");
		expect(updateStatus(model({ kind: "error", phase: "check", message: "offline" }), o)).toBe("offline");
	});
});
