// Headless check that Settings > General > "Show notes natively (preview)" can be switched on with the mouse and is saved:
//   ZN_DB=<copy of library.sqlite> ZN_PORT=23164 ZN_SHOTS=<dir> bun scripts/shot-native-note-setting.tsx
// Opens Settings at General, clicks the switch on the setting's row, then checks the setting and the (throw-away) ui-state.json.
import { STATE_FILE } from "./_shell-env";
import { readFileSync, existsSync } from "node:fs";
import { boot, SHOTS } from "./shell-shot-lib";
import { startCore } from "../src/core";
import { openSettings } from "../src/shell/layout";
import { gotoSection } from "../src/settings/SettingsPage";
import { nativeNotes } from "../src/notes/native/prefs";

let fails = 0;
const check = (ok: unknown, what: string) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
	if (!ok) fails++;
};

await startCore();
const h = await boot({ prefs: { mode: "light" }, width: 1400, height: 900 });
const r = h.t.renderer;
openSettings();
await h.settle(400);
gotoSection("general");
await h.settle(800);

const LABEL = "Show notes natively (preview)";
const label = r.findByText(LABEL);
let lb = label ? r.getElementBounds(label.id) : null;
for (let i = 0; i < 20 && (!lb || lb.y > 860 || lb.height === 0); i++) {
	// scroll the settings page down to the row
	r.nativeSimulateScrollWheel(700, 500, 0, -300);
	await h.settle(150);
	lb = label ? r.getElementBounds(label.id) : null;
}
check(!!lb && lb.height > 0, `the "${LABEL}" row is on screen (${lb ? `${lb.x.toFixed(0)},${lb.y.toFixed(0)}` : "missing"})`);
check(nativeNotes() === false, "the setting starts off");

// the switch on the same row: the settings rows put their control at the right; ZN_SWITCH_X gives its x (from a screenshot)
r.captureScreenshot(`${SHOTS}/native-note-setting-before.png`);
const sx = Number(process.env.ZN_SWITCH_X ?? 0);
const sy = Number(process.env.ZN_SWITCH_Y ?? 0);
const best = sx && lb ? { x: sx, y: sy || lb.y + lb.height / 2 } : null;
check(!!best, `clicking at the row's switch (${best ? `${best.x},${best.y.toFixed(0)}` : "set ZN_SWITCH_X"})`);
if (best) await h.click(best.x, best.y);
await h.settle(900);
r.captureScreenshot(`${SHOTS}/native-note-setting-after.png`);

check(nativeNotes() === true, "clicking the switch turns the setting on");
const saved = existsSync(STATE_FILE) ? readFileSync(STATE_FILE, "utf8") : "";
check(/"notes\.nativeView":\s*true/.test(saved), "the setting is saved to ui-state.json");

console.log(fails ? `${fails} check(s) failed` : "all checks passed");
process.exit(fails ? 1 : 0);
