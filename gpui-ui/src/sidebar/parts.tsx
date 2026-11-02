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
function brighten(hex: string, f: number): string {
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
export const ROW = "relative flex min-h-7 items-center gap-1.5 rounded-lg pr-2 hover:bg-foreground/5";
export const SPECIAL = "relative flex min-h-7 cursor-pointer items-center gap-1 rounded-lg pl-6 pr-2 hover:bg-foreground/5";
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

export function SectionHeader(p: {
	label: string;
	open: boolean;
	onToggle: () => void;
	icon?: string;
	actions?: JSX.Element;
	onContextMenu?: (x: number, y: number) => void;
}): JSX.Element {
	return (
		<div style={t(HEADER_ROW)}>
			<div
				role="button"
				aria-expanded={p.open}
				aria-label={p.label}
				onClick={p.onToggle}
				onAuxClick={(e) => { if (e.isRightClick && p.onContextMenu) p.onContextMenu(e.x ?? 0, e.y ?? 0); }}
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
