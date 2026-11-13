// The data paths of the plain web page (src/platform.web.ts; the extension's library page has no use for this, so web/build.ts leaves
// the file out of that build):
//   page   the page's own library: startPageLibrary() (browser-db/page-library.ts) runs it in a worker the page starts, SQLite on OPFS
//   demo   (?demo) the demo library, in memory: SQLite WebAssembly and the core's handleApi in the tab. Nothing leaves the tab: the
//          library is an in-memory copy, settings go to an in-memory file system (shims/fs.ts). The files it fetches (library.sqlite,
//          collection-style.json, storage.json and storage/) sit next to the bundle (written by web/build.ts)
import { seedFile } from "./shims/fs";

export interface PageSource {
	transport: (req: Request) => Promise<Response>;
	/** Something other than this page wrote to the library (page only). */
	onChanged?(cb: () => void): void;
	/** Demo only: the stored attachments' paths (<key>/<file>) and the core's own handler, for the automated checks. */
	demo?: { stored: string[]; handle: (req: Request) => Promise<Response | null> };
}

const here = (f: string) => new URL(f, import.meta.url).href;
const bytes = async (f: string) => new Uint8Array(await (await fetch(here(f))).arrayBuffer());

export async function openPageSource(kind: "page" | "demo"): Promise<PageSource> {
	if (kind === "page") {
		const lib = await import("./browser-db/page-library").then((m) => m.startPageLibrary());
		return { transport: lib.transport, onChanged: (cb) => lib.onChanged(cb) };
	}
	// the demo library and the files the app reads from disk (the collections' colours and icons), fetched before any app module asks for them
	const [lib, styles, stored] = await Promise.all([
		bytes("library.sqlite"),
		fetch(here("collection-style.json")).then((r) => (r.ok ? r.text() : "")),
		fetch(here("storage.json")).then((r) => (r.ok ? (r.json() as Promise<string[]>) : [])),
	]);
	// the library's stored attachments (the demo article's PDF), where the core looks for them: <library folder>/storage/<key>/<file>
	await Promise.all(stored.map(async (rel) => seedFile(`/demo/storage/${rel}`, await bytes(`storage/${rel.split("/").map(encodeURIComponent).join("/")}`))));
	if (styles) seedFile("/appdata/zotero-next-gpui/collection-style.json", styles, true);
	const { initSqlite, registerDatabase, Database } = await import("./sqlite");
	await initSqlite();
	registerDatabase("/demo/library.sqlite", lib);
	// (ZN_DB stays unset: on the desktop it makes src/core.ts start a loopback server; here the core is plugged in with setDirect)
	const db = new Database("/demo/library.sqlite");
	const { handleApi } = await import("../../core/src/api");
	const handle = (req: Request) => handleApi(req, db as never);
	return { transport: async (req) => (await handle(req)) ?? new Response('{"error":"not found"}', { status: 404 }), demo: { stored, handle } };
}
