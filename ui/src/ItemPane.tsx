// Zotero 7/8-style item pane: header + collapsible sections + a section icon strip on the right edge.
// Implementation lives in ./itempane/.
import {
	createComputed, createEffect, createResource, createSignal, For, on, Show, type Component,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import { createStore, reconcile } from "solid-js/store";
import { AlignLeft, FileText, Info, Library, Link2, Paperclip, StickyNote, Tag, type LucideProps } from "lucide-solid";
import { api, type ItemDetail, type ZoteroItemData } from "./api";
import { store } from "./store";
import { itemList } from "./ItemTable";
import { fail } from "~/lib/actions";
import { cn } from "~/lib/utils";
import { Skeleton } from "~/components/ui/skeleton";
import { ipApi } from "./itempane/api";
import { creatorsSummary, PaneContext, setCollapsed, yearOf, type PaneCtx } from "./itempane/ctx";
import { Header, AbstractSection } from "./itempane/Header";
import { InfoSection } from "./itempane/Info";
import { AttachmentsSection } from "./itempane/Attachments";
import { NotesSection } from "./itempane/Notes";
import { CollectionsSection } from "./itempane/Collections";
import { TagsSection } from "./itempane/Tags";
import { RelatedSection } from "./itempane/Related";
import { MultiSelect } from "./itempane/Multi";
import { reconcile as _r } from "solid-js/store";
void _r;

const SECTIONS: { id: string; title: string; icon: Component<LucideProps> }[] = [
	{ id: "info", title: "Info", icon: Info },
	{ id: "abstract", title: "Abstract", icon: AlignLeft },
	{ id: "attachments", title: "Attachments", icon: Paperclip },
	{ id: "notes", title: "Notes", icon: StickyNote },
	{ id: "collections", title: "Libraries and Collections", icon: Library },
	{ id: "tags", title: "Tags", icon: Tag },
	{ id: "related", title: "Related", icon: Link2 },
];

const empty = (t: string) => (
	<div class="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground" data-testid="ip-empty">
		<FileText class="size-10 opacity-40" strokeWidth={1.25} />
		{t}
	</div>
);

const DetailSkeleton: Component = () => (
	<div class="space-y-3 px-3 pt-3">
		<Skeleton class="h-5 w-3/4" />
		<Skeleton class="h-3 w-1/3" />
		<Skeleton class="h-6 w-full" />
		<Skeleton class="h-6 w-full" />
		<Skeleton class="h-6 w-2/3" />
		<Skeleton class="h-28 w-full" />
	</div>
);

const Detail: Component<{ ctx: PaneCtx }> = (p) => {
	let scroller!: HTMLDivElement;
	const [active, setActive] = createSignal("info");

	const spy = () => {
		const top = scroller.scrollTop + 12;
		let cur = SECTIONS[0].id;
		for (const s of SECTIONS) {
			const el = scroller.querySelector<HTMLElement>(`#ip-sec-${s.id}`);
			if (el && el.offsetTop <= top) cur = s.id;
		}
		if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) cur = SECTIONS[SECTIONS.length - 1].id;
		setActive(cur);
	};
	const goTo = (id: string) => {
		setCollapsed(id, false);
		queueMicrotask(() => {
			const el = scroller.querySelector<HTMLElement>(`#ip-sec-${id}`);
			if (el) scroller.scrollTo({ top: el.offsetTop, behavior: "smooth" });
			setActive(id);
		});
	};

	return (
		<PaneContext.Provider value={p.ctx}>
			<div class="flex h-full min-h-0 flex-col" data-testid="ip-detail" data-item={p.ctx.d.data.key}>
				<Header />
				<div class="flex min-h-0 flex-1">
					<div ref={scroller} class="relative min-w-0 flex-1 overflow-y-auto" onScroll={spy}>
						<InfoSection />
						<AbstractSection />
						<AttachmentsSection />
						<NotesSection />
						<CollectionsSection />
						<TagsSection />
						<RelatedSection />
						<div class="h-48" />
					</div>
					<nav class="flex w-8 flex-none flex-col items-center gap-0.5 border-l bg-card py-1.5" aria-label="Item pane sections">
						<For each={SECTIONS}>
							{(s) => (
								<button
									type="button"
									title={s.title}
									aria-label={s.title}
									data-nav={s.id}
									onClick={() => goTo(s.id)}
									class={cn(
										"relative inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
										active() === s.id && "bg-accent text-foreground",
									)}
								>
									<Show when={active() === s.id}>
										<span class="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-primary" />
									</Show>
									<Dynamic component={s.icon} class="size-4" />
								</button>
							)}
						</For>
					</nav>
				</div>
			</div>
		</PaneContext.Provider>
	);
};

const SingleItem: Component = () => {
	const [res, { refetch }] = createResource(() => store.activeKey(), (k) => api.item(k));
	const [schema] = createResource(() => ipApi.schema());
	const [d, setD] = createStore<ItemDetail>({ data: { key: "", itemType: "" }, children: [], collections: [], tags: [] });

	createEffect(on(() => res.error, (e) => { if (e) fail("Could not load item", e); }));
	// Sync server state into the store before anything renders from it.
	createComputed(() => {
		const r = res();
		if (!r) return;
		if (r.data.key === d.data.key) setD(reconcile(r, { merge: true }));
		else setD(reconcile(r));
	});

	async function reload() {
		await refetch();
	}

	// Saves run one at a time so a slow response can't clobber a later optimistic edit.
	let chain: Promise<void> = Promise.resolve();
	const save: PaneCtx["save"] = (patch) =>
		(chain = chain.then(async () => {
			const key = d.data.key;
			const prev: Record<string, unknown> = {};
			for (const k of Object.keys(patch)) prev[k] = JSON.parse(JSON.stringify(d.data[k] ?? null));
			for (const [k, v] of Object.entries(patch)) setD("data", k, reconcile(v as never));
			try {
				const r = await api.patchItem(key, patch as Partial<ZoteroItemData>);
				if (d.data.key === key) setD(reconcile(r, { merge: true }));
				itemList.patch(key, {
					title: r.data.title ?? "",
					publication: r.data.publicationTitle ?? null,
					year: yearOf(r.data.date),
					itemType: r.data.itemType,
					creatorsSummary: creatorsSummary(r.data.creators, "author"),
				});
			} catch (e) {
				if (d.data.key === key) for (const [k, v] of Object.entries(prev)) setD("data", k, reconcile((v ?? undefined) as never));
				fail("Could not save changes", e);
			}
		}));

	const ctx: PaneCtx = { d, setD, save, reload, schema };
	const ready = () => !!d.data.key && d.data.key === store.activeKey();
	return (
		<Show when={ready()} fallback={res.error ? empty("Could not load item") : <DetailSkeleton />}>
			<Detail ctx={ctx} />
		</Show>
	);
};

export const ItemPane: Component = () => {
	return (
		<div class="h-full">
			<Show when={store.selected().size <= 1} fallback={<MultiSelect />}>
				<Show when={store.activeKey()} fallback={empty("Select an item to view its details")}>
					<SingleItem />
				</Show>
			</Show>
		</div>
	);
};
