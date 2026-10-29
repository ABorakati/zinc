import { For, Show, type Component, type JSX } from "solid-js";
import { Check, Ellipsis, Paperclip, Star, StickyNote } from "lucide-solid";
import { Dynamic } from "solid-js/web";
import { attachmentIcon } from "~/lib/icons";
import type { ItemSummary } from "../api";
import { store } from "../store";
import { cn } from "~/lib/utils";
import { cardLayout } from "./layout";
import { metaText } from "./fields";
import { badgeTags, isStarred, toggleStar } from "./tags";
import { selectClick, type ItemListHandle } from "./shared";

/** Open a section of the item pane for the selected item (the pane renders it once the item has loaded). */
function showInPane(section: string) {
	let tries = 0;
	const go = () => {
		const nav = document.querySelector<HTMLElement>(`[data-nav="${section}"]`);
		if (nav) nav.click();
		else if (tries++ < 8) setTimeout(go, 120);
	};
	setTimeout(go, 60);
}

const mix = (c: string, pct: number, into: string) => `color-mix(in srgb, ${c} ${pct}%, ${into})`;

export const TagBadge: Component<{ name: string; color?: string }> = (p) => (
	<button
		type="button"
		tabindex="-1"
		title={`Show items tagged "${p.name}"`}
		class={cn("inline-flex max-w-48 items-center truncate rounded-full border px-2 text-[11px] font-medium leading-[18px] align-middle transition-[filter] hover:brightness-95 dark:hover:brightness-125",
			!p.color && "border-border bg-muted text-muted-foreground")}
		style={p.color ? {
			"background-color": mix(p.color, 16, "transparent"),
			"border-color": mix(p.color, 38, "transparent"),
			color: mix(p.color, 62, "var(--foreground)"),
		} : undefined}
		onClick={(e) => { e.stopPropagation(); store.setTag(p.name); }}
		onDblClick={(e) => e.stopPropagation()}>
		<span class="truncate">{p.name}</span>
	</button>
);

const IconButton: Component<{ title: string; onClick: (e: MouseEvent) => void; class?: string; children: JSX.Element }> = (p) => (
	<button type="button" tabindex="-1" title={p.title} aria-label={p.title}
		class={cn("inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground", p.class)}
		onClick={(e) => { e.stopPropagation(); p.onClick(e); }} onDblClick={(e) => e.stopPropagation()}>
		{p.children}
	</button>
);

const typeLabel = (ct: string) => (/pdf/i.test(ct) ? "PDF" : /epub/i.test(ct) ? "EPUB" : /html/i.test(ct) ? "Snapshot" : "File");

export const Card: Component<{
	item: ItemSummary;
	index: number;
	list: ItemListHandle;
	selected: boolean;
	focused: boolean;
}> = (p) => {
	const L = cardLayout.layout;
	const compact = () => L().density === "compact";

	const authors = () => {
		const mode = L().creators;
		const names = p.item.creators;
		if (mode === "off") return "";
		if (mode === "summary" || !names) return p.item.creatorsSummary;
		return mode === "short" && names.length > 3 ? names.slice(0, 3).join(", ") + " et al." : names.join(", ");
	};
	const metas = () => cardLayout.metaFields().map((m) => ({ m, text: metaText(m, p.item) })).filter((x) => x.text);
	const badges = () => (L().tags ? badgeTags(p.item, L().allTags) : []);

	const notes = () => p.item.noteCount;
	const IconsRow: Component = () => (
		<div class="flex items-center gap-0.5">
			<Show when={p.item.noteCount > 0}>
				<IconButton title={`${notes()} note${notes() === 1 ? "" : "s"}`} onClick={() => { store.selectOnly(p.item.key, p.index); showInPane("notes"); }}>
					<StickyNote class="size-3.5" /> {notes()}
				</IconButton>
			</Show>
			<Show when={p.item.primaryAttachment}>{(a) => (
				<IconButton title={`Open ${typeLabel(a().contentType)}`} class="text-primary hover:text-primary" onClick={() => store.openSummary(p.item)}>
					<Dynamic component={attachmentIcon(a().contentType)} class="size-3.5" /> {typeLabel(a().contentType)}
				</IconButton>
			)}</Show>
			<Show when={p.item.attachmentCount > 1}>
				<IconButton title={`${p.item.attachmentCount} attachments`} onClick={() => { store.selectOnly(p.item.key, p.index); showInPane("attachments"); }}>
					<Paperclip class="size-3.5" /> {p.item.attachmentCount}
				</IconButton>
			</Show>
		</div>
	);
	const hasIcons = () => L().icons && (p.item.noteCount > 0 || !!p.item.primaryAttachment || p.item.attachmentCount > 1);

	return (
		<div
			class={cn(
				"group/card relative flex gap-3 rounded-lg border bg-card transition-colors",
				compact() ? "px-2.5 py-1.5" : "px-3.5 py-3",
				p.selected ? "border-primary/60 bg-primary/10 hover:bg-primary/15" : "hover:border-foreground/20 hover:bg-accent/60",
				p.focused && "ring-2 ring-ring/50 group-focus-within/list:ring-ring",
			)}>
			<button type="button" role="checkbox" aria-checked={p.selected} aria-label="Select item" tabindex="-1"
				class={cn("mt-0.5 flex size-[18px] flex-none items-center justify-center rounded-[5px] border transition-colors",
					p.selected ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background text-transparent hover:border-primary/70 group-hover/card:text-transparent")}
				onClick={(e) => { e.stopPropagation(); selectClick(p.list, p.index, { shift: e.shiftKey, ctrl: true }); }}
				onDblClick={(e) => e.stopPropagation()}>
				<Check class="size-3.5" strokeWidth={3} />
			</button>

			<div class="min-w-0 flex-1">
				<p class={cn("break-words font-semibold leading-snug text-foreground", compact() ? "text-sm" : "text-[15px]")}>
					<span>{p.item.title || "(untitled)"}</span>
					<Show when={L().star}>
						<button type="button" tabindex="-1" aria-pressed={isStarred(p.item)} title={isStarred(p.item) ? "Remove star" : "Star"}
							class={cn("ml-1.5 inline-flex size-5 translate-y-[3px] items-center justify-center rounded transition-opacity hover:bg-foreground/10",
								isStarred(p.item) ? "text-amber-500" : "text-muted-foreground opacity-0 group-hover/card:opacity-60 hover:!opacity-100 focus-visible:opacity-100")}
							onClick={(e) => { e.stopPropagation(); toggleStar(p.list, p.item); }} onDblClick={(e) => e.stopPropagation()}>
							<Star class={cn("size-4", isStarred(p.item) && "fill-current")} />
						</button>
					</Show>
					<Show when={badges().length}>
						<span class="ml-1 inline-flex flex-wrap gap-1 align-middle">
							<For each={badges()}>{(b) => <TagBadge name={b.name} color={b.color} />}</For>
						</span>
					</Show>
				</p>

				<Show when={authors()}>
					<p class={cn("mt-0.5 text-foreground/75", compact() ? "text-xs" : "text-[13px]")}>{authors()}</p>
				</Show>

				<div class={cn("flex items-center gap-2", compact() ? "mt-0.5" : "mt-1")}>
					<div class={cn("flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 text-muted-foreground", compact() ? "text-xs" : "text-[13px]")}>
						<For each={metas()}>{(x, i) => (
							<>
								<Show when={i() > 0}><span aria-hidden="true" class="opacity-50">·</span></Show>
								<span class={cn(x.m.accent && "font-medium text-primary", "max-w-full truncate")} title={x.text}>{x.text}</span>
							</>
						)}</For>
					</div>
					<Show when={compact() && hasIcons()}><IconsRow /></Show>
					<button type="button" tabindex="-1" title="More actions" aria-label="More actions"
						class="inline-flex size-6 flex-none items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
						onClick={(e) => {
							e.stopPropagation();
							const r = e.currentTarget.getBoundingClientRect();
							e.currentTarget.closest("[data-index]")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left, clientY: r.bottom }));
						}}
						onDblClick={(e) => e.stopPropagation()}>
						<Ellipsis class="size-4" />
					</button>
				</div>

				<Show when={!compact() && hasIcons()}>
					<div class="-ml-1.5 mt-1"><IconsRow /></div>
				</Show>
			</div>
		</div>
	);
};
