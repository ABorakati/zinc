// `translate` (library.wit): import / export / lookup / web translators through core's /api/translate/*, /api/io/*, /api/add/*.
import { defineHandler, witError } from "./registry";
import { coreJson } from "./data/core";
import { requirePermission } from "./data/perm";
import { matchNetHost } from "./data/nethosts";

export default defineHandler({
	interface: "zinc:plugin/translate",
	where: "host",
	functions: {
		async "list-translators"(ctx, kind: string) {
			requirePermission(ctx, "library.translate");
			if (kind === "web" || kind === "search") throw witError("unavailable", `listing ${kind} translators needs a core route`);
			const list = await coreJson<{ id: string; label: string; extension?: string }[]>(ctx, `/api/translate/${kind === "importer" ? "import" : "export"}-formats?all=1`);
			return list.map((t) => ({ id: t.id, label: t.label, kind, extension: t.extension, priority: 100 }));
		},

		async "import-text"(ctx, r: { text: string; translator?: string; library?: number; collection?: string; newCollectionName?: string }) {
			requirePermission(ctx, "library.translate");
			requirePermission(ctx, "library.write");
			if (r.library !== undefined && r.library !== 1) throw witError("unavailable", "import into a group library needs a core route");
			const out = await coreJson<{ created: number; skipped: number; errors: string[]; itemKeys?: string[]; format?: string; translator?: string }>(ctx, "/api/translate/import", {
				json: { text: r.text, translatorID: r.translator, collectionKey: r.collection, collectionName: r.newCollectionName },
			});
			return { created: out.created, skipped: out.skipped, errors: out.errors ?? [], itemKeys: out.itemKeys ?? [], translator: out.translator ?? out.format ?? "" };
		},

		async "export-items"(ctx, r: { translator: string; items: string[]; collection?: string; library?: number; includeNotes: boolean; displayOptions?: string }) {
			requirePermission(ctx, "library.translate");
			const out = await coreJson<{ filename: string; contentType: string; text: string; count: number }>(ctx, "/api/translate/export", {
				json: { translatorID: r.translator, keys: r.items.length ? r.items : undefined, collectionKey: r.collection, includeNotes: r.includeNotes, displayOptions: r.displayOptions ? JSON.parse(r.displayOptions) : undefined },
			});
			return { filename: out.filename, contentType: out.contentType, text: out.text, count: out.count };
		},

		async lookup(ctx, text: string) {
			requirePermission(ctx, "library.translate");
			// core's add-by-identifier saves what it finds; lookup must not save: needs a core route that only resolves
			void text;
			throw witError("unavailable", "lookup without saving needs a core route (POST /api/add/identifier saves the items)");
		},

		async web(ctx, r: { url: string; library?: number; collection?: string; attachments: boolean; translator?: string }) {
			requirePermission(ctx, "library.translate");
			requirePermission(ctx, "library.write");
			let u: URL;
			try {
				u = new URL(r.url);
			} catch {
				throw witError("invalid-argument", "invalid url");
			}
			// the same rule as `net` (one matcher); a plugin's Add from URL never reaches a private or local destination, listed or not.
			// core enforces that again for every request, redirect, translator request and download of the job (publicOnly)
			const m = matchNetHost(ctx.grants.netHosts, u);
			if (!m) throw witError("permission-denied", `net.hosts: ${u.origin}`);
			if (m.privateHost) throw witError("permission-denied", `translate.web does not reach private or local addresses: ${u.origin}`);
			const out = await coreJson<any>(ctx, "/api/translate/web", { json: { url: r.url, collectionKey: r.collection, attachments: r.attachments, translatorID: r.translator, publicOnly: true } });
			if (out.choices) return { tag: "choose", val: { session: out.choices.session, items: out.choices.items.map((i: any) => ({ id: i.key, title: i.title })) } };
			return { tag: "saved", val: (out.items ?? []).map((i: any) => i.key) };
		},

		async "web-select"(ctx, session: string, ids: string[], collection: string | undefined) {
			requirePermission(ctx, "library.translate");
			requirePermission(ctx, "library.write");
			const out = await coreJson<{ items: { key: string }[] }>(ctx, "/api/translate/web/select", { json: { session, keys: ids, collectionKey: collection, publicOnly: true } });
			return out.items.map((i) => i.key);
		},
	},
});
