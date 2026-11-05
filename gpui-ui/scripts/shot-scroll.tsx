// Headless shots of the card list mid-scroll: the scrollbar thumb and the group popup (CardList.tsx) while the wheel is moving,
// then again after the popup has hidden. Needs a core on a library COPY (ZN_URL), as shot-app.tsx.
//   bun scripts/shot-scroll.tsx [out-prefix] [--px 30000] [--mode light|dark] [--view table]
import { SHOTS, boot, sleep } from "./shell-shot-lib";

const args = process.argv.slice(2);
const val = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const prefix = args.find((a) => !a.startsWith("--") && !/^\d+$/.test(a) && a !== val("--mode") && a !== val("--view")) ?? `${SHOTS}/scroll`;
const px = Number(val("--px") ?? 30000);
const h = await boot({ prefs: { mode: (val("--mode") as "light" | "dark" | undefined) ?? "light" } });
if (val("--view") === "table") { h.store.setViewMode("table"); await h.settle(800); } // the Classic table's popup (Table.tsx)
const r = h.t.renderer as unknown as { nativeSimulateScrollWheel(x: number, y: number, dx: number, dy: number): void; flush(): void; dispatchNativeEvents(): void; captureScreenshot(f: string): void };
const steps = 30;
for (let i = 0; i < steps; i++) { r.nativeSimulateScrollWheel(640, 500, 0, -px / steps); r.flush(); r.dispatchNativeEvents(); await sleep(16); }
await sleep(120); // past the popup's 60 ms throttle, well inside its 700 ms hide delay
r.flush(); r.dispatchNativeEvents(); r.flush();
r.captureScreenshot(`${prefix}-during.png`);
console.log("wrote", `${prefix}-during.png`);
await h.settle(1200);
r.captureScreenshot(`${prefix}-after.png`);
console.log("wrote", `${prefix}-after.png`);
process.exit(0);
