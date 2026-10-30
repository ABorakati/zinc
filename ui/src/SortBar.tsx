// Group / Sort chip bar shared by the List (cards) view and the Classic table ("Quiet Paper" mockup, second row).
// "Group" picks the grouping field; "Sort" is up to four numbered levels. While grouped, level 1 is the group field.
import { For, Show, type Component, type JSX } from "solid-js";
import { ChevronDown, LayoutPanelTop, ArrowDownUp, Plus } from "lucide-solid";
import { store, GROUP_BY, type GroupBy, type SortLevel } from "./store";
import { cn } from "~/lib/utils";
import {
	DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
	DropdownMenuSeparator, DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { labelOf, moreColumns } from "./columns/defs";

export const SORT_OPTIONS = [
	{ key: "title", label: "Title" },
	{ key: "creator", label: "Creator" },
	{ key: "year", label: "Year" },
	{ key: "dateAdded", label: "Date Added" },
	{ key: "dateModified", label: "Date Modified" },
	{ key: "itemType", label: "Item Type" },
	{ key: "publication", label: "Publication" },
	{ key: "noteCount", label: "Notes" },
	{ key: "attachmentCount", label: "Attachments" },
];
const KNOWN = new Set(SORT_OPTIONS.map((o) => o.key));

export const sortLabel = (key: string) => SORT_OPTIONS.find((o) => o.key === key)?.label ?? labelOf(key);
/** Numeric / date keys read "↑ ↓"; text keys read "A–Z / Z–A". */
export const isNumericKey = (key: string) => /^(year|dateAdded|dateModified|accessDate|noteCount|attachmentCount)$/.test(key);
export const dirLabel = (l: SortLevel) => (isNumericKey(l.key) ? (l.dir === "asc" ? "↑" : "↓") : l.dir === "asc" ? "A–Z" : "Z–A");
export const defaultDir = (key: string): "asc" | "desc" => (/^(year|dateAdded|dateModified|accessDate)$/.test(key) ? "desc" : "asc");

const MAX_LEVELS = 4;

/** All sortable keys as radio items (the common ones, then every other schema field). */
const KeyItems: Component<{ exclude?: (key: string) => boolean }> = (p) => (
	<>
		<For each={SORT_OPTIONS.filter((o) => !p.exclude?.(o.key))}>{(o) => <DropdownMenuRadioItem value={o.key}>{o.label}</DropdownMenuRadioItem>}</For>
		<Show when={moreColumns().length}>
			<DropdownMenuSeparator />
			<DropdownMenuLabel class="text-xs text-muted-foreground">More fields</DropdownMenuLabel>
			<For each={moreColumns().filter((c) => !KNOWN.has(c.id) && !p.exclude?.(c.id))}>{(c) => <DropdownMenuRadioItem value={c.id}>{c.label}</DropdownMenuRadioItem>}</For>
		</Show>
	</>
);

const chipBase = "inline-flex h-[26px] items-center rounded-full border text-xs transition-colors";

const LevelChip: Component<{ level: SortLevel; index: number }> = (p) => {
	const levels = () => store.sortLevels();
	const locked = () => p.index === 0 && store.groupBy() !== "none";
	const removable = () => !locked() && levels().length > 1;
	const replace = (next: SortLevel | null) =>
		store.setSortLevels(levels().flatMap((l, i) => (i === p.index ? (next ? [next] : []) : next && l.key === next.key ? [] : [l])));
	const flip = () => replace({ key: p.level.key, dir: p.level.dir === "asc" ? "desc" : "asc" });
	const label = () => (
		<>
			<b class="font-semibold tabular-nums">{p.index + 1}</b>
			<span class="max-w-32 truncate">{sortLabel(p.level.key)}</span>
		</>
	);
	return (
		<span class={cn(chipBase, "border-border bg-card text-foreground/90 hover:border-foreground/25")} data-testid="sort-level">
			<Show when={!locked()} fallback={
				<span class="inline-flex h-full items-center gap-1.5 pl-2.5 pr-1" title="Locked to the group field">{label()}</span>
			}>
				<DropdownMenu>
					<DropdownMenuTrigger as="button" type="button" class="inline-flex h-full items-center gap-1.5 rounded-l-full pl-2.5 pr-1 hover:bg-accent/60" aria-label={`Sort level ${p.index + 1}: ${sortLabel(p.level.key)}`}>
						{label()}
					</DropdownMenuTrigger>
					<DropdownMenuContent class="max-h-[70vh] w-52 overflow-y-auto">
						<DropdownMenuLabel>Sort level {p.index + 1} by</DropdownMenuLabel>
						<DropdownMenuRadioGroup value={p.level.key} onChange={(key) => replace({ key, dir: defaultDir(key) })}>
							<KeyItems />
						</DropdownMenuRadioGroup>
						<Show when={removable()}>
							<DropdownMenuSeparator />
							<DropdownMenuItem class="text-destructive focus:text-destructive" onSelect={() => replace(null)}>Remove level</DropdownMenuItem>
						</Show>
					</DropdownMenuContent>
				</DropdownMenu>
			</Show>
			<button type="button" class="inline-flex h-full min-w-6 items-center justify-center rounded-r-full pl-1 pr-2.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
				title={p.level.dir === "asc" ? "Ascending - click to reverse" : "Descending - click to reverse"} aria-label="Reverse sort direction" onClick={flip}>
				{dirLabel(p.level)}
			</button>
		</span>
	);
};

const GroupChip: Component = () => (
	<DropdownMenu>
		<DropdownMenuTrigger as="button" type="button" aria-label="Group by"
			class={cn(chipBase, "gap-1 px-2.5 font-medium",
				store.groupBy() === "none"
					? "border-border bg-card text-foreground/80 hover:border-foreground/25"
					: "border-primary/25 bg-primary/10 text-primary hover:bg-primary/15")}>
			{GROUP_BY.find((g) => g.id === store.groupBy())?.label ?? "None"} <ChevronDown class="size-3 opacity-70" />
		</DropdownMenuTrigger>
		<DropdownMenuContent class="w-44">
			<DropdownMenuLabel>Group by</DropdownMenuLabel>
			<DropdownMenuRadioGroup value={store.groupBy()} onChange={(g) => store.setGroupBy(g as GroupBy)}>
				<For each={GROUP_BY}>{(g) => <DropdownMenuRadioItem value={g.id}>{g.label}</DropdownMenuRadioItem>}</For>
			</DropdownMenuRadioGroup>
		</DropdownMenuContent>
	</DropdownMenu>
);

const AddLevel: Component = () => {
	const used = () => new Set(store.sortLevels().map((l) => l.key));
	return (
		<DropdownMenu>
			<DropdownMenuTrigger as="button" type="button" aria-label="Add sort level"
				class={cn(chipBase, "gap-1 border-dashed border-border px-2 text-muted-foreground hover:border-foreground/30 hover:text-foreground")}>
				<Plus class="size-3" /> Add level
			</DropdownMenuTrigger>
			<DropdownMenuContent class="max-h-[70vh] w-52 overflow-y-auto">
				<DropdownMenuLabel>Then sort by</DropdownMenuLabel>
				<DropdownMenuRadioGroup value="" onChange={(key) => key && store.setSortLevels([...store.sortLevels(), { key, dir: defaultDir(key) }])}>
					<KeyItems exclude={(k) => used().has(k)} />
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
};

export const SortBar: Component<{
	/** number of items in the list (left out of the count text when absent) */
	total?: number;
	loading?: boolean;
	/** extra controls on the right, after the count */
	trailing?: JSX.Element;
	class?: string;
}> = (p) => {
	const sel = () => store.selected().size;
	return (
		<div class={cn("flex flex-wrap items-center gap-2 border-b px-5 pb-2.5 text-xs text-muted-foreground", p.class)} data-testid="sort-bar">
			<span class="flex items-center gap-1.5"><LayoutPanelTop class="size-3.5" /> Group</span>
			<GroupChip />
			<span class="mx-1 h-4 w-px bg-border" aria-hidden="true" />
			<span class="flex items-center gap-1.5"><ArrowDownUp class="size-3.5" /> Sort</span>
			<For each={store.sortLevels()}>{(l, i) => (
				<>
					<Show when={i() > 0}><span aria-hidden="true">›</span></Show>
					<LevelChip level={l} index={i()} />
				</>
			)}</For>
			<Show when={store.sortLevels().length < MAX_LEVELS}><AddLevel /></Show>
			<div class="flex-1" />
			<Show when={p.total !== undefined}>
				<span class="tabular-nums" data-testid="cards-count">
					{p.total!.toLocaleString()} {p.total === 1 ? "item" : "items"}
					<Show when={sel() > 0}> · {sel().toLocaleString()} selected</Show>
					<Show when={p.loading}> · loading…</Show>
				</span>
			</Show>
			{p.trailing}
		</div>
	);
};
