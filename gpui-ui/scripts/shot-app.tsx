// Headless screenshot of <App/> once the first page of items has loaded.
import { createTestRoot } from "@gpuix/solid/testing";
import { App } from "../src/App";
import { registerFonts } from "../src/fonts";
import { store } from "../src/store";

const out = process.argv[2] ?? "C:/Users/abora/AppData/Local/Temp/claude/C--Users-abora-Hecate/0719cea7-1eb3-4344-a1e4-a862c3bde6eb/scratchpad/gpui-shots/app.png";
const t = createTestRoot({ width: 1400, height: 900 });
registerFonts(t.renderer);
t.render(() => <App />);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 100 && store.total() === 0; i++) await sleep(100);
await sleep(600); // pages + collections settle
t.renderer.flush();
await sleep(200);
t.renderer.flush();
t.renderer.captureScreenshot(out);
console.log("wrote", out, "total", store.total(), "collections", store.collections().length);
t.unmount();
process.exit(0);
