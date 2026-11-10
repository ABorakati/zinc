// Visual pieces shared by the sidebar sections (ui/src/sidebar.tsx + class strings of Collections.tsx / Tags.tsx).
import { Show, type JSX } from "solid-js";
import type { Mode, Style } from "../contracts";
import { Icon } from "../icons";
import { store } from "../store";
import { textStyle, tokens, tw } from "../theme";

export const mode = (): Mode => store.mode();
export const t = (cls: string): Style => tw(cls, mode());
export const tx = (cls: string): Style => textStyle(cls, mode());
export const tok = (name: string): string => tokens[mode()][name] ?? "#888";
export const muted = (): string => tok("muted-foreground");

// ---- folder colours (ui/src/sidebar.tsx) ----

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
export function brighten(hex: string, f: number): string {
	const n = parseInt(hex.slice(1), 16);
	const c = (s: number) => Math.min(255, Math.round(((n >> s) & 255) * f));
	return `rgb(${c(16)}, ${c(8)}, ${c(0)})`;
}

/** Stroke colour of a collection's folder; dark mode brightens it by 25%. */
export const folderColor = (key: string): string => (mode() === "dark" ? brighten(collectionColor(key), 1.25) : collectionColor(key));

const FOLDER_PATH =
	"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z";
const FOLDER_OPEN_PATH =
	"m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2";

/** GPUIX tints an <svg> with style.color (a mask), so stroke and the 16% fill share one colour via fill-opacity. */
export function folderSvg(open: boolean): string {
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="currentColor" fill-opacity="0.16" ` +
		`stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${open ? FOLDER_OPEN_PATH : FOLDER_PATH}"/></svg>`
	);
}

// ---- class strings copied from the web UI ----

export const HEADER_ROW = "flex flex-none items-center justify-between pr-1";
export const HEADER_BTN = "flex min-w-0 items-center gap-1.5 rounded-md px-2.5 pt-0.5 pb-1.5 text-left";
export const HEADER_TEXT = "text-[11px] font-semibold text-muted-foreground";
/** The section header's label on its accent band. */
export const HEADER_TEXT_BAND = "text-[11px] font-semibold text-primary-deep";
export const ROW = "relative flex min-h-7 items-center gap-1.5 rounded-lg pr-2 hover:bg-foreground/5";
export const SPECIAL = "relative flex min-h-7 cursor-pointer items-center gap-1 rounded-lg pl-6 pr-2 hover:bg-foreground/5";
// The same rows without the native `hover:` refinement: each refinement costs frame time on every visible row, so the rows keep
// a hover flag instead (a commit only while the pointer is over the sidebar) and paint ROW_HOVER on it.
export const ROW_STATIC = ROW.replace(" hover:bg-foreground/5", "");
export const SPECIAL_STATIC = SPECIAL.replace(" hover:bg-foreground/5", "");
export const ROW_HOVER = "bg-foreground/5";
export const BADGE = "inline-flex h-[18px] min-w-[22px] flex-none items-center justify-center rounded-full bg-border-soft px-1.5";

/** CSS `uppercase tracking-[0.06em]` for 11px text: GPUIX has no letter-spacing, so uppercase the label only. */
export const tracked = (s: string): string => s.toUpperCase();

export const TRUNCATE: Style = { overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", minWidth: 0 };

/** Selected treeitem: the raised pill from styles.css (`[role="treeitem"][aria-selected="true"]`). */
export const pill = (sel: boolean): Style => {
	if (!sel) return {};
	const s = t("bg-background shadow-pill");
	return { ...s, hover: s };
};
export const labelCls = (sel: boolean): string => (sel ? "text-[13px] font-semibold text-primary-deep" : "text-[13px] text-foreground/90");

/** Width a thin web scrollbar takes beside the content; GPUIX's thumb overlays the container's right edge. */
export const SCROLLBAR_GUTTER = 11;

/**
 * One entry of the sidebar's virtual list. GPUIX rebuilds, lays out and paints every node of the window on every frame (there is no
 * per-subtree cache), and a scrolling container does that for ALL its rows, on screen or not: a 36-row collections tree cost ~8 ms
 * per frame while only the item list scrolled. A <virtual-list> builds just the rows that intersect its viewport.
 *
 * The list's children must be exactly the entries (a <Show> or a conditional next to them leaves an empty placeholder text node
 * behind, i.e. a zero-height item), so the sidebar flattens its sections into `Entry[]` and renders a single <For> over them.
 */
export interface Entry {
	id: string;
	render: () => JSX.Element;
}

/** Right padding of a list entry: the old `pr-2` plus the gutter GPUIX's overlaid scrollbar thumb needs. */
const ENTRY_PAD_RIGHT = 8 + SCROLLBAR_GUTTER;

/**
 * Wraps one row of the virtual list. A list item is measured as its own box, so the 1px flex gap the rows had (`gap-px`) and the
 * scrollbar gutter live in this wrapper's padding. `gap` is that 1px (0 inside the saved-searches block, which had no gap),
 * `top` extra space above (the 16px between the Library and Collections groups).
 */
export function ListItem(p: { children: JSX.Element; gap?: number; top?: number }): JSX.Element {
	return <div style={{ width: "100%", paddingRight: ENTRY_PAD_RIGHT, paddingBottom: p.gap ?? 1, paddingTop: p.top ?? 0 }}>{p.children}</div>;
}

export function SectionHeader(p: {
	label: string;
	open: boolean;
	onToggle: () => void;
	icon?: string;
	actions?: JSX.Element;
	onContextMenu?: (x: number, y: number) => void;
}): JSX.Element {
	// a tinted band in the accent colour, so each section (Library, Collections, Group Libraries, Tags) stands apart from its rows
	return (
		<div style={{ ...t(HEADER_ROW), ...t("mx-1 mb-1 min-h-[26px] rounded-md bg-primary-tint") }}>
			<div
				role="button"
				aria-expanded={p.open}
				aria-label={p.label}
				onClick={p.onToggle}
				onAuxClick={(e) => { if (e.isRightClick && p.onContextMenu) p.onContextMenu(e.x ?? 0, e.y ?? 0); }}
				style={{ ...t(HEADER_BTN), ...t("py-1"), flexGrow: 1, cursor: "pointer" }}
			>
				<Icon name={p.open ? "chevron-down" : "chevron-right"} size={12} color={tok("primary")} />
				<Show when={p.icon}>
					<Icon name={p.icon!} size={12} color={tok("primary")} />
				</Show>
				<text style={tx(HEADER_TEXT_BAND)}>{tracked(p.label)}</text>
			</div>
			{p.actions}
		</div>
	);
}

/** Ghost icon button: `inline-flex items-center justify-center rounded-md text-muted-foreground hover:bg-accent`. */
export function IconButton(p: { name: string; box: number; icon: number; label: string; onClick?: (e: { x?: number; y?: number }) => void }): JSX.Element {
	return (
		<div
			role="button"
			aria-label={p.label}
			onClick={(e) => p.onClick?.(e)}
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

/** Small rounded grey count badge; renders nothing for 0 / undefined. */
export function CountBadge(p: { n: number | undefined }): JSX.Element {
	return (
		<Show when={p.n}>
			<div style={{ ...t(BADGE), marginLeft: 4 }}>
				<text style={{ ...tx("text-[11px] font-semibold text-secondary-foreground"), whiteSpace: "nowrap" }}>{p.n!.toLocaleString("en-US")}</text>
			</div>
		</Show>
	);
}
