// STUB. Not the real file: the plain web page's own library, run in a worker the page starts (SQLite on OPFS), is written on another
// branch, and that file replaces this one when the two merge. This stub only has the signature src/platform.web.ts imports, so the
// start-up code, the build and the type check work without it; it throws, so a page that reaches it says so.
//
// The contract (what platform.web.ts relies on):
//   transport(req)  answers one /api Request with a Response, like the core's handleApi does (the app's api.ts calls it through setDirect)
//   onChanged(cb)   cb runs whenever a write committed that this page did not make (another tab, an import): the app reloads its lists
export async function startPageLibrary(): Promise<{
	transport: (req: Request) => Promise<Response>;
	onChanged(cb: () => void): void;
}> {
	throw new Error("The library of this page is not built yet (web/browser-db/page-library.ts is a stub). Add ?demo to the address for the demo library.");
}
