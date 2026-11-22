// bun test src/cards/rows.test.ts -- what keeps a row of the card list mounted, and the separators of a card's meta line.
import { beforeAll, describe, expect, test } from "bun:test";

process.env.ZN_UI_STATE = "off";
let rows: typeof import("./rows");
let logic: any;
beforeAll(async () => {
	// importing the rows starts the list store: every request is answered here, none reaches a core
	const api = await import("../api");
	api.setDirect(async () => new Response("{}", { status: 503, headers: { "content-type": "application/json" } }));
	rows = await import("./rows");
	logic = await import("./logic");
});

describe("sameRow", () => {
	const header = (over = {}) => ({ kind: "header" as const, group: { value: "2025", label: "2025", count: 3, start: 4, ...over } });
	test("a header with the same content is the same row: a refresh does not mount it again", () => {
		expect(rows.sameRow(header(), header())).toBe(true);
	});
	test("a header that shows something else is another row", () => {
		for (const over of [{ value: "2024" }, { label: "Two" }, { count: 4 }, { start: 5 }]) expect(rows.sameRow(header(), header(over))).toBe(false);
		expect(rows.sameRow(header(), { kind: "item", index: 4 })).toBe(false);
	});
});

describe("meta line separators", () => {
	const sep = "\u00b7";
	const line = (...runs: [string, boolean][]) =>
		logic.separateRuns(runs.map(([text, accent]) => ({ text, accent, dir: "ltr" }))).map((r: { text: string }) => r.text).join(" ");
	test("one separator between neighbours, also when both are muted runs of different directions", () => {
		expect(line(["Ann", false], ["Journal", true], ["2025", false], ["Article", false])).toBe(["Ann", "Journal", "2025", "Article"].join(" " + sep + " "));
		expect(line(["2026", false], ["Report", false])).toBe("2026 " + sep + " Report");
		expect(line(["Journal", true])).toBe("Journal");
	});
});
