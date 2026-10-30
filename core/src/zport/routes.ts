// Route registry for the Zotero port (see index.ts). Separate from index.ts so feature files can import it
// without an import cycle.
import type { Database } from "bun:sqlite";

export type ZRoute = (req: Request, ctx: { db: Database; url: URL; server: Bun.Server<unknown> }) => Response | null | Promise<Response | null>;

export const routes: { method: string; path: string | RegExp; handler: ZRoute }[] = [];

/** Add a handler for METHOD path (exact string or RegExp on the pathname). First match wins. */
export function registerZRoute(method: string, path: string | RegExp, handler: ZRoute) {
	routes.push({ method: method.toUpperCase(), path, handler });
}
