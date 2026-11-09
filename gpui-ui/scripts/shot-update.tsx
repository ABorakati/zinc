// Headless screenshots of the auto-update UI: Settings > System > Updates in each state, the update toast and the "What's new" dialog.
//   bun scripts/shot-update.tsx [dark|light]      files: <SHOTS>/shell-update-<scene>[-light].png  (ZN_SHOTS overrides the folder)
// No network: the updater runs on an in-memory fake env and a freshly generated test key; ZN_UI_STATE is a throw-away file (_shell-env.ts).
// Scenes: idle, available (+ toast), whatsnew (dialog), downloading, ready.
import { SHOTS, boot, sleep } from "./shell-shot-lib";
import { createHash } from "node:crypto";
import { Show } from "solid-js";
import { generateKeyPair, signManifest } from "../../core/src/update/manifest";
import type { UpdateEnv } from "../../core/src/update/updater";
import { gotoSection, SettingsPage } from "../src/settings";
import { setSettingsQuery, settingsShown } from "../src/settings/registry";
import { openSettings } from "../src/shell/layout";
import { store } from "../src/store";
import { textStyle, tw } from "../src/theme";
import { TopBar } from "../src/TopBar";
import { OverlayHost, toast } from "../src/ui";
import { initUpdates, setUpdateFeed, showWhatsNew, updateModel } from "../src/update/service";

const mode = process.argv.includes("light") ? "light" : "dark";
const suffix = mode === "light" ? "-light" : "";

// ---- a fake feed: signed manifest, in-memory "installer", a download that waits at 40 % until released
const kp = await generateKeyPair();
const installer = new Uint8Array(3_000_000).map((_, i) => (i * 31) % 251);
const manifest = await signManifest({
	version: "0.2.0+1a2b3c4d-20261201", releasedAt: "2026-12-01T09:00:00Z", url: "https://updates.example.org/Zinc-Setup-0.2.0-1a2b3c4d-20261201.exe",
	sha256: createHash("sha256").update(installer).digest("hex"), size: installer.length,
	notes: "# Zinc 0.2.0\n\n- Automatic updates: signed, verified, installed when you choose\n- Faster start-up with large libraries\n- The reader remembers your zoom per document\n\n## Fixes\n\n- Duplicate detection no longer stalls on very large libraries\n- Word add-in reconnects after Word restarts",
}, kp.privateJwk);
const files = new Map<string, Uint8Array>();
let release!: () => void;
const gate = new Promise<void>((r) => { release = r; });
const env: UpdateEnv = {
	updatesDir: "C:/shot/updates", pid: 1,
	async fetchText() { return JSON.stringify(manifest); },
	async download(_url, dest, { onProgress }) {
		onProgress(installer.length * 0.4, installer.length);
		await gate;
		files.set(dest, installer);
		onProgress(installer.length, installer.length);
	},
	async fileSize(p) { return files.get(p)?.length ?? null; },
	async sha256(p) { return createHash("sha256").update(files.get(p)!).digest("hex"); },
	async rename(a, b) { files.set(b, files.get(a)!); files.delete(a); },
	async remove(p) { files.delete(p); },
	async list() { return []; },
	runInstaller() {},
	exit() {},
};

const h = await boot({
	prefs: { mode },
	view: () => (
		<div style={{ ...tw("flex flex-col bg-canvas", store.mode()), width: "100%", height: "100%" }}>
			<TopBar />
			<div style={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0, width: "100%", backgroundColor: "transparent" }}>
				<Show when={store.activeTab() === "settings"} fallback={<text style={textStyle("text-foreground", store.mode())}>library tab</text>}>
					<SettingsPage active />
				</Show>
			</div>
			<OverlayHost />
		</div>
	),
});
setUpdateFeed("https://updates.example.org/latest.json");
initUpdates({ currentVersion: "0.1.0+b7cd9fc4-20261106", publicKey: kp.publicKey, env });
openSettings();
settingsShown();
setSettingsQuery("");
gotoSection("system");
await h.settle(1200);
const shot = (name: string) => h.shot(`update-${name}${suffix}`);

await shot("idle");

await h.clickText("Check now");
await sleep(400);
await h.settle(600);
console.log("state after Check now:", updateModel().state.kind);
await shot("available"); // the toast is bottom-right

toast.dismiss();
showWhatsNew();
await h.settle(800);
await shot("whatsnew");
// close the dialog: Later
await h.clickText("Later");
await h.settle(400);

toast.dismiss();
void (async () => { await h.clickText("Install on exit"); })(); // starts the download (installOnExit) and stays at 40 % until released
await sleep(500);
await h.settle(600);
console.log("state while downloading:", updateModel().state.kind);
toast.dismiss();
await h.settle(300);
await shot("downloading");

release();
await sleep(600);
await h.settle(600);
console.log("state after download:", updateModel().state.kind);
toast.dismiss();
await h.settle(300);
await shot("ready");

// the whole Updates group at once: filter the System page by "update" (every row of the group has that keyword)
setSettingsQuery("update");
await h.settle(600);
await shot("all-rows");

h.t.unmount();
console.log("wrote screenshots to", SHOTS);
process.exit(0);
