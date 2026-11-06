import Electrobun, { BrowserWindow, Utils } from "electrobun/main";
import { setBrowserBridge } from "../../../core/src/fulltext/browser-bridge";
import { createSigninBridge } from "./signin";
import { watchWindowMemory } from "./memory";
import { applyWindowIcon } from "./windowicon";
import { installMacMenu } from "./macmenu";
import { VIEWS_FOLDER } from "electrobun/main/paths";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveLibrary } from "../../../core/src/library-location";
import { setIntegrationsRepo } from "../../../core/src/integrations/api";
import { startServer } from "../../../core/src/server";
import { startZoteroPort } from "../../../core/src/zport";
import { configureExtractPool } from "../../../core/src/extract";
import { startSyncService, stopSync } from "../../../core/src/sync";
import { createZoteroBackends, findZoteroDataDir, isZoteroProcessRunning } from "../../../core/src/zotero-db";
import { configuredZoteroDataDir } from "../../../core/src/files/config";
import { setFolderPicker } from "../../../core/src/files/api";

// The core service (database, API, static UI and reader) runs inside the main
// process for now; Phase 2 moves it to a standalone background service.
const PORT = Number(process.env.ZN_PORT) || 23120; // 23119 is Zotero's own port; ZN_PORT overrides (tests)

// The UI and reader are copied into the app bundle (electrobun.config.ts `copy`).
// ZN_ROOT points at the repo instead, to serve fresh builds during development; so does the marker file
// data/live-dev in the repo, which lets the installed app pick up rebuilt UI/reader code (pages reload
// themselves when their build folder changes) without reinstalling. Delete the file to go back.
const REPO = process.env.ZN_REPO ?? join(homedir(), "zotero-next").replaceAll("\\", "/");
const ROOT = process.env.ZN_ROOT ?? (existsSync(`${REPO}/data/live-dev`) ? REPO : undefined);
const uiDir = ROOT ? `${ROOT}/ui/dist/` : join(VIEWS_FOLDER, "app") + "/";
const readerDir = ROOT ? `${ROOT}/reader-host/dist/` : join(VIEWS_FOLDER, "reader-host") + "/";
const noteDir = ROOT ? `${ROOT}/note-host/dist/` : join(VIEWS_FOLDER, "note-host") + "/";
const readerNextDir = ROOT ? `${ROOT}/reader-next/dist/` : join(VIEWS_FOLDER, "reader-next") + "/";

// Text extraction uses the document-worker build shipped with the reader, and the worker
// script copied next to the bundle (repo defaults apply under ZN_ROOT).
if (!ROOT) {
	configureExtractPool({
		buildDir: join(VIEWS_FOLDER, "reader-host", "document-worker"),
		workerEntry: join(import.meta.dir, "pdf-worker.ts"),
	});
}

// Library database: the shared rule (core/src/library-location.ts): ZN_DB / ZN_LIBRARY, the library path saved in
// %APPDATA%\zotero-next-gpui\library.json (the GPUI app and the Word add-in read it too), the legacy <home>\zotero-next\data
// library (adopted into that setting), this app's own data folder, else a new library at %APPDATA%\zotero-next\library.sqlite.
const library = resolveLibrary({ alsoLegacy: [join(Utils.paths.userData, "library.sqlite")] });
const dbPath = library.path ?? library.defaultPath;
mkdirSync(dirname(dbPath), { recursive: true }); // a new library's folder (openDb creates the file, not the folder)
if (existsSync(join(REPO, "word", "install.ps1"))) setIntegrationsRepo(REPO); // the Word / connector installers live in the checkout

const core = startServer({
	dbPath,
	port: PORT,
	mounts: [
		{ prefix: "/app/", dir: uiDir },
		{ prefix: "/reader-host/", dir: readerDir },
		{ prefix: "/note-host/", dir: noteDir },
		{ prefix: "/reader-next/", dir: readerNextDir },
	],
	devReload: !!ROOT,
});
if (ROOT) console.log(`[dev] serving UI and readers from ${ROOT} with live reload`);

// Zotero's port (23119) for the browser Connector and Word: taken only while Zotero itself isn't running,
// re-checked every 30 s so zotero-next steps in when Zotero quits. ZN_ZPORT overrides the port (tests); 0 disables.
const zport = process.env.ZN_ZPORT === "0" ? null : startZoteroPort(core.db, {
	port: Number(process.env.ZN_ZPORT) || undefined,
	retryMs: 30_000,
	onStart: (p) => console.log(`[zport] answering Zotero Connector / Word requests on ${p}`),
});
Electrobun.events.on("before-quit", () => zport?.stop());

// Two-way sync with the local Zotero library (reading is always on; writing is opt-in in the UI).
if (process.env.ZN_SYNC !== "0") {
	// Backends passed explicitly (a run-time lookup wouldn't survive bundling). Each write session
	// backs up zotero.sqlite (~180 MB); keep only the last 2 because disk space is tight.
	// Zotero data folder: ZN_ZOTERO_DIR, else the one chosen in Settings (zotero-next.config.json next to the library),
	// else what Zotero's own prefs say. The same folder feeds the backends and the sync service.
	const zoteroDir = configuredZoteroDataDir(dbPath) ?? findZoteroDataDir();
	const zotero = createZoteroBackends(zoteroDir, { keepBackups: 2 });
	void startSyncService(core.db, { dataDir: zoteroDir, ...zotero, isZoteroRunning: isZoteroProcessRunning }).catch((e) => console.warn("[sync] not started:", e));
	Electrobun.events.on("before-quit", () => void stopSync(core.db));
}

// Settings > Advanced > Files and Folders: "Browse..." opens the native folder dialog.
setFolderPicker(async (startIn) => {
	const picked = await Utils.openFileDialog({ startingFolder: startIn ?? "", canChooseFiles: false, canChooseDirectory: true, allowsMultipleSelection: false });
	const first = Array.isArray(picked) ? picked[0] : undefined;
	return first ? first : null;
});

// Embedded sign-in browser for Find Full Text (institution sign-in window + hidden page loader).
const signin = createSigninBridge();
setBrowserBridge(signin);
Electrobun.events.on("before-quit", () => signin.closeAll());
if (process.env.ZN_SIGNIN_SELFTEST === "1") {
	void import("./signin-selftest").then((m) => m.runSigninSelftest(signin));
}

installMacMenu();

const mainWindow = new BrowserWindow({
	title: "zotero-next",
	url: `http://127.0.0.1:${PORT}/app/`,
	frame: { width: 1400, height: 900, x: 80, y: 60 },
	hidden: process.env.ZN_HIDDEN === "1",
});
watchWindowMemory(mainWindow);
applyWindowIcon(join(VIEWS_FOLDER, "app-icon.ico"));
