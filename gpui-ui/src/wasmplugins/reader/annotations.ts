// The `annotations` import: read, create, update, remove and image of annotations (reader.wit `annotations`).
//
// DECISION (data path): an attachment with an open reader is served through that reader's annotation session
// (reader/annotations/session.ts: its store is what the sidebar and the pages draw and what PUTs to the core, so a plugin's write shows
// at once and cannot be overwritten by the store's next save). An attachment with no open reader goes straight to the core's
// `/api/attachments/:key/annotations` (GET list, PUT upsert by id, DELETE ids), the same wire format as the store. Both run in the
// Zinc process (`where: "zinc"`); no host-process handler is needed. Annotation keys have no lookup of their own in the core, so
// `get-annotations` and `update-annotations` find an annotation by the attachments this bridge has seen (an open reader's list, or
// an earlier list / create call); an unknown key answers none (get) or not-found (update).
import { apiRequest } from "../../api";
import {
	formatSortIndex,
	generateKey,
	isKey,
	makeAnnotation,
	nowIso,
	pageLabelFor,
	type Annotation,
} from "../../reader/annotations/model";
import { renderAnnotationImage } from "../../reader/annotations/imageExport";
import { sessionOf, type Session } from "../../reader/annotations/session";
import { findReader, infoOf, allReaders } from "./host";
import { annotationColors, fromNewAnnotation, fromPatch, splitPosition, toWitAnnotation } from "./convert";
import { emitAnnotationsChange, withOwn } from "./events";
import { fail, type ItemRef, type PluginCtx, type WitAnnotation, type WitAnnotationPatch, type WitNewAnnotation } from "./types";

/** attachment of every annotation key this bridge has seen */
const seen = new Map<string, string>();
const MAX_SEEN = 20_000;
function remember(attachment: string, list: Annotation[]): void {
	if (seen.size > MAX_SEEN) seen.clear();
	for (const a of list) seen.set(a.id, attachment);
}

interface Source {
	attachment: string;
	session?: Session;
	list(): Promise<Annotation[]>;
	readOnly(): boolean;
}

async function loadedSession(key: string): Promise<Session | undefined> {
	const s = sessionOf(key);
	if (!s) return undefined;
	for (let i = 0; i < 100 && !s.store.loaded(); i++) await Bun.sleep(50);
	return s.store.loaded() ? s : undefined;
}

async function source(key: string): Promise<Source> {
	const s = findReader(key) ? await loadedSession(key) : undefined;
	if (s) return { attachment: key, session: s, list: async () => s.store.list(), readOnly: () => s.store.readOnly() };
	const path = `/attachments/${encodeURIComponent(key)}/annotations`;
	return {
		attachment: key,
		list: async () => {
			const rows = await apiRequest<unknown>("GET", path).catch((e: { status?: number; message?: string }) => {
				if (e.status === 404) return fail("not-found", `attachment ${key}`);
				throw e;
			});
			return (Array.isArray(rows) ? rows : []).filter((a): a is Annotation => !!a && typeof (a as Annotation).id === "string");
		},
		readOnly: () => false,
	};
}

const libraryOf = (key: string): number => {
	const c = findReader(key);
	return c ? infoOf(c).attachment.library : 1;
};
const wit = (src: Source, a: Annotation): WitAnnotation =>
	toWitAnnotation(a, { library: libraryOf(src.attachment), attachment: src.attachment, readOnly: src.readOnly() });

const apiFailure = (e: unknown): never => {
	const st = (e as { status?: number }).status;
	const msg = e instanceof Error ? e.message : String(e);
	if (e instanceof Error && e.name === "WitFailure") throw e;
	if (st === 403 || st === 401) return fail("read-only", msg);
	if (st === 404) return fail("not-found", msg);
	if (st && st >= 400 && st < 500) return fail("invalid-argument", msg);
	return fail("internal", msg);
};

async function write(src: Source, plugin: string, upsert: Annotation[], remove: string[]): Promise<void> {
	if (src.readOnly()) fail("read-only", "the attachment's library is read-only");
	if (src.session) {
		const { store } = src.session;
		withOwn(plugin, src.attachment, () => {
			for (const a of upsert) {
				if (store.get(a.id)) store.update(a.id, a);
				else store.add(a);
			}
			if (remove.length) src.session!.act.remove(remove);
		});
		return;
	}
	const path = `/attachments/${encodeURIComponent(src.attachment)}/annotations`;
	try {
		if (upsert.length) await apiRequest("PUT", path, upsert);
		if (remove.length) await apiRequest("DELETE", path, { ids: remove });
	} catch (e) {
		apiFailure(e);
	}
}

/** The attachment of an annotation key: from an open reader's list, else what was seen before. */
function attachmentOf(key: string): string | undefined {
	for (const c of allReaders()) {
		const s = sessionOf(c.attachmentKey);
		if (s?.store.get(key)) return c.attachmentKey;
	}
	return seen.get(key);
}

export function createAnnotationsApi() {
	return {
		async listAnnotations(ctx: PluginCtx, attachment: ItemRef): Promise<WitAnnotation[]> {
			ctx.require("annotations.read");
			const src = await source(attachment.key);
			const list = await src.list();
			remember(attachment.key, list);
			return [...list].sort((a, b) => (a.sortIndex < b.sortIndex ? -1 : a.sortIndex > b.sortIndex ? 1 : 0)).map((a) => wit(src, a));
		},

		async getAnnotations(ctx: PluginCtx, refs: ItemRef[]): Promise<(WitAnnotation | undefined)[]> {
			ctx.require("annotations.read");
			const lists = new Map<string, Source & { rows: Annotation[] }>();
			const out: (WitAnnotation | undefined)[] = [];
			for (const r of refs) {
				const att = attachmentOf(r.key);
				if (!att) {
					out.push(undefined);
					continue;
				}
				let l = lists.get(att);
				if (!l) {
					const src = await source(att);
					l = Object.assign(src, { rows: await src.list() });
					lists.set(att, l);
				}
				const a = l.rows.find((x) => x.id === r.key);
				out.push(a ? wit(l, a) : undefined);
			}
			return out;
		},

		async createAnnotations(ctx: PluginCtx, attachment: ItemRef, items: WitNewAnnotation[]): Promise<WitAnnotation[]> {
			ctx.require("annotations.write");
			const src = await source(attachment.key);
			if (src.readOnly()) fail("read-only", "the attachment's library is read-only");
			const existing = await src.list();
			remember(attachment.key, existing);
			const taken = new Set(existing.map((a) => a.id));
			const made: Annotation[] = [];
			for (const n of items) {
				const f = fromNewAnnotation(n);
				if (f.key !== undefined && !isKey(f.key)) fail("invalid-argument", `key ${JSON.stringify(f.key)} is not an 8-character key`);
				if (f.key && taken.has(f.key)) fail("conflict", `annotation ${f.key} exists`);
				let first = true;
				for (const pos of splitPosition(f.position)) {
					let id = first && f.key ? f.key : generateKey();
					while (taken.has(id)) id = generateKey();
					taken.add(id);
					const sortIndex =
						f.sortIndex ??
						(src.session
							? await src.session.act.sortIndex(pos)
							: formatSortIndex(pos.pageIndex, 0, 0)); // no text layer without a reader: page first, then key order
					const a = makeAnnotation(
						{
							type: f.type,
							color: f.color,
							position: pos,
							sortIndex,
							pageLabel: f.pageLabel ?? pageLabelFor(pos.pageIndex, [...existing, ...made]),
							text: f.text,
							comment: f.comment,
							tags: f.tags,
						},
						{ id, authorName: f.authorName },
					);
					if (f.isExternal) a.isExternal = true;
					made.push(a);
					first = false;
				}
			}
			await write(src, ctx.pluginId, made, []);
			remember(attachment.key, made);
			if (!src.session) emitAnnotationsChange({ attachment, added: made.map((a) => a.id), modified: [], removed: [] }, ctx.pluginId);
			return made.map((a) => wit(src, a));
		},

		async updateAnnotations(ctx: PluginCtx, _library: number, patches: WitAnnotationPatch[]): Promise<WitAnnotation[]> {
			ctx.require("annotations.write");
			const byAtt = new Map<string, WitAnnotationPatch[]>();
			for (const p of patches) {
				const att = attachmentOf(p.key) ?? fail("not-found", `annotation ${p.key} (list the attachment's annotations first)`);
				byAtt.set(att, [...(byAtt.get(att) ?? []), p]);
			}
			const out: WitAnnotation[] = [];
			for (const [att, list] of byAtt) {
				const src = await source(att);
				const rows = await src.list();
				const next: Annotation[] = [];
				for (const p of list) {
					const a = rows.find((x) => x.id === p.key) ?? fail("not-found", `annotation ${p.key}`);
					if (a.isExternal) fail("read-only", `annotation ${p.key} is embedded in the PDF`);
					next.push({ ...a, ...fromPatch(p), dateModified: nowIso() });
				}
				await write(src, ctx.pluginId, next, []);
				if (!src.session) emitAnnotationsChange({ attachment: { library: libraryOf(att), key: att }, added: [], modified: next.map((a) => a.id), removed: [] }, ctx.pluginId);
				out.push(...next.map((a) => wit(src, a)));
			}
			return out;
		},

		async removeAnnotations(ctx: PluginCtx, _library: number, keys: string[]): Promise<void> {
			ctx.require("annotations.write");
			const byAtt = new Map<string, string[]>();
			for (const k of keys) {
				const att = attachmentOf(k);
				if (att) byAtt.set(att, [...(byAtt.get(att) ?? []), k]);
			}
			for (const [att, ids] of byAtt) {
				const src = await source(att);
				await write(src, ctx.pluginId, [], ids);
				for (const id of ids) seen.delete(id);
				if (!src.session) emitAnnotationsChange({ attachment: { library: libraryOf(att), key: att }, added: [], modified: [], removed: ids }, ctx.pluginId);
			}
		},

		/** A PNG of an image or ink annotation, drawn from the page of an open reader; none when no reader is open on it. */
		async getAnnotationImage(ctx: PluginCtx, ref: ItemRef): Promise<Uint8Array | undefined> {
			ctx.require("annotations.read");
			const att = attachmentOf(ref.key);
			const reader = att ? findReader(att) : undefined;
			const a = att ? sessionOf(att)?.store.get(ref.key) : undefined;
			if (!reader || !a || (a.type !== "image" && a.type !== "ink")) return undefined;
			const r = await renderAnnotationImage(reader, a, 2);
			return r ? new Uint8Array(r.png) : undefined;
		},

		setAnnotationImage(ctx: PluginCtx): never {
			ctx.require("annotations.write");
			return fail("unavailable", "Zinc draws image annotations from the page: there is no cached image to replace");
		},

		annotationColors,

		importEmbeddedAnnotations(ctx: PluginCtx): never {
			ctx.require("annotations.write");
			return fail("unavailable", "importing the annotations embedded in a PDF is not available in Zinc yet");
		},
	};
}
export type AnnotationsApi = ReturnType<typeof createAnnotationsApi>;
