// Headless screenshots of the registry features' dialogs and panels (no window opens, nothing is written to the library):
//   bun scripts/shot-features.tsx [outDir] [light|dark] [name ...]
// Writes <outDir>/features-<name>.png for: identifier newitem linkuri export bibliography citesettings duplicates shortcuts
// references fulltextsettings panels settings (all by default). Needs the core API of ZN_URL (default http://127.0.0.1:23160).
import { createTestRoot } from "@gpuix/solid/testing";
import { mkdirSync } from "node:fs";
import { openDialog, OverlayHost, toast } from "../src/ui";
import { overlayLayers } from "../src/ui/core";
import { registerFonts } from "../src/fonts";
import { store } from "../src/store";
import { tw } from "../src/theme";
import { settingsSections } from "../src/registry";
import { register } from "../src/features/index";
import { openIdentifierDialog, openLinkUriDialog, openNewItemDialog } from "../src/features/additems/dialogs";
import { _seedRetrieveRows } from "../src/features/additems/client";
import { RetrievePanel } from "../src/features/additems/RetrievePanel";
import { openBibliography, openCiteSettings } from "../src/features/cite/dialogs";
import { openDuplicates } from "../src/features/duplicates/DuplicatesDialog";
import { _seedJobs } from "../src/features/fulltext/jobs";
import { FullTextProgress } from "../src/features/fulltext/Progress";
import { openFullTextSettings } from "../src/features/fulltext/settings";
import { openExportDialog } from "../src/features/io/dialogs";
import { openMendeleyImport } from "../src/features/io/mendeley";
import { showShortcutHelp } from "../src/features/maintenance/shortcutHelp";
import { ReferencesPanel } from "../src/features/references/ReferencesPanel";

const args = process.argv.slice(2);
const outDir =
	args.find((a) => /[\\/]/.test(a)) ??
	"C:/Users/abora/AppData/Local/Temp/claude/C--Users-abora-Hecate/0719cea7-1eb3-4344-a1e4-a862c3bde6eb/scratchpad/gpui-shots";
const mode = args.includes("light") ? "light" : "dark";
const only = args.filter((a) => !/[\\/]/.test(a) && a !== "light" && a !== "dark");
mkdirSync(outDir, { recursive: true });

register(); // the same registrations the app makes (settings sections, overlays, actions)
store.setMode(mode);
const t = createTestRoot({ width: 1400, height: 900 });
registerFonts(t.renderer);
const r = t.renderer;
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const frames = async (ms: number) => {
	const t0 = performance.now();
	while (performance.now() - t0 < ms) {
		r.flush();
		r.dispatchNativeEvents();
		r.flush();
		await sleep(16);
	}
};

t.render(() => (
	<div style={{ ...tw("flex flex-col bg-canvas", store.mode()), position: "relative", width: "100%", height: "100%" }}>
		<RetrievePanel />
		<FullTextProgress />
		<OverlayHost />
	</div>
));

for (let i = 0; i < 100 && store.total() === 0; i++) await sleep(100);
await frames(600);
const keys: string[] = [];
for (let i = 0; i < 30 && keys.length < 3; i++) {
	const it = store.itemAt(i);
	if (it && it.itemType !== "attachment" && it.itemType !== "note") keys.push(it.key);
	else if (!it) await frames(100);
}
console.log("sample items:", keys.join(","));

const closeAll = () => {
	for (const l of overlayLayers()) (l as unknown as { close?: (v?: unknown) => void }).close?.(undefined);
};
let failed = 0;
async function shot(name: string, open: () => unknown, wait = 1500) {
	if (only.length && !only.includes(name)) return;
	try {
		void open();
		await frames(wait);
		const out = `${outDir}/features-${name}${mode === "light" ? "-light" : ""}.png`;
		r.captureScreenshot(out);
		console.log("wrote", out);
	} catch (e) {
		failed++;
		console.error("FAIL", name, e instanceof Error ? e.message : e);
	}
	closeAll();
	await frames(200);
}

await shot("identifier", () => openIdentifierDialog("10.1136/bmj-2023-078378\n31452104\narXiv:1706.03762"), 800);
await shot("newitem", () => openNewItemDialog(), 1500);
await shot("linkuri", () => openLinkUriDialog(), 600);
await shot("export", () => openExportDialog({ kind: "items", keys }), 600);
await shot("mendeley", () => openMendeleyImport(), 1500);
await shot("bibliography", () => openBibliography("3 selected items", keys), 3500);
await shot("citesettings", () => openCiteSettings(keys), 4000);
await shot("duplicates", () => openDuplicates(), 6000);
await shot("shortcuts", () => showShortcutHelp(), 600);
await shot(
	"references",
	() =>
		openDialog<void>(() => <ReferencesPanel itemKey={keys[1]!} height={560} focus={{ index: 2 }} />, {
			title: "References",
			width: 600,
		}),
	7000,
);
await shot("fulltextsettings", () => openFullTextSettings(), 2500);
await shot(
	"panels",
	() => {
		_seedRetrieveRows([
			{ key: "A", title: "smith-2021-trial.pdf", state: "retrieved" },
			{ key: "B", title: "scan0042.pdf", state: "failed", message: "Not found" },
			{ key: "C", title: "lancet-review.pdf", state: "running" },
			{ key: "D", title: "guidelines.pdf", state: "queued" },
		]);
		_seedJobs([
			{
				openAccessOnly: false,
				cancelling: false,
				startedAt: Date.now(),
				job: {
					id: "demo",
					done: false,
					items: [
						{ key: "K1", title: "Surgical outcomes after pancreatoduodenectomy", state: "attached", source: "Unpaywall" },
						{
							key: "K2",
							title: "A randomised trial of early feeding",
							state: "needs-sign-in",
							source: "KCL OpenAthens",
							handoffUrl: "https://doi.org/10.1000/x",
						},
						{ key: "K3", title: "Registry-based cohort study of sepsis", state: "downloading", source: "Europe PMC" },
						{ key: "K4", title: "Machine learning in perioperative care", state: "not-found" },
					],
				},
			},
		]);
		toast("Bibliography copied (3 items, vancouver)", { kind: "success" });
	},
	800,
);
// the three settings sections the features contribute
for (const id of ["cite", "export", "fulltext"]) {
	await shot(
		`settings-${id}`,
		() => {
			const s = settingsSections().find((x) => x.id === id)!;
			_seedRetrieveRows([]);
			_seedJobs([]);
			return openDialog<void>(() => s.render(), { title: `Settings > ${s.label}`, width: 760 });
		},
		2500,
	);
}
console.log(failed ? `${failed} failed` : "done");
t.unmount();
process.exit(failed ? 1 : 0);
