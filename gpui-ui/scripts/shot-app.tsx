// Headless screenshots of the whole <App/> shell: bun scripts/shot-app.tsx [out.png] [--mode light|dark] [--scheme id] [--drag] [--panels 10|01|00]
//   out.png          default <scratchpad>/gpui-shots/shell-app.png
//   --drag           drag the first column gutter 140 px right (the Resizable), screenshot as <out>-resized.png and print the saved sizes
//   --panels 10      hide the item pane (also 01 / 00); the layout is rebuilt for that combination
// Preferences go to a throw-away ui-state.json (scripts/_shell-env.ts), never the real one.
import { readFileSync } from "node:fs";
import { SHOTS, STATE_FILE, boot, sleep } from "./shell-shot-lib";
import { getCols, setLeftOpen, setRightOpen } from "../src/shell/layout";
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

if (flag(args, "--drag")) {
	const before = getCols("11");
	// the first gutter sits at the right edge of the sidebar column: 18% of the width left after the two 12 px gutters and the 12 px right padding
	const win = h.t.renderer.getWindowSize();
	const x0 = Math.round(0.18 * (win.width - 12 - 24) + 6);
	const y = Math.round(win.height / 2);
	h.t.renderer.nativeSimulateMouseDown(x0, y);
	for (let i = 1; i <= 7; i++) {
		h.t.renderer.nativeSimulateMouseMove(x0 + i * 20, y, 0);
		await sleep(30);
	}
	h.t.renderer.nativeSimulateMouseUp(x0 + 140, y);
	await h.settle(500);
	const resized = out.replace(/\.png$/, "-resized.png");
	h.t.renderer.captureScreenshot(resized);
	console.log(
		"wrote",
		resized,
		"cols before",
		before.map((n) => +n.toFixed(3)),
		"after",
		getCols("11").map((n) => +n.toFixed(3)),
	);
}
await sleep(800); // the ui-state.json write is debounced
const saved = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Record<string, unknown>;
console.log("saved shell.* keys:", JSON.stringify(Object.fromEntries(Object.entries(saved).filter(([k]) => k.startsWith("shell.")))));
h.t.unmount();
process.exit(0);
