// Live development with the installed app: `bun live.ts`
// Creates data/live-dev (so the app serves ui/dist and reader-next/dist from this repo, with live reload) and
// rebuilds the UI and the new PDF reader on every save. Restart the app once after the first run.
// `bun live.ts off` removes the marker; the app then uses its own bundled copy again (after a restart).
import { existsSync, rmSync, writeFileSync } from "node:fs";

const marker = `${import.meta.dir}/data/live-dev`;
if (process.argv[2] === "off") {
	rmSync(marker, { force: true });
	console.log("live mode off: restart Zotero Next to use its bundled UI and reader again");
	process.exit(0);
}
if (!existsSync(marker)) {
	writeFileSync(marker, "Zotero Next serves ui/dist and reader-next/dist from this repo while this file exists (see live.ts).\n");
	console.log("live mode on: restart Zotero Next once so it picks this up");
}

const watchers = ["ui", "reader-next"].map((dir) =>
	Bun.spawn(["bun", "--bun", "x", "vite", "build", "--watch"], { cwd: `${import.meta.dir}/${dir}`, stdout: "inherit", stderr: "inherit" }));
console.log("watching ui/ and reader-next/: save a file, and the open window or reader tab reloads after the rebuild");
process.on("SIGINT", () => { for (const w of watchers) w.kill(); process.exit(0); });
await Promise.all(watchers.map((w) => w.exited));
