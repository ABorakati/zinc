// The data path of the plain web page (src/platform.web.ts; the extension's library page has no use for this, so web/build.ts leaves the
// file out of that build): the demo library, in memory and read-only. The page is a showcase: SQLite WebAssembly and the core's handleApi
// in the tab, nothing saved, no sync. Nothing leaves the tab: the library is an in-memory copy, settings go to an in-memory file system
// (shims/fs.ts). The files it fetches (library.sqlite, collection-style.json, storage.json and storage/) sit next to the bundle (written by
// web/build.ts). To keep a library, install the Zinc Connector.
import { seedFile } from "./shims/fs";

export const READ_ONLY_MESSAGE = "This is a read-only demo. Install the Zinc Connector to keep a library.";

export interface DemoSource {
	transport: (req: Request) => Promise<Response>;
	/** The stored attachments' paths (<key>/<file>) and the core's own handler, for the automated checks. */
	stored: string[];
	handle: (req: Request) => Promise<Response | null>;
}

const here = (f: string) => new URL(f, import.meta.url).href;
const bytes = async (f: string) => new Uint8Array(await (await fetch(here(f))).arrayBuffer());

/**
 * Reads only: any request but GET and HEAD answers 403 with READ_ONLY_MESSAGE. The exception is POST /api/ui/selection, which is view
 * state (what is selected), not library data. The library list tells the app that My Library cannot be edited (the same flag a
 * group library without edit rights has), so the app hides its edit actions instead of letting them fail.
 */
export function readOnly(handle: (req: Request) => Promise<Response | null>): (req: Request) => Promise<Response> {
	return async (req) => {
		const path = new URL(req.url).pathname;
		if (req.method !== "GET" && req.method !== "HEAD" && !(req.method === "POST" && path === "/api/ui/selection")) {
			return Response.json({ error: READ_ONLY_MESSAGE }, { status: 403 });
		}
		const res = (await handle(req)) ?? new Response('{"error":"not found"}', { status: 404 });
		if (req.method === "GET" && path === "/api/libraries" && res.ok) {
			const body = (await res.json()) as { libraries: { id: number; editable?: boolean; filesEditable?: boolean }[] };
			return Response.json({
				...body,
				libraries: body.libraries.map((l) => (l.id === 1 ? { ...l, editable: false, filesEditable: false } : l)),
			});
		}
		return res;
	};
}

export async function openDemoSource(): Promise<DemoSource> {
	// the demo library and the files the app reads from disk (the collections' colours and icons), fetched before any app module asks for them
	const [lib, styles, stored] = await Promise.all([
		bytes("library.sqlite"),
		fetch(here("collection-style.json")).then((r) => (r.ok ? r.text() : "")),
		fetch(here("storage.json")).then((r) => (r.ok ? (r.json() as Promise<string[]>) : [])),
	]);
	// the library's stored attachments (the demo article's PDF), where the core looks for them: <library folder>/storage/<key>/<file>
	await Promise.all(
		stored.map(async (rel) =>
			seedFile(`/demo/storage/${rel}`, await bytes(`storage/${rel.split("/").map(encodeURIComponent).join("/")}`)),
		),
	);
	if (styles) seedFile("/appdata/zotero-next-gpui/collection-style.json", styles, true);
	const { initSqlite, registerDatabase, Database } = await import("./sqlite");
	await initSqlite();
	registerDatabase("/demo/library.sqlite", lib);
	// (ZN_DB stays unset: on the desktop it makes src/core.ts start a loopback server; here the core is plugged in with setDirect)
	const db = new Database("/demo/library.sqlite");
	const { handleApi } = await import("../../core/src/api");
	const handle = (req: Request) => handleApi(req, db as never);
	return { transport: readOnly(handle), stored, handle };
}
