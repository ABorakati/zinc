// Left sidebar of the library window: LIBRARY (My Library / Unfiled / Trash / Duplicate Items), SAVED SEARCHES,
// COLLECTIONS tree and the collapsed TAGS header. Mirrors ui/src/Collections.tsx + sidebar.tsx + Tags.tsx (header only)
// with the same Tailwind class strings, resolved through tw() / textStyle() so the look comes from the shared tokens.
import { createSignal, For, Show, type JSX } from "solid-js";
import type { Collection, Mode, Style } from "./contracts";
import { Icon } from "./icons";
import { store } from "./store";
import { textStyle, tokens, tw } from "./theme";

// ---- ui/src/sidebar.tsx: folder colours ----

/** Folder colours (stroke) from the Quiet Paper design; the fill is the same colour at 16% opacity. */
const FOLDER_COLORS = ["#2B5FA8", "#B2457A", "#B76A12", "#1F7A62", "#6A4FC8", "#C0532E", "#5F6B7A"];

/** Deterministic colour for a collection key (FNV-1a hash into the palette). */
export function collectionColor(key: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < key.length; i++) {
		h ^= key.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return FOLDER_COLORS[(h >>> 0) % FOLDER_COLORS.length]!;
}

/** `dark:brightness-125` on the folder icons. */
function brighten(hex: string, f: number): string {
	const n = parseInt(hex.slice(1), 16);
	const c = (s: number) => Math.min(255, Math.round(((n >> s) & 255) * f));
	return `rgb(${c(16)}, ${c(8)}, ${c(0)})`;
}

/** Stroke colour of a collection's folder; dark mode brightens it by 25% (`dark:brightness-125`). */
const folderColor = (key: string, mode: Mode) => (mode === "dark" ? brighten(collectionColor(key), 1.25) : collectionColor(key));

// lucide "folder" / "folder-open", drawn here (not via <Icon>) so the body can carry the 16% tint fill of folderStyle()
const FOLDER_PATH =
	"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z";
const FOLDER_OPEN_PATH =
	"m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2";

/** GPUIX tints an <svg> with style.color (a mask), so stroke and the 16% fill share one colour via fill-opacity. */
function folderSvg(open: boolean): string {
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="currentColor" fill-opacity="0.16" ` +
		`stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${open ? FOLDER_OPEN_PATH : FOLDER_PATH}"/></svg>`
	);
}

// ---- class strings copied from the web UI ----

// sidebar.tsx SectionHeader
const HEADER_ROW = "flex flex-none items-center justify-between pr-1";
const HEADER_BTN = "flex min-w-0 items-center gap-1.5 rounded-md px-2.5 pt-0.5 pb-1.5 text-left";
const HEADER_TEXT = "text-[11px] font-semibold text-muted-foreground"; // + uppercase tracking-[0.06em] (see tracked())
// Collections.tsx
const ROW = "relative flex min-h-7 items-center gap-1.5 rounded-lg pr-2 hover:bg-foreground/5";
const SPECIAL = "relative flex min-h-7 cursor-pointer items-center gap-1 rounded-lg pl-6 pr-2 hover:bg-foreground/5";
const BADGE = "inline-flex h-[18px] min-w-[22px] flex-none items-center justify-center rounded-full bg-border-soft px-1.5";

/** CSS `uppercase tracking-[0.06em]` for 11px text: GPUIX has no letter-spacing, so uppercase the label only. */
const tracked = (s: string) => s.toUpperCase();

/** Width a thin web scrollbar takes beside the content (Chromium, Windows). */
const SCROLLBAR_GUTTER = 11;

const TRUNCATE: Style = { overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", minWidth: 0 };

export function Sidebar(): JSX.Element {
	const mode = (): Mode => store.mode();
	const t = (cls: string): Style => tw(cls, mode());
	const tx = (cls: string): Style => textStyle(cls, mode());
	const muted = () => tokens[mode()]["muted-foreground"]!;

	// open/closed state of the sections (persistedFlag in the web UI; library/collections open, tags closed)
	const [libOpen, setLibOpen] = createSignal(true);
	const [colOpen, setColOpen] = createSignal(true);
	const [tagsOpen, setTagsOpen] = createSignal(false);
	const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());

	const toggle = (key: string) => {
		const s = new Set(expanded());
		if (s.has(key)) s.delete(key);
		else s.add(key);
		setExpanded(s);
	};
	// A chevron click must not also select the row: GPUI delivers the click to the chevron's and the row's handler.
	let chevronAt = 0;
	// Unfiled / Trash go through the store as the keys "unfiled" / "trash" (it turns them into the API's view flags)
	const isSelected = (key: string | null) => store.selectedCollection() === key;
	const select = (key: string | null) => store.selectCollection(key);

	// ---- pieces ----

	function SectionHeader(p: { label: string; open: boolean; onToggle: () => void; icon?: string; actions?: JSX.Element }) {
		return (
			<div style={t(HEADER_ROW)}>
				<div
					role="button"
					aria-expanded={p.open}
					aria-label={p.label}
					onClick={p.onToggle}
					style={{ ...t(HEADER_BTN), cursor: "pointer", hover: { ...t("text-foreground") } }}
				>
					<Icon name={p.open ? "chevron-down" : "chevron-right"} size={12} color={muted()} />
					<Show when={p.icon}>
						<Icon name={p.icon!} size={12} color={muted()} />
					</Show>
					<text style={tx(HEADER_TEXT)}>{tracked(p.label)}</text>
				</div>
				{p.actions}
			</div>
		);
	}

	/** ghost icon button: `inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-accent` */
	function IconButton(p: { name: string; box: number; icon: number; label: string; onClick?: () => void }) {
		return (
			<div
				role="button"
				aria-label={p.label}
				onClick={p.onClick}
				style={{
					...t("inline-flex flex-none items-center justify-center rounded-md hover:bg-accent"),
					width: p.box,
					height: p.box,
					cursor: "pointer",
				}}
			>
				<Icon name={p.name} size={p.icon} color={muted()} />
			</div>
		);
	}

	/** Selected treeitem: the raised pill from styles.css (`[role="treeitem"][aria-selected="true"]`). */
	const pill = (sel: boolean): Style => {
		if (!sel) return {};
		const s = t("bg-background shadow-pill");
		return { ...s, hover: s };
	};
	const labelCls = (sel: boolean) => (sel ? "text-[13px] font-semibold text-primary-deep" : "text-[13px] text-foreground/90");

	function Special(p: { kind: string | null; label: string; icon: string }) {
		const sel = () => isSelected(p.kind);
		return (
			<div
				role="treeitem"
				aria-selected={sel()}
				onClick={() => select(p.kind)}
				style={{ ...t(SPECIAL), ...pill(sel()) }}
			>
				<Icon name={p.icon} size={16} color={tokens[mode()][sel() ? "primary" : "muted-foreground"]!} />
				<text style={{ ...tx(labelCls(sel())), ...TRUNCATE, flexGrow: 1, flexBasis: 0 }}>{p.label}</text>
			</div>
		);
	}

	function CountBadge(p: { n: number }) {
		return (
			<Show when={p.n}>
				<div style={{ ...t(BADGE), marginLeft: 4 }}>
					<text style={{ ...tx("text-[11px] font-semibold text-secondary-foreground"), whiteSpace: "nowrap" }}>
						{p.n.toLocaleString("en-US")}
					</text>
				</div>
			</Show>
		);
	}

	function Row(p: { c: Collection; depth: number }): JSX.Element {
		const kids = () => p.c.children ?? [];
		const open = () => expanded().has(p.c.key);
		const sel = () => isSelected(p.c.key);
		return (
			<>
				<div
					role="treeitem"
					aria-selected={sel()}
					onClick={() => {
						if (Date.now() - chevronAt < 150) return;
						select(p.c.key);
					}}
					style={{ ...t(ROW), cursor: "pointer", paddingLeft: 6 + p.depth * 14, ...pill(sel()) }}
				>
					<div
						onClick={() => {
							chevronAt = Date.now();
							if (kids().length) toggle(p.c.key);
						}}
						style={t("flex size-4 flex-none items-center justify-center")}
					>
						<Show when={kids().length}>
							<Icon name={open() ? "chevron-down" : "chevron-right"} size={14} color={muted()} />
						</Show>
					</div>
					<svg
						source={folderSvg(open() || sel())}
						style={{ width: 15, height: 15, flexShrink: 0, color: folderColor(p.c.key, mode()) }}
					/>
					<text style={{ ...tx(labelCls(sel())), ...TRUNCATE, flexGrow: 1, flexBasis: 0 }}>{p.c.name}</text>
					<CountBadge n={p.c.itemCount} />
				</div>
				<Show when={open()}>
					<For each={kids()}>{(c) => <Row c={c} depth={p.depth + 1} />}</For>
				</Show>
			</>
		);
	}

	// ---- layout ----

	return (
		// App.tsx: `zn-sidebar flex h-full min-h-0 flex-col gap-3 px-2.5 pt-1.5 pb-1`
		<div style={{ ...t("flex h-full min-h-0 w-full flex-col gap-3 px-2.5 pt-1.5 pb-1") }}>
			{/* CollectionsPane: `flex min-h-0 flex-col overflow-y-auto pr-2`, flex 3 1 0% (open) */}
			<div
				style={{
					...t("flex min-h-0 flex-col overflow-y-auto pr-2"),
					// web scrollbars (`scrollbar-width: thin`, ~11px) take layout space beside the pr-2; GPUIX's thumb overlays the
					// container's right edge, so reserve that gutter here and the thumb stays clear of the rows
					paddingRight: 8 + SCROLLBAR_GUTTER,
					flexGrow: colOpen() ? 3 : 0,
					flexShrink: 1,
					...(colOpen() ? { flexBasis: 0 } : {}),
				}}
			>
				{/* role="tree": `flex flex-col gap-4 pb-1` */}
				<div style={t("flex flex-none flex-col gap-4 pb-1")}>
					{/* Library group: `flex flex-col gap-px` */}
					<div style={t("flex flex-col gap-px")}>
						<SectionHeader label="Library" open={libOpen()} onToggle={() => setLibOpen(!libOpen())} />
						<Show when={libOpen()}>
							<Special kind={null} label="My Library" icon="library" />
							<Special kind="unfiled" label="Unfiled" icon="inbox" />
							<Special kind="trash" label="Trash" icon="trash-2" />
							{/* duplicates/DuplicateDialog.tsx DuplicateSidebarEntry (count blank until the dialog was opened) */}
							<div role="treeitem" aria-selected={false} style={t(SPECIAL)}>
								<Icon name="copy" size={16} color={muted()} />
								<text style={{ ...tx(labelCls(false)), ...TRUNCATE, flexGrow: 1, flexBasis: 0 }}>Duplicate Items</text>
							</div>
							{/* searches/SavedSearches.tsx */}
							<div style={t("flex flex-col")}>
								<div style={t("flex items-center justify-between py-1 pl-2 pr-1 pt-2")}>
									<text style={tx("text-[11px] font-semibold text-muted-foreground")}>{tracked("Saved Searches")}</text>
									<IconButton name="plus" box={24} icon={16} label="Advanced search" />
								</div>
								<div style={t("px-6 py-1")}>
									<text style={tx("text-xs text-muted-foreground")}>No saved searches</text>
								</div>
							</div>
						</Show>
					</div>
					{/* Collections group */}
					<div style={t("flex flex-col gap-px")}>
						<SectionHeader
							label="Collections"
							open={colOpen()}
							onToggle={() => setColOpen(!colOpen())}
							actions={<IconButton name="plus" box={20} icon={16} label="New collection" onClick={() => setColOpen(true)} />}
						/>
						<Show when={colOpen()}>
							<For each={store.collections()}>{(c) => <Row c={c} depth={0} />}</For>
						</Show>
					</div>
				</div>
			</div>
			{/* Tags.tsx TagList, collapsed: `flex min-h-0 flex-col`, flex 0 0 auto: header only */}
			<div style={{ ...t("flex min-h-0 flex-col"), flexGrow: 0, flexShrink: 0 }}>
				<SectionHeader
					label="Tags"
					open={tagsOpen()}
					onToggle={() => setTagsOpen(!tagsOpen())}
					icon="tag"
					actions={<IconButton name="ellipsis" box={20} icon={14} label="Tag menu" />}
				/>
			</div>
		</div>
	);
}
