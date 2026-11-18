import { createTestRoot } from "@gpuix/solid/testing";
import { registerFonts } from "../src/fonts";
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80" viewBox="0 0 200 80"><rect width="200" height="80" fill="#fff"/><text x="10" y="30" font-family="Inter" font-size="16" fill="#c0532e">Hello canvas</text><text x="190" y="60" font-family="sans-serif" font-size="14" text-anchor="end" fill="#2b5fa8">anchor end</text></svg>`;
const t = createTestRoot({ width: 400, height: 300 });
(registerFonts as (r?: unknown) => void)(t.renderer);
t.render(() => (
	<div style={{ display: "flex", flexDirection: "row", gap: 10, padding: 10, backgroundColor: "#ffffff" }}>
		<img src={"data:image/svg+xml;base64," + Buffer.from(svg).toString("base64")} style={{ width: 200, height: 80 }} />
	</div>
));
for (let i = 0; i < 5; i++) { t.renderer.flush(); await Bun.sleep(40); }
t.renderer.captureScreenshot(process.argv[2]);
t.unmount();
console.log("ok");
