// Shared pieces of the left sidebar (Quiet Paper): collapsible uppercase section headers, count badges, and the fixed
// palette of collection folder colours. Selected-entry styling (the raised white pill) lives in styles.css under
// `.zn-sidebar [role="treeitem"]`, so rows registered by other features (saved searches, duplicates) match.
import { ChevronDown, ChevronRight } from "lucide-solid";
import { Show, type Component, type JSX } from "solid-js";
import { persistedFlag } from "./settings/prefs";
import { cn } from "~/lib/utils";

/** Open/closed state of a sidebar section, remembered across sessions ("zn.flag.sidebar.<id>"). */
export const sectionOpen = {
	library: persistedFlag("sidebar.library", true),
	collections: persistedFlag("sidebar.collections", true),
	tags: persistedFlag("sidebar.tags", false),
};

export const SectionHeader: Component<{
	label: string;
	open: boolean;
	onToggle: () => void;
	icon?: JSX.Element;
	actions?: JSX.Element;
	class?: string;
}> = (p) => (
	<div class={cn("flex flex-none items-center justify-between pr-1", p.class)}>
		<button
			type="button"
			aria-expanded={p.open}
			onClick={p.onToggle}
			class="flex min-w-0 items-center gap-1.5 rounded-md px-2.5 pt-0.5 pb-1.5 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground hover:text-foreground"
		>
			{p.open ? <ChevronDown class="size-3 flex-none" /> : <ChevronRight class="size-3 flex-none" />}
			<Show when={p.icon}>{p.icon}</Show>
			{p.label}
		</button>
		<Show when={p.actions}><div class="flex items-center gap-0.5 pb-1">{p.actions}</div></Show>
	</div>
);

/** Small rounded grey count badge; renders nothing for 0 / undefined. */
export const CountBadge: Component<{ n: number | undefined; class?: string; title?: string }> = (p) => (
	<Show when={p.n}>
		<span
			title={p.title}
			class={cn("inline-flex h-[18px] min-w-[22px] flex-none items-center justify-center rounded-full bg-border-soft px-1.5 text-[11px] font-semibold tabular-nums text-secondary-foreground", p.class)}
		>
			{p.n!.toLocaleString()}
		</span>
	</Show>
);

/** Folder colours (stroke) from the Quiet Paper design; the fill is the same colour at low opacity so it works in both modes. */
const FOLDER_COLORS = ["#2B5FA8", "#B2457A", "#B76A12", "#1F7A62", "#6A4FC8", "#C0532E", "#5F6B7A"];

/** Deterministic colour for a collection key (FNV-1a hash into the palette). */
export function collectionColor(key: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193); }
	return FOLDER_COLORS[(h >>> 0) % FOLDER_COLORS.length];
}

export const folderStyle = (key: string): JSX.CSSProperties => {
	const c = collectionColor(key);
	return { color: c, fill: `color-mix(in srgb, ${c} 16%, transparent)` };
};
