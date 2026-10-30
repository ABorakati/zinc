// Zotero Connector (browser extension) endpoints on the Zotero port: /connector/*. See index.ts.
// The protocol lives in ../connector/handlers.ts; this file only registers its routes.
import { connectorRoutes, runConnectorRoute } from "../connector/handlers";
import { registerZRoute } from "./routes";

for (const route of connectorRoutes) {
	for (const method of route.methods) {
		registerZRoute(method, route.path, (req, ctx) => runConnectorRoute(route, req, { db: ctx.db, url: ctx.url }));
	}
}
