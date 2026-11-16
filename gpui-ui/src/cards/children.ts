// Opened items in the list (Zotero's twisty): which item keys show their attachments / notes as child rows, the children loaded for
// them (the item detail carries them, through actions.ts getDetail), and the selected child row. Shared by the cards and the
// table and kept for the session, so switching views or lists keeps what was open.
import { batch, createSignal, untrack } from "solid-js";
import type { ChildSummary } from "../api";
import type { ItemRow } from "../contracts";
import { store } from "../store";
import { getDetail } from "./actions";

const [openKeys, setOpenKeys] = createSignal<ReadonlySet<string>>(new Set());
/** Loaded children, for one revision of the library data (store.itemsRev): an edit elsewhere drops them all. */
const [kids, setKids] = createSignal<{ rev: number; map: ReadonlyMap<string, readonly ChildSummary[]> }>({ rev: -1, map: new Map() });
const loading = new Set<string>(); // "rev:key"

/** Item keys whose children are shown. */
export { openKeys };
export const isOpen = (key: string) => openKeys().has(key);
/** Whether the item gets a twisty: it has attachments or notes (Zotero shows notes as children too). */
export const hasChildren = (it: Pick<ItemRow, "attachmentCount" | "noteCount">) => (it.attachmentCount ?? 0) + (it.noteCount ?? 0) > 0;

function load(key: string) {
	const rev = untrack(store.itemsRev);
	const id = `${rev}:${key}`;
	if (loading.has(id) || (untrack(kids).rev === rev && untrack(kids).map.has(key))) return;
	loading.add(id);
	getDetail(key).then(
		(d) => {
			loading.delete(id);
			if (rev !== untrack(store.itemsRev)) return;
			setKids((k) => ({ rev, map: new Map(k.rev === rev ? k.map : []).set(key, d.children) }));
		},
		() => loading.delete(id),
	);
}

/** Loaded children of `key` (null until they arrive; reading it asks for them). Dropped when the library data changes. */
export function childrenOf(key: string): readonly ChildSummary[] | null {
	const k = kids();
	const got = k.rev === store.itemsRev() ? k.map.get(key) : undefined;
	if (!got) queueMicrotask(() => load(key));
	return got ?? null;
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
