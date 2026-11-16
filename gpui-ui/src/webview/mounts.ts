// Static mounts the in-process core serves for the web tabs, as the Electrobun app's main process does (app/src/bun/index.ts):
//   /reader-host/  Zotero's web reader (snapshots, EPUBs)      reader-host/dist
//   /note-host/    the note editor page                        note-host/dist
// Unpackaged: the repo's builds (../../reader-host/dist). Packaged: next to the exe (scripts/package.ts copies them). ZN_READER_HOST /
// ZN_NOTE_HOST override. A mount whose folder (or index.html) is missing is left out, which turns web tabs off (config.ts).
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { packaged } from "../packaged";

export interface Mount {
	prefix: string;
	dir: string;
}

const here = import.meta.dir; // gpui-ui/src/webview (the exe build rewrites this to the embedded repo-relative location, which is not on disk)
const root = (): string => (packaged ? dirname(process.execPath) : resolve(here, "..", "..", ".."));

function dir(env: string, name: string, index: string): string | null {
	const cands = [process.env[env], packaged ? join(root(), name, "dist") : null, join(resolve(here, "..", "..", ".."), name, "dist")];
	for (const c of cands) if (c && existsSync(join(c, index))) return c;
	return null;
}

export function webMounts(): Mount[] {
	const out: Mount[] = [];
	const reader = dir("ZN_READER_HOST", "reader-host", "index.html");
	if (reader) out.push({ prefix: "/reader-host/", dir: reader + "/" });
	const note = dir("ZN_NOTE_HOST", "note-host", "editor.html");
	if (note) out.push({ prefix: "/note-host/", dir: note + "/" });
	return out;
}
