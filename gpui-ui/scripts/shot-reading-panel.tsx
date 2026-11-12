// Headless screenshots of the reading view's "Aa" panel (reader/reflow/SettingsPanel.tsx), no window and no library:
//   bun scripts/shot-reading-panel.tsx [outDir]
// Shots: panel-light.png (Literata chosen), panel-dark.png (dark theme), panel-custom.png (custom font, installed fonts listed).
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createSignal } from "solid-js";
import { createTestRoot } from "@gpuix/solid/testing";
import { registerFonts } from "../src/fonts";
import { installedFonts } from "../src/shell/installedFonts";
import { makeChip, SettingsPanel } from "../src/reader/reflow/SettingsPanel";
import { DEFAULT_SETTINGS, palette, type ReadingSettings } from "../src/reader/reflow/settings";

const out = resolve(process.argv[2] ?? "panel-out");
mkdirSync(out, { recursive: true });
await installedFonts(); // so the custom shot lists them

async function shot(name: string, start: Partial<ReadingSettings>) {
	const t = createTestRoot({ width: 1120, height: 330 });
	const r = t.renderer;
	registerFonts(r);
	const [st, setSt] = createSignal<ReadingSettings>({ ...DEFAULT_SETTINGS, ...start });
	const pal = () => palette(st());
	t.render(() => (
		<div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", backgroundColor: pal().bg }}>
			<SettingsPanel pal={pal} settings={st} setSettings={(p) => setSt({ ...st(), ...p })} reset={() => setSt({ ...DEFAULT_SETTINGS })} Chip={makeChip(pal)} />
			<div style={{ padding: 24, maxWidth: 680 }}>
				<text style={{ color: pal().fg, fontFamily: "Inter", fontSize: 15 }}>(reading text below the panel)</text>
			</div>
		</div>
	));
	const t0 = performance.now();
	while (performance.now() - t0 < 1200) { r.flush(); r.dispatchNativeEvents(); r.flush(); await Bun.sleep(16); }
	const file = join(out, `${name}.png`);
	r.captureScreenshot(file);
	console.log("shot", file);
}

await shot("panel-light", { font: "literata" });
await shot("panel-dark", { theme: "dark", font: "system" });
await shot("panel-custom", { theme: "sepia", font: "custom", customFont: "Cascadia Code" });
process.exit(0);
