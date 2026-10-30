import { createVirtualizer } from "@tanstack/solid-virtual";
import { AlertCircle, Library, LockOpen, RefreshCw, Search, X } from "lucide-solid";
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "~/components/ui/hover-card";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";
import { useReferences, type Reference } from "./api";
import { openUrl, ReferenceCard, type ReferenceActions } from "./ReferenceCard";
import { doiUrl, referenceUrl } from "./match";

export { useReferences } from "./api";
export type { Reference } from "./api";

export interface ReferencesPanelProps extends ReferenceActions {
	/** Item key or attachment key of the document being read (the server resolves attachments to their parent). */
	itemKey: string;
	/** Scroll to and briefly highlight a reference ("show-references" from the reader). Pass a new object each time. */
	focus?: { index: number } | null;
	class?: string;
}

const VIRTUALIZE_ABOVE = 100;
const ROW_ESTIMATE = 84;

function matches(r: Reference, q: string) {
	const hay = [r.index, r.title, r.raw, r.authors?.join(" "), r.year, r.venue, r.doi].filter((x) => x != null).join(" ").toLowerCase();
	return q.split(/\s+/).every((t) => hay.includes(t));
}

// Only one hover card may be open at a time: moving quickly between rows used to leave earlier
// cards visible during their close delay. Opening a card closes whichever one was open.
const [openCard, setOpenCard] = createSignal<Reference | null>(null);

function ReferenceRow(props: { reference: Reference; highlighted: boolean } & ReferenceActions) {
	const r = () => props.reference;
	const meta = () => [r().authors?.[0] && (r().authors!.length > 1 ? `${r().authors![0]} et al.` : r().authors![0]), r().year, r().venue].filter(Boolean).join(" · ");
	const target = () => (r().inLibraryKey ? () => props.onOpenItem?.(r().inLibraryKey!) : referenceUrl(r()) ? () => openUrl(referenceUrl(r())!) : undefined);
	const onOpenChange = (open: boolean) => {
		if (open) setOpenCard(r());
		else if (openCard() === r()) setOpenCard(null);
	};

	return (
		<HoverCard open={openCard() === r()} onOpenChange={onOpenChange} openDelay={350} closeDelay={150} placement="left-start" flip>
			<HoverCardTrigger
				as="div"
				tabindex="0"
				role="button"
				data-ref-index={r().index}
				data-in-library={r().inLibraryKey ? "" : undefined}
				class={cn(
					"group flex gap-2 border-b px-3 py-2 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset",
					props.highlighted && "bg-primary/15 hover:bg-primary/15",
					target() && "cursor-pointer",
				)}
				onClick={() => target()?.()}
				onKeyDown={(e: KeyboardEvent) => {
					if (e.key === "Enter" && e.target === e.currentTarget) target()?.();
				}}
			>
				<span class="w-6 shrink-0 pt-px text-right text-[11px] tabular-nums text-muted-foreground">{r().index}</span>
				<div class="min-w-0 flex-1">
					<Show
						when={r().title}
						fallback={<div class="line-clamp-3 text-[12px] leading-snug break-words text-foreground/90">{r().raw ?? "Untitled reference"}</div>}
					>
						<div class="line-clamp-2 text-[13px] leading-snug font-medium break-words">{r().title}</div>
					</Show>
					<Show when={meta()}><div class="mt-0.5 truncate text-[11px] text-muted-foreground">{meta()}</div></Show>
					<Show when={r().inLibraryKey || r().openAccessUrl || r().doi}>
						<div class="mt-1 flex flex-wrap items-center gap-1">
							<Show when={r().inLibraryKey}>
								<Badge
									variant="success"
									class="cursor-pointer gap-1 px-1.5 py-0 text-[10px] font-medium hover:brightness-95"
									role="button"
									tabindex="-1"
									onClick={(e: MouseEvent) => { e.stopPropagation(); props.onOpenItem?.(r().inLibraryKey!); }}
								>
									<Library class="size-3" /> In library
								</Badge>
							</Show>
							<Show when={r().openAccessUrl}>
								<Badge
									variant="outline"
									class="cursor-pointer gap-1 border-amber-500/50 px-1.5 py-0 text-[10px] font-medium text-amber-700 hover:bg-amber-500/10 dark:text-amber-400"
									role="button"
									tabindex="-1"
									title="Open the open-access PDF"
									onClick={(e: MouseEvent) => { e.stopPropagation(); openUrl(r().openAccessUrl!); }}
								>
									<LockOpen class="size-3" /> Open access
								</Badge>
							</Show>
							<Show when={r().doi}>
								<Badge
									variant="outline"
									class="max-w-full cursor-pointer truncate px-1.5 py-0 text-[10px] font-normal text-muted-foreground hover:text-foreground"
									role="link"
									tabindex="-1"
									title={doiUrl(r().doi!)}
									onClick={(e: MouseEvent) => { e.stopPropagation(); openUrl(doiUrl(r().doi!)); }}
								>
									DOI
								</Badge>
							</Show>
						</div>
					</Show>
				</div>
			</HoverCardTrigger>
			<HoverCardContent>
				<ReferenceCard reference={r()} onOpenItem={props.onOpenItem} onAdded={props.onAdded} />
			</HoverCardContent>
		</HoverCard>
	);
}

function RowSkeletons() {
	return (
		<div aria-busy="true" aria-label="Loading references" data-testid="references-loading">
			<For each={Array.from({ length: 9 })}>
				{() => (
					<div class="flex gap-2 border-b px-3 py-2.5">
						<div class="h-3 w-6 shrink-0 animate-pulse rounded bg-muted" />
						<div class="flex-1 space-y-1.5">
							<div class="h-3.5 w-11/12 animate-pulse rounded bg-muted" />
							<div class="h-3 w-7/12 animate-pulse rounded bg-muted" />
						</div>
					</div>
				)}
			</For>
		</div>
	);
}

export function ReferencesPanel(props: ReferencesPanelProps) {
	const { list, refresh, markInLibrary } = useReferences(() => props.itemKey);
	const [filter, setFilter] = createSignal("");
	const [hideInLibrary, setHideInLibrary] = createSignal(false);
	const [flash, setFlash] = createSignal<number | null>(null);
	let scroller!: HTMLDivElement;

	// Reading a failed resource throws, so every read goes through `data`.
	const data = () => (list.error ? undefined : list());
	const all = () => data()?.references ?? [];
	const visible = createMemo(() => {
		const q = filter().trim().toLowerCase();
		return all().filter((r) => (!hideInLibrary() || !r.inLibraryKey) && (!q || matches(r, q)));
	});
	const inLibraryCount = () => all().filter((r) => r.inLibraryKey).length;
	const virtual = () => visible().length > VIRTUALIZE_ABOVE;

	const virtualizer = createVirtualizer({
		get count() { return visible().length; },
		getScrollElement: () => scroller,
		estimateSize: () => ROW_ESTIMATE,
		overscan: 8,
	});

	function onAdded(index: number, key: string) {
		markInLibrary(index, key);
		props.onAdded?.(index, key);
	}

	// "show-references": scroll to a reference and highlight it for a moment.
	let flashTimer: ReturnType<typeof setTimeout> | undefined;
	onCleanup(() => clearTimeout(flashTimer));
	createEffect(on(() => [props.focus, data()] as const, ([focus, l]) => {
		if (!focus || !l) return;
		if (!visible().some((r) => r.index === focus.index)) {
			setFilter("");
			setHideInLibrary(false);
		}
		queueMicrotask(() => {
			const i = visible().findIndex((r) => r.index === focus.index);
			if (i < 0) return;
			if (virtual()) virtualizer.scrollToIndex(i, { align: "center" });
			else scroller.querySelector(`[data-ref-index="${focus.index}"]`)?.scrollIntoView({ block: "center" });
			setFlash(focus.index);
			clearTimeout(flashTimer);
			flashTimer = setTimeout(() => setFlash(null), 2200);
		});
	}));

	return (
		<section class={cn("flex h-full min-h-0 flex-col bg-background text-foreground", props.class)} aria-label="References" data-testid="references-panel">
			<header class="flex flex-col gap-2 border-b px-3 py-2">
				<div class="flex items-center gap-2">
					<h2 class="text-sm font-semibold">References</h2>
					<Show when={data()}>
						<span class="text-xs tabular-nums text-muted-foreground" data-testid="references-count">
							{visible().length === all().length ? all().length : `${visible().length} / ${all().length}`}
						</span>
						<Badge variant="secondary" class="px-1.5 py-0 text-[10px] font-normal" title={`Fetched ${data()!.fetchedAt}`}>{data()!.source}</Badge>
					</Show>
					<Button
						variant="ghost" size="icon" class="ml-auto size-7" title="Refresh" aria-label="Refresh references"
						disabled={list.loading} onClick={refresh}
					>
						<RefreshCw class={cn("size-3.5", list.loading && "animate-spin")} />
					</Button>
				</div>
				<div class="relative">
					<Search class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
					<Input
						class="pr-7 pl-7" placeholder="Filter references" aria-label="Filter references"
						value={filter()} onInput={(e) => setFilter(e.currentTarget.value)}
					/>
					<Show when={filter()}>
						<button class="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label="Clear filter" onClick={() => setFilter("")}>
							<X class="size-3.5" />
						</button>
					</Show>
				</div>
				<label class="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground select-none">
					<input
						type="checkbox" class="size-3.5 accent-[var(--primary)]"
						checked={hideInLibrary()} onChange={(e) => setHideInLibrary(e.currentTarget.checked)}
					/>
					Hide items in library
					<Show when={data()}><span class="ml-auto tabular-nums">{inLibraryCount()} in library</span></Show>
				</label>
			</header>

			<div ref={scroller} class="min-h-0 flex-1 overflow-y-auto" data-testid="references-scroller">
				<Show when={list.error}>
					<div class="flex flex-col items-center gap-2 px-6 py-10 text-center text-sm" role="alert">
						<AlertCircle class="size-6 text-destructive" />
						<div class="font-medium">Could not load references</div>
						<div class="text-xs text-muted-foreground">{(list.error as Error).message}</div>
						<Button size="sm" variant="outline" class="h-7 text-xs" onClick={refresh}>Try again</Button>
					</div>
				</Show>
				<Show when={!list.error && !data()}><RowSkeletons /></Show>
				<Show when={data()}>
					<Show
						when={visible().length}
						fallback={
							<div class="px-6 py-10 text-center text-sm text-muted-foreground" data-testid="references-empty">
								{all().length ? "No references match the current filter." : "No references were found for this item."}
							</div>
						}
					>
						<Show
							when={virtual()}
							fallback={
								<For each={visible()}>
									{(r) => <ReferenceRow reference={r} highlighted={flash() === r.index} onOpenItem={props.onOpenItem} onAdded={onAdded} />}
								</For>
							}
						>
							<div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}>
								<For each={virtualizer.getVirtualItems()}>
									{(v) => (
										<div
											data-index={v.index}
											ref={(el) => queueMicrotask(() => virtualizer.measureElement(el))}
											style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${v.start}px)` }}
										>
											<Show when={visible()[v.index]}>
												{(r) => <ReferenceRow reference={r()} highlighted={flash() === r().index} onOpenItem={props.onOpenItem} onAdded={onAdded} />}
											</Show>
										</div>
									)}
								</For>
							</div>
						</Show>
					</Show>
				</Show>
			</div>
		</section>
	);
}
