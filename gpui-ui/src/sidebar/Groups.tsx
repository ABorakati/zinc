// The "Group Libraries" block of the sidebar: one row per group library (Zotero's heading of the same name), each opening that
// group's items, with its collection tree below when expanded. A read-only group shows a lock. Group collections can be
// browsed and created in (when the user may edit the group); renaming, styling and drag-and-drop stay My Library's.
import { createSignal, Show, type JSX } from "solid-js";
import type { Collection, Library } from "../contracts";
import { promptText } from "../features/kit";
import { Icon } from "../icons";
import { store } from "../store";
import { openMenu, toast } from "../ui";
import { currentView, setView } from "./bridge";
import { errMsg, sidebarApi } from "./client";
import { CountBadge, type Entry, folderSvg, labelCls, ListItem, muted, pill, ROW_HOVER, ROW_STATIC, SectionHeader, SPECIAL_STATIC, t, tok, tx } from "./parts";
import { buildGroupRows, libraryRowKey } from "./groupRows";
import { expandedKeys, groupsOpen, setExpandedKeys, setGroupsOpen } from "./state";

const libKey = libraryRowKey;
const isOpen = (key: string) => expandedKeys().includes(key);
const toggle = (key: string) => setExpandedKeys(isOpen(key) ? expandedKeys().filter((k) => k !== key) : [...expandedKeys(), key]);
const stop = (e: unknown) => (e as { stopPropagation?: () => void }).stopPropagation?.();

async function newCollection(lib: Library, parentKey?: string) {
	const name = await promptText({ title: `New collection in ${lib.name}`, confirmLabel: "Create", placeholder: "Name" });
	if (!name) return;
	try {
		await sidebarApi.createCollection(name, parentKey ?? null, lib.id);
		if (parentKey && !isOpen(parentKey)) toggle(parentKey);
		else if (!parentKey && !isOpen(libKey(lib.id))) toggle(libKey(lib.id));
		store.refresh();
	} catch (e) {
		toast("Could not create the collection", { kind: "error", description: errMsg(e) });
	}
}

function LibraryRow(p: { lib: Library; hasCollections: boolean }): JSX.Element {
	const sel = () => store.libraryId() === p.lib.id && currentView().kind === "library";
	const [hov, setHov] = createSignal(false);
	return (
		<ListItem>
			<div
				role="treeitem"
				aria-selected={sel()}
				aria-expanded={p.hasCollections ? isOpen(libKey(p.lib.id)) : undefined}
				aria-label={p.lib.editable ? p.lib.name : `${p.lib.name} (read-only)`}
				onClick={() => store.selectLibrary(p.lib.id)}
				onAuxClick={(e) => {
					if (!e.isRightClick) return;
					openMenu({ x: e.x ?? 0, y: e.y ?? 0 }, [
						{ label: "New Collection…", icon: "folder-plus", disabled: !p.lib.editable, onSelect: () => void newCollection(p.lib) },
						{ label: "Refresh", icon: "refresh-cw", onSelect: () => void store.reloadLibraries().then(() => store.refresh()) },
					]);
				}}
				onMouseEnter={() => setHov(true)}
				onMouseLeave={() => setHov(false)}
				style={{ ...t(SPECIAL_STATIC), paddingLeft: 6, ...(hov() ? t(ROW_HOVER) : {}), ...pill(sel()) }}
			>
				<div onClick={(e) => { stop(e); if (p.hasCollections) toggle(libKey(p.lib.id)); }} style={t("flex size-4 flex-none items-center justify-center")}>
					<Show when={p.hasCollections}>
						<Icon name={isOpen(libKey(p.lib.id)) ? "chevron-down" : "chevron-right"} size={14} color={muted()} />
					</Show>
				</div>
				<Icon name="users" size={16} color={tok(sel() ? "primary" : "muted-foreground")} />
				<text style={{ ...tx(labelCls(sel())), overflow: "hidden", whiteSpace: "nowrap", minWidth: 0, flexGrow: 1, flexBasis: 0 }}>{p.lib.name}</text>
				<Show when={!p.lib.editable}>
					<Icon name="lock" size={12} color={muted()} />
				</Show>
			</div>
		</ListItem>
	);
}

function CollectionRow(p: { lib: Library; c: Collection; depth: number }): JSX.Element {
	const kids = () => p.c.children ?? [];
	const sel = () => {
		const v = currentView();
		return v.kind === "collection" && v.key === p.c.key;
	};
	const [hov, setHov] = createSignal(false);
	return (
		<ListItem>
			<div
				role="treeitem"
				aria-selected={sel()}
				aria-expanded={kids().length ? isOpen(p.c.key) : undefined}
				onClick={() => setView({ kind: "collection", key: p.c.key })}
				onAuxClick={(e) => {
					if (!e.isRightClick) return;
					openMenu({ x: e.x ?? 0, y: e.y ?? 0 }, [{ label: "New Subcollection…", icon: "folder-plus", disabled: !p.lib.editable, onSelect: () => void newCollection(p.lib, p.c.key) }]);
				}}
				onMouseEnter={() => setHov(true)}
				onMouseLeave={() => setHov(false)}
				style={{ ...t(ROW_STATIC), cursor: "pointer", paddingLeft: 6 + p.depth * 14, ...(hov() ? t(ROW_HOVER) : {}), ...pill(sel()) }}
			>
				<div onClick={(e) => { stop(e); if (kids().length) toggle(p.c.key); }} style={t("flex size-4 flex-none items-center justify-center")}>
					<Show when={kids().length}>
						<Icon name={isOpen(p.c.key) ? "chevron-down" : "chevron-right"} size={14} color={muted()} />
					</Show>
				</div>
				<svg source={folderSvg(isOpen(p.c.key) || sel())} style={{ width: 15, height: 15, flexShrink: 0, color: muted() }} />
				<text style={{ ...tx(labelCls(sel())), overflow: "hidden", whiteSpace: "nowrap", minWidth: 0, flexGrow: 1, flexBasis: 0 }}>{p.c.name}</text>
				<CountBadge n={p.c.itemCount} />
			</div>
		</ListItem>
	);
}

/** The block's entries for the sidebar's virtual list; nothing when the account has no groups. */
export function groupEntries(top: number): Entry[] {
	const rows = buildGroupRows({ libraries: store.libraries(), trees: store.groupCollections(), open: groupsOpen(), expanded: new Set(expandedKeys()) });
	return rows.map((r): Entry => {
		if (r.kind === "header") {
			return {
				id: r.id,
				render: () => (
					<ListItem top={top}>
						<SectionHeader label="Group Libraries" open={groupsOpen()} onToggle={() => setGroupsOpen(!groupsOpen())} />
					</ListItem>
				),
			};
		}
		if (r.kind === "library") return { id: r.id, render: () => <LibraryRow lib={r.lib} hasCollections={r.hasCollections} /> };
		return { id: r.id, render: () => <CollectionRow lib={r.lib} c={r.c} depth={r.depth} /> };
	});
}
