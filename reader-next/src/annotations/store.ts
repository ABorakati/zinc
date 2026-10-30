// Reactive annotation list for one attachment, persisted through the core API (debounced):
//   GET/PUT/DELETE /api/attachments/:key/annotations  (Zotero reader JSON, synced into Zotero's database by the core).
import { createSignal } from "solid-js";
import { bySortIndex, isDisplayable, nowIso, toWire, type Annotation } from "./model";

const SAVE_DELAY = 500;
const RETRY_DELAY = 4000;

export function createStore(attachmentKey: string) {
	const url = `/api/attachments/${encodeURIComponent(attachmentKey)}/annotations`;
	const [list, setList] = createSignal<Annotation[]>([]);
	const [status, setStatus] = createSignal<"saved" | "saving" | "error">("saved");
	const dirty = new Set<string>();
	const removed = new Set<string>();
	let timer = 0;
	let inFlight: Promise<void> = Promise.resolve();

	const post = (method: "PUT" | "DELETE", body: unknown, keepalive: boolean) =>
		fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive }).then((r) => {
			if (!r.ok) throw new Error(`${method} annotations: HTTP ${r.status}`);
		});

	function flush(keepalive = false): Promise<void> {
		clearTimeout(timer);
		timer = 0;
		const up = [...dirty].map((id) => list().find((a) => a.id === id)).filter((a): a is Annotation => !!a).map(toWire);
		const del = [...removed];
		dirty.clear();
		removed.clear();
		if (!up.length && !del.length) return inFlight;
		setStatus("saving");
		// sequential, so a delete never overtakes the upsert it follows
		inFlight = inFlight.then(async () => {
			try {
				if (up.length) await post("PUT", up, keepalive);
				if (del.length) await post("DELETE", { ids: del }, keepalive);
				if (!dirty.size && !removed.size) setStatus("saved");
			} catch (e) {
				console.warn("[annotations] save failed, will retry:", e);
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
		timer = window.setTimeout(() => void flush(), ms);
	}

	return {
		list,
		status,
		/** Fetch the saved annotations (ignoring ones that cannot be placed). */
		async load(): Promise<void> {
			const r = await fetch(url);
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			const rows: unknown = await r.json();
			setList((Array.isArray(rows) ? rows.filter(isDisplayable) : []).sort(bySortIndex));
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
		dispose() { void flush(true); },
	};
}
export type Store = ReturnType<typeof createStore>;
