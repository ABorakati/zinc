// "Saved Searches" under the Library rows in the left pane (ui/src/searches/SavedSearches.tsx): list, select -> savedSearch view,
// rename inline, edit via the Advanced Search dialog, delete, "+" opens a fresh advanced search.
import { createSignal, Show, type JSX } from "solid-js";
import { Icon } from "../icons";
import { currentView, refreshStore, setView } from "../sidebar/bridge";
import { errMsg, sidebarApi, type SavedSearch } from "../sidebar/client";
import { NameInput } from "../sidebar/NameInput";
import { type Entry, IconButton, labelCls, ListItem, pill, SPECIAL, t, tok, TRUNCATE, tracked, tx } from "../sidebar/parts";
import { confirm, openMenu, toast } from "../ui";
import { openAdvancedSearch } from "./AdvancedSearch";
import { refreshSavedSearches, savedSearches } from "./state";

const [renaming, setRenaming] = createSignal<string | null>(null);
const [menuKey, setMenuKey] = createSignal<string | null>(null);

async function commitRename(s: SavedSearch, name: string) {
	setRenaming(null);
	const n = name.trim();
	if (!n || n === s.name) return;
	try {
		await sidebarApi.patchSavedSearch(s.key, { name: n });
		await refreshSavedSearches();
	} catch (e) { toast("Could not rename search", { kind: "error", description: errMsg(e) }); }
}

async function remove(s: SavedSearch) {
	const ok = await confirm({
		title: `Delete saved search "${s.name}"?`,
		body: "Only the search is removed; your items are not affected.",
		confirmLabel: "Delete",
		danger: true,
	});
	if (!ok) return;
	try {
		await sidebarApi.deleteSavedSearch(s.key);
		const v = currentView();
		if (v.kind === "savedSearch" && v.key === s.key) setView({ kind: "library" });
		await refreshSavedSearches();
		refreshStore();
		toast(`Deleted saved search "${s.name}"`, { kind: "success" });
	} catch (e) { toast("Could not delete search", { kind: "error", description: errMsg(e) }); }
}

function showMenu(s: SavedSearch, x: number, y: number) {
	setMenuKey(s.key);
	openMenu({ x, y }, [
		{ label: "Edit Search…", icon: "pencil", onSelect: () => void openAdvancedSearch(s.key) },
		{ label: "Rename", icon: "text-cursor-input", onSelect: () => setRenaming(s.key) },
		{ separator: true },
		{ label: "Delete…", icon: "trash-2", danger: true, onSelect: () => void remove(s) },
	]);
	setTimeout(() => setMenuKey((k) => (k === s.key ? null : k)), 3000);
}

const active = (k: string) => {
	const v = currentView();
	return v.kind === "savedSearch" && v.key === k;
};

function SavedSearchRow(p: { s: SavedSearch }): JSX.Element {
	const s = p.s;
	return (
		<div
			role="treeitem"
			aria-selected={active(s.key)}
			onClick={(e) => {
				if (renaming() === s.key) return;
				if ((e.clickCount ?? 1) >= 2) void openAdvancedSearch(s.key);
				else setView({ kind: "savedSearch", key: s.key });
			}}
			onAuxClick={(e) => { if (e.isRightClick) showMenu(s, e.x ?? 0, e.y ?? 0); }}
			style={{
				...t(SPECIAL),
				...(menuKey() === s.key && !active(s.key) ? { backgroundColor: tok("accent") } : {}),
				...pill(active(s.key)),
			}}
		>
			<Icon name="search" size={16} color={tok(active(s.key) ? "primary" : "muted-foreground")} />
			<Show
				when={renaming() === s.key}
				fallback={<text style={{ ...tx(labelCls(active(s.key))), ...TRUNCATE, flexGrow: 1, flexBasis: 0 }}>{s.name}</text>}
			>
				<NameInput value={s.name} onDone={(v) => void commitRename(s, v)} onCancel={() => setRenaming(null)} />
			</Show>
		</div>
	);
}

/**
 * The "Saved Searches" sub-section of the Library group, as entries of the sidebar's virtual list: a header (label + "+"), then one
 * row per search or the empty note. Inside the block the rows have no gap (`gap={0}`), as the old `flex flex-col` column had.
 */
export function savedSearchEntries(): Entry[] {
	const list = savedSearches();
	const out: Entry[] = [{
		id: "ss:header",
		render: () => (
			<ListItem gap={0}>
				<div style={t("flex items-center justify-between py-1 pl-2 pr-1 pt-2")}>
					<text style={tx("text-[11px] font-semibold text-muted-foreground")}>{tracked("Saved Searches")}</text>
					<IconButton name="plus" box={24} icon={16} label="Advanced search" onClick={() => void openAdvancedSearch()} />
				</div>
			</ListItem>
		),
	}];
	if (!list.length) {
		out.push({
			id: "ss:empty",
			render: () => (
				<ListItem gap={0}>
					<div style={t("px-6 py-1")}>
						<text style={tx("text-xs text-muted-foreground")}>No saved searches</text>
					</div>
				</ListItem>
			),
		});
	}
	for (const s of list) out.push({ id: `ss:${s.key}`, render: () => <ListItem gap={0}><SavedSearchRow s={s} /></ListItem> });
	return out;
}
