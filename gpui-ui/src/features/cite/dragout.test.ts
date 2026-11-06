// bun test src/features/cite/dragout.test.ts -- the drag-out controller with the Win32 / OLE side replaced by fakes.
import { describe, expect, test } from "bun:test";
import { pointOutside } from "../../shell/dragout";
import { planQuickCopy } from "./logic";
import { createOutDrag, type OutDragDeps } from "./dragout";
import type { QuickCopyContent } from "./quickcopy";

const settings = { style: "vancouver", locale: "", mode: "bibliography" as const, format: "html" as const };
const content = (shift: boolean): QuickCopyContent => {
	const plan = planQuickCopy(settings, "", { shift });
	return { plan, text: shift ? "[1]" : "1. Smith J.", html: shift ? "<span>[1]</span>" : "<p>1. Smith J.</p>", count: 1 };
};

function rig(over: Partial<OutDragDeps> = {}) {
	const state = { left: true, shift: false, alt: false, outside: false, ready: true };
	const log: string[] = [];
	const runs: { text: string; html?: string }[] = [];
	const requested: boolean[] = [];
	let tick: () => void = () => {};
	const deps: OutDragDeps = {
		supported: () => true,
		leftDown: () => state.left,
		shiftDown: () => state.shift,
		altDown: () => state.alt,
		outside: () => state.outside,
		ready: () => state.ready,
		content: async (_k, shift) => { requested.push(shift); return content(shift); },
		run: async (c) => { runs.push(c); return "dropped"; },
		endInApp: () => log.push("endInApp"),
		copy: async (c) => { log.push(`copy:${c.text}`); },
		notify: (m, kind) => log.push(`${kind}:${m}`),
		every: (fn) => { tick = fn; return () => { tick = () => {}; }; },
		...over,
	};
	const out = createOutDrag(deps);
	return { out, state, log, runs, requested, tick: () => tick(), flush: () => new Promise((r) => setTimeout(r, 5)) };
}
const payload = { kind: "items" as const, keys: ["AAAA1111"] };

describe("createOutDrag", () => {
	test("stays in-app while the pointer is inside the window", async () => {
		const r = rig();
		r.out.start(payload);
		r.tick(); r.tick();
		await r.flush();
		expect(r.runs).toEqual([]);
		expect(r.log).toEqual([]);
		expect(r.out.active()).toBe(true);
	});

	test("hands over to the OS drag when the pointer leaves: bibliography by default", async () => {
		const r = rig();
		r.out.start(payload);
		r.state.outside = true;
		r.tick();
		await r.flush();
		expect(r.runs).toEqual([{ text: "1. Smith J.", html: "<p>1. Smith J.</p>" }]);
		expect(r.log).toEqual(["endInApp"]);
	});

	test("Shift at the moment of leaving drops the citation", async () => {
		const r = rig();
		r.out.start(payload);
		r.state.outside = true; r.state.shift = true;
		r.tick();
		await r.flush();
		expect(r.runs).toEqual([{ text: "[1]", html: "<span>[1]</span>" }]);
	});

	test("both results are formatted up front, so the handover does not wait on the server", async () => {
		const r = rig();
		r.out.start(payload);
		expect(r.requested.sort()).toEqual([false, true]);
	});

	test("a large selection formats only the default result up front", async () => {
		const r = rig();
		r.out.start({ kind: "items", keys: Array.from({ length: 500 }, (_, i) => `K${i}`) });
		expect(r.requested).toEqual([false]);
	});

	test("Alt held at the start hands over at once", async () => {
		const r = rig();
		r.state.alt = true;
		r.out.start(payload);
		await r.flush();
		expect(r.runs.length).toBe(1);
	});

	test("the button released inside the window ends the watch without a drag", async () => {
		const r = rig();
		r.out.start(payload);
		r.state.left = false; r.state.outside = true;
		r.tick();
		await r.flush();
		expect(r.runs).toEqual([]);
		expect(r.out.active()).toBe(false);
	});

	test("button released while the text was still being formatted: clipboard fallback", async () => {
		const r = rig({ content: async (_k, shift) => { await new Promise((x) => setTimeout(x, 10)); r.state.left = false; return content(shift); } });
		r.out.start(payload);
		r.state.outside = true;
		r.tick();
		await new Promise((x) => setTimeout(x, 30));
		expect(r.runs).toEqual([]);
		expect(r.log).toEqual(["copy:1. Smith J.", "success:Bibliography copied (1 item, vancouver) — paste it", "endInApp"]);
	});

	test("an OS drag that cannot run falls back to the clipboard", async () => {
		const r = rig({ run: async () => "failed" });
		r.out.start(payload);
		r.state.outside = true;
		r.tick();
		await r.flush();
		expect(r.log).toEqual(["endInApp", "copy:1. Smith J.", "success:Bibliography copied (1 item, vancouver) — paste it"]);
	});

	test("no window or no drag source: error toast, no drag", async () => {
		const r = rig();
		r.state.ready = false;
		r.out.start(payload);
		r.state.outside = true;
		r.tick();
		await r.flush();
		expect(r.runs).toEqual([]);
		expect(r.log[0]).toBe("endInApp");
		expect(r.log[1]).toMatch(/^error:/);
	});

	test("a formatting error is reported and the in-app drag ends", async () => {
		const r = rig({ content: async () => { throw new Error("core down"); } });
		r.out.start(payload);
		r.state.outside = true;
		r.tick();
		await r.flush();
		expect(r.runs).toEqual([]);
		expect(r.log).toEqual(["endInApp", "error:Could not drag the citation"]);
	});

	test("unsupported platforms do nothing", () => {
		const r = rig({ supported: () => false });
		r.out.start(payload);
		expect(r.out.active()).toBe(false);
	});

	test("end() stops the watch; a second drag starts fresh", async () => {
		const r = rig();
		r.out.start(payload);
		r.out.end();
		expect(r.out.active()).toBe(false);
		r.out.start(payload);
		r.state.outside = true;
		r.tick();
		await r.flush();
		expect(r.runs.length).toBe(1);
	});
});

describe("pointOutside", () => {
	const r = { left: 100, top: 100, right: 500, bottom: 400 };
	test("inside, edges, outside", () => {
		expect(pointOutside(r, 300, 200)).toBe(false);
		expect(pointOutside(r, 100, 200)).toBe(true); // on the border counts as leaving (inset 1)
		expect(pointOutside(r, 102, 102)).toBe(false);
		expect(pointOutside(r, 499, 200)).toBe(true);
		expect(pointOutside(r, 50, 200)).toBe(true);
		expect(pointOutside(r, 300, 450)).toBe(true);
		expect(pointOutside(r, 100, 200, 0)).toBe(false);
	});
});
