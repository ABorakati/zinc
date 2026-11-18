// Headless screenshots of the whole <App/> shell: bun scripts/shot-app.tsx [out.png] [--mode light|dark] [--scheme id] [--drag]
//   [--panels 10|01|00] [--toggle] [--stacked]
//   out.png          default <scratchpad>/gpui-shots/shell-app.png
//   --drag           drag the first column gutter 140 px right (the Resizable), screenshot as <out>-resized.png and print the saved sizes
//   --panels 10      hide the item pane (also 01 / 00)
//   --toggle         scroll the list, then hide and show the sidebar and the item pane: the panes must not be rebuilt (same host
//                    element ids, the list keeps its scroll offset); compares the shots before and after (<out>-toggle-*.png)
//   --stacked        put the item pane below the list in the centre column (the right column empties), screenshot, then drag the
//                    row gutter 120 px up (<out>-stacked*.png)
// Preferences go to a throw-away ui-state.json (scripts/_shell-env.ts), never the real one.
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { SHOTS, STATE_FILE, boot, sleep } from "./shell-shot-lib";
import { libraryLayout, setLeftOpen, setLibraryLayout, setRightOpen } from "../src/shell/layout";
import { flag } from "./_args";
import { gotoSection } from "../src/settings";
import { openSettings } from "../src/shell/layout";
import { setThemePrefs } from "../src/shell/appearance";

const args = process.argv.slice(2);
const val = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const out = args.find((a) => a.endsWith(".png")) ?? `${SHOTS}/shell-app.png`;
const mode = val("--mode") as "light" | "dark" | undefined;
const scheme = val("--scheme");
const panels = val("--panels");
const sizes = () => libraryLayout().sizes.map((n) => +n.toFixed(3));

const h = await boot({ prefs: { ...(mode ? { mode } : { mode: "dark" }), ...(scheme ? { scheme } : {}) } });
const live = val("--live-scheme"); // switch the scheme after the app is up: every drawn component must restyle
if (live) {
	setThemePrefs({ scheme: live });
	await h.settle(800);
}
if (flag(args, "--select")) {
	const it = h.store.itemAt(1);
	if (it) h.store.selectItem(it.key);
	await h.settle(1500);
}
if (flag(args, "--settings")) {
	openSettings();
	gotoSection(val("--settings-section") ?? "appearance");
	await h.settle(800);
}
if (panels) {
	setLeftOpen(panels[0] === "1");
	setRightOpen(panels[1] === "1");
	await h.settle();
}
await h.settle(400);
h.t.renderer.captureScreenshot(out);
console.log("wrote", out);

const win = h.t.renderer.getWindowSize();
async function dragBy(x0: number, y0: number, dx: number, dy: number) {
	h.t.renderer.nativeSimulateMouseDown(x0, y0);
	for (let i = 1; i <= 7; i++) {
		h.t.renderer.nativeSimulateMouseMove(Math.round(x0 + (i * dx) / 7), Math.round(y0 + (i * dy) / 7), 0);
		await sleep(30);
	}
	h.t.renderer.nativeSimulateMouseUp(x0 + dx, y0 + dy);
	await h.settle(500);
}

if (flag(args, "--drag")) {
	const before = sizes();
	// the first gutter sits at the right edge of the sidebar column: 18% of the width left after the two 12 px gutters and the 12 px right padding
	const x0 = Math.round(0.18 * (win.width - 12 - 24) + 6);
	await dragBy(x0, Math.round(win.height / 2), 140, 0);
	const resized = out.replace(/\.png$/, "-resized.png");
	h.t.renderer.captureScreenshot(resized);
	console.log("wrote", resized, "sizes before", before, "after", sizes());
}

/** Fraction of pixels that differ between two screenshots. */
function diff(a: string, b: string): number {
	const pa = PNG.sync.read(readFileSync(a));
	const pb = PNG.sync.read(readFileSync(b));
	if (pa.width !== pb.width || pa.height !== pb.height) return 1;
	const n = pixelmatch(pa.data, pb.data, null, pa.width, pa.height, { threshold: 0.1 });
	return n / (pa.width * pa.height);
}
const idOf = (testId: string) => h.t.renderer.findByTestId(testId)?.id;

if (flag(args, "--toggle")) {
	const items = h.t.renderer.findByTestId("pane-items");
	const box = items ? h.t.renderer.getElementBounds(items.id) : null;
	if (box) h.t.renderer.nativeSimulateScrollWheel(box.x + box.width / 2, box.y + box.height / 2, 0, -1500);
	await h.settle(800);
	const ids0 = ["pane-items", "pane-item", "column-left"].map(idOf);
	const a = out.replace(/\.png$/, "-toggle-a.png");
	h.t.renderer.captureScreenshot(a);
	setLeftOpen(false);
	setRightOpen(false);
	await h.settle(600);
	const mid = out.replace(/\.png$/, "-toggle-hidden.png");
	h.t.renderer.captureScreenshot(mid);
	setLeftOpen(true);
	setRightOpen(true);
	await h.settle(800);
	const b = out.replace(/\.png$/, "-toggle-b.png");
	h.t.renderer.captureScreenshot(b);
	const ids1 = ["pane-items", "pane-item", "column-left"].map(idOf);
	const same = ids0.every((x, i) => x !== undefined && x === ids1[i]);
	console.log("wrote", a, mid, b);
	console.log(
		`toggle: host ids ${same ? "unchanged" : "CHANGED"} ${JSON.stringify(ids0)} -> ${JSON.stringify(ids1)}; ` +
			`before/after differ in ${(diff(a, b) * 100).toFixed(3)}% of pixels; sizes ${JSON.stringify(sizes())}`,
	);
}

if (flag(args, "--stacked")) {
	const l = libraryLayout();
	setLibraryLayout({
		...l,
		centre: {
			stacks: [
				{ panes: ["items"], active: "items" },
				{ panes: ["item"], active: "item" },
			],
			sizes: [0.6, 0.4],
		},
		right: { stacks: [], sizes: [] },
	});
	await h.settle(800);
	const s1 = out.replace(/\.png$/, "-stacked.png");
	h.t.renderer.captureScreenshot(s1);
	const item = h.t.renderer.findByTestId("pane-item");
	const b = item ? h.t.renderer.getElementBounds(item.id) : null;
	if (b && b.height > 0) {
		const before = JSON.stringify(libraryLayout().centre.sizes);
		await dragBy(Math.round(b.x + b.width / 2), Math.round(b.y - 6), 0, -120);
		const s2 = out.replace(/\.png$/, "-stacked-resized.png");
		h.t.renderer.captureScreenshot(s2);
		console.log("wrote", s1, s2, "centre stacks before", before, "after", JSON.stringify(libraryLayout().centre.sizes));
	} else console.log("wrote", s1, "(the item pane is not drawn)", JSON.stringify(b));
}

await sleep(800); // the ui-state.json write is debounced
const saved = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Record<string, unknown>;
console.log("saved shell.* keys:", JSON.stringify(Object.fromEntries(Object.entries(saved).filter(([k]) => k.startsWith("shell.")))));
h.t.unmount();
process.exit(0);
