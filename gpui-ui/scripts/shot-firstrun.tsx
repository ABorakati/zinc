// Headless screenshots of the first-run screen against a MOCK api (no library, no Zotero, no dialogs; nothing on disk is read or written):
//   bun scripts/shot-firstrun.tsx [out-dir] [light|dark]
// Writes <out-dir>/firstrun-{choose,no-zotero,importing,error}[-light].png. Default out-dir: C:/Users/abora/zn-ws/_tmp/firstrun.
// The preferences stay in memory (ZN_UI_STATE=off) so the real %APPDATA% is not touched.
process.env.ZN_UI_STATE = "off";
const args = process.argv.slice(2);
const outDir = args.find((a) => /[\\/]/.test(a)) ?? "C:/Users/abora/zn-ws/_tmp/firstrun";
const mode = args.includes("light") ? "light" : "dark";
const suffix = mode === "light" ? "-light" : "";

const { mkdirSync } = await import("node:fs");
const { createTestRoot } = await import("@gpuix/solid/testing");
const { registerFonts } = await import("../src/fonts");
const { applyAppearance, setThemePrefs } = await import("../src/shell/appearance");
const { FirstRun } = await import("../src/firstrun/FirstRun");
import type { FirstRunApi } from "../src/firstrun/FirstRun";
mkdirSync(outDir, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FOUND = {
	dir: "C:/Users/example/Zotero",
	hasDatabase: true,
	readable: true,
	itemCount: 12419,
	collectionCount: 310,
	attachmentCount: 9882,
};

async function shoot(
	name: string,
	api: Partial<FirstRunApi>,
	then?: (h: { click: (label: string) => Promise<void>; settle: () => Promise<void> }) => Promise<void>,
) {
	const t = createTestRoot({ width: 1400, height: 900 });
	setThemePrefs({ mode });
	const m = applyAppearance();
	registerFonts(t.renderer);
	const full: FirstRunApi = {
		defaultPath: "C:/Users/example/AppData/Roaming/zotero-next/library.sqlite",
		canPick: true,
		detectZotero: async () => FOUND,
		pickZoteroFolder: async () => null,
		importFromZotero: () => new Promise(() => {}),
		pickLibrary: async () => null,
		createEmpty: async () => "unused",
		done: () => {},
		...api,
	};
	t.render(() => <FirstRun api={full} mode={m} />);
	const settle = async () => {
		for (let i = 0; i < 4; i++) {
			t.renderer.flush();
			t.renderer.dispatchNativeEvents();
			await sleep(150);
		}
		t.renderer.flush();
	};
	const click = async (label: string) => {
		const el = t.renderer.findByText(label);
		const b = el ? t.renderer.getElementBounds(el.id) : null;
		if (!b) throw new Error(`no element with text "${label}"`);
		t.renderer.nativeSimulateClick(b.x + b.width / 2, b.y + b.height / 2, 0);
		await settle();
	};
	await sleep(600);
	await settle();
	await then?.({ click, settle });
	const file = `${outDir}/firstrun-${name}${suffix}.png`;
	t.renderer.captureScreenshot(file);
	console.log("wrote", file);
	t.unmount();
}

await shoot("choose", {});
await shoot("no-zotero", {
	detectZotero: async () => null,
	notice: "no library was found at D:/Backups/zotero-next/library.sqlite. Choose a library below; the missing file is left alone.",
});
await shoot(
	"importing",
	{
		importFromZotero: (_dir, onProgress) => {
			onProgress({ phase: "items", done: 5200, total: 12419 });
			return new Promise(() => {});
		},
	},
	async (h) => {
		await h.click("Import from Zotero");
		await sleep(300);
		await h.settle();
	},
);
await shoot(
	"error",
	{
		importFromZotero: async () => {
			throw new Error("Zotero has the database locked. Close Zotero to read it.");
		},
	},
	async (h) => {
		await h.click("Import from Zotero");
		await sleep(300);
		await h.settle();
	},
);
process.exit(0);
