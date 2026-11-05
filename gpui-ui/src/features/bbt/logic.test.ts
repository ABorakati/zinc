// bun test src/features/bbt/logic.test.ts -- Quick Copy request, formula-preview state, debounce, settings patch, auto-export text, the table column.
import { describe, expect, test } from "bun:test";
import type { AutoExport } from "../../../../core/src/bbt/types";
import { DEFAULT_COLUMNS, getColumn, MENU_COLUMNS } from "../../table/defs";
import { BBT_EXPORT_FORMATS } from "./formats";
import {
	autoExportLines, canSaveFormula, citeRequest, debounce, defaultExportName, formulaChecked, formulaTyped, hasCitationKey, parseSeconds, pinTarget,
	settingsPatch, staleKeysNote, type Scheduler,
} from "./logic";
import type { BbtSettings } from "./client";

const base = { quickCopy: "latex", citeCommand: "cite" } as const;

describe("citeRequest", () => {
	test("latex carries the command", () => expect(citeRequest(["A"], base)).toEqual({ items: ["A"], format: "latex", command: "cite" }));
	test("blank command is omitted", () => expect(citeRequest(["A"], { ...base, citeCommand: " " })).toEqual({ items: ["A"], format: "latex" }));
	test("pandoc and key ignore the command", () => {
		expect(citeRequest(["A", "B"], { ...base, quickCopy: "pandoc" })).toEqual({ items: ["A", "B"], format: "pandoc" });
		expect(citeRequest(["A"], { ...base, quickCopy: "key" })).toEqual({ items: ["A"], format: "key" });
	});
	test("an unknown format falls back to latex", () => expect(citeRequest(["A"], { ...base, quickCopy: "nope" as never }).format).toBe("latex"));
});

describe("item pane", () => {
	test("only regular items have a key", () => {
		expect(hasCitationKey("journalArticle")).toBe(true);
		for (const t of ["note", "attachment", "annotation"]) expect(hasCitationKey(t)).toBe(false);
	});
	test("pinTarget", () => {
		expect(pinTarget(" smith2020 ", "smith2019")).toBe("smith2020");
		expect(pinTarget("smith2019", "smith2019")).toBeNull();
		expect(pinTarget("  ", "smith2019")).toBeNull();
	});
});

describe("formula preview state", () => {
	test("empty formula is an error, typing is pending", () => {
		expect(formulaTyped("").status).toBe("error");
		expect(formulaTyped("auth").status).toBe("pending");
	});
	test("a result applies to the current formula only", () => {
		const s = formulaTyped("auth + year");
		const ok = formulaChecked(s, "auth + year", { ok: true, preview: "smith2020" });
		expect(ok).toEqual({ status: "ok", formula: "auth + year", preview: "smith2020" });
		const typedAgain = formulaTyped("auth + yea");
		expect(formulaChecked(typedAgain, "auth + year", { ok: true, preview: "x" })).toBe(typedAgain);
	});
	test("errors keep message and position", () => {
		const r = formulaChecked(formulaTyped("auth +"), "auth +", { ok: false, error: "Unexpected end", position: 6 });
		expect(r).toEqual({ status: "error", formula: "auth +", error: "Unexpected end", position: 6 });
	});
	test("Save only for a valid, changed formula", () => {
		const ok = formulaChecked(formulaTyped("a"), "a", { ok: true, preview: "x" });
		expect(canSaveFormula(ok, "b")).toBe(true);
		expect(canSaveFormula(ok, "a")).toBe(false);
		expect(canSaveFormula(formulaTyped("a"), "b")).toBe(false);
		expect(canSaveFormula(formulaChecked(formulaTyped("a"), "a", { ok: false }), "b")).toBe(false);
	});
});

describe("debounce", () => {
	function fake() {
		let now = 0, id = 0;
		const timers = new Map<number, { at: number; fn: () => void }>();
		const s: Scheduler = {
			set: (fn, ms) => { timers.set(++id, { at: now + ms, fn }); return id; },
			clear: (h) => { timers.delete(h as number); },
		};
		const advance = (ms: number) => {
			now += ms;
			for (const [k, v] of [...timers]) if (v.at <= now) { timers.delete(k); v.fn(); }
		};
		return { s, advance };
	}
	test("only the last call in a burst fires", () => {
		const { s, advance } = fake();
		const calls: string[] = [];
		const d = debounce((v: string) => calls.push(v), 300, s);
		d("a"); advance(100); d("ab"); advance(100); d("abc");
		advance(299);
		expect(calls).toEqual([]);
		advance(1);
		expect(calls).toEqual(["abc"]);
	});
	test("cancel drops the pending call", () => {
		const { s, advance } = fake();
		const calls: string[] = [];
		const d = debounce((v: string) => calls.push(v), 300, s);
		d("a"); d.cancel(); advance(1000);
		expect(calls).toEqual([]);
	});
});

describe("settings model", () => {
	const saved = { citekeyFormat: "auth", citekeyFold: true, quickCopy: "latex" } as BbtSettings;
	test("settingsPatch keeps only changed fields", () => {
		expect(settingsPatch(saved, { citekeyFormat: "auth", citekeyFold: false })).toEqual({ citekeyFold: false });
		expect(settingsPatch(saved, { quickCopy: "pandoc", skipWords: undefined })).toEqual({ quickCopy: "pandoc" });
	});
	test("parseSeconds", () => {
		expect(parseSeconds(" 5 ")).toBe(5);
		expect(parseSeconds("2.6")).toBe(3);
		for (const bad of ["", "x", "-1"]) expect(parseSeconds(bad)).toBeUndefined();
	});
	test("staleKeysNote", () => {
		expect(staleKeysNote(0)).toBe("");
		expect(staleKeysNote(1)).toContain("1 citation key is");
		expect(staleKeysNote(1200)).toContain("citation keys are");
	});
});

describe("automatic exports", () => {
	const e: AutoExport = {
		id: 1, path: "C:/refs.bib", format: "betterbiblatex", scope: { type: "library" }, trigger: "idle", options: {},
		status: "done", error: null, lastExport: "2026-01-01T00:00:00Z", count: 1, scopeName: "My Library",
	};
	test("row text", () => {
		expect(autoExportLines(e, () => "3 min ago")).toEqual({
			title: "C:/refs.bib", detail: "Better BibLaTeX · My Library · When idle", status: "Up to date · last export 3 min ago, 1 item", error: false,
		});
	});
	test("error status", () => {
		const r = autoExportLines({ ...e, status: "error", error: "EACCES", count: null }, () => "never");
		expect(r.error).toBe(true);
		expect(r.status).toBe("Error: EACCES · last export never");
	});
	test("default file name", () => {
		expect(defaultExportName("My Library", "betterbibtex")).toBe("My Library.bib");
		expect(defaultExportName("a/b:c", "bettercslyaml")).toBe("a_b_c.yml");
	});
});

describe("columns and export formats", () => {
	test("Citation Key column", () => {
		const c = getColumn("citationKey");
		expect(c.sort).toBe("citationKey");
		expect(c.field).toBe("citationKey");
		expect(c.width).toBe(160);
		expect(c.label).toBe("Citation Key");
		expect(c.get({ fields: { citationKey: "smith2020" } } as never)).toBe("smith2020");
		expect(c.get({} as never)).toBe("");
	});
	test("is pickable and not a default column", () => {
		expect(MENU_COLUMNS).toContain("citationKey");
		expect(DEFAULT_COLUMNS).not.toContain("citationKey");
	});
	test("export dialog lists the four Better formats", () => {
		expect(BBT_EXPORT_FORMATS.map((f) => f.id)).toEqual(["betterbibtex", "betterbiblatex", "bettercsljson", "bettercslyaml"]);
		expect(BBT_EXPORT_FORMATS[3]!.label).toBe("Better CSL YAML");
	});
});
