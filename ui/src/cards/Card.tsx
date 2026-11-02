import { createSignal, For, Show, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { Copy, ExternalLink, FileSearch, FileText, Download, Ellipsis, Paperclip, Star, StickyNote, type LucideProps } from "lucide-solid";
import { toast } from "solid-sonner";
import { itemTypeIcon } from "~/lib/icons";
import type { ItemSummary } from "../api";
import { store } from "../store";
import { cn } from "~/lib/utils";
import { fail } from "~/lib/actions";
import { findFullText } from "~/lib/fulltext";
import { citeApi, copyRich } from "~/cite/client";
import { pdfAttachment, retrieveMetadata } from "~/additems/client";
import { doiUrl, openUrl, webUrl } from "../itemopen";
import { cardLayout } from "./layout";
import { metaText } from "./fields";
import { badgeTags, isStarred, toggleStar } from "./tags";
import { type ItemListHandle } from "./shared";
import { AttachmentMenu } from "./AttachmentMenu";

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

// Button tints: warm orange for "Open PDF", the accent blue for "Find full text"; both mix with theme tokens so dark mode works.
const ORANGE = "#D9622B";
const TINTS = {
	orange: { "background-color": mix(ORANGE, 11, "var(--card)"), "border-color": mix(ORANGE, 32, "var(--card)"), color: mix(ORANGE, 72, "var(--foreground)") },
	blue: { "background-color": mix("var(--primary)", 9, "var(--card)"), "border-color": mix("var(--primary)", 28, "var(--card)"), color: mix("var(--primary)", 85, "var(--foreground)") },
} as const;

const ActionBtn: Component<{
	icon: Component<LucideProps>;
	label: string;
	title?: string;
	tint?: keyof typeof TINTS;
	compact: boolean;
	strong?: boolean;
	onClick: (e: MouseEvent) => void;
}> = (p) => (
	<button type="button" tabindex="-1" title={p.title ?? p.label} aria-label={p.label}
		class={cn("inline-flex flex-none items-center gap-1.5 rounded-[7px] border text-[12.5px] transition-[filter,background-color] hover:brightness-95 dark:hover:brightness-125",
			p.compact ? "h-6 px-1.5" : "h-7 px-[11px]",
			p.strong ? "font-semibold" : "font-medium",
			!p.tint && "border-border bg-card text-foreground/85 hover:bg-accent")}
		style={p.tint ? TINTS[p.tint] : undefined}
		onClick={(e) => { e.stopPropagation(); p.onClick(e); }}
		onDblClick={(e) => e.stopPropagation()}>
		<p.icon class="size-[15px]" />
		<Show when={!p.compact}><span>{p.label}</span></Show>
	</button>
);

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Copy a citation for one item in the Quick Copy style (HTML + plain text on the clipboard). */
async function copyCitation(key: string) {
	try {
		const s = (await citeApi.settings()).quickCopy;
		const r = await citeApi.format({ keys: [key], style: s.style, locale: s.locale, mode: "bibliography", format: ["html", "text"] });
		await copyRich(r.html ?? "", r.text ?? "");
		toast.success(`Reference copied (${s.style})`);
	} catch (e) {
		fail("Could not copy the citation", e);
	}
}

export const Card: Component<{
	item: ItemSummary;
	index: number;
	list: ItemListHandle;
	selected: boolean;
	focused: boolean;
}> = (p) => {
	const L = cardLayout.layout;
	const compact = () => L().density === "compact";
	const [citing, setCiting] = createSignal(false);

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
	const extraAtts = () => p.item.attachmentCount - (p.item.primaryAttachment ? 1 : 0);
	const regular = () => p.item.itemType !== "attachment" && p.item.itemType !== "note" && p.item.itemType !== "annotation";
	const primary = () => p.item.primaryAttachment;
	const openLabel = (ct: string) => (/epub/i.test(ct) ? "Open EPUB" : /html/i.test(ct) ? "Open snapshot" : "Open PDF");
	const needsFullText = () => regular() && !primary() && p.item.itemType !== "webpage";
	// Retrieve Metadata only applies to standalone PDF attachments (their parent item is created from the lookup)
	const needsMetadata = () => p.item.itemType === "attachment" && pdfAttachment(p.item.key) === true;
	const webpage = () => (regular() ? webUrl(p.item.fields?.url) ?? doiUrl(p.item.fields?.DOI) : null);

	const iconCls = () => (compact() ? "size-4" : "size-[18px]");

	return (
		<div
			class={cn(
				"group/card relative flex items-start gap-3 transition-colors",
				compact() ? "px-2.5 py-1.5" : "px-2.5 py-2.5",
				p.selected
					? "rounded-[10px] bg-primary/[0.07] shadow-[0_0_0_1px_color-mix(in_srgb,var(--primary)_32%,transparent),0_4px_12px_color-mix(in_srgb,var(--primary)_14%,transparent)]"
					: "rounded-none border-b border-border/60 hover:bg-accent/40",
				p.focused && !p.selected && "bg-accent/50",
				p.focused && "ring-2 ring-ring/50 group-focus-within/list:ring-ring",
			)}>
			<span class="flex w-[22px] flex-none items-center justify-center pt-[3px] text-muted-foreground/80" aria-hidden="true">
				<Dynamic component={itemTypeIcon(p.item.itemType)} class={iconCls()} />
			</span>

			<div class="min-w-0 flex-1">
				<div class="flex items-start gap-2">
					<p class={cn("min-w-0 flex-1 break-words font-title leading-[1.35] text-foreground", compact() ? "text-sm" : "text-[15.5px]")}>
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
					<button type="button" tabindex="-1" title="More actions" aria-label="More actions"
						class="inline-flex size-6 flex-none items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-foreground/10 hover:text-foreground group-hover/card:opacity-100 focus-visible:opacity-100"
						onClick={(e) => {
							e.stopPropagation();
							const r = e.currentTarget.getBoundingClientRect();
							e.currentTarget.closest("[data-index]")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left, clientY: r.bottom }));
						}}
						onDblClick={(e) => e.stopPropagation()}>
						<Ellipsis class="size-4" />
					</button>
				</div>

				<Show when={authors() || metas().length}>
					<div class={cn("mt-[3px] flex min-w-0 items-baseline gap-x-1.5 text-muted-foreground", compact() ? "text-xs" : "text-[13px]")}>
						<Show when={authors()}><span class="min-w-0 truncate" title={authors()}>{authors()}</span></Show>
						<For each={metas()}>{(x, i) => (
							<>
								<Show when={i() > 0 || authors()}><span aria-hidden="true" class="flex-none opacity-50">·</span></Show>
								<span class={cn("flex-none max-w-[40%] truncate", x.m.accent && "text-primary/90")} title={x.text}>{x.text}</span>
							</>
						)}</For>
					</div>
				</Show>

				<div class={cn("flex flex-wrap gap-1.5", compact() ? "mt-1" : "mt-2")}>
					<Show when={primary()}>{(a) => (
						<ActionBtn icon={FileText} label={openLabel(a().contentType)} tint="orange" strong compact={compact()}
							onClick={() => store.openAttachment(a().key, p.item.title)} />
					)}</Show>
					<Show when={needsFullText()}>
						<ActionBtn icon={Download} label="Find full text" tint="blue" strong compact={compact()} onClick={() => findFullText([p.item.key])} />
					</Show>
					<Show when={needsMetadata()}>
						<ActionBtn icon={FileSearch} label="Find metadata" compact={compact()} onClick={() => void retrieveMetadata([p.item.key])} />
					</Show>
					<Show when={webpage()}>{(u) => (
						<ActionBtn icon={ExternalLink} label="Open webpage" compact={compact()} onClick={() => void openUrl(u())} />
					)}</Show>
					<Show when={regular()}>
						<ActionBtn icon={Copy} label={citing() ? "Copying…" : "Cite"} title="Copy citation" compact={compact()}
							onClick={() => { setCiting(true); void copyCitation(p.item.key).finally(() => setCiting(false)); }} />
					</Show>
					<Show when={L().icons && notes() > 0}>
						<AttachmentMenu item={p.item} notes title={plural(notes(), "note")}
							class={cn("inline-flex flex-none items-center gap-1.5 rounded-[7px] border border-border bg-card text-[12.5px] text-foreground/85 hover:bg-accent data-[expanded]:bg-accent",
								compact() ? "h-6 px-1.5" : "h-7 px-[11px]")}>
							<StickyNote class="size-[15px]" />
							<span>{compact() ? notes() : plural(notes(), "note")}</span>
						</AttachmentMenu>
					</Show>
					<Show when={L().icons && extraAtts() > 0}>
						<AttachmentMenu item={p.item} title={plural(p.item.attachmentCount, "attachment")}
							class={cn("inline-flex flex-none items-center gap-1.5 rounded-[7px] border border-border bg-card text-[12.5px] text-muted-foreground hover:bg-accent hover:text-foreground data-[expanded]:bg-accent",
								compact() ? "h-6 px-1.5" : "h-7 px-2.5")}>
							<Paperclip class="size-[15px]" /> {extraAtts()}
						</AttachmentMenu>
					</Show>
				</div>
			</div>
		</div>
	);
};
