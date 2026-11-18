// `fulltext` (library.wit): indexed text, index state, and search. Core serves the text through its MCP tool get_fulltext (no plain
// HTTP route), the search through /api/search. Writing text and reindexing have no core route yet: they answer `unavailable`.
import { defineHandler, witError, type HandlerContext } from "./registry";
import { coreJson, mcpText, qs } from "./data/core";
import { requirePermission } from "./data/perm";
import { getDetail } from "./data/library-map";

const TEXT_CAP = 8_000_000; // characters

async function requireAttachment(ctx: HandlerContext, key: string) {
	const d = await getDetail(ctx, key);
	if (!d) throw witError("not-found", `item ${key}`);
	if (d.data.itemType !== "attachment") throw witError("invalid-argument", `${key} is not an attachment`);
	return d;
}

const HEADER = /characters (\d+)-(\d+) of (\d+)/;

/** The whole indexed text of an attachment, or undefined when none is indexed. */
export async function readIndexedText(ctx: HandlerContext, key: string): Promise<string | undefined> {
	let out = "";
	for (let offset = 0; ; ) {
		const t = await mcpText(ctx, "get_fulltext", { key, offset, maxChars: 100_000 });
		const m = HEADER.exec(t.slice(0, 300));
		if (!m) return undefined; // "No full text is indexed ..."
		const nl = t.indexOf("\n\n");
		out += t.slice(nl + 2);
		const end = +m[2];
		if (end >= +m[3] || end <= offset) break;
		if (out.length > TEXT_CAP) throw witError("limit-exceeded", "indexed text is over 8 million characters");
		offset = end;
	}
	return out;
}

export default defineHandler({
	interface: "zinc:plugin/fulltext",
	where: "host",
	functions: {
		async "get-content"(ctx, attachment: string) {
			requirePermission(ctx, "library.fulltext.read");
			await requireAttachment(ctx, attachment);
			const text = await readIndexedText(ctx, attachment);
			// core does not say which source or when: "extracted" and the epoch stand in (needs core: fulltext.source, indexed_at)
			return text === undefined ? undefined : { text, source: "extracted", indexedAt: "1970-01-01T00:00:00Z" };
		},

		async "get-index-state"(ctx, attachments: string[]) {
			requirePermission(ctx, "library.fulltext.read");
			const out: string[] = [];
			for (const key of attachments) {
				const d = await getDetail(ctx, key);
				if (!d || d.data.itemType !== "attachment" || d.data.linkMode === "linked_url") {
					out.push("unavailable");
					continue;
				}
				const t = await mcpText(ctx, "get_fulltext", { key, maxChars: 1 });
				out.push(HEADER.test(t.slice(0, 300)) ? "indexed" : "unindexed");
			}
			return out;
		},

		async "set-content"(ctx, _attachment: string, _text: string) {
			requirePermission(ctx, "library.fulltext.write");
			throw witError("unavailable", "set-content needs a core route and fulltext.source = 'plugin'");
		},

		async reindex(ctx, _attachments: string[]) {
			requirePermission(ctx, "library.fulltext.write");
			throw witError("unavailable", "reindex needs a core route");
		},

		async search(ctx, text: string, library: number | undefined, limit: number, offset: number) {
			requirePermission(ctx, "library.read");
			requirePermission(ctx, "library.fulltext.read");
			const r = await coreJson<{ hits: { key: string; snippet: string; matchedIn: string[] }[] }>(
				ctx,
				"/api/search" + qs({ q: text, limit: limit > 0 ? Math.min(limit, 200) : 50, offset, library }),
			);
			return r.hits.map((h) => ({ key: h.key, snippet: h.snippet, matchedIn: h.matchedIn }));
		},

		async "get-queue-status"(ctx) {
			requirePermission(ctx, "library.fulltext.read");
			throw witError("unavailable", "the index queue is not reported by core");
		},
	},
});
