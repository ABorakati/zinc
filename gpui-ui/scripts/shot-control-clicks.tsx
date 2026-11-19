// Headless check (no window, no core): a click on the painted box of a Checkbox and on the track of a Switch toggles them.
// GPUIX lets a filled element take a click itself, so the inner box / track / thumb carry pointerEvents "none" (src/ui/controls.tsx).
//   bun scripts/shot-control-clicks.tsx     (exit code 1 when a check fails; macOS and Windows only, like every shot script)
import { boot } from "./shell-shot-lib";
import { createSignal } from "solid-js";
import { Checkbox, Switch } from "../src/ui";

const [cb, setCb] = createSignal(false);
const [sw, setSw] = createSignal(false);
const h = await boot({
	view: () => (
		<div style={{ display: "flex", flexDirection: "column", gap: 20, padding: 40, width: "100%", height: "100%" }}>
			<Checkbox checked={cb()} onChange={setCb} label="check me" />
			<Switch checked={sw()} onChange={setSw} />
		</div>
	),
});
await h.settle(400);
const r = h.t.renderer;
const lab = r.getElementBounds(r.findByText("check me")!.id)!;
const box = { x: lab.x - 16, y: lab.y + lab.height / 2 }; // the 16px box sits 8px left of its label
const swPt = { x: 40 + 16, y: lab.y + lab.height + 20 + 9 }; // the 32x18 track one gap below
console.log("under box:", r.getElementsAt(box.x, box.y).length, "under switch:", r.getElementsAt(swPt.x, swPt.y).length);
await h.click(box.x, box.y);
await h.click(swPt.x, swPt.y);
await h.settle(300);
console.log("checkbox after one click:", cb(), "| switch after one click:", sw());
await h.click(box.x, box.y);
await h.settle(300);
console.log("checkbox after two clicks:", cb());
process.exit(cb() === false && sw() === true ? 0 : 1);
