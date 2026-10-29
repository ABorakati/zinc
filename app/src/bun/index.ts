import { BrowserWindow } from "electrobun/main";
import { startServer } from "../../../core/src/server";

// The core service (database, API, static UI and reader) runs inside the main
// process for now; Phase 2 moves it to a standalone background service.
const ROOT = process.env.ZN_ROOT ?? "C:/Users/abora/zotero-next";
const PORT = 23120; // 23119 is Zotero's own port

startServer({
	dbPath: process.env.ZN_DB ?? `${ROOT}/data/library.sqlite`,
	port: PORT,
	mounts: [
		{ prefix: "/app/", dir: `${ROOT}/ui/dist/` },
		{ prefix: "/reader-host/", dir: `${ROOT}/reader-host/dist/` },
	],
});

new BrowserWindow({
	title: "zotero-next",
	url: `http://127.0.0.1:${PORT}/app/`,
	frame: { width: 1400, height: 900, x: 80, y: 60 },
	hidden: process.env.ZN_HIDDEN === "1",
});
