// The COLLECTIONS group: tree with create / rename / delete / move, context menu (built-ins + registry collectionActions),
// item drop target and persisted expand state. Mirrors ui/src/Collections.tsx; tree drag-to-move is an addition.
//
// Drags (a collection moved in the tree, or items dropped from the list) are hit-tested by coordinates: GPUIX captures the
// pointer for the element a press started on (any element with onMouseDown + onMouseMove), so other rows see no enter / up.
import { createEffect, createMemo, createRoot, createSignal, on, onCleanup, Show, type JSX } from "solid-js";
import type { HostElement } from "@gpuix/solid";
import type { Collection } from "../contracts";
import { Icon } from "../icons";
import { collectionActions } from "../registry";
import { confirm, openMenu, toast, type MenuItem } from "../ui";
import { boundsOf } from "../ui/core";
import { currentView, refreshStore, setView, storeCollections } from "./bridge";
import { itemDrag, itemDragPoint } from "./dndBridge";
import { errMsg, sidebarApi } from "./client";
import { NameInput } from "./NameInput";
import {
	CountBadge, type Entry, folderColor, folderSvg, IconButton, labelCls, ListItem, muted, pill, ROW, ROW_HOVER, ROW_STATIC, SectionHeader, t, tok, tx,
} from "./parts";
import { collectionsOpen, expandedKeys, setCollectionsOpen, setExpandedKeys, sidebarWidth } from "./state";
import { clipText, textWidth } from "../clip";

// ---- data: the store's tree, replaced by a fresher copy right after a write ----

const [override, setOverride] = createSignal<Collection[] | null>(null);
/** The collection tree (roots with children). */
export const collections = (): Collection[] => override() ?? storeCollections();
createRoot(() => createEffect(on(storeCollections, () => setOverride(null), { defer: true })));

function flatten(list: Collection[], out = new Map<string, Collection>()): Map<string, Collection> {
	for (const c of list) {
		out.set(c.key, c);
		if (c.children) flatten(c.children, out);
	}
	return out;
}
const flat = createRoot(() => createMemo(() => flatten(collections())));
export const collectionByKey = (k: string): Collection | undefined => flat().get(k);

/** Re-read the collection tree (counts too) and tell the store to refresh its list. */
export async function reloadCollections(): Promise<void> {
	try { setOverride(await sidebarApi.collections()); } catch { /* keep what is shown */ }
	refreshStore();
}

/** True when `key` is `ancestor` or inside it. */
function inside(ancestor: string, key: string | null): boolean {
	for (let k = key, n = 0; k && n < 64; n++) {
		if (k === ancestor) return true;
		k = flat().get(k)?.parentKey ?? null;
	}
	return false;
}

const fail = (what: string, e: unknown) => toast(what, { kind: "error", description: errMsg(e) });

// ---- state ----

const expanded = createRoot(() => createMemo(() => new Set(expandedKeys())));
const setExpanded = (s: ReadonlySet<string>) => setExpandedKeys([...s]);
const toggle = (key: string) => {
	const s = new Set(expanded());
	if (!s.delete(key)) s.add(key);
	setExpanded(s);
};
export const expandAll = () => setExpanded(new Set(flat().keys()));
export const collapseAll = () => setExpanded(new Set());

const [editing, setEditing] = createSignal<string | null>(null);
const [creating, setCreating] = createSignal<string | "root" | null>(null);
/** The collection ("root" = top level) an inline new-collection field is open under, or null. */
export { creating };
/** Called right before a new-collection field opens (the sidebar snapshots its scroll position there). */
let beforeCreate: (() => void) | undefined;
export const onBeforeCreate = (f: (() => void) | undefined) => { beforeCreate = f; };
/** The collection row (or "root" = the Collections header) a drag is currently over. */
const [dropKey, setDropKey] = createSignal<string | null>(null);
const [menuKey, setMenuKey] = createSignal<string | null>(null);
/** Key of the collection being dragged to a new parent (null when none). */
const [colDrag, setColDrag] = createSignal<string | null>(null);
let press: { key: string; x: number; y: number } | null = null;
let justDragged = 0;
// A chevron click must not also select the row: GPUI delivers the click to the child's and the row's handler.
let childClickAt = 0;

// ---- hit testing (rows register their element) ----

const rowEls = new Map<string, HostElement>();
let paneEl: HostElement | undefined;
let headerEl: HostElement | undefined;
const hit = (el: HostElement | undefined, x: number, y: number): boolean => {
	const b = boundsOf(el);
	return !!b && x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
};
/** True when a window point is inside the collections pane (rows scrolled out of it must not react to clicks there). */
const visibleAt = (x: number, y: number): boolean => !paneEl || hit(paneEl, x, y);
/** The collection (or "root" for the header) under a window point, or null. Rows scrolled out of the pane do not count. */
function targetAt(x: number, y: number): string | null {
	if (hit(headerEl, x, y)) return "root";
	if (paneEl && !hit(paneEl, x, y)) return null;
	for (const [k, el] of rowEls) if (hit(el, x, y)) return k;
	return null;
}
/** Can the dragged collection be dropped on `target` ("root" = top level)? */
function validTarget(drag: string, target: string): boolean {
	const c = flat().get(drag);
	if (!c) return false;
	if (target === "root") return c.parentKey !== null;
	return target !== drag && !inside(drag, target) && c.parentKey !== target;
}

// ---- actions ----

async function commitCreate(parent: string | "root", name: string) {
	setCreating(null);
	const n = name.trim();
	if (!n) return;
	try {
		await sidebarApi.createCollection(n, parent === "root" ? null : parent);
		if (parent !== "root") setExpanded(new Set(expanded()).add(parent));
		await reloadCollections();
		toast(`Created collection "${n}"`, { kind: "success" });
	} catch (e) { fail("Could not create collection", e); }
}

async function commitRename(c: Collection, name: string) {
	setEditing(null);
	const n = name.trim();
	if (!n || n === c.name) return;
	try { await sidebarApi.patchCollection(c.key, { name: n }); await reloadCollections(); } catch (e) { fail("Could not rename collection", e); }
}

async function remove(c: Collection) {
	const ok = await confirm({
		title: `Delete collection "${c.name}"?`,
		body: "The items inside are kept in your library; only the collection is removed.",
		confirmLabel: "Delete",
		danger: true,
	});
	if (!ok) return;
	try {
		await sidebarApi.deleteCollection(c.key);
		const v = currentView();
		if (v.kind === "collection" && inside(c.key, v.key)) setView({ kind: "library" });
		await reloadCollections();
		toast(`Deleted collection "${c.name}"`, { kind: "success" });
	} catch (e) { fail("Could not delete collection", e); }
}

async function move(key: string, parent: string | null) {
	const c = flat().get(key);
	if (!c || c.parentKey === parent || (parent !== null && inside(key, parent))) return;
	try {
		await sidebarApi.patchCollection(key, { parentKey: parent });
		if (parent) setExpanded(new Set(expanded()).add(parent));
		await reloadCollections();
		toast(parent ? `Moved "${c.name}" into "${flat().get(parent)?.name ?? "collection"}"` : `Moved "${c.name}" to the top level`, { kind: "success" });
	} catch (e) { fail("Could not move collection", e); }
}

async function addItems(c: Collection, keys: string[]) {
	if (!keys.length) return;
	try {
		await sidebarApi.addToCollection(c.key, keys);
		await reloadCollections();
		toast(`Added ${keys.length} item${keys.length === 1 ? "" : "s"} to "${c.name}"`, { kind: "success" });
	} catch (e) { fail("Could not add to collection", e); }
}

// Items dragged out of the list: hover follows the source's reported pointer; the drag ending over a row is the drop.
createRoot(() => {
	let last: { x: number; y: number } | null = null;
	createEffect(() => {
		const d = itemDrag();
		const p = itemDragPoint();
		if (d && p) { last = p; setDropKey(targetAt(p.x, p.y)); }
	});
	createEffect(on(itemDrag, (cur, prev) => {
		if (!prev || cur) return;
		const p = last;
		last = null;
		setDropKey(null);
		const k = p ? targetAt(p.x, p.y) : null;
		const c = k && k !== "root" ? flat().get(k) : undefined;
		if (c) { justDragged = Date.now(); void addItems(c, prev.keys); }
	}, { defer: true }));
});

function startCreate(parent: string | "root") {
	beforeCreate?.();
	setCollectionsOpen(true);
	if (parent !== "root") setExpanded(new Set(expanded()).add(parent));
	setCreating(parent);
}

function collectionMenu(c: Collection): MenuItem[] {
	return [
		{ label: "New subcollection", icon: "folder-plus", onSelect: () => startCreate(c.key) },
		{ label: "Rename", icon: "pencil", onSelect: () => setEditing(c.key) },
		...(c.parentKey ? [{ label: "Move to top level", icon: "corner-left-up", onSelect: () => void move(c.key, null) } satisfies MenuItem] : []),
		...collectionActions().map((a): MenuItem => ({ label: a.label, icon: a.icon, onSelect: () => a.run({ collectionKey: c.key, name: c.name }) })),
		{ separator: true },
		{ label: "Delete…", icon: "trash-2", danger: true, onSelect: () => void remove(c) },
	];
}

function showCollectionMenu(c: Collection, x: number, y: number) {
	setMenuKey(c.key);
	openMenu({ x, y }, collectionMenu(c));
	// the menu has no close callback: drop the "menu is open" tint after a moment
	setTimeout(() => setMenuKey((k) => (k === c.key ? null : k)), 3000);
}

function headerMenu(x: number, y: number) {
	openMenu({ x, y }, [
		{ label: "New collection", icon: "folder-plus", onSelect: () => startCreate("root") },
		{ separator: true },
		{ label: "Expand all", icon: "chevrons-up-down", onSelect: expandAll },
		{ label: "Collapse all", icon: "chevrons-down-up", onSelect: collapseAll },
	]);
}

// ---- rows (entries of the sidebar's virtual list) ----

/** One collection row. The tree is flattened by collectionEntries(); a row knows its depth, not its children's rows. */
function Row(p: { c: Collection; depth: number }): JSX.Element {
	const kids = () => p.c.children ?? [];
	const open = () => expanded().has(p.c.key);
	const sel = () => {
		const v = currentView();
		return v.kind === "collection" && v.key === p.c.key;
	};
	const isEditing = () => editing() === p.c.key;
	const [hov, setHov] = createSignal(false);
	/** The name cut to the row (JS pre-clipping instead of textOverflow: ellipsis, see clip.ts): the sidebar's paddings, the row's
	    indent, chevron, folder, gaps and the count badge are what the label does not get. */
	const name = () => {
		const W = sidebarWidth();
		if (W <= 0) return p.c.name;
		const n = p.c.itemCount;
		const badge = n ? 10 + Math.max(22, textWidth(n.toLocaleString("en-US"), 11, 600) + 12) : 0;
		return clipText(p.c.name, W - 20 - 19 - (6 + p.depth * 14) - 16 - 6 - 15 - 6 - 8 - badge, 13, sel() ? 600 : 400);
	};
	/** The drag is over this row and it may be dropped here (items go anywhere; a collection not into itself). */
	const over = () => dropKey() === p.c.key && (!colDrag() || validTarget(colDrag()!, p.c.key));
	return (
		<ListItem>
			<div
				ref={(el: HostElement) => {
					rowEls.set(p.c.key, el);
					onCleanup(() => { if (rowEls.get(p.c.key) === el) rowEls.delete(p.c.key); });
				}}
				role="treeitem"
				aria-selected={sel()}
				onClick={(e) => {
					if (Date.now() - childClickAt < 150 || Date.now() - justDragged < 250 || isEditing()) return;
					if ((e.clickCount ?? 1) >= 2) return setEditing(p.c.key);
					setView({ kind: "collection", key: p.c.key });
				}}
				onAuxClick={(e) => { if (e.isRightClick && visibleAt(e.x ?? 0, e.y ?? 0)) showCollectionMenu(p.c, e.x ?? 0, e.y ?? 0); }}
				onMouseEnter={() => setHov(true)}
				onMouseLeave={() => setHov(false)}
				onMouseDown={(e) => { if (e.button === 0 && !isEditing()) press = { key: p.c.key, x: e.x ?? 0, y: e.y ?? 0 }; }}
				// this row holds the pointer from the press until the release, so the move / up events carry the drag
				onMouseMove={(e) => {
					if (colDrag() === p.c.key) {
						if (e.pressedButton === undefined) return endDrags(); // released outside the window
						return setDropKey(targetAt(e.x ?? 0, e.y ?? 0));
					}
					if (!press || press.key !== p.c.key || e.pressedButton !== 0) return;
					if (Math.hypot((e.x ?? 0) - press.x, (e.y ?? 0) - press.y) > 6) setColDrag(p.c.key);
				}}
				onMouseUp={(e) => {
					const d = colDrag();
					if (d === p.c.key) {
						const target = targetAt(e.x ?? 0, e.y ?? 0);
						justDragged = Date.now();
						endDrags();
						if (target && validTarget(d, target)) void move(d, target === "root" ? null : target);
					}
					press = null;
				}}
				style={{
					...t(ROW_STATIC),
					cursor: colDrag() ? "grabbing" : "pointer",
					paddingLeft: 6 + p.depth * 14,
					...(hov() ? t(ROW_HOVER) : {}),
					...(menuKey() === p.c.key && !sel() ? { backgroundColor: tok("accent") } : {}),
					...pill(sel()),
					...(colDrag() === p.c.key ? { opacity: 0.45 } : {}),
					...(over() ? { outlineWidth: 2, outlineColor: tok("primary"), outlineOffset: -2 } : {}),
				}}
			>
				<div
					onClick={() => {
						childClickAt = Date.now();
						if (kids().length) toggle(p.c.key);
					}}
					style={t("flex size-4 flex-none items-center justify-center")}
				>
					<Show when={kids().length}>
						<Icon name={open() ? "chevron-down" : "chevron-right"} size={14} color={muted()} />
					</Show>
				</div>
				<svg source={folderSvg(open() || sel())} style={{ width: 15, height: 15, flexShrink: 0, color: folderColor(p.c.key) }} />
				<Show
					when={isEditing()}
					fallback={<text style={{ ...tx(labelCls(sel())), overflow: "hidden", whiteSpace: "nowrap", minWidth: 0, flexGrow: 1, flexBasis: 0 }}>{name()}</text>}
				>
					<NameInput value={p.c.name} onDone={(v) => void commitRename(p.c, v)} onCancel={() => setEditing(null)} />
				</Show>
				<CountBadge n={p.c.itemCount} />
			</div>
		</ListItem>
	);
}

/** The inline "new collection" row: a muted folder and a name field, indented past the chevron slot. */
function CreateRow(p: { parent: string | "root"; padLeft: number }): JSX.Element {
	return (
		<ListItem>
			<div style={{ ...t(ROW), paddingLeft: p.padLeft + 20 }}>
				<Icon name="folder" size={15} color={muted()} />
				<NameInput value="" placeholder="Collection name" onDone={(v) => void commitCreate(p.parent, v)} onCancel={() => setCreating(null)} />
			</div>
		</ListItem>
	);
}

/** Cancel a half-finished tree drag (button released elsewhere). */
export function endDrags() {
	press = null;
	if (colDrag()) { justDragged = Date.now(); setColDrag(null); }
	setDropKey(null);
}

/** Registers the scrolling pane the rows live in (drops only count inside it). */
export const setCollectionsPane = (el: HostElement) => { paneEl = el; };

/**
 * The Collections group as entries of the sidebar's virtual list: the header, then (while open) the new-collection field for the
 * top level, the visible rows of the tree in order (a collection's children right after it while it is expanded) and each inline
 * new-subcollection field right after its parent. `top` is the space above the header (the 16px gap between the groups).
 */
export function collectionEntries(top: number): Entry[] {
	const out: Entry[] = [{
		id: "c:header",
		render: () => (
			<ListItem top={top}>
				<div
					ref={(el: HostElement) => { headerEl = el; }}
					style={dropKey() === "root" && colDrag() && validTarget(colDrag()!, "root") ? { outlineWidth: 2, outlineColor: tok("primary"), outlineOffset: -2, borderRadius: 8 } : {}}
				>
					<SectionHeader
						label="Collections"
						open={collectionsOpen()}
						onToggle={() => setCollectionsOpen(!collectionsOpen())}
						onContextMenu={headerMenu}
						actions={<IconButton name="plus" box={20} icon={16} label="New collection" onClick={() => startCreate("root")} />}
					/>
				</div>
			</ListItem>
		),
	}];
	if (!collectionsOpen()) return out;
	// the new-collection field sits at the top so it is on screen however long the tree is
	if (creating() === "root") out.push({ id: "c:create:root", render: () => <CreateRow parent="root" padLeft={6} /> });
	const open = expanded();
	const walk = (list: Collection[], depth: number) => {
		for (const c of list) {
			out.push({ id: `c:${c.key}`, render: () => <Row c={c} depth={depth} /> });
			if (creating() === c.key) out.push({ id: `c:create:${c.key}`, render: () => <CreateRow parent={c.key} padLeft={6 + (depth + 1) * 14} /> });
			if (open.has(c.key) && c.children) walk(c.children, depth + 1);
		}
	};
	walk(collections(), 0);
	return out;
}
