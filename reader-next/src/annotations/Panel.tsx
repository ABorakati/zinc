// "Annotations" sidebar tab: all annotations in document order, search, colour/tag filters, inline comments,
// click to jump, and "Add note from annotations".
import { FilePlus, Highlighter, PenLine, SquareDashed, StickyNote, Trash, Type, Underline } from "lucide-solid";
import { createEffect, createMemo, createSignal, For, onMount, Show, type Component } from "solid-js";
import type { Ctx } from "./actions";
import { COLORS, matchesFilter, type Annotation, type AnnotationType } from "./model";
import { CommentBox, TagEditor } from "./Widgets";
import { Button } from "../viewer/ui/button";
import { cn } from "../viewer/ui/utils";

const TYPE_ICON: Record<AnnotationType, Component<{ class?: string }>> = {
	highlight: Highlighter, underline: Underline, note: StickyNote, image: SquareDashed, ink: PenLine, text: Type,
};

function Crop(props: { ctx: Ctx; a: Annotation }) {
	let host!: HTMLDivElement;
	onMount(() => {
		const r = props.a.position.rects?.[0];
		if (!r) return;
		void props.ctx.viewer.renderRegion(props.a.position.pageIndex, r, 240).then((c) => {
			c.className = "max-w-full rounded border";
			host.replaceChildren(c);
		}).catch(() => {});
	});
	return <div ref={host} class="mt-1" />;
}

function Item(props: { ctx: Ctx; id: string }) {
	const { store, ui, act } = props.ctx;
	const a = createMemo(() => store.get(props.id));
	const selected = () => ui.selectedId() === props.id;
	let el!: HTMLDivElement;
	createEffect(() => { if (selected()) el.scrollIntoView({ block: "nearest" }); });
	return (
		<Show when={a()}>
			<div
				ref={el} data-ann-item={props.id}
				class={cn("group relative cursor-default border-b py-2 pl-3 pr-2 hover:bg-accent/60", selected() && "bg-accent")}
				onClick={() => act.jump(a()!)}
			>
				<span class="absolute inset-y-0 left-0 w-1" style={{ "background-color": a()!.color }} />
				<div class="flex items-center gap-1.5 text-[11px] text-muted-foreground">
					{(() => { const I = TYPE_ICON[a()!.type] ?? Highlighter; return <I class="size-3.5" />; })()}
					<span>Page {a()!.pageLabel || a()!.position.pageIndex + 1}</span>
					<span class="flex-1" />
					<button
						class="rounded p-0.5 opacity-0 hover:text-destructive group-hover:opacity-100" title="Delete" aria-label="Delete annotation"
						onClick={(e) => { e.stopPropagation(); act.remove([props.id]); }}
					><Trash class="size-3.5" /></button>
				</div>
				<Show when={a()!.text}>
					<p class="mt-1 line-clamp-6 border-l-2 pl-2 text-[12.5px]" style={{ "border-color": a()!.color }}>{a()!.text}</p>
				</Show>
				<Show when={a()!.type === "image"}><Crop ctx={props.ctx} a={a()!} /></Show>
				<Show when={a()!.type === "ink"}><p class="mt-1 text-[12px] italic text-muted-foreground">Ink drawing</p></Show>
				<div class="mt-1.5" onClick={(e) => e.stopPropagation()}>
					<CommentBox ctx={props.ctx} id={props.id} rows={1} class="text-[12px]" />
				</div>
				<Show when={(a()!.tags ?? []).length}>
					<div class="mt-1 flex flex-wrap gap-1">
						<For each={a()!.tags}>{(t) => <span class="rounded bg-accent px-1.5 py-0.5 text-[11px]">{t.name}</span>}</For>
					</div>
				</Show>
			</div>
		</Show>
	);
}

export function AnnotationsPanel(props: { ctx: Ctx }) {
	const { store, act } = props.ctx;
	const [query, setQuery] = createSignal("");
	const [colors, setColors] = createSignal<string[]>([]);
	const [tag, setTag] = createSignal("");
	const allTags = createMemo(() => [...new Set(store.list().flatMap((a) => (a.tags ?? []).map((t) => t.name)))].sort((x, y) => x.localeCompare(y)));
	const usedColors = createMemo(() => COLORS.filter((c) => store.list().some((a) => a.color === c.value)));
	const shown = createMemo(
		() => store.list().filter((a) => matchesFilter(a, { query: query(), colors: colors(), tag: tag() })).map((a) => a.id),
		[] as string[],
		{ equals: (x, y) => x.length === y.length && x.every((v, i) => v === y[i]) },
	);
	const toggle = (c: string) => setColors((cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]));
	const filtered = () => !!(query().trim() || colors().length || tag());
	return (
		<div class="flex h-full flex-col" data-annotations-panel>
			<div class="shrink-0 space-y-2 border-b p-2">
				<input
					type="search" value={query()} placeholder="Search annotations" aria-label="Search annotations"
					class="h-7 w-full rounded border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
					onInput={(e) => setQuery(e.currentTarget.value)}
					onKeyDown={(e) => e.stopPropagation()}
				/>
				<Show when={usedColors().length > 1 || allTags().length}>
					<div class="flex flex-wrap items-center gap-1">
						<For each={usedColors()}>{(c) => (
							<button
								class={cn("size-4 rounded-full border border-black/20", colors().includes(c.value) ? "ring-2 ring-primary ring-offset-1 ring-offset-card" : colors().length && "opacity-40")}
								style={{ "background-color": c.value }} title={`Show only ${c.name.toLowerCase()}`} aria-label={`Filter ${c.name}`} onClick={() => toggle(c.value)}
							/>
						)}</For>
						<Show when={allTags().length}>
							<select
								class="ml-auto h-6 max-w-32 rounded border bg-background px-1 text-[11px] outline-none" aria-label="Filter by tag"
								value={tag()} onChange={(e) => setTag(e.currentTarget.value)}
							>
								<option value="">All tags</option>
								<For each={allTags()}>{(t) => <option value={t}>{t}</option>}</For>
							</select>
						</Show>
					</div>
				</Show>
				<div class="flex items-center gap-2 text-[11px] text-muted-foreground">
					<span data-count>{filtered() ? `${shown().length} of ${store.list().length}` : `${store.list().length} annotation${store.list().length === 1 ? "" : "s"}`}</span>
					<Show when={filtered()}>
						<button class="underline" onClick={() => { setQuery(""); setColors([]); setTag(""); }}>Clear</button>
					</Show>
					<span class="flex-1" />
					<span classList={{ "text-destructive": store.status() === "error" }}>{store.status() === "saved" ? "Saved" : store.status() === "saving" ? "Saving…" : "Not saved, retrying"}</span>
				</div>
				<Button
					variant="outline" class="h-7 w-full justify-start gap-1.5 px-2 text-xs" disabled={!props.ctx.viewer.itemKey || !store.list().length}
					title={props.ctx.viewer.itemKey ? "Create a child note listing these annotations" : "This file has no parent item"}
					onClick={() => void act.noteFromAnnotations(store.list().filter((a) => shown().includes(a.id)))}
				><FilePlus class="size-3.5" />Add note from annotations{filtered() ? " (filtered)" : ""}</Button>
			</div>
			<div class="min-h-0 flex-1 overflow-y-auto">
				<Show when={store.list().length} fallback={
					<p class="p-4 text-xs text-muted-foreground">No annotations yet. Select text to highlight it, or pick a tool in the toolbar.</p>
				}>
					<For each={shown()} fallback={<p class="p-4 text-xs text-muted-foreground">No annotations match.</p>}>{(id) => <Item ctx={props.ctx} id={id} />}</For>
				</Show>
			</div>
		</div>
	);
}
