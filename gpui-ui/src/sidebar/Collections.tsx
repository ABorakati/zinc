// The COLLECTIONS group: tree with create / rename / delete / move, context menu (built-ins + registry collectionActions),
// item drop target and persisted expand state. Mirrors ui/src/Collections.tsx; tree drag-to-move is an addition.
//
// Drags (a collection moved in the tree, or items dropped from the list) are hit-tested by coordinates: GPUIX captures the
// pointer for the element a press started on (any element with onMouseDown + onMouseMove), so other rows see no enter / up.
import { createEffect, createMemo, createRoot, createSignal, on, onCleanup, Show, untrack, type JSX } from "solid-js";
import type { HostElement } from "@gpuix/solid";
import type { Collection } from "../contracts";
import { Icon } from "../icons";
import { collectionActions } from "../registry";
import { confirm, DropdownMenu, openMenu, toast, type MenuItem } from "../ui";
import { boundsOf } from "../ui/core";
import { currentView, refreshStore, setView, storeCollections } from "./bridge";
import { itemDrag, itemDragPoint } from "./dndBridge";
import { errMsg, sidebarApi } from "./client";
import { NameInput } from "./NameInput";
import { handleFileDrop } from "../features/additems/client";
import {
	brighten,
	CountBadge,
	type Entry,
	folderColor,
	folderSvg,
	mode,
	IconButton,
	labelCls,
	ListItem,
	muted,
	pill,
	ROW,
	ROW_HOVER,
	ROW_STATIC,
	SectionHeader,
	t,
	tok,
	tx,
} from "./parts";
import { collectionsOpen, expandedKeys, setCollectionsOpen, setExpandedKeys, sidebarWidth } from "./state";
import { clipText, textWidth } from "../clip";
import { buildRows, type HeaderRow } from "./collectionRows";
import { collectionStyle, GROUP_KEYS, GROUP_LABELS, ICONS, PALETTE, paletteHex, SORT_KEYS, SORT_LABELS } from "./collectionStyle";

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
// first-seen / last-changed times for "Date created / modified" (the core sends none): recorded whenever the list changes
createRoot(() =>
	createEffect(() => {
		const l = [...flat().values()];
		untrack(() => collectionStyle.observe(l));
	}),
);
export const collectionByKey = (k: string): Collection | undefined => flat().get(k);

/** Re-read the collection tree (counts too) and tell the store to refresh its list. */
export async function reloadCollections(): Promise<void> {
	try {
		setOverride(await sidebarApi.collections());
	} catch {
		/* keep what is shown */
	}
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
export const onBeforeCreate = (f: (() => void) | undefined) => {
	beforeCreate = f;
};
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
export function collectionAt(x: number, y: number): string | null {
	const k = targetAt(x, y);
	return k && k !== "root" ? k : null;
}
/** The collection (or "root" for the header) under a window point, or null. Rows scrolled out of the pane do not count. */
function targetAt(x: number, y: number): string | null {
	if (hit(headerEl, x, y)) return "root";
	if (paneEl && !hit(paneEl, x, y)) return null;
	for (const [k, el] of rowEls) if (hit(el, x, y)) return k.startsWith("pin:") ? k.slice(4) : k; // the Pinned copy of a row counts as the row
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
	} catch (e) {
		fail("Could not create collection", e);
	}
}

async function commitRename(c: Collection, name: string) {
	setEditing(null);
	const n = name.trim();
	if (!n || n === c.name) return;
	try {
		await sidebarApi.patchCollection(c.key, { name: n });
		await reloadCollections();
	} catch (e) {
		fail("Could not rename collection", e);
	}
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
		collectionStyle.forget(c.key);
		const v = currentView();
		if (v.kind === "collection" && inside(c.key, v.key)) setView({ kind: "library" });
		await reloadCollections();
		toast(`Deleted collection "${c.name}"`, { kind: "success" });
	} catch (e) {
		fail("Could not delete collection", e);
	}
}

async function move(key: string, parent: string | null) {
	const c = flat().get(key);
	if (!c || c.parentKey === parent || (parent !== null && inside(key, parent))) return;
	try {
		await sidebarApi.patchCollection(key, { parentKey: parent });
		if (parent) setExpanded(new Set(expanded()).add(parent));
		await reloadCollections();
		toast(parent ? `Moved "${c.name}" into "${flat().get(parent)?.name ?? "collection"}"` : `Moved "${c.name}" to the top level`, {
			kind: "success",
		});
	} catch (e) {
		fail("Could not move collection", e);
	}
}

async function addItems(c: Collection, keys: string[]) {
	if (!keys.length) return;
	try {
		await sidebarApi.addToCollection(c.key, keys);
		await reloadCollections();
		toast(`Added ${keys.length} item${keys.length === 1 ? "" : "s"} to "${c.name}"`, { kind: "success" });
	} catch (e) {
		fail("Could not add to collection", e);
	}
}

// Items dragged out of the list: hover follows the source's reported pointer; the drag ending over a row is the drop.
createRoot(() => {
	let last: { x: number; y: number } | null = null;
	createEffect(() => {
		const d = itemDrag();
		const p = itemDragPoint();
		if (d && p) {
			last = p;
			setDropKey(targetAt(p.x, p.y));
		}
	});
	createEffect(
		on(
			itemDrag,
			(cur, prev) => {
				if (!prev || cur) return;
				const p = last;
				last = null;
				setDropKey(null);
				const k = p ? targetAt(p.x, p.y) : null;
				const c = k && k !== "root" ? flat().get(k) : undefined;
				if (c) {
					justDragged = Date.now();
					void addItems(c, prev.keys);
				}
			},
			{ defer: true },
		),
	);
});

function startCreate(parent: string | "root") {
	beforeCreate?.();
	setCollectionsOpen(true);
	if (parent !== "root") setExpanded(new Set(expanded()).add(parent));
	setCreating(parent);
}

/** Section name input: a new section (to put collection `key` in) or a rename; shown as an inline row at the top of the list. */
const [sectionInput, setSectionInput] = createSignal<{ kind: "new"; key: string } | { kind: "rename"; name: string } | null>(null);

function colourMenu(c: Collection): MenuItem[] {
	const cur = collectionStyle.styleOf(c.key).color;
	return [
		...PALETTE.map((p): MenuItem => ({
			label: p.name,
			icon: cur === p.id ? "circle-check" : "circle",
			iconColor: p.hex,
			onSelect: () => collectionStyle.setColor(c.key, p.id),
		})),
		{ separator: true },
		{ label: "None", icon: !cur ? "circle-check" : "circle", onSelect: () => collectionStyle.setColor(c.key, undefined) },
	];
}

function iconMenu(c: Collection): MenuItem[] {
	const cur = collectionStyle.styleOf(c.key).icon;
	return [
		{ label: "Folder (default)", icon: "folder", checked: !cur, onSelect: () => collectionStyle.setIcon(c.key, undefined) },
		...ICONS.map((name): MenuItem => ({
			label: name.replace(/-/g, " ").replace(/^./, (x) => x.toUpperCase()),
			icon: name,
			checked: cur === name,
			onSelect: () => collectionStyle.setIcon(c.key, name),
		})),
	];
}

function sectionMenu(c: Collection): MenuItem[] {
	const cur = collectionStyle.styleOf(c.key).section;
	const sections = collectionStyle.get().sections;
	return [
		{
			label: "New section…",
			icon: "folder-plus",
			onSelect: () => {
				beforeCreate?.();
				setCollectionsOpen(true);
				setSectionInput({ kind: "new", key: c.key });
			},
		},
		...(sections.length ? [{ separator: true } satisfies MenuItem] : []),
		...sections.map((s): MenuItem => ({ label: s, checked: cur === s, onSelect: () => collectionStyle.setSection(c.key, s) })),
		...(cur
			? [
					{ separator: true } satisfies MenuItem,
					{
						label: "Remove from section",
						icon: "x",
						onSelect: () => collectionStyle.setSection(c.key, undefined),
					} satisfies MenuItem,
				]
			: []),
	];
}

function commitSection(v: string) {
	const input = sectionInput();
	setSectionInput(null);
	const n = v.trim();
	if (!input || !n) return;
	if (input.kind === "rename") {
		if (!collectionStyle.renameSection(input.name, n) && n !== input.name)
			toast(`A section named "${n}" already exists`, { kind: "error" });
		return;
	}
	collectionStyle.addSection(n); // an existing name just reuses that section
	collectionStyle.setSection(input.key, n);
	if (collectionStyle.get().group !== "section")
		toast(`Moved to section "${n}"`, { description: 'Group the list "By section" from the ⋯ menu to see it.' });
}

function collectionMenu(c: Collection): MenuItem[] {
	const pinned = collectionStyle.isPinned(c.key);
	return [
		{ label: "New subcollection", icon: "folder-plus", onSelect: () => startCreate(c.key) },
		{ label: "Rename", icon: "pencil", onSelect: () => setEditing(c.key) },
		{
			label: pinned ? "Unpin" : "Pin to top",
			icon: pinned ? "pin-off" : "pin",
			onSelect: () => (pinned ? collectionStyle.unpin(c.key) : collectionStyle.pin(c.key)),
		},
		{ label: "Colour", icon: "palette", submenu: colourMenu(c) },
		{ label: "Icon", icon: "shapes", submenu: iconMenu(c) },
		...(c.parentKey ? [] : [{ label: "Move to section", icon: "folder-tree", submenu: sectionMenu(c) } satisfies MenuItem]),
		...(c.parentKey
			? [{ label: "Move to top level", icon: "corner-left-up", onSelect: () => void move(c.key, null) } satisfies MenuItem]
			: []),
		...collectionActions().map((a): MenuItem => ({
			label: a.label,
			icon: a.icon,
			onSelect: () => a.run({ collectionKey: c.key, name: c.name }),
		})),
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

/** The ⋯ menu of the Collections header: how the list is sorted and grouped. */
function viewMenu(): MenuItem[] {
	const d = collectionStyle.get();
	return [
		{ heading: "Sort by" },
		...SORT_KEYS.map((k): MenuItem => ({ label: SORT_LABELS[k], checked: d.sort === k, onSelect: () => collectionStyle.setSort(k) })),
		{ separator: true },
		{ heading: "Group by" },
		...GROUP_KEYS.map((k): MenuItem => ({
			label: GROUP_LABELS[k],
			checked: d.group === k,
			onSelect: () => collectionStyle.setGroup(k),
		})),
	];
}

function sectionHeaderMenu(name: string, x: number, y: number) {
	openMenu({ x, y }, [
		{
			label: "Rename section",
			icon: "pencil",
			onSelect: () => {
				setCollectionsOpen(true);
				setSectionInput({ kind: "rename", name });
			},
		},
		{ label: "Delete section", icon: "trash-2", danger: true, onSelect: () => collectionStyle.deleteSection(name) },
	]);
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
function Row(p: { c: Collection; depth: number; pinnedCopy?: boolean }): JSX.Element {
	// a Pinned-section copy is a plain row: no expand arrow, and it registers its element as "pin:<key>" (see targetAt)
	const kids = () => (p.pinnedCopy ? [] : (p.c.children ?? []));
	const open = () => !p.pinnedCopy && expanded().has(p.c.key);
	const style = () => collectionStyle.styleOf(p.c.key);
	/** Folder tint: the chosen colour; uncoloured rows keep the old automatic tint, except under "By colour" where they are muted. */
	const tint = () => {
		const hex = paletteHex(style().color);
		if (!hex) return collectionStyle.get().group === "colour" ? muted() : folderColor(p.c.key);
		return mode() === "dark" ? brighten(hex, 1.25) : hex;
	};
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
		return clipText(
			p.c.name,
			W - 20 - 19 - (6 + p.depth * 14) - 16 - 6 - 15 - 6 - 8 - badge - (p.pinnedCopy ? 17 : 0),
			13,
			sel() ? 600 : 400,
		);
	};
	/** The drag is over this row and it may be dropped here (items go anywhere; a collection not into itself). */
	const over = () => dropKey() === p.c.key && (!colDrag() || validTarget(colDrag()!, p.c.key));
	return (
		<ListItem>
			<div
				ref={(el: HostElement) => {
					const id = p.pinnedCopy ? `pin:${p.c.key}` : p.c.key;
					rowEls.set(id, el);
					onCleanup(() => {
						if (rowEls.get(id) === el) rowEls.delete(id);
					});
				}}
				role="treeitem"
				aria-selected={sel()}
				onFileDrop={(e) => void handleFileDrop(e.paths ?? [], { collectionKey: p.c.key })}
				onClick={(e) => {
					if (Date.now() - childClickAt < 150 || Date.now() - justDragged < 250 || isEditing()) return;
					if ((e.clickCount ?? 1) >= 2) return setEditing(p.c.key);
					setView({ kind: "collection", key: p.c.key });
				}}
				onAuxClick={(e) => {
					if (e.isRightClick && visibleAt(e.x ?? 0, e.y ?? 0)) showCollectionMenu(p.c, e.x ?? 0, e.y ?? 0);
				}}
				onMouseEnter={() => setHov(true)}
				onMouseLeave={() => setHov(false)}
				onMouseDown={(e) => {
					if (e.button === 0 && !isEditing()) press = { key: p.c.key, x: e.x ?? 0, y: e.y ?? 0 };
				}}
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
				<Show
					when={style().icon}
					fallback={<svg source={folderSvg(open() || sel())} style={{ width: 15, height: 15, flexShrink: 0, color: tint() }} />}
				>
					<Icon name={style().icon!} size={15} color={tint()} />
				</Show>
				<Show
					when={isEditing()}
					fallback={
						<text
							style={{
								...tx(labelCls(sel())),
								overflow: "hidden",
								whiteSpace: "nowrap",
								minWidth: 0,
								flexGrow: 1,
								flexBasis: 0,
							}}
						>
							{name()}
						</text>
					}
				>
					<NameInput value={p.c.name} onDone={(v) => void commitRename(p.c, v)} onCancel={() => setEditing(null)} />
				</Show>
				<Show when={p.pinnedCopy}>
					<Icon name="pin" size={11} color={muted()} style={{ marginLeft: 4 }} />
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
				<NameInput
					value=""
					placeholder="Collection name"
					onDone={(v) => void commitCreate(p.parent, v)}
					onCancel={() => setCreating(null)}
				/>
			</div>
		</ListItem>
	);
}

/** Inline name field for a new / renamed section. */
function SectionInputRow(p: { initial: string }): JSX.Element {
	return (
		<ListItem>
			<div style={{ ...t(ROW), paddingLeft: 6 + 20 }}>
				<Icon name="folder-tree" size={15} color={muted()} />
				<NameInput value={p.initial} placeholder="Section name" onDone={commitSection} onCancel={() => setSectionInput(null)} />
			</div>
		</ListItem>
	);
}

const DOT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="currentColor"/></svg>';

/** A group header of the list: Pinned, a colour group or a section (click to collapse; sections: right-click to rename / delete). */
function GroupHeader(p: { h: HeaderRow; gap: number }): JSX.Element {
	const hex = () => paletteHex(p.h.color);
	return (
		<ListItem top={p.gap}>
			<div
				role="button"
				aria-expanded={!p.h.collapsed}
				aria-label={p.h.label}
				onClick={() => collectionStyle.toggleCollapsed(p.h.id)}
				onAuxClick={(e) => {
					if (e.isRightClick && p.h.section && visibleAt(e.x ?? 0, e.y ?? 0)) sectionHeaderMenu(p.h.section, e.x ?? 0, e.y ?? 0);
				}}
				style={{ ...t("flex min-h-6 items-center gap-1.5 rounded-md pl-1.5 pr-2"), cursor: "pointer", hover: t("bg-foreground/5") }}
			>
				<Icon name={p.h.collapsed ? "chevron-right" : "chevron-down"} size={12} color={muted()} />
				<Show when={hex()}>
					<svg
						source={DOT_SVG}
						style={{ width: 8, height: 8, flexShrink: 0, color: mode() === "dark" ? brighten(hex()!, 1.25) : hex()! }}
					/>
				</Show>
				<Show when={p.h.id === "pinned"}>
					<Icon name="pin" size={11} color={muted()} />
				</Show>
				<text
					style={{
						...tx("text-[11px] font-semibold text-muted-foreground"),
						flexGrow: 1,
						flexBasis: 0,
						minWidth: 0,
						whiteSpace: "nowrap",
						overflow: "hidden",
					}}
				>
					{p.h.label}
				</text>
				<text style={{ ...tx("text-[11px] text-muted-foreground"), whiteSpace: "nowrap" }}>{String(p.h.count)}</text>
			</div>
		</ListItem>
	);
}

/** Cancel a half-finished tree drag (button released elsewhere). */
export function endDrags() {
	press = null;
	if (colDrag()) {
		justDragged = Date.now();
		setColDrag(null);
	}
	setDropKey(null);
}

/** Registers the scrolling pane the rows live in (drops only count inside it). */
export const setCollectionsPane = (el: HostElement) => {
	paneEl = el;
};

/**
 * The Collections group as entries of the sidebar's virtual list: the header, then (while open) the new-collection field for the
 * top level, the visible rows of the tree in order (a collection's children right after it while it is expanded) and each inline
 * new-subcollection field right after its parent. `top` is the space above the header (the 16px gap between the groups).
 */
export function collectionEntries(top: number): Entry[] {
	const out: Entry[] = [
		{
			id: "c:header",
			render: () => (
				<ListItem top={top}>
					<div
						ref={(el: HostElement) => {
							headerEl = el;
						}}
						style={
							dropKey() === "root" && colDrag() && validTarget(colDrag()!, "root")
								? { outlineWidth: 2, outlineColor: tok("primary"), outlineOffset: -2, borderRadius: 8 }
								: {}
						}
					>
						<SectionHeader
							label="Collections"
							open={collectionsOpen()}
							onToggle={() => setCollectionsOpen(!collectionsOpen())}
							onContextMenu={headerMenu}
							actions={
								<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 2 }}>
									<DropdownMenu
										align="end"
										width={190}
										items={viewMenu}
										trigger={<IconButton name="arrow-up-down" box={20} icon={14} label="Sort and group collections" />}
									/>
									<IconButton name="plus" box={20} icon={16} label="New collection" onClick={() => startCreate("root")} />
								</div>
							}
						/>
					</div>
				</ListItem>
			),
		},
	];
	if (!collectionsOpen()) return out;
	// the new-collection field sits at the top so it is on screen however long the tree is
	if (creating() === "root") out.push({ id: "c:create:root", render: () => <CreateRow parent="root" padLeft={6} /> });
	const si = sectionInput();
	if (si) out.push({ id: "c:section-input", render: () => <SectionInputRow initial={si.kind === "rename" ? si.name : ""} /> });
	const d = collectionStyle.get();
	const rows = buildRows({
		collections: collections(),
		sort: d.sort,
		group: d.group,
		styles: d.styles,
		stamps: d.stamps,
		sections: d.sections,
		pins: d.pins,
		expanded: expanded(),
		collapsed: new Set(d.collapsed),
	});
	let first = true;
	for (const r of rows) {
		if (r.kind === "header") {
			out.push({ id: `c:h:${r.id}`, render: () => <GroupHeader h={r} gap={first ? 0 : 6} /> });
		} else {
			out.push({ id: r.id, render: () => <Row c={r.c} depth={r.depth} pinnedCopy={r.pinnedCopy} /> });
			if (!r.pinnedCopy && creating() === r.c.key)
				out.push({ id: `c:create:${r.c.key}`, render: () => <CreateRow parent={r.c.key} padLeft={6 + (r.depth + 1) * 14} /> });
		}
		first = false;
	}
	return out;
}
