import { createTestRoot, hasNativeTestRenderer } from "@gpuix/solid/testing";
import { Hello } from "../src/hello";
console.log("native test renderer:", hasNativeTestRenderer);
const t = createTestRoot({ width: 400, height: 200 });
t.render(() => <Hello />);
const out = process.argv[2] ?? "hello.png";
t.renderer.captureScreenshot(out);
console.log("wrote", out);
t.unmount();
