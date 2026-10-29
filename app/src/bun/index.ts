import { BrowserWindow, Utils } from "electrobun/main";
import { VIEWS_FOLDER } from "electrobun/main/paths";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../../../core/src/server";

// The core service (database, API, static UI and reader) runs inside the main
// process for now; Phase 2 moves it to a standalone background service.
const PORT = 23120; // 23119 is Zotero's own port

// The UI and reader are copied into the app bundle (electrobun.config.ts `copy`).
// ZN_ROOT points at the repo instead, to serve fresh builds during development.
const ROOT = process.env.ZN_ROOT;
const uiDir = ROOT ? `${ROOT}/ui/dist/` : join(VIEWS_FOLDER, "app") + "/";
const readerDir = ROOT ? `${ROOT}/reader-host/dist/` : join(VIEWS_FOLDER, "reader-host") + "/";

// Library database: ZN_DB, else the library imported into the repo, else the
// app's own data folder (an empty library).
const REPO_DB = "C:/Users/abora/zotero-next/data/library.sqlite";
const dbPath = process.env.ZN_DB ?? (existsSync(REPO_DB) ? REPO_DB : join(Utils.paths.userData, "library.sqlite"));

startServer({
	dbPath,
	port: PORT,
	mounts: [
		{ prefix: "/app/", dir: uiDir },
		{ prefix: "/reader-host/", dir: readerDir },
	],
});

new BrowserWindow({
	title: "zotero-next",
	url: `http://127.0.0.1:${PORT}/app/`,
	frame: { width: 1400, height: 900, x: 80, y: 60 },
	hidden: process.env.ZN_HIDDEN === "1",
});
