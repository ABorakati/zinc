// bun test src/itempane/model.copy.test.ts -- the item pane's copyText goes through the shared clipboard (ui/clipboard.ts), and a failed
// copy is reported, not dropped and not an unhandled rejection.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import type * as ModelMod from "./model";
import type * as NetMod from "./net";

describe("item pane copyText", () => {
	let model: typeof ModelMod;
	let net: typeof NetMod;
	let clip: { writeText: (t: string) => Promise<void> };
	let origWrite: (t: string) => Promise<void>;
	let origSchema: unknown;
	let origColors: unknown;
	let envBefore: string | undefined;
	let dispose: () => void;
	let pane: ModelMod.PaneModel;

	beforeAll(async () => {
		envBefore = process.env.ZN_UI_STATE;
		process.env.ZN_UI_STATE = "off";
		net = await import("./net");
		model = await import("./model");
		clip = (await import("../ui/clipboard")).clipboard;
		origWrite = clip.writeText;
		origSchema = net.ipApi.schema;
		origColors = net.ipApi.tagColors;
		(net.ipApi as { schema: unknown }).schema = async () => ({});
		(net.ipApi as { tagColors: unknown }).tagColors = async () => [];
		pane = createRoot((d) => {
			dispose = d;
			return model.createPaneModel(() => null);
		});
	});
	afterAll(() => {
		dispose();
		clip.writeText = origWrite;
		(net.ipApi as { schema: unknown }).schema = origSchema;
		(net.ipApi as { tagColors: unknown }).tagColors = origColors;
		if (envBefore === undefined) delete process.env.ZN_UI_STATE;
		else process.env.ZN_UI_STATE = envBefore;
	});

	test("copies through the shared clipboard", async () => {
		const got: string[] = [];
		clip.writeText = async (t) => void got.push(t);
		pane.copyText("10.1000/xyz");
		await Promise.resolve();
		expect(got).toEqual(["10.1000/xyz"]);
	});

	test("a clipboard that rejects is handled", async () => {
		clip.writeText = () => Promise.reject(new Error("no clipboard"));
		const unhandled: unknown[] = [];
		const on = (e: unknown) => void unhandled.push(e);
		process.on("unhandledRejection", on);
		try {
			expect(() => pane.copyText("x")).not.toThrow();
			await new Promise((r) => setTimeout(r, 20));
		} finally {
			process.off("unhandledRejection", on);
		}
		expect(unhandled).toEqual([]);
	});
});
