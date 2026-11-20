import { afterEach, describe, expect, test } from "bun:test";
import type { Run } from "../../src/contracts";
import {
	createResultWriter,
	ensureBibliographyStyle,
	formatOptions,
	queueLoadBibliographyStyle,
	resultWriter,
	runsToOoxml,
	setWriteStrategy,
} from "../../src/format";
import { createFakeField, FakeField } from "./fakes";

afterEach(() => {
	setWriteStrategy("insertText");
	delete formatOptions.bibliographyStyleKind;
	delete formatOptions.ooxmlResetFormatting;
	delete (globalThis as any).Office;
});

describe("queueResult — strategy (a): insertText per run", () => {
	test("replaces field.result on first run, clears inherited character effects, and does not sync", () => {
		const { context, field, commands } = createFakeField();
		resultWriter.queueResult(field as unknown as Word.Field, [{ t: "(Smith, 2021)" }]);

		expect(context.syncCount).toBe(0);
		expect(commands).toEqual([
			{ kind: "insertText", target: "field.result", text: "(Smith, 2021)", location: "Replace", returnedRange: "r1" },
			{ kind: "setFont", target: "r1", prop: "italic", value: false },
			{ kind: "setFont", target: "r1", prop: "bold", value: false },
			{ kind: "setFont", target: "r1", prop: "superscript", value: false },
			{ kind: "setFont", target: "r1", prop: "subscript", value: false },
			{ kind: "setFont", target: "r1", prop: "smallCaps", value: false },
		]);
	});

	test("queues subsequent runs at End of field.result and sets false clears before true marks on each range", () => {
		const { field, commands } = createFakeField();
		const runs: Run[] = [
			{ t: "(see " },
			{ t: "Smith", sc: 1 },
			{ t: " " },
			{ t: "et al.", i: 1, b: 1 },
			{ t: ", 2021" },
			{ t: "a", sup: 1 },
			{ t: ")" },
		];
		resultWriter.queueResult(field as unknown as Word.Field, runs);

		const inserts = commands.filter((c) => c.kind === "insertText");
		expect(inserts).toEqual([
			{ kind: "insertText", target: "field.result", text: "(see ", location: "Replace", returnedRange: "r1" },
			{ kind: "insertText", target: "field.result", text: "Smith", location: "End", returnedRange: "r2" },
			{ kind: "insertText", target: "field.result", text: " ", location: "End", returnedRange: "r3" },
			{ kind: "insertText", target: "field.result", text: "et al.", location: "End", returnedRange: "r4" },
			{ kind: "insertText", target: "field.result", text: ", 2021", location: "End", returnedRange: "r5" },
			{ kind: "insertText", target: "field.result", text: "a", location: "End", returnedRange: "r6" },
			{ kind: "insertText", target: "field.result", text: ")", location: "End", returnedRange: "r7" },
		]);

		// r4 ("et al.", i: 1, b: 1): clears superscript/subscript/smallCaps first, then sets italic & bold true
		expect(commands.filter((c) => c.kind === "setFont" && c.target === "r4")).toEqual([
			{ kind: "setFont", target: "r4", prop: "superscript", value: false },
			{ kind: "setFont", target: "r4", prop: "subscript", value: false },
			{ kind: "setFont", target: "r4", prop: "smallCaps", value: false },
			{ kind: "setFont", target: "r4", prop: "italic", value: true },
			{ kind: "setFont", target: "r4", prop: "bold", value: true },
		]);

		// r5 (", 2021"): explicitly clears italic & bold so it cannot inherit r4's formatting
		expect(commands.filter((c) => c.kind === "setFont" && c.target === "r5")).toEqual([
			{ kind: "setFont", target: "r5", prop: "italic", value: false },
			{ kind: "setFont", target: "r5", prop: "bold", value: false },
			{ kind: "setFont", target: "r5", prop: "superscript", value: false },
			{ kind: "setFont", target: "r5", prop: "subscript", value: false },
			{ kind: "setFont", target: "r5", prop: "smallCaps", value: false },
		]);
	});

	test("clears an empty bibliography or citation to empty text and resets font properties", () => {
		const { field, commands } = createFakeField();
		resultWriter.queueResult(field as unknown as Word.Field, []);

		expect(commands[0]).toEqual({
			kind: "insertText",
			target: "field.result",
			text: "",
			location: "Replace",
			returnedRange: "r1",
		});
		expect(commands.filter((c) => c.kind === "setFont")).toHaveLength(5);
	});

	test("normalizes \\r and \\r\\n paragraph breaks to \\n for multiline bibliography runs", () => {
		const { field, commands } = createFakeField();
		resultWriter.queueResult(field as unknown as Word.Field, [{ t: "1. First\r2. Second\r\n3. Third" }]);

		expect(commands[0]).toEqual({
			kind: "insertText",
			target: "field.result",
			text: "1. First\n2. Second\n3. Third",
			location: "Replace",
			returnedRange: "r1",
		});
	});

	test("handles subscript runs and gives superscript precedence if both sup and sub are set", () => {
		const { field, commands } = createFakeField();
		resultWriter.queueResult(field as unknown as Word.Field, [{ t: "H" }, { t: "2", sub: 1 }, { t: "O", sup: 1, sub: 1 }]);

		expect(commands.filter((c) => c.kind === "setFont" && c.target === "r2")).toEqual([
			{ kind: "setFont", target: "r2", prop: "italic", value: false },
			{ kind: "setFont", target: "r2", prop: "bold", value: false },
			{ kind: "setFont", target: "r2", prop: "superscript", value: false },
			{ kind: "setFont", target: "r2", prop: "smallCaps", value: false },
			{ kind: "setFont", target: "r2", prop: "subscript", value: true },
		]);
		expect(commands.filter((c) => c.kind === "setFont" && c.target === "r3")).toEqual([
			{ kind: "setFont", target: "r3", prop: "italic", value: false },
			{ kind: "setFont", target: "r3", prop: "bold", value: false },
			{ kind: "setFont", target: "r3", prop: "subscript", value: false },
			{ kind: "setFont", target: "r3", prop: "smallCaps", value: false },
			{ kind: "setFont", target: "r3", prop: "superscript", value: true },
		]);
	});

	test("skips font.smallCaps when Office.context.requirements reports WordApiDesktop 1.3 unsupported", () => {
		(globalThis as any).Office = {
			context: {
				requirements: {
					isSetSupported: (set: string, ver: string) => !(set === "WordApiDesktop" && ver === "1.3"),
				},
			},
		};
		const { field, commands } = createFakeField();
		resultWriter.queueResult(field as unknown as Word.Field, [{ t: "Author", sc: 1 }]);

		const fontProps = commands.filter((c) => c.kind === "setFont").map((c) => c.prop);
		expect(fontProps).toEqual(["italic", "bold", "superscript", "subscript"]);
	});
});

describe('queueResult — strategy (b): single insertOoxml("Replace")', () => {
	test('switching formatOptions.strategy to "ooxml" issues one insertOoxml("Replace") command', () => {
		setWriteStrategy("ooxml");
		const { context, field, commands } = createFakeField();
		const runs: Run[] = [{ t: "(" }, { t: "et al.", i: 1 }, { t: ", 2021)" }];

		resultWriter.queueResult(field as unknown as Word.Field, runs);

		expect(context.syncCount).toBe(0);
		expect(commands).toEqual([
			{
				kind: "insertOoxml",
				target: "field.result",
				ooxml: runsToOoxml(runs),
				location: "Replace",
				returnedRange: "r1",
			},
		]);
	});

	test("createResultWriter supports independent writer instances with ooxmlResetFormatting", () => {
		const writer = createResultWriter({ strategy: "ooxml", ooxmlResetFormatting: true });
		const { field, commands } = createFakeField();
		const runs: Run[] = [{ t: "1", sup: 1 }];

		writer.queueResult(field as unknown as Word.Field, runs);

		expect(commands).toHaveLength(1);
		expect(commands[0]).toEqual({
			kind: "insertOoxml",
			target: "field.result",
			ooxml: runsToOoxml(runs, { resetFormatting: true }),
			location: "Replace",
			returnedRange: "r1",
		});
	});
});

describe("queueBibliographyFormat", () => {
	test("applies the built-in Bibliography style and no direct indents or spacing (Zotero: they belong to the style), without syncing", () => {
		const { context, field, commands } = createFakeField();
		resultWriter.queueBibliographyFormat(field as unknown as Word.Field, {
			hanging: true,
			entrySpacing: 1,
			lineSpacing: 1.5,
		});

		expect(context.syncCount).toBe(0);
		expect(commands).toEqual([
			{ kind: "getStyles" },
			{ kind: "getStyleByNameOrNull", name: "Bibliography" },
			{ kind: "setStyleBuiltIn", target: "field.result", style: "Bibliography" },
		]);
	});

	test("puts no direct paragraph formatting on the result for secondFieldAlign either", () => {
		const { field, commands } = createFakeField();
		resultWriter.queueBibliographyFormat(field as unknown as Word.Field, {
			secondFieldAlign: true,
			entrySpacing: 0,
		});

		expect(commands.filter((c) => c.kind === "setParagraphFormat")).toEqual([]);
	});

	test("creates missing Bibliography style once (Word on the web) and assigns range.style instead of styleBuiltIn", () => {
		const { context, field, commands } = createFakeField({ styles: [] });
		resultWriter.queueBibliographyFormat(field as unknown as Word.Field, { hanging: true });

		expect(context.document.hasStyle("Bibliography")).toBe(true);
		expect(commands).toEqual([
			{ kind: "getStyles" },
			{ kind: "getStyleByNameOrNull", name: "Bibliography" },
			{ kind: "addStyle", name: "Bibliography", styleType: "Paragraph" },
			{ kind: "setStyle", target: "field.result", style: "Bibliography" },
		]);

		// A second bibliography field in the same document reuses the cached custom style without calling addStyle again.
		commands.length = 0;
		const secondField = new FakeField(context, "field2.result");
		resultWriter.queueBibliographyFormat(secondField as unknown as Word.Field, {});
		expect(commands).toEqual([{ kind: "setStyle", target: "field2.result", style: "Bibliography" }]);
	});

	test("works with strict Office.js unloaded style proxies via queueLoadBibliographyStyle and ensureBibliographyStyle", async () => {
		// 1. Piggybacking onto an earlier caller sync via queueLoadBibliographyStyle (zero extra syncs!)
		const env1 = createFakeField({ styles: [], strictUnloadedStyle: true });
		queueLoadBibliographyStyle(env1.context as unknown as Word.RequestContext);
		await env1.context.sync(); // e.g., caller's sync that switches Track Changes off
		env1.commands.length = 0;

		resultWriter.queueBibliographyFormat(env1.field as unknown as Word.Field, { hanging: true });
		expect(env1.commands).toEqual([
			{ kind: "addStyle", name: "Bibliography", styleType: "Paragraph" },
			{ kind: "setStyle", target: "field.result", style: "Bibliography" },
		]);

		// 2. Standalone async ensureBibliographyStyle preflight
		const env2 = createFakeField({ styles: [], strictUnloadedStyle: true });
		const kind = await ensureBibliographyStyle(env2.context as unknown as Word.RequestContext);
		expect(kind).toBe("custom");
		expect(env2.context.document.hasStyle("Bibliography")).toBe(true);
		env2.commands.length = 0;

		resultWriter.queueBibliographyFormat(env2.field as unknown as Word.Field, { entrySpacing: 2 });
		expect(env2.commands).toEqual([{ kind: "setStyle", target: "field.result", style: "Bibliography" }]);

		// 3. Without preflight on strict unloaded proxy: falls back cleanly without throwing PropertyNotLoaded
		const env3 = createFakeField({ styles: [{ name: "Bibliography", builtIn: true }], strictUnloadedStyle: true });
		resultWriter.queueBibliographyFormat(env3.field as unknown as Word.Field, {});
		expect(env3.commands).toEqual([
			{ kind: "getStyles" },
			{ kind: "getStyleByNameOrNull", name: "Bibliography" },
			{ kind: "setStyleBuiltIn", target: "field.result", style: "Bibliography" },
		]);
	});

	test("uses range.style without addStyle when Bibliography already exists as a custom style, and omits indents when hanging is false", () => {
		const { field, commands } = createFakeField({ styles: [{ name: "Bibliography", builtIn: false }] });
		resultWriter.queueBibliographyFormat(field as unknown as Word.Field, {
			hanging: false,
			secondFieldAlign: false,
		});

		expect(commands).toEqual([
			{ kind: "getStyles" },
			{ kind: "getStyleByNameOrNull", name: "Bibliography" },
			{ kind: "setStyle", target: "field.result", style: "Bibliography" },
		]);
	});
});
