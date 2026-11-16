// Opened items in the list (Zotero's twisty): which item keys show their attachments / notes as child rows, the children loaded for
// them (the item detail carries them, through actions.ts getDetail), and the selected child row. Shared by the cards and the
// table and kept for the session, so switching views or lists keeps what was open.
import { batch, createSignal, untrack } from "solid-js";
import type { ChildSummary } from "../api";
import type { ItemRow } from "../contracts";
import { store } from "../store";
import { getDetail } from "./actions";

const [openKeys, setOpenKeys] = createSignal<ReadonlySet<string>>(new Set());
/**
 * Loaded children per item, each with the revision of the library data (store.itemsRev) it was loaded at. After a refresh (an edit,
 * a sync, a save from the connector) the old list stays on screen while it is loaded again: dropping it turned every child row into
 * a placeholder for a moment, and a click (the second half of a double-click) on a placeholder did nothing.
 */
const [kids, setKids] = createSignal<ReadonlyMap<string, { rev: number; list: readonly ChildSummary[] }>>(new Map());
const loading = new Set<string>(); // "rev:key"

/** Two clicks on the same child row within this many ms open it even when the system's click count did not reach 2. */
export const DOUBLE_CLICK_MS = 500;
let lastClick: { key: string; at: number } | null = null;

/**
 * Whether this click completes a double-click on child `key`: the system says so, or the previous click was on the same row just
 * now (the row may have been rebuilt between the two clicks, and GPUI's count then starts again at 1).
 */
export function isDoubleClick(key: string, clickCount: number, now: number): boolean {
	const twice = clickCount >= 2 || (lastClick?.key === key && now - lastClick.at <= DOUBLE_CLICK_MS);
	// a double-click consumes the pair, so a third quick click starts again rather than opening a second time
	lastClick = twice ? null : { key, at: now };
	return twice;
}

/** The new list, reusing the old child objects that did not change, so the rows showing them stay mounted. */
export function keepSame(old: readonly ChildSummary[] | undefined, next: readonly ChildSummary[]): readonly ChildSummary[] {
	if (!old) return next;
	const byKey = new Map(old.map((c) => [c.key, c]));
	const same = (a: ChildSummary, b: ChildSummary) => JSON.stringify(a) === JSON.stringify(b);
	const list = next.map((c) => {
		const o = byKey.get(c.key);
		return o && same(o, c) ? o : c;
	});
	return list.length === old.length && list.every((c, i) => c === old[i]) ? old : list;
}

/** Item keys whose children are shown. */
export { openKeys };
export const isOpen = (key: string) => openKeys().has(key);
/** Whether the item gets a twisty: it has attachments or notes (Zotero shows notes as children too). */
export const hasChildren = (it: Pick<ItemRow, "attachmentCount" | "noteCount">) => (it.attachmentCount ?? 0) + (it.noteCount ?? 0) > 0;

function load(key: string) {
	const rev = untrack(store.itemsRev);
	const id = `${rev}:${key}`;
	if (loading.has(id) || untrack(kids).get(key)?.rev === rev) return;
	loading.add(id);
	getDetail(key).then(
		(d) => {
			loading.delete(id);
			if (rev !== untrack(store.itemsRev)) return; // a newer load is on its way
			setKids((k) => {
				const old = k.get(key);
				const list = keepSame(old?.list, d.children);
				if (old && old.list === list && old.rev === rev) return k;
				return new Map(k).set(key, { rev, list });
			});
		},
		() => loading.delete(id),
	);
}

/**
 * Loaded children of `key` (null until they first arrive; reading it asks for them). After the library data changes the last
 * loaded list is kept, and replaced only if the reload finds a difference.
 */
export function childrenOf(key: string): readonly ChildSummary[] | null {
	const got = kids().get(key);
	if (!got || got.rev !== store.itemsRev()) queueMicrotask(() => load(key));
	return got?.list ?? null;
}

export function setOpen(key: string, on: boolean) {
	if (on === openKeys().has(key)) return;
	const s = new Set(openKeys());
	if (on) s.add(key);
	else s.delete(key);
	setOpenKeys(s);
	if (on) load(key);
}
export const toggleOpen = (key: string) => setOpen(key, !openKeys().has(key));
/** "+": open these items (the ones in view that have children). */
export function openAll(keys: readonly string[]) {
	const s = new Set(openKeys());
	for (const k of keys) s.add(k);
	setOpenKeys(s);
	for (const k of keys) load(k);
}
/** "-": close every item. */
export const closeAll = () => setOpenKeys(new Set<string>());

// ---- the selected child row ----
const [childSel, setChildSel] = createSignal<{ parentKey: string; key: string } | null>(null);

/** The child row that is selected: it is the store's one selected key (the item pane shows it). */
export function selectedChild(): { parentKey: string; key: string } | null {
	const c = childSel();
	if (!c || store.selectedItem() !== c.key) return null;
	const sel = store.selected();
	return sel.size === 1 && sel.has(c.key) ? c : null;
}
/** Select a child row: the attachment / note becomes the selection (the item pane shows it); its parent stays the anchor row. */
export function selectChild(parentKey: string, parentIndex: number, key: string) {
	batch(() => {
		setChildSel({ parentKey, key });
		store.selectOnly(key, parentIndex);
	});
}
