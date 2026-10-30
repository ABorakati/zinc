// Dropdown listing an item's attachments (and optionally notes); each entry opens like a double-click on that child.
import { createResource, For, Show, type Component, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { ItemSummary } from "../api";
import { childIcon, childLabel, getDetail, openChild } from "../itemopen";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "~/components/ui/dropdown-menu";

const MenuBody: Component<{ item: ItemSummary; notes: boolean }> = (p) => {
	const [d] = createResource(() => p.item.key, getDetail);
	const atts = () => d()?.children.filter((c) => c.itemType === "attachment") ?? [];
	const notes = () => (p.notes ? d()?.children.filter((c) => c.itemType === "note") ?? [] : []);
	const entry = (c: ReturnType<typeof atts>[number]) => (
		<DropdownMenuItem onSelect={() => openChild(p.item, c)}>
			<Dynamic component={childIcon(c)} class="mr-2 size-4 flex-none" />
			<span class="truncate">{childLabel(c)}</span>
		</DropdownMenuItem>
	);
	return (
		<Show when={d()} fallback={<div class="px-2 py-1.5 text-xs text-muted-foreground">{d.error ? "Could not load" : "Loading…"}</div>}>
			<Show when={atts().length || notes().length} fallback={<div class="px-2 py-1.5 text-xs text-muted-foreground">No attachments</div>}>
				<Show when={atts().length}>
					<DropdownMenuLabel class="text-xs text-muted-foreground">Attachments</DropdownMenuLabel>
					<For each={atts()}>{entry}</For>
				</Show>
				<Show when={notes().length}>
					<Show when={atts().length}><DropdownMenuSeparator /></Show>
					<DropdownMenuLabel class="text-xs text-muted-foreground">Notes</DropdownMenuLabel>
					<For each={notes()}>{entry}</For>
				</Show>
			</Show>
		</Show>
	);
};

export const AttachmentMenu: Component<{ item: ItemSummary; notes?: boolean; title: string; class?: string; children: JSX.Element }> = (p) => (
	<DropdownMenu>
		<DropdownMenuTrigger as="button" type="button" tabindex="-1" title={p.title} aria-label={p.title} class={p.class}
			onDblClick={(e: MouseEvent) => e.stopPropagation()}>
			{p.children}
		</DropdownMenuTrigger>
		<DropdownMenuContent class="max-h-72 min-w-56 max-w-96 overflow-y-auto">
			<MenuBody item={p.item} notes={!!p.notes} />
		</DropdownMenuContent>
	</DropdownMenu>
);
