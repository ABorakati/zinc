// Reactive annotation list for one attachment, persisted through the core API (debounced). Same wire format as the web reader
// (reader-next/src/annotations/store.ts), so both apps share the annotations:
//   GET/PUT/DELETE /api/attachments/:key/annotations  (Zotero reader JSON, synced into Zotero's database by the core).
//
// Coordinates: on the wire positions are in PDF user space (Zotero's: a page's /Rotate is not applied); in memory they are in the
// reader's page space (the page as displayed). The two differ only on pages with a /Rotate (core/geometry.ts); the conversion uses
// the geometry of the document the list was loaded for, so a page rotated in the file keeps its annotations on its content.
import { createSignal } from "solid-js";
import { apiRequest } from "../../api";
import { fromUser, getDocGeometry, mapPath, pageRot, rectFromUser, rectToUser, toUser, type DocGeometry } from "../core/geometry";
import { bySortIndex, isDisplayable, nowIso, toWire, type Annotation, type Position } from "./model";

const SAVE_DELAY = 500;
const RETRY_DELAY = 4000;

/** A position between user space and page space (`toPage`: user -> page); unchanged when neither of its pages has a /Rotate. */
function convert(p: Position, g: DocGeometry | undefined, toPage: boolean): Position {
	if (!g || (!pageRot(g, p.pageIndex) && !(p.nextPageRects && pageRot(g, p.pageIndex + 1)))) return p;
	const rect = toPage ? rectFromUser : rectToUser, pt = toPage ? fromUser : toUser;
	const out: Position = { ...p };
	if (p.rects) out.rects = p.rects.map((r) => rect(g, p.pageIndex, r));
	if (p.nextPageRects) out.nextPageRects = p.nextPageRects.map((r) => rect(g, p.pageIndex + 1, r));
	if (p.paths) out.paths = p.paths.map((path) => mapPath(path, (x, y) => pt(g, p.pageIndex, x, y)));
	return out;
}

/** The latest store of every attachment, so page edits (core/pageops.ts) can save pending changes before they touch the list. */
const live = new Map<string, WeakRef<{ flush(): Promise<void> }>>();
/** Save the pending annotation changes of an attachment (if a store is open for it). */
export function flushAnnotationStore(attachmentKey: string): Promise<void> {
	return live.get(attachmentKey)?.deref()?.flush() ?? Promise.resolve();
}

export function createStore(attachmentKey: string) {
	const path = `/attachments/${encodeURIComponent(attachmentKey)}/annotations`;
	const [list, setList] = createSignal<Annotation[]>([]);
	const [status, setStatus] = createSignal<"saved" | "saving" | "error">("saved");
	const [loaded, setLoaded] = createSignal(false);
	const dirty = new Set<string>();
	const removed = new Set<string>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let inFlight: Promise<void> = Promise.resolve();
	/** the page geometry the list was loaded with (positions in memory are in its page space) */
	let geo: DocGeometry | undefined;
	const wire = (a: Annotation): Annotation => { const w = toWire(a); return { ...w, position: convert(w.position, geo, false) }; };

	function flush(): Promise<void> {
		clearTimeout(timer);
		timer = undefined;
		const up = [...dirty].map((id) => list().find((a) => a.id === id)).filter((a): a is Annotation => !!a).map(wire);
		const del = [...removed];
		dirty.clear();
		removed.clear();
		if (!up.length && !del.length) return inFlight;
		setStatus("saving");
		// sequential, so a delete never overtakes the upsert it follows
		inFlight = inFlight.then(async () => {
			try {
				if (up.length) await apiRequest("PUT", path, up);
				if (del.length) await apiRequest("DELETE", path, { ids: del });
				if (!dirty.size && !removed.size) setStatus("saved");
			} catch (e) {
				console.warn("[annotations] save failed, will retry:", (e as Error).message);
				for (const a of up) if (list().some((x) => x.id === a.id)) dirty.add(a.id);
				for (const id of del) removed.add(id);
				setStatus("error");
				schedule(RETRY_DELAY);
			}
		});
		return inFlight;
	}
	function schedule(ms = SAVE_DELAY) {
		clearTimeout(timer);
		timer = setTimeout(() => void flush(), ms);
	}

	const store = {
		list,
		status,
		loaded,
		/** Fetch the saved annotations (ignoring ones that cannot be placed). */
		async load(): Promise<void> {
			const rows = await apiRequest<unknown>("GET", path);
			geo = getDocGeometry(attachmentKey);
			setList((Array.isArray(rows) ? rows.filter(isDisplayable) : []).map((a) => ({ ...a, position: convert(a.position, geo, true) })).sort(bySortIndex));
			setLoaded(true);
		},
		get(id: string) { return list().find((a) => a.id === id); },
		add(a: Annotation) {
			setList((l) => [...l.filter((x) => x.id !== a.id), a].sort(bySortIndex));
			dirty.add(a.id);
			removed.delete(a.id);
			schedule();
		},
		update(id: string, patch: Partial<Annotation>) {
			let found = false;
			setList((l) => {
				const next = l.map((a) => (a.id === id ? (found = true, { ...a, ...patch, dateModified: nowIso() }) : a));
				return patch.sortIndex ? next.sort(bySortIndex) : next;
			});
			if (!found) return;
			dirty.add(id);
			schedule();
		},
		remove(ids: string[]) {
			const gone = new Set(ids);
			setList((l) => l.filter((a) => !gone.has(a.id)));
			for (const id of ids) { dirty.delete(id); removed.add(id); }
			schedule();
		},
		flush,
		dispose() { void flush(); },
	};
	live.set(attachmentKey, new WeakRef(store));
	return store;
}
export type Store = ReturnType<typeof createStore>;
