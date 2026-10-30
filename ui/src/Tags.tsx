import { createMemo, createResource, createSignal, For, onMount, Show, type Component } from "solid-js";
import { Check, Ellipsis, Tag } from "lucide-solid";
import { api } from "./api";
import { store } from "./store";
import { afterListShown } from "./startup";
import { allTags } from "./itempane/Tags";
import { setShowAutoTags, showAutoTags } from "./settings/prefs";
import { loadTagColors, setTagColor, tagColor, TAG_PALETTE } from "./cards/tags";
import { fail } from "~/lib/actions";
import { maintenance } from "./maintenance/client";
import { deleteAutomaticTags, deleteTag, renameTag } from "./maintenance/ops";
import {
	DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import { cn } from "~/lib/utils";
import { SectionHeader, sectionOpen } from "./sidebar";
import {
	ContextMenu, ContextMenuContent, ContextMenuGroupLabel, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
} from "~/components/ui/context-menu";

export const TagList: Component = () => {
	// one shared fetch per tag-list change (itempane/Tags.tsx allTags), also used by tag autocomplete
	const [open, setOpen] = sectionOpen.tags;
	// the list is large (tens of thousands of tags on a big library), so it loads only while the section is open
	const [tags] = createResource(() => (open() ? store.tagsRev() + 1 : false), () => afterListShown().then(allTags).catch((e) => { fail("Could not load tags", e); return []; }));
	const [f, setF] = createSignal("");
	onMount(loadTagColors);
	// "Show Automatic": automatic tags (added by importers/translators) can be hidden; remembered across sessions.
	// (shared with Settings, see settings/prefs.ts)
	const showAuto = showAutoTags, setShowAuto = setShowAutoTags;
	const [auto] = createResource(() => (open() ? store.tagsRev() + 1 : false), () => afterListShown().then(maintenance.automaticTags).catch(() => []));
	const autoOnly = createMemo(() => new Map((auto() ?? []).map((a) => [a.tag, a.count])));
	// Coloured tags first in Zotero's position order, then the rest alphabetically.
	const TAG_LIMIT = 500;
	const filtered = createMemo(() => {
		const q = f().toLowerCase();
		const hideAuto = !showAuto();
		const list = (tags() ?? []).filter((t) =>
			t.tag.toLowerCase().includes(q) &&
			// only hide tags whose every use is automatic
			!(hideAuto && !tagColor(t.tag) && autoOnly().get(t.tag) === t.count));
		const pos = (name: string) => tagColor(name)?.position ?? Infinity;
		return list.sort((a, b) => pos(a.tag) - pos(b.tag));
	});
	const shown = createMemo(() => filtered().slice(0, TAG_LIMIT));
	return (
		<div class="flex min-h-0 flex-col" style={{ flex: open() ? "2 1 0%" : "0 0 auto" }} data-pane="tags">
			<SectionHeader label="Tags" open={open()} onToggle={() => setOpen(!open())} icon={<Tag class="size-3" />} actions={
				<DropdownMenu>
					<DropdownMenuTrigger class="inline-flex size-5 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3.5" aria-label="Tag menu">
						<Ellipsis />
					</DropdownMenuTrigger>
					<DropdownMenuContent class="w-64">
						<DropdownMenuCheckboxItem checked={showAuto()} onChange={setShowAuto}>Show Automatic</DropdownMenuCheckboxItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem onSelect={() => void deleteAutomaticTags()}>Delete Automatic Tags in This Library…</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			} />
			<Show when={open()}>
				<Input class="mx-2.5 mb-2 h-7 w-auto flex-none rounded-lg border-transparent bg-muted" placeholder="Filter tags" value={f()} onInput={(e) => setF(e.currentTarget.value)} />
				<div class="flex min-h-0 flex-1 flex-wrap content-start gap-1.5 overflow-y-auto px-2.5 pb-2">
					<Show when={!tags.loading || tags()} fallback={
						<For each={[48, 64, 40, 56, 72]}>{(w) => <Skeleton class="h-6 rounded-full" style={{ width: w + "px" }} />}</For>
					}>
						<For each={shown()}>{(t) => (
						<ContextMenu>
							<ContextMenuTrigger as="span">
								<span
									class={cn(
										"inline-flex h-6 max-w-full cursor-default items-center gap-1.5 rounded-full bg-background px-2.5 text-xs whitespace-nowrap ring-1 ring-border transition-colors hover:ring-primary/50",
										store.tag() === t.tag ? "bg-primary-tint font-medium text-primary-deep ring-primary-line" : "text-secondary-foreground",
									)}
									title={`${t.count} items`} role="button" aria-pressed={store.tag() === t.tag}
									onClick={() => store.setTag(store.tag() === t.tag ? null : t.tag)}>
									<Show when={tagColor(t.tag)}>{(c) => <span class="size-[7px] flex-none rounded-full" style={{ background: c().color }} />}</Show>
									<span class="truncate">{t.tag}</span>
								</span>
							</ContextMenuTrigger>
							<ContextMenuContent class="w-44">
								<ContextMenuGroupLabel>Tag colour</ContextMenuGroupLabel>
								<For each={TAG_PALETTE}>{(p) => (
									<ContextMenuItem onSelect={() => setTagColor(t.tag, p.color)}>
										<span class="mr-2 size-3 rounded-full" style={{ background: p.color }} />
										{p.name}
										<Show when={tagColor(t.tag)?.color.toLowerCase() === p.color.toLowerCase()}><Check class="ml-auto size-3.5" /></Show>
									</ContextMenuItem>
								)}</For>
								<Show when={tagColor(t.tag)}>
									<ContextMenuSeparator />
									<ContextMenuItem onSelect={() => setTagColor(t.tag, null)}>Remove colour</ContextMenuItem>
								</Show>
								<ContextMenuSeparator />
								<ContextMenuItem onSelect={() => void renameTag(t.tag)}>Rename Tag…</ContextMenuItem>
								<ContextMenuItem onSelect={() => void deleteTag(t.tag, t.count)}>Delete Tag…</ContextMenuItem>
							</ContextMenuContent>
						</ContextMenu>
					)}</For>
						<Show when={filtered().length > TAG_LIMIT}>
							<span class="inline-flex h-6 items-center px-2 text-xs text-muted-foreground">+ {(filtered().length - TAG_LIMIT).toLocaleString()} more</span>
						</Show>
					</Show>
				</div>
			</Show>
		</div>
	);
};
