// Server-side smoke test for reader-host/dist (run: bun reader-host/test/smoke.ts [--serve]).
// Starts the mock API, checks that every asset the page needs is served with a sane MIME type,
// and exercises the annotation / view-state routes. With --serve it keeps the mock running so
// a browser can open http://127.0.0.1:23122/reader-host/index.html?attachment=TEST
//
// Browser-level checks (rendering, Reading Mode, highlight round-trip) were done in the Browser pane:
//   window.__readerReady === true                       // first page rendered
//   window._reader._setReadingMode(true, true)          // Reading Mode; window.__sdtFromCache tells cache hit
//   window._reader._annotationManager.addAnnotation({type:'highlight', color:'#ffd400',
//     sortIndex:'00000|000100|00200', position:{pageIndex:0, rects:[[100,600,300,620]]}})
//   fetch('/__log')                                      // PUT annotations / PUT view-state entries
import { startMock } from "../mock-api.ts";

const server = startMock(23122);
const base = `http://127.0.0.1:${server.port}`;
let failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
	console.log(`${ok ? "ok  " : "FAIL"} ${name} ${extra}`);
	if (!ok) failed++;
};

for (const [path, type] of [
	["index.html", "text/html"],
	["reader.js", "javascript"],
	["host.js", "javascript"],
	["reader.css", "text/css"],
	["pdf/web/viewer.html", "text/html"],
	["pdf/build/pdf.mjs", "javascript"],
	["pdf/build/pdf.worker.mjs", "javascript"],
	["document-worker/worker.js", "javascript"],
] as const) {
	const r = await fetch(`${base}/reader-host/${path}`);
	const ct = r.headers.get("content-type") ?? "";
	check(path, r.ok && ct.includes(type), `${r.status} ${ct}`);
	await r.arrayBuffer();
}

const f = await fetch(`${base}/api/attachments/TEST/file`);
check("file is pdf", f.headers.get("content-type") === "application/pdf" && (await f.arrayBuffer()).byteLength > 1000);

const put = await fetch(`${base}/api/attachments/TEST/annotations`, {
	method: "PUT",
	body: JSON.stringify([{ id: "A1", type: "highlight", sortIndex: "0", position: {}, dateModified: "x" }]),
});
check("PUT annotations", put.ok);
const got = await (await fetch(`${base}/api/attachments/TEST/annotations`)).json();
check("GET annotations round-trip", got.length === 1 && got[0].id === "A1");
const del = await fetch(`${base}/api/attachments/TEST/annotations`, { method: "DELETE", body: JSON.stringify({ ids: ["A1"] }) });
check("DELETE annotations", del.ok && (await (await fetch(`${base}/api/attachments/TEST/annotations`)).json()).length === 0);
check(
	"PUT view-state",
	(await fetch(`${base}/api/attachments/TEST/view-state`, { method: "PUT", body: JSON.stringify({ pageIndex: 3 }) })).ok,
);
check("GET view-state", (await (await fetch(`${base}/api/attachments/TEST/view-state`)).json()).pageIndex === 3);

if (process.argv.includes("--serve")) {
	console.log(`serving ${base}/reader-host/index.html?attachment=TEST (Ctrl+C to stop)`);
} else {
	server.stop(true);
	console.log(failed ? `${failed} FAILED` : "all passed");
	process.exit(failed ? 1 : 0);
}
