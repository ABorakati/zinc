// `cite` (library.wit): styles, bibliographies and citations, Quick Copy. Core does the formatting (citeproc) at /api/cite/*.
import { defineHandler, witError } from "./registry";
import { core, coreJson, qs } from "./data/core";
import { requirePermission } from "./data/perm";

interface CoreStyle {
	id: string;
	title: string;
	titleShort?: string;
	format?: string;
	dependent: boolean;
	installed: boolean;
}

const toStyle = (s: CoreStyle) => ({ id: s.id, title: s.title, titleShort: s.titleShort, class: s.format, dependent: s.dependent, installed: s.installed });

export default defineHandler({
	interface: "zinc:plugin/cite",
	where: "host",
	functions: {
		async "list-styles"(ctx, query: string, installedOnly: boolean, limit: number, offset: number) {
			requirePermission(ctx, "library.cite.styles");
			const res = await core(ctx, "/api/cite/styles" + qs({ q: query, installed: installedOnly ? 1 : undefined, limit: limit > 0 ? Math.min(limit, 500) : 50, offset }));
			const styles = (await res.json()) as CoreStyle[];
			return { total: Number(res.headers.get("x-total") ?? styles.length), styles: styles.map(toStyle) };
		},

		async "get-style-xml"(ctx, id: string) {
			requirePermission(ctx, "library.cite.styles");
			// core has no route that returns the XML of an installed style (needs core)
			void id;
			throw witError("unavailable", "get-style-xml needs a core route: styles are files in <library>/styles");
		},

		async "install-style"(ctx, id: string) {
			requirePermission(ctx, "library.cite.styles");
			return toStyle(await coreJson<CoreStyle>(ctx, "/api/cite/styles/install", { json: { id } }));
		},

		async "remove-style"(ctx, id: string) {
			requirePermission(ctx, "library.cite.styles");
			await core(ctx, `/api/cite/styles/${encodeURIComponent(id)}`, { method: "DELETE" });
		},

		async format(ctx, req: any) {
			requirePermission(ctx, "library.cite");
			const f = req.formats ?? {};
			const formats = (["html", "text", "rtf"] as const).filter((k) => f[k]);
			const wantNote = !!f["note-citation"] || !!f.noteCitation;
			if (wantNote && req.mode !== "citation") throw witError("invalid-argument", "note-citation needs mode: citation");
			const cur = (await coreJson<{ quickCopy: { style: string; locale: string; mode: string } }>(ctx, "/api/cite/settings")).quickCopy;
			const r = await coreJson<{ html?: string; text?: string; rtf?: string; keys: string[] }>(ctx, "/api/cite/format", {
				json: {
					keys: req.items.map((i: any) => i.key),
					style: req.style ?? cur.style,
					locale: req.locale ?? (cur.locale || undefined),
					mode: req.mode,
					format: formats.length ? formats : ["html"],
				},
			});
			let noteCitation: string | undefined;
			if (wantNote) noteCitation = noteCitationHtml(req.items, r.keys, r.html ?? r.text ?? "");
			return { html: formats.includes("html") ? r.html : undefined, text: formats.includes("text") ? r.text : undefined, rtf: formats.includes("rtf") ? r.rtf : undefined, noteCitation, keys: r.keys };
		},

		async "quick-copy"(ctx, items: string[], asCitations: boolean) {
			requirePermission(ctx, "library.cite");
			const s = (await coreJson<{ quickCopy: { style: string; locale: string; mode: string } }>(ctx, "/api/cite/settings")).quickCopy;
			const r = await coreJson<{ html?: string; text?: string }>(ctx, "/api/cite/format", {
				json: { keys: items, style: s.style, locale: s.locale || undefined, mode: asCitations ? "citation" : s.mode, format: ["html", "text"] },
			});
			return { html: r.html, text: r.text };
		},

		async "get-quick-copy-settings"(ctx) {
			requirePermission(ctx, "library.cite");
			const s = (await coreJson<{ quickCopy: { style: string; locale: string; mode: string } }>(ctx, "/api/cite/settings")).quickCopy;
			return { style: s.style, locale: s.locale, mode: s.mode === "citation" ? "citation" : "bibliography" };
		},
	},
});

/** Zotero's note citation markup: `<span class="citation" data-citation="<urlencoded JSON>">(text)</span>`. */
function noteCitationHtml(items: any[], keys: string[], rendered: string): string {
	const data = {
		citationItems: items
			.filter((i) => keys.includes(i.key))
			.map((i) => ({ uris: [`http://zotero.org/users/local/items/${i.key}`], locator: i.locator ?? undefined, label: i.label ?? undefined, prefix: i.prefix ?? undefined, suffix: i.suffix ?? undefined, "suppress-author": i.suppressAuthor || undefined, "author-only": i.authorOnly || undefined })),
		properties: {},
	};
	const text = rendered.replace(/<[^>]+>/g, "");
	return `<span class="citation" data-citation="${encodeURIComponent(JSON.stringify(data))}">${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</span>`;
}
