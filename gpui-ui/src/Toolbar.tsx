// Toolbar (quick-search mode, search box, List/Classic toggle, Tools, Add) and the Group / Sort bar under it.
// Mirrors Toolbar in ui/src/App.tsx, QuickSearchMode.tsx and SortBar.tsx with the same class strings.
import { createMemo, For, onCleanup, Show } from "solid-js";
import { useGpuix } from "@gpuix/solid";
import { openCustomize } from "./cards/Customize";
import { registerSearchFocus } from "./cards/keys";
import type { GroupBy, Mode, SortLevel, Style } from "./contracts";
import { Icon } from "./icons";
import { appActions } from "./registry";
import { defaultDir, GROUP_BY, MAX_LEVELS, store, type QMode } from "./store";
import { isNumericKey, moreColumns, SORT_OPTIONS, sortLabel } from "./table/defs";
import { shadows, textStyle, tokens, tw, type BoxShadow } from "./theme";
import { DropdownMenu, type MenuItem } from "./ui";

const mode = (): Mode => store.mode();
const t = (cls: string): Style => tw(cls, mode());
const tx = (cls: string): Style => textStyle(cls, mode());
const tok = (name: string): string => tokens[mode()][name] ?? "#888";

/** GPUIX has no display:none that takes the box out of the layout: collapse it and hide it. The subtree stays mounted. */
const HIDDEN: Style = {
	display: "none",
	visibility: "hidden",
	width: 0,
	height: 0,
	flexGrow: 0,
	flexShrink: 1,
	overflow: "hidden",
	padding: 0,
	paddingTop: 0,
	paddingBottom: 0,
	paddingLeft: 0,
	paddingRight: 0,
	margin: 0,
	marginLeft: 0,
	borderBottomWidth: 0,
};

// ------------------------------------------------------------------------------------------------ quick search mode

type SearchMode = QMode | "fulltext";
export const QUICK_MODES: { mode: SearchMode; label: string; hint: string }[] = [
	{ mode: "titleCreatorYear", label: "Title, Creator, Year", hint: "Match words in the title, creators or year" },
	{ mode: "fields", label: "All Fields & Tags", hint: "Match any field, creator or tag" },
	{ mode: "everything", label: "Everything", hint: "Also match notes and attachment full text" },
	{ mode: "fulltext", label: "Full text", hint: "Search inside PDFs and notes, showing the matching passages" },
];
const currentMode = (): SearchMode => (store.fulltext() ? "fulltext" : store.qmode());

/**
 * QuickSearchMode: what the search box matches, as a quiet prefix INSIDE the search field ("Title, Creator, Year ▾ │ 🔍 Search…"):
 * no border or fill of its own, a hover wash like the toolbar's other ghost buttons. (The web UI had a separate bordered
 * select beside the field; a lone white box among the toolbar's grey controls looked out of place.)
 */
function QuickSearchMode() {
	const items = (): MenuItem[] =>
		QUICK_MODES.map((m) => ({
			label: m.label,
			checked: currentMode() === m.mode,
			onSelect: () => {
				store.setFulltext(m.mode === "fulltext");
				if (m.mode !== "fulltext") store.setQMode(m.mode);
			},
		}));
	return (
		<DropdownMenu
			items={items}
			width={200}
			style={{ flexShrink: 0, marginLeft: 3 }}
			trigger={
				<div
					role="button"
					aria-label="Quick search mode"
					style={{
						...t("flex h-[30px] flex-none items-center gap-1 rounded-md pl-2.5 pr-1.5"),
						cursor: "pointer",
						hover: t("bg-foreground/5"),
					}}
				>
					<text style={{ ...tx("text-xs font-medium text-muted-foreground"), whiteSpace: "nowrap" }}>
						{QUICK_MODES.find((m) => m.mode === currentMode())?.label ?? "Title, Creator, Year"}
					</text>
					<Icon name="chevron-down" size={13} color={tok("muted-foreground")} />
				</div>
			}
		/>
	);
}

/** Search box: h-9 rounded-lg bg-muted field; the quick-search mode picker, a divider and the search icon sit inside it, at left. */
function SearchBox() {
	const gpuix = useGpuix();
	let input: { id: number } | undefined;
	registerSearchFocus(() => {
		if (input) gpuix?.renderer.focusElement?.(input.id);
	});
	onCleanup(() => registerSearchFocus(undefined));
	return (
		<div style={t("relative flex h-9 min-w-0 flex-1 items-center rounded-lg bg-muted")}>
			<QuickSearchMode />
			<div style={{ width: 1, height: 18, flexShrink: 0, marginLeft: 6, marginRight: 10, backgroundColor: tok("border") }} />
			<div style={{ display: "flex", alignItems: "center", flexShrink: 0, pointerEvents: "none" }}>
				<Icon name="search" size={15} color={tok("muted-foreground")} />
			</div>
			<input
				ref={(el: { id: number }) => {
					input = el;
				}}
				value={store.filter()}
				placeholder={store.fulltext() ? "Search full text…" : "Search titles, authors, year…"}
				onChange={(e) => store.setFilter((e as { value?: string }).value ?? "")}
				style={{
					flexGrow: 1,
					minWidth: 0,
					height: 36,
					paddingLeft: 8,
					paddingRight: 12,
					fontSize: 13,
					fontFamily: "Inter",
					color: tok("foreground"),
				}}
				theme={{
					appearance: mode(),
					bg: tok("muted"),
					text: tok("foreground"),
					textMuted: tok("muted-foreground"),
					textFaint: tok("muted-foreground"),
					textDim: tok("muted-foreground"),
					accent: tok("primary"),
					caret: tok("primary"),
					fontSans: "Inter",
				}}
			/>
		</div>
	);
}

/** View toggle: inline-flex rounded-lg bg-muted p-[3px]; buttons h-[30px] rounded-md px-2.5 text-[13px] gap-1.5. */
function ViewToggle() {
	const items = [
		{ id: "cards" as const, text: "List", icon: "layout-list" },
		{ id: "table" as const, text: "Classic", icon: "table-2" },
	];
	return (
		<div style={t("flex flex-none rounded-lg bg-muted p-[3px]")}>
			<For each={items}>
				{(m) => {
					const on = () => store.viewMode() === m.id;
					return (
						<div
							role="button"
							aria-label={m.id === "cards" ? "Card view" : "Table view"}
							aria-selected={on()}
							onClick={() => store.setViewMode(m.id)}
							style={{
								...t("flex h-[30px] items-center gap-1.5 rounded-md px-2.5"),
								cursor: "pointer",
								...(on()
									? { backgroundColor: tok("background"), boxShadow: tw("shadow-sm", mode()).boxShadow as BoxShadow[] }
									: {}),
							}}
						>
							<Icon name={m.icon} size={14} color={tok(on() ? "foreground" : "muted-foreground")} />
							<text style={tx(on() ? "text-[13px] font-medium text-foreground" : "text-[13px] text-muted-foreground")}>
								{m.text}
							</text>
						</div>
					);
				}}
			</For>
		</div>
	);
}

/** Registered app actions of a toolbar menu ("tools" wrench / "add" +). Collapsed while the menu has no entries. */
function ActionMenu(p: { menu: "add" | "tools" }) {
	const list = createMemo(() => appActions().filter((a) => a.menu === p.menu && (a.when?.() ?? true)));
	const items = (): MenuItem[] =>
		list().map((a) => ({
			label: typeof a.label === "function" ? a.label() : a.label,
			icon: a.icon,
			shortcut: a.shortcut,
			onSelect: () => a.run(),
		}));
	return (
		<div style={{ display: "flex", flexDirection: "row", marginLeft: 10, ...(list().length ? {} : HIDDEN) }}>
			<DropdownMenu
				items={items}
				align="end"
				width={240}
				trigger={
					p.menu === "add" ? (
						/* Add: h-9 rounded-lg bg-primary px-3.5 text-[13px] font-medium text-primary-foreground shadow-primary */
						<div
							role="button"
							aria-label="Add items"
							style={{
								...t("flex h-9 flex-none items-center gap-1.5 rounded-lg bg-primary px-3.5"),
								boxShadow: shadows[mode()].primary,
								cursor: "pointer",
							}}
						>
							<Icon name="plus" size={14} color={tok("primary-foreground")} />
							<text style={tx("text-[13px] font-medium text-primary-foreground")}>Add</text>
						</div>
					) : (
						/* Tools: size-8 rounded-lg icon button */
						<div
							role="button"
							aria-label="Tools"
							style={{
								...t("flex size-8 flex-none items-center justify-center rounded-lg"),
								cursor: "pointer",
								hover: t("bg-foreground/5"),
							}}
						>
							<Icon name="wrench" size={16} color={tok("muted-foreground")} />
						</div>
					)
				}
			/>
		</div>
	);
}

/** GPUIX cache region sized by its content (Toolbar, SortBar); typed because the host style type does not list the key. */
const CONTENT_REGION: Style = { cacheRegion: "content" };

/** flex flex-none items-center gap-2.5 border-b border-border-soft px-4 pt-3.5 pb-2.5 */
export function Toolbar() {
	return (
		// cacheRegion "content": drawn by its own cached GPUI view at the height it last painted with (re-measured whenever its
		// subtree changes), so list scrolling does not rebuild the toolbar every frame.
		<div
			style={{ ...t("flex flex-none items-center border-b border-border-soft px-4 pt-3.5 pb-2.5"), width: "100%", ...CONTENT_REGION }}
		>
			<SearchBox />
			<div style={{ width: 10, flexShrink: 0 }} />
			<ViewToggle />
			{/* each menu carries its own 10px left margin and collapses while it is empty (an empty <Show> would add a flex item) */}
			<ActionMenu menu="tools" />
			<ActionMenu menu="add" />
		</div>
	);
}

// ------------------------------------------------------------------------------------------------ Group / Sort bar

const chipBase = "flex h-[26px] flex-none items-center rounded-full border";
const KNOWN = new Set(SORT_OPTIONS.map((o) => o.key));
const dirLabel = (l: SortLevel) => (isNumericKey(l.key) ? (l.dir === "asc" ? "↑" : "↓") : l.dir === "asc" ? "A–Z" : "Z–A");

/** All sortable keys as radio items (the common ones, then every other schema field). */
function keyItems(current: string | null, exclude: (key: string) => boolean, pick: (key: string) => void): MenuItem[] {
	const out: MenuItem[] = SORT_OPTIONS.filter((o) => !exclude(o.key)).map((o) => ({
		label: o.label,
		checked: o.key === current,
		onSelect: () => pick(o.key),
	}));
	const more = moreColumns().filter((c) => !KNOWN.has(c.id) && !exclude(c.id));
	if (more.length) {
		out.push({ separator: true }, { heading: "More fields" });
		out.push(...more.map((c) => ({ label: c.label, checked: c.id === current, onSelect: () => pick(c.id) })));
	}
	return out;
}

function LevelChip(p: { level: SortLevel; index: number }) {
	const levels = () => store.sortLevels();
	const locked = () => p.index === 0 && store.groupBy() !== "none";
	const removable = () => !locked() && levels().length > 1;
	const replace = (next: SortLevel | null) =>
		store.setSortLevels(levels().flatMap((l, i) => (i === p.index ? (next ? [next] : []) : next && l.key === next.key ? [] : [l])));
	const flip = () => replace({ key: p.level.key, dir: p.level.dir === "asc" ? "desc" : "asc" });
	const menu = (): MenuItem[] => {
		const out: MenuItem[] = [
			{ heading: `Sort level ${p.index + 1} by` },
			...keyItems(
				p.level.key,
				() => false,
				(key) => replace({ key, dir: defaultDir(key) }),
			),
		];
		if (removable()) out.push({ separator: true }, { label: "Remove level", danger: true, onSelect: () => replace(null) });
		return out;
	};
	const label = (
		<div style={t("flex h-full items-center gap-1.5 pl-2.5 pr-1")}>
			<text style={tx("text-xs font-semibold text-foreground/90")}>{String(p.index + 1)}</text>
			<text style={{ ...tx("text-xs text-foreground/90"), whiteSpace: "nowrap" }}>{sortLabel(p.level.key)}</text>
		</div>
	);
	return (
		<div role="group" aria-label={`Sort level ${p.index + 1}`} style={t(`${chipBase} border-border bg-card`)}>
			<Show when={!locked()} fallback={label}>
				<DropdownMenu
					items={menu}
					width={208}
					trigger={<div style={{ ...t("flex h-full rounded-l-full hover:bg-accent/60"), cursor: "pointer" }}>{label}</div>}
				/>
			</Show>
			<div
				role="button"
				aria-label="Reverse sort direction"
				onClick={flip}
				style={{
					...t("flex h-full min-w-6 items-center justify-center rounded-r-full pl-1 pr-2.5 hover:bg-accent/60"),
					cursor: "pointer",
				}}
			>
				<text style={tx("text-xs text-muted-foreground")}>{dirLabel(p.level)}</text>
			</div>
		</div>
	);
}

function GroupChip() {
	const none = () => store.groupBy() === "none";
	const items = (): MenuItem[] => [
		{ heading: "Group by" },
		...GROUP_BY.map((g) => ({ label: g.label, checked: g.id === store.groupBy(), onSelect: () => store.setGroupBy(g.id as GroupBy) })),
	];
	return (
		<DropdownMenu
			items={items}
			width={176}
			trigger={
				<div
					role="button"
					aria-label="Group by"
					style={{
						...t(`${chipBase} gap-1 px-2.5 ${none() ? "border-border bg-card" : "border-primary/25 bg-primary/10"}`),
						cursor: "pointer",
					}}
				>
					<text style={tx(`text-xs font-medium ${none() ? "text-foreground/80" : "text-primary"}`)}>
						{GROUP_BY.find((g) => g.id === store.groupBy())?.label ?? "None"}
					</text>
					<Icon name="chevron-down" size={12} color={tok(none() ? "foreground" : "primary")} style={{ opacity: 0.7 }} />
				</div>
			}
		/>
	);
}

function AddLevel() {
	const used = () => new Set(store.sortLevels().map((l) => l.key));
	const items = (): MenuItem[] => [
		{ heading: "Then sort by" },
		...keyItems(
			null,
			(k) => used().has(k),
			(key) => store.setSortLevels([...store.sortLevels(), { key, dir: defaultDir(key) }]),
		),
	];
	return (
		<div style={{ display: "flex", flexDirection: "row", ...(store.sortLevels().length < MAX_LEVELS ? {} : HIDDEN) }}>
			<DropdownMenu
				items={items}
				width={208}
				trigger={
					<div
						role="button"
						aria-label="Add sort level"
						style={{ ...t(`${chipBase} gap-1 border-dashed border-border px-2`), cursor: "pointer" }}
					>
						<Icon name="plus" size={12} color={tok("muted-foreground")} />
						<text style={{ ...tx("text-xs text-muted-foreground"), whiteSpace: "nowrap" }}>Add level</text>
					</div>
				}
			/>
		</div>
	);
}

/** flex flex-wrap items-center gap-2 border-b px-5 py-1.5 text-xs text-muted-foreground */
export function SortBar() {
	// "N selected" replaces the total while something is selected (the bar does not wrap, so the longer text would not fit)
	const count = () => {
		const sel = store.selected().size;
		if (sel > 0) return `${sel.toLocaleString("en-GB")} selected`;
		return `${store.total().toLocaleString("en-GB")} ${store.total() === 1 ? "item" : "items"}${store.loading() ? " · loading…" : ""}`;
	};
	// the sort bar belongs to the item list: the full-text results have their own header-less list
	return (
		<div
			style={{
				...t("flex flex-none items-center gap-2 border-b px-5 py-1.5"),
				width: "100%",
				overflow: "hidden",
				...CONTENT_REGION,
				...(store.fulltext() ? HIDDEN : {}),
			}}
		>
			<div style={t("flex items-center gap-1.5")}>
				<Icon name="layout-panel-top" size={14} color={tok("muted-foreground")} />
				<text style={tx("text-xs text-muted-foreground")}>Group</text>
			</div>
			<GroupChip />
			<div style={t("h-4 w-px bg-border mx-1")} />
			<div style={t("flex items-center gap-1.5")}>
				<Icon name="arrow-down-up" size={14} color={tok("muted-foreground")} />
				<text style={tx("text-xs text-muted-foreground")}>Sort</text>
			</div>
			<For each={store.sortLevels()}>
				{(l, i) => (
					<div style={{ display: "flex", flexDirection: "row", alignItems: "center" }}>
						<text
							style={
								i() > 0
									? { ...tx("text-xs text-muted-foreground"), marginRight: 8 }
									: { ...tx("text-xs text-muted-foreground"), ...HIDDEN }
							}
						>
							›
						</text>
						<LevelChip level={l} index={i()} />
					</div>
				)}
			</For>
			<AddLevel />
			<div style={{ flexGrow: 1 }} />
			<text
				style={{
					...tx("text-xs text-muted-foreground"),
					whiteSpace: "nowrap",
					overflow: "hidden",
					textOverflow: "ellipsis",
					flexShrink: 1,
					minWidth: 0,
				}}
			>
				{count()}
			</text>
			{/* Customise (cards view trailing control): ghost button with a sliders icon */}
			<div
				role="button"
				aria-label="Customise rows"
				onClick={() => openCustomize()}
				style={{
					...t("flex h-6 items-center gap-1.5 rounded-md px-2"),
					cursor: "pointer",
					hover: t("bg-foreground/5"),
					...(store.viewMode() === "cards" ? {} : HIDDEN),
				}}
			>
				<Icon name="settings-2" size={14} color={tok("muted-foreground")} />
				<text style={tx("text-xs text-muted-foreground")}>Customise</text>
			</div>
		</div>
	);
}
