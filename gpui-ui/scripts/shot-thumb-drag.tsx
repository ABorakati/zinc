// Drags the card list's scrollbar thumb in the headless renderer and checks the list followed: press the thumb at the top of the
// list's right edge, move halfway down, release; then click the track near the bottom. Prints the year group at the top after
// each step and writes screenshots. Needs a core on a library COPY (ZN_URL), as shot-app.tsx.
//   bun scripts/shot-thumb-drag.tsx [out-prefix]
import { SHOTS, boot, sleep } from "./shell-shot-lib";

const prefix = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? `${SHOTS}/thumb`;
const h = await boot({ prefs: { mode: "light" } });
type R = {
	findByTestId(id: string): { id: number } | undefined;
	getElementBounds(id: number): { x: number; y: number; width: number; height: number } | null;
	nativeSimulateMouseDown(x: number, y: number, button?: number): void;
	nativeSimulateMouseMove(x: number, y: number, pressedButton?: number): void;
	nativeSimulateMouseUp(x: number, y: number, button?: number): void;
	flush(): void; dispatchNativeEvents(): void; captureScreenshot(f: string): void;
};
const r = h.t.renderer as unknown as R;
await h.settle(600); // bounds exist once a frame has painted
const el = r.findByTestId("card-list");
if (!el) console.log("no element with testId card-list");
// a virtual list reports no bounds of its own: use its parent box (CardsView's root, same rect)
const lists = (r as unknown as { findByType(t: string): { id: number; parentId?: number; parent?: { id: number } }[] }).findByType("virtual-list");
const pick = lists.find((l) => l.id === el?.id) ?? lists[0];
const pid = pick?.parentId ?? pick?.parent?.id;
const b = (el && r.getElementBounds(el.id)) ?? (pid != null ? r.getElementBounds(pid) : null);
console.log("virtual lists", lists.length, "picked", pick?.id, "parent", pid);
if (!b) throw new Error("no card-list");
console.log("list bounds", b);
const x = b.x + b.width - 3; // on the 6 px thumb at the right edge
const tick = async (ms = 40) => { r.flush(); r.dispatchNativeEvents(); await sleep(ms); };
// record what the list reports as visible (CardList's onVisibleRange -> store.setVisible(firstItem, lastItem))
let vis: [number, number] | null = null;
const st = h.store as unknown as { setVisible(a: number, b: number): void };
const orig = st.setVisible.bind(st);
st.setVisible = (a: number, b: number) => { vis = [a, b]; orig(a, b); };

const before = vis;
console.log("visible before", before);
r.nativeSimulateMouseDown(x, b.y + 8, 0);
await tick();
const steps = 20, target = b.y + b.height / 2;
for (let i = 1; i <= steps; i++) { r.nativeSimulateMouseMove(x, b.y + 8 + ((target - b.y - 8) * i) / steps, 0); await tick(30); }
r.captureScreenshot(`${prefix}-mid-drag.png`);
r.nativeSimulateMouseUp(x, target, 0);
await tick(300);
console.log("visible after drag", vis);
r.captureScreenshot(`${prefix}-after-drag.png`);
// a press on the track near the bottom jumps there
r.nativeSimulateMouseDown(x, b.y + b.height - 20, 0);
await tick();
r.nativeSimulateMouseUp(x, b.y + b.height - 20, 0);
await tick(400);
console.log("visible after track click", vis);
r.captureScreenshot(`${prefix}-after-track.png`);
console.log("wrote", `${prefix}-*.png`);
process.exit(0);
