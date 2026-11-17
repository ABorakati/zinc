// Does a packaged Zinc start? `bun scripts/start-check.ts <package dir> [--seconds 60]` (any OS; needs a display, like the app).
//
// Starts <package dir>/zotero-next-gpui(.exe) on a throwaway library (three items, its own APPDATA / XDG folders, its own port, no
// sync, no Zotero port, no sign-in) and waits for the app's "[zn-t] first-items" start-up mark (src/trace.ts: the first page of items
// is in the store). Exit 0 when it comes, 1 when the app exits or the time runs out first. The window is closed afterwards.
// desktop-packages.yml runs it on the AOT build before it ships it, and falls back to the bytecode build when it fails: a build
// that compiles can still crash at start (on Linux, Bun's AOT runtime denies write+execute memory, which software Vulkan needs).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb } from "../../core/src/db";
import { rebuildSearchIndex } from "../../core/src/search";
import { insertItem } from "../../core/test/fixture";

const pkg = resolve(process.argv[2] ?? join(import.meta.dir, "..", "out", "package-aot", "zotero-next-gpui"));
const i = process.argv.indexOf("--seconds");
const seconds = i > 0 ? Number(process.argv[i + 1]) : 60;
const exe = join(pkg, process.platform === "win32" ? "zotero-next-gpui.exe" : "zotero-next-gpui");

const root = mkdtempSync(join(tmpdir(), "zn-start-check-"));
const dbPath = join(root, "library.sqlite");
{
	const db = openDb(dbPath);
	for (const [key, title] of [
		["CHECK001", "Machine perfusion in liver transplantation"],
		["CHECK002", "Outcomes after kidney transplantation in older recipients"],
		["CHECK003", "Deep learning in clinical research"],
	] as const)
		insertItem(db, {
			key,
			itemType: "journalArticle",
			title,
			creators: [{ creatorType: "author", firstName: "A", lastName: "Check" }],
			date: "2024",
		} as never);
	rebuildSearchIndex(db);
	db.close();
}

const app = Bun.spawn([exe], {
	env: {
		...process.env,
		APPDATA: join(root, "appdata"),
		XDG_CONFIG_HOME: join(root, "config"),
		XDG_DATA_HOME: join(root, "data"),
		XDG_CACHE_HOME: join(root, "cache"),
		ZN_DB: dbPath,
		ZN_PORT: process.env.ZN_PORT ?? "23193",
		ZN_SYNC: "0",
		ZN_ZPORT: "0",
		ZN_SIGNIN: "0",
		ZN_TRACE: "1",
	},
	stdout: "pipe",
	stderr: "inherit",
});

const t0 = performance.now();
let firstItems: number | null = null;
const reader = (async () => {
	const dec = new TextDecoder();
	let buf = "";
	for await (const chunk of app.stdout) {
		buf += dec.decode(chunk);
		let n: number;
		while ((n = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, n);
			buf = buf.slice(n + 1);
			console.log(line);
			const m = /^\[zn-t\] first-items (\d+)/.exec(line);
			if (m) firstItems = Number(m[1]);
		}
	}
})();
while (firstItems === null && app.exitCode === null && performance.now() - t0 < seconds * 1000) await Bun.sleep(50);
const exited = app.exitCode;
app.kill();
await app.exited;
await reader.catch(() => {});
rmSync(root, { recursive: true, force: true });

if (firstItems !== null) {
	console.log(`start-check: ok, first items after ${firstItems} ms (${exe})`);
	process.exit(0);
}
console.error(
	exited !== null
		? `start-check: FAILED, the app exited (code ${exited}) before its first items (${exe})`
		: `start-check: FAILED, no first items within ${seconds} s (${exe})`,
);
process.exit(1);
