// MCP server exposing the zotero-next library to agents.
// Transports live elsewhere: http.ts (Streamable HTTP on the core server) and
// core/scripts/mcp-stdio.ts (stdio, opens the SQLite file directly).

import type { Database } from "bun:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ChildSummary, Collection, ZoteroItemData } from "../api-types";
import * as repo from "../db";
import { HttpError } from "../db";
import { resolveStoredPath } from "../files/paths";
import { indexItem, search, stripHtml } from "../search";
import { listLibraries, resolveLibrary } from "../libraries";
import { pendingCount } from "../sync/build";
import { attachPluginTools } from "./plugin-tools-server";
import type { PluginToolProvider } from "./plugin-tools";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const DEFAULT_TEXT_CHARS = 20000;
const MAX_TEXT_CHARS = 100000;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function text(s: string): ToolResult {
	return { content: [{ type: "text", text: s }] };
}

function jsonResult(v: unknown): ToolResult {
	return text(JSON.stringify(v, null, 1));
}

function fail(message: string): ToolResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

// Run a tool body; repository errors become tool errors the model can read and correct.
function guard<A>(fn: (args: A) => ToolResult): (args: A) => ToolResult {
	return (args) => {
		try {
			return fn(args);
		} catch (e) {
			if (e instanceof HttpError) return fail(e.message);
			return fail(e instanceof Error ? e.message : String(e));
		}
	};
}

const limitSchema = z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Page size, 1-${MAX_LIMIT} (default ${DEFAULT_LIMIT})`);
const offsetSchema = z.number().int().min(0).optional().describe("Number of results to skip (for paging)");
const keySchema = z.string().min(1).describe("8-character Zotero item key");

// ---------------------------------------------------------------- helpers

interface AttachmentInfo {
	key: string;
	contentType: string | null;
	path: string | null;
	hasFile: boolean;
	hasText: boolean;
}

function attachmentsOf(db: Database, parentKey: string): AttachmentInfo[] {
	const rows = db
		.query(
			`SELECT i.key, a.content_type, a.path,
				EXISTS (SELECT 1 FROM fulltext f WHERE f.attachment_key = i.key) AS has_text
			 FROM items i JOIN attachments a ON a.item_key = i.key
			 WHERE i.parent_key = ? AND i.item_type = 'attachment' AND i.deleted = 0
			 ORDER BY i.date_added, i.key`,
		)
		.all(parentKey) as { key: string; content_type: string | null; path: string | null; has_text: number }[];
	return rows.map((r) => ({
		key: r.key,
		contentType: r.content_type,
		path: resolveStoredPath(db, r.path),
		hasFile: repo.fileExists(resolveStoredPath(db, r.path)),
		hasText: !!r.has_text,
	}));
}

function itemType(db: Database, key: string): string | null {
	const r = db.query("SELECT item_type FROM items WHERE key = ?").get(key) as { item_type: string } | null;
	return r ? r.item_type : null;
}

// Attachments an item key refers to: the attachment itself, or all attachments of a parent.
function resolveAttachments(db: Database, key: string): AttachmentInfo[] {
	const type = itemType(db, key);
	if (!type) throw new HttpError(404, `item not found: ${key}`);
	if (type === "attachment") {
		const a = repo.getAttachment(db, key);
		if (!a) throw new HttpError(404, `attachment row not found: ${key}`);
		const hasText = !!db.query("SELECT 1 FROM fulltext WHERE attachment_key = ?").get(key);
		return [{ key, contentType: a.content_type, path: a.path, hasFile: repo.fileExists(a.path), hasText }];
	}
	if (type === "note" || type === "annotation") throw new HttpError(400, `${key} is a ${type}, not an item with attachments`);
	return attachmentsOf(db, key);
}

// Best attachment: PDF/EPUB/HTML ranking (pickPrimary), optionally restricted to those passing `ok`.
function bestOf(atts: AttachmentInfo[], ok: (a: AttachmentInfo) => boolean = () => true): AttachmentInfo | null {
	const cand = atts.filter(ok);
	const p = repo.pickPrimary(cand);
	if (p) return cand.find((a) => a.key === p.key) ?? null;
	return cand[0] ?? null;
}

function clip(s: string, n: number): string {
	return s.length > n ? s.slice(0, n) + "…" : s;
}

const MARK_RE = /<\/?mark>/g;

// Drop fields that only add noise for a reader of the metadata.
function cleanData(d: ZoteroItemData): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const skip = new Set(["tags", "collections", "relations", "version", "parentItem", "deleted"]);
	for (const [k, v] of Object.entries(d)) {
		if (skip.has(k)) continue;
		if (v === "" || v === null || v === undefined) continue;
		if (Array.isArray(v) && v.length === 0) continue;
		out[k] = v;
	}
	if (d.deleted) out.inTrash = true;
	return out;
}

// Fields update_item will not touch: identity, structure, and things with dedicated tools.
const PROTECTED_FIELDS: Record<string, string> = {
	key: "the item key cannot be changed",
	itemType: "the item type cannot be changed",
	dateAdded: "dateAdded cannot be changed",
	dateModified: "dateModified is set automatically",
	parentItem: "the parent cannot be changed",
	version: "version is managed automatically",
	tags: "use add_tags / remove_tags",
	collections: "use add_to_collection / remove_from_collection",
	deleted: "use trash_item / restore_item",
	relations: "relations cannot be edited here",
};

function collectionNames(db: Database): Map<string, Collection> {
	// every library's collections: an item's collection keys can belong to a group
	return new Map(
		listLibraries(db)
			.flatMap((l) => repo.listCollections(db, l.id))
			.map((c) => [c.key, c]),
	);
}

// ---------------------------------------------------------------- server

export interface McpServerOptions {
	/** Where WASM plugin tools come from (HTTP transport inside the app). Default: none. */
	pluginTools?: PluginToolProvider;
}

export function createMcpServer(db: Database, opts: McpServerOptions = {}): McpServer {
	const server = new McpServer(
		{ name: "zotero-next", version: "0.1.0" },
		{
			instructions:
				"Search and manage a local Zotero-style reference library. Start with search_library (full text + metadata) or list_items, " +
				"then get_item for details, get_fulltext to read a paper's text, and get_file_path for the PDF on disk. " +
				"Item keys are 8-character strings. Results are paginated; use offset to page. " +
				"Tools act on My Library unless you pass library (an id from list_libraries) to work in a group library; some groups are read-only.",
		},
	);

	const librarySchema = z.number().int().positive().optional().describe("Library id from list_libraries; omit for My Library");

	const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
	const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

	server.registerTool(
		"list_libraries",
		{
			title: "List libraries",
			description:
				"My Library and the group libraries synced from zotero.org, with their ids (pass an id as library to other tools), whether this user can edit them and how many changes await pushing.",
			inputSchema: {},
			annotations: readOnly,
		},
		guard(() =>
			jsonResult({
				libraries: listLibraries(db).map((l) => ({
					id: l.id,
					name: l.name,
					type: l.type,
					editable: l.editable,
					pendingChanges: pendingCount(db, l.id),
				})),
			}),
		),
	);

	server.registerTool(
		"search_library",
		{
			title: "Search library",
			description:
				"Full-text search across item metadata (title, authors, abstract, journal, tags), child notes, and the extracted full text of attached PDFs. " +
				'Words are AND-ed; use "double quotes" for an exact phrase and a trailing * for a prefix match. Results are ranked by relevance. ' +
				"Returns key, title, creators, year, a snippet with matches in **bold**, and matchedIn (which of metadata/notes/fulltext matched). " +
				"Use get_item with a key for details.",
			inputSchema: {
				query: z.string().min(1).describe("Search words, e.g. normothermic machine perfusion"),
				library: librarySchema,
				limit: limitSchema,
				offset: offsetSchema,
			},
			annotations: readOnly,
		},
		guard(({ query, limit, offset, library }) => {
			const r = search(db, query, {
				limit: limit ?? DEFAULT_LIMIT,
				offset,
				library: library === undefined ? undefined : resolveLibrary(db, library),
			});
			return jsonResult({
				total: r.total,
				offset: offset ?? 0,
				returned: r.hits.length,
				hits: r.hits.map((h) => ({
					key: h.key,
					title: h.title,
					creators: h.creatorsSummary,
					year: h.year,
					matchedIn: h.matchedIn,
					snippet: h.snippet.replace(MARK_RE, "**"),
				})),
			});
		}),
	);

	server.registerTool(
		"list_items",
		{
			title: "List items",
			description:
				"List top-level library items (not attachments or notes), optionally filtered. This is a browse tool, not full-text search: " +
				"q only matches title, creators and year. Combine collection (collection key from list_collections), tag (exact tag), " +
				"unfiled (items in no collection) or trash (items in the trash). Returns total and one page of items.",
			inputSchema: {
				library: librarySchema,
				collection: z.string().optional().describe("Collection key"),
				tag: z.string().optional().describe("Exact tag name"),
				unfiled: z.boolean().optional().describe("Only items that are in no collection"),
				trash: z.boolean().optional().describe("List trashed items instead of live ones"),
				q: z.string().optional().describe("Words that must appear in title, creators or year"),
				sort: z.enum(["title", "creator", "year", "dateAdded"]).optional().describe("Sort field (default dateAdded)"),
				dir: z.enum(["asc", "desc"]).optional().describe("Sort direction (default desc)"),
				limit: limitSchema,
				offset: offsetSchema,
			},
			annotations: readOnly,
		},
		guard((a) => {
			const r = repo.listItems(db, {
				...a,
				library: a.library === undefined ? undefined : resolveLibrary(db, a.library),
				limit: a.limit ?? DEFAULT_LIMIT,
			});
			return jsonResult({
				total: r.total,
				offset: a.offset ?? 0,
				returned: r.items.length,
				items: r.items.map((i) => ({
					key: i.key,
					itemType: i.itemType,
					title: i.title,
					creators: i.creatorsSummary,
					year: i.year,
					publication: i.publication,
					dateAdded: i.dateAdded,
					attachments: i.attachmentCount,
					notes: i.noteCount,
				})),
			});
		}),
	);

	server.registerTool(
		"get_item",
		{
			title: "Get item",
			description:
				"Full details of one item: metadata fields (title, creators, date, DOI, abstract, ...), tags, the names of the collections it is in, " +
				"and its children. Attachments list contentType, absolute local file path, hasFile and annotationCount; notes are returned as plain text. " +
				"Use the attachment key with get_fulltext, get_annotations or get_file_path.",
			inputSchema: { key: keySchema },
			annotations: readOnly,
		},
		guard(({ key }) => {
			const d = repo.getItemDetail(db, key);
			if (!d) return fail(`item not found: ${key}`);
			const names = collectionNames(db);
			const noteRows = db
				.query("SELECT key, data FROM items WHERE parent_key = ? AND item_type = 'note' AND deleted = 0 ORDER BY date_added, key")
				.all(key) as { key: string; data: string }[];
			const noteText = new Map(noteRows.map((n) => [n.key, stripHtml(String((JSON.parse(n.data) as ZoteroItemData).note ?? ""))]));
			const paths = new Map(attachmentsOf(db, key).map((a) => [a.key, a.path]));
			const children = d.children.map((c: ChildSummary) =>
				c.itemType === "note"
					? { key: c.key, itemType: "note", text: clip(noteText.get(c.key) ?? "", 4000) }
					: {
							key: c.key,
							itemType: "attachment",
							title: c.title,
							contentType: c.contentType,
							linkMode: c.linkMode,
							path: paths.get(c.key) ?? null,
							hasFile: c.hasFile,
							annotationCount: c.annotationCount,
						},
			);
			return jsonResult({
				...cleanData(d.data),
				tags: d.tags.map((t) => t.tag),
				collections: d.collections.map((k) => ({ key: k, name: names.get(k)?.name ?? k })),
				children,
			});
		}),
	);

	server.registerTool(
		"get_fulltext",
		{
			title: "Get full text",
			description:
				"Read the extracted text of a paper. Pass an attachment key, or a parent item key to use its best attachment that has indexed text. " +
				"Long texts are paged: the result says how many characters exist in total and the offset to pass next. " +
				"If no text is indexed the tool says so; then use get_file_path and read the file directly.",
			inputSchema: {
				key: keySchema.describe("Attachment key, or parent item key"),
				maxChars: z
					.number()
					.int()
					.min(1)
					.max(MAX_TEXT_CHARS)
					.optional()
					.describe(`Characters to return (default ${DEFAULT_TEXT_CHARS}, max ${MAX_TEXT_CHARS})`),
				offset: offsetSchema.describe("Character offset to start from"),
			},
			annotations: readOnly,
		},
		guard(({ key, maxChars, offset }) => {
			const atts = resolveAttachments(db, key);
			const att = bestOf(atts, (a) => a.hasText);
			if (!att) {
				const why = atts.length === 0 ? "it has no attachments" : "none of its attachments has indexed text";
				return text(`No full text is indexed for ${key}: ${why}. Try get_file_path to read the file directly.`);
			}
			const row = db.query("SELECT content FROM fulltext WHERE attachment_key = ?").get(att.key) as { content: string };
			const content = row.content;
			const start = Math.min(offset ?? 0, content.length);
			const n = maxChars ?? DEFAULT_TEXT_CHARS;
			const end = Math.min(start + n, content.length);
			const header =
				`attachment ${att.key} (${att.contentType ?? "unknown type"}), characters ${start}-${end} of ${content.length}` +
				(end < content.length ? `; call again with offset=${end} for more` : "; end of text");
			return text(`${header}\n\n${content.slice(start, end)}`);
		}),
	);

	server.registerTool(
		"get_annotations",
		{
			title: "Get annotations",
			description:
				"Highlights, underlines and notes made in the reader. Pass an attachment key, or a parent item key to get the annotations of all its attachments. " +
				"Each annotation has type, highlighted text, the reader's comment, page label and colour, in reading order.",
			inputSchema: { key: keySchema.describe("Attachment key, or parent item key") },
			annotations: readOnly,
		},
		guard(({ key }) => {
			const atts = resolveAttachments(db, key);
			const out = atts.flatMap((a) =>
				repo.getAnnotations(db, a.key).map((n) => ({
					attachment: a.key,
					id: n.id,
					type: n.type,
					text: n.text ?? "",
					comment: n.comment ?? "",
					pageLabel: n.pageLabel ?? "",
					color: n.color ?? "",
				})),
			);
			return jsonResult({ total: out.length, annotations: out });
		}),
	);

	server.registerTool(
		"list_collections",
		{
			title: "List collections",
			description:
				"All collections as a nested tree with keys, names and item counts (top-level items directly in each collection, not subcollections). " +
				"Use the keys with list_items, add_to_collection and create_collection.",
			inputSchema: { library: librarySchema },
			annotations: readOnly,
		},
		guard(({ library }) => {
			type Node = { key: string; name: string; itemCount: number; children: Node[] };
			const all = repo.listCollections(db, library === undefined ? 1 : resolveLibrary(db, library));
			const nodes = new Map<string, Node>(
				all.map((c) => [c.key, { key: c.key, name: c.name, itemCount: c.itemCount, children: [] }]),
			);
			const roots: Node[] = [];
			for (const c of all) {
				const parent = c.parentKey ? nodes.get(c.parentKey) : undefined;
				(parent ? parent.children : roots).push(nodes.get(c.key)!);
			}
			return jsonResult({ total: all.length, collections: roots });
		}),
	);

	server.registerTool(
		"create_collection",
		{
			title: "Create collection",
			description: "Create a new collection, optionally nested under parentKey. Returns the new collection with its key.",
			inputSchema: {
				name: z.string().min(1).describe("Collection name"),
				parentKey: z.string().optional().describe("Key of the parent collection; omit for top level"),
				library: librarySchema,
			},
			annotations: { ...write, idempotentHint: false },
		},
		guard(({ name, parentKey, library }) =>
			jsonResult(repo.createCollection(db, name, parentKey, library === undefined ? undefined : resolveLibrary(db, library))),
		),
	);

	server.registerTool(
		"add_to_collection",
		{
			title: "Add to collection",
			description: "Add items to a collection (they stay in their other collections). Items already in it are left alone.",
			inputSchema: {
				collectionKey: z.string().min(1),
				itemKeys: z.array(z.string().min(1)).min(1).max(500).describe("Keys of top-level items"),
			},
			annotations: write,
		},
		guard(({ collectionKey, itemKeys }) => {
			repo.addItemsToCollection(db, collectionKey, itemKeys);
			return text(`Added ${itemKeys.length} item(s) to collection ${collectionKey}.`);
		}),
	);

	server.registerTool(
		"remove_from_collection",
		{
			title: "Remove from collection",
			description: "Remove items from a collection. The items themselves are not deleted and stay in the library.",
			inputSchema: {
				collectionKey: z.string().min(1),
				itemKeys: z.array(z.string().min(1)).min(1).max(500),
			},
			annotations: write,
		},
		guard(({ collectionKey, itemKeys }) => {
			repo.removeItemsFromCollection(db, collectionKey, itemKeys);
			return text(`Removed ${itemKeys.length} item(s) from collection ${collectionKey}.`);
		}),
	);

	server.registerTool(
		"add_tags",
		{
			title: "Add tags",
			description: "Add tags to an item. Existing tags are kept; duplicates are ignored. Search is re-indexed.",
			inputSchema: { itemKey: keySchema, tags: z.array(z.string().min(1)).min(1).max(100) },
			annotations: write,
		},
		guard(({ itemKey, tags }) => {
			repo.addTags(db, itemKey, tags);
			indexItem(db, itemKey);
			return jsonResult({ itemKey, tags: repo.getItemDetail(db, itemKey)!.tags.map((t) => t.tag) });
		}),
	);

	server.registerTool(
		"remove_tags",
		{
			title: "Remove tags",
			description: "Remove the named tags from an item. Tags the item does not have are ignored. Search is re-indexed.",
			inputSchema: { itemKey: keySchema, tags: z.array(z.string().min(1)).min(1).max(100) },
			annotations: write,
		},
		guard(({ itemKey, tags }) => {
			repo.removeTags(db, itemKey, tags);
			indexItem(db, itemKey);
			return jsonResult({ itemKey, tags: repo.getItemDetail(db, itemKey)!.tags.map((t) => t.tag) });
		}),
	);

	server.registerTool(
		"update_item",
		{
			title: "Update item",
			description:
				"Edit metadata fields of an item (PATCH semantics: only the fields you pass change). Use Zotero field names, e.g. " +
				"title, date, DOI, abstractNote, publicationTitle, volume, pages, url, extra, creators (full replacement array of " +
				'{creatorType, firstName, lastName}). Set a field to "" to clear it. key, itemType, tags, collections and trash ' +
				"state cannot be changed here (use the dedicated tools). Search is re-indexed.",
			inputSchema: {
				key: keySchema,
				fields: z.record(z.string(), z.unknown()).describe("Field names and new values"),
			},
			annotations: { ...write, destructiveHint: true },
		},
		guard(({ key, fields }) => {
			const names = Object.keys(fields);
			if (names.length === 0) return fail("fields is empty");
			const bad = names.filter((n) => n in PROTECTED_FIELDS);
			if (bad.length) return fail(bad.map((n) => `${n}: ${PROTECTED_FIELDS[n]}`).join("; "));
			const d = repo.patchItem(db, key, fields as Partial<ZoteroItemData>);
			indexItem(db, key);
			return jsonResult(cleanData(d.data));
		}),
	);

	server.registerTool(
		"trash_item",
		{
			title: "Trash item",
			description: "Move an item to the trash. It disappears from search and listings but is recoverable with restore_item.",
			inputSchema: { key: keySchema },
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		guard(({ key }) => {
			repo.patchItem(db, key, { deleted: 1 });
			indexItem(db, key);
			return text(`Moved ${key} to the trash.`);
		}),
	);

	server.registerTool(
		"restore_item",
		{
			title: "Restore item",
			description: "Restore an item from the trash.",
			inputSchema: { key: keySchema },
			annotations: write,
		},
		guard(({ key }) => {
			repo.patchItem(db, key, { deleted: 0 });
			indexItem(db, key);
			return text(`Restored ${key} from the trash.`);
		}),
	);

	server.registerTool(
		"get_file_path",
		{
			title: "Get file path",
			description:
				"Absolute path on disk of an attachment file, so you can read it directly. Pass an attachment key, or a parent item key to get " +
				"its best file (PDF first, then EPUB, then HTML snapshot). Says clearly if the file is missing.",
			inputSchema: { key: keySchema.describe("Attachment key, or parent item key") },
			annotations: readOnly,
		},
		guard(({ key }) => {
			const atts = resolveAttachments(db, key);
			if (atts.length === 0) return text(`Item ${key} has no attachments.`);
			const att = bestOf(atts, (a) => a.hasFile) ?? bestOf(atts)!;
			if (!att.path) return text(`Attachment ${att.key} has no local file path (linked URL only).`);
			if (!att.hasFile) return text(`Attachment ${att.key} points to ${att.path}, but that file does not exist on disk.`);
			return jsonResult({ attachment: att.key, contentType: att.contentType, path: att.path });
		}),
	);

	server.registerTool(
		"format_bibliography",
		{
			title: "Format bibliography",
			description:
				"Format items as a bibliography (or in-text citation) in any CSL citation style (default: the user's Quick Copy style, " +
				"initially Vancouver). Styles are downloaded from zotero.org on first use; pass the style id such as 'apa', 'nature', " +
				"'the-lancet', 'harvard-cite-them-right'. Returns plain text by default.",
			inputSchema: {
				keys: z.array(keySchema).min(1).max(500).describe("Item keys, in the order they should appear"),
				style: z.string().optional().describe("zotero.org style id (default: Quick Copy style)"),
				format: z.enum(["text", "html", "rtf"]).optional().describe("Output format (default text)"),
				mode: z
					.enum(["bibliography", "citation"])
					.optional()
					.describe("bibliography (default) or one in-text citation for all items"),
			},
			annotations: readOnly,
		},
		async ({ keys, style, format, mode }) => {
			try {
				const { citeService } = await import("../cite/api");
				const f = format ?? "text";
				const res = await citeService(db).format(db, { keys, style, format: f, mode });
				return text(res[f] ?? "");
			} catch (e) {
				return fail(e instanceof Error ? e.message : String(e));
			}
		},
	);

	if (opts.pluginTools) attachPluginTools(server, opts.pluginTools);
	return server;
}
