import Electrobun, { BrowserWindow, Utils } from "electrobun/main";
import { setBrowserBridge } from "../../../core/src/fulltext/browser-bridge";
import { createSigninBridge } from "./signin";
import { VIEWS_FOLDER } from "electrobun/main/paths";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../../../core/src/server";
import { configureExtractPool } from "../../../core/src/extract";
import { startSyncService, stopSync } from "../../../core/src/sync";
import { createZoteroBackends } from "../../../core/src/zotero-db";

// The core service (database, API, static UI and reader) runs inside the main
// process for now; Phase 2 moves it to a standalone background service.
const PORT = Number(process.env.ZN_PORT) || 23120; // 23119 is Zotero's own port; ZN_PORT overrides (tests)

// The UI and reader are copied into the app bundle (electrobun.config.ts `copy`).
// ZN_ROOT points at the repo instead, to serve fresh builds during development; so does the marker file
// data/live-dev in the repo, which lets the installed app pick up rebuilt UI/reader code (pages reload
// themselves when their build folder changes) without reinstalling. Delete the file to go back.
const REPO = "C:/Users/abora/zotero-next";
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

// Library database: ZN_DB, else the library imported into the repo, else the
// app's own data folder (an empty library).
const REPO_DB = `${REPO}/data/library.sqlite`;
const dbPath = process.env.ZN_DB ?? (existsSync(REPO_DB) ? REPO_DB : join(Utils.paths.userData, "library.sqlite"));

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

// Two-way sync with the local Zotero library (reading is always on; writing is opt-in in the UI).
if (process.env.ZN_SYNC !== "0") {
	// Backends passed explicitly (a run-time lookup wouldn't survive bundling). Each write session
	// backs up zotero.sqlite (~180 MB); keep only the last 2 because disk space is tight.
	const zotero = createZoteroBackends(process.env.ZN_ZOTERO_DIR, { keepBackups: 2 });
	void startSyncService(core.db, { dataDir: process.env.ZN_ZOTERO_DIR, ...zotero }).catch((e) => console.warn("[sync] not started:", e));
	Electrobun.events.on("before-quit", () => void stopSync(core.db));
}

// Embedded sign-in browser for Find Full Text (institution sign-in window + hidden page loader).
const signin = createSigninBridge();
setBrowserBridge(signin);
Electrobun.events.on("before-quit", () => signin.closeAll());
if (process.env.ZN_SIGNIN_SELFTEST === "1") {
	void import("./signin-selftest").then((m) => m.runSigninSelftest(signin));
}

new BrowserWindow({
	title: "zotero-next",
	url: `http://127.0.0.1:${PORT}/app/`,
	frame: { width: 1400, height: 900, x: 80, y: 60 },
	hidden: process.env.ZN_HIDDEN === "1",
});
