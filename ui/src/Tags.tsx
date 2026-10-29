import { createMemo, createResource, createSignal, For, onMount, Show, type Component } from "solid-js";
import { Check } from "lucide-solid";
import { api } from "./api";
import { store } from "./store";
import { loadTagColors, setTagColor, tagColor, TAG_PALETTE } from "./cards/tags";
import { fail } from "~/lib/actions";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import {
	ContextMenu, ContextMenuContent, ContextMenuGroupLabel, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
} from "~/components/ui/context-menu";

export const TagList: Component = () => {
	const [tags] = createResource(() => store.tagsRev(), () => api.tags().catch((e) => { fail("Could not load tags", e); return []; }));
	const [f, setF] = createSignal("");
	onMount(loadTagColors);
	// Coloured tags first in Zotero's position order, then the rest alphabetically.
	const shown = createMemo(() => {
		const q = f().toLowerCase();
		const list = (tags() ?? []).filter((t) => t.tag.toLowerCase().includes(q));
		const pos = (name: string) => tagColor(name)?.position ?? Infinity;
		return list.sort((a, b) => pos(a.tag) - pos(b.tag)).slice(0, 500);
	});
	return (
		<div class="flex h-full min-h-0 flex-col">
			<div class="flex-none px-2 pt-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Tags</div>
			<Input class="mx-2 mb-1.5 w-auto flex-none" placeholder="Filter tags" value={f()} onInput={(e) => setF(e.currentTarget.value)} />
			<div class="flex min-h-0 flex-1 flex-wrap content-start gap-1 overflow-y-auto px-2 pb-2">
				<Show when={!tags.loading || tags()} fallback={
					<For each={[48, 64, 40, 56, 72]}>{(w) => <Skeleton class="h-5 rounded-full" style={{ width: w + "px" }} />}</For>
				}>
					<For each={shown()}>{(t) => (
						<ContextMenu>
							<ContextMenuTrigger as="span">
								<Badge round variant={store.tag() === t.tag ? "default" : "outline"}
									class="cursor-default gap-1 px-2 py-0 font-normal hover:border-primary"
									title={`${t.count} items`} role="button"
									onClick={() => store.setTag(store.tag() === t.tag ? null : t.tag)}>
									<Show when={tagColor(t.tag)}>{(c) => <span class="size-2 rounded-full" style={{ background: c().color }} />}</Show>
									{t.tag}
								</Badge>
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
							</ContextMenuContent>
						</ContextMenu>
					)}</For>
				</Show>
			</div>
		</div>
	);
};
