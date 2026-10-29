import { createEffect, createResource, createSignal, For, on, Show, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { ExternalLink, Plus, StickyNote, X } from "lucide-solid";
import { api, type ChildSummary, type Creator, type ItemDetail, type ZoteroItemData } from "./api";
import { store } from "./store";
import { itemList } from "./ItemTable";
import { sanitizeNote } from "./sanitize";
import { fail } from "~/lib/actions";
import { attachmentIcon, itemTypeIcon, itemTypeLabel } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input, Textarea } from "~/components/ui/input";
import { Separator } from "~/components/ui/separator";
import { Skeleton } from "~/components/ui/skeleton";

const yearOf = (d?: string) => {
	const m = d?.match(/\b(\d{4})\b/);
	return m ? +m[1] : null;
};

const Note: Component<{ c: ChildSummary }> = (p) => {
	const [d] = createResource(() => p.c.key, (k) => api.item(k));
	return (
		<div class="my-1 flex gap-2 rounded-md border bg-muted/50 px-2.5 py-1.5">
			<StickyNote class="mt-0.5 size-3.5 flex-none text-muted-foreground" />
			<div class="min-w-0 break-words [&_h1]:text-sm [&_h1]:font-semibold [&_h2]:font-semibold [&_p]:my-1 [&_a]:text-primary [&_a]:underline"
				innerHTML={sanitizeNote(d()?.data.note ?? "")} />
		</div>
	);
};

const SectionTitle: Component<{ n?: number; children: string }> = (p) => (
	<div class="mt-4 mb-1.5 flex items-center gap-2">
		<span class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{p.children}</span>
		<Separator class="flex-1" />
	</div>
);

const Field: Component<{
	label: string;
	value: string;
	multiline?: boolean;
	onSave: (v: string) => void;
	link?: string;
}> = (p) => {
	const commit = (e: FocusEvent & { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => {
		if (e.currentTarget.value !== p.value) p.onSave(e.currentTarget.value);
	};
	return (
		<div class="mb-1.5 grid grid-cols-[68px_1fr] items-start gap-2">
			<label class="pt-1 text-right text-xs text-muted-foreground">{p.label}</label>
			<div class="flex min-w-0 items-start gap-1">
				<Show
					when={p.multiline}
					fallback={
						<Input
							value={p.value}
							onBlur={commit}
							onKeyDown={(e) => {
								if (e.key === "Enter") e.currentTarget.blur();
								if (e.key === "Escape") {
									e.currentTarget.value = p.value;
									e.currentTarget.blur();
								}
							}}
						/>
					}
				>
					<Textarea class="resize-y" rows={p.label === "Abstract" ? 8 : 3} value={p.value} onBlur={commit} />
				</Show>
				<Show when={p.link && p.value}>
					<a class="mt-1 text-muted-foreground hover:text-primary" href={p.link} target="_blank" rel="noopener noreferrer" title="Open">
						<ExternalLink class="size-3.5" />
					</a>
				</Show>
			</div>
		</div>
	);
};

const Detail: Component<{ d: ItemDetail; reload: () => void }> = (props) => {
	const d = () => props.d.data;
	const key = () => d().key;
	const [newTag, setNewTag] = createSignal("");

	async function save(data: Partial<ZoteroItemData>) {
		try {
			const res = await api.patchItem(key(), data);
			itemList.patch(key(), {
				title: res.data.title ?? "",
				publication: res.data.publicationTitle ?? null,
				year: yearOf(res.data.date),
			});
			props.reload();
		} catch (e) {
			fail("Could not save changes", e);
		}
	}
	const saveCreators = (list: Creator[]) => save({ creators: list });
	const setCreator = (i: number, patch: Partial<Creator>) =>
		saveCreators((d().creators ?? []).map((c, j) => (j === i ? { ...c, ...patch } : c)));

	async function addTag() {
		const t = newTag().trim();
		setNewTag("");
		if (!t) return;
		try {
			await api.addTags(key(), [t]);
			props.reload();
			store.bumpTags();
		} catch (e) {
			fail("Could not add tag", e);
		}
	}
	async function removeTag(t: string) {
		try {
			await api.removeTags(key(), [t]);
			props.reload();
			store.bumpTags();
		} catch (e) {
			fail("Could not remove tag", e);
		}
	}

	return (
		<div class="px-3 pt-2 pb-6">
			<div class="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
				<Dynamic component={itemTypeIcon(d().itemType)} class="size-3.5" />
				{itemTypeLabel(d().itemType)}
			</div>
			<Field label="Title" value={d().title ?? ""} multiline onSave={(v) => save({ title: v })} />
			<div class="mb-1.5 grid grid-cols-[68px_1fr] items-start gap-2">
				<label class="pt-1 text-right text-xs text-muted-foreground">Creators</label>
				<div class="flex min-w-0 flex-col gap-1">
					<For each={d().creators ?? []}>
						{(c, i) => (
							<div class="flex items-center gap-1">
								<span class="w-12 flex-none truncate text-[11px] text-muted-foreground">{c.creatorType}</span>
								<Show
									when={c.name === undefined}
									fallback={
										<Input
											value={c.name ?? ""}
											onBlur={(e) => e.currentTarget.value !== c.name && setCreator(i(), { name: e.currentTarget.value })}
										/>
									}
								>
									<Input
										placeholder="Last"
										value={c.lastName ?? ""}
										onBlur={(e) => e.currentTarget.value !== (c.lastName ?? "") && setCreator(i(), { lastName: e.currentTarget.value })}
									/>
									<Input
										placeholder="First"
										value={c.firstName ?? ""}
										onBlur={(e) => e.currentTarget.value !== (c.firstName ?? "") && setCreator(i(), { firstName: e.currentTarget.value })}
									/>
								</Show>
								<Button variant="ghost" size="icon" class="size-6 flex-none text-muted-foreground" title="Remove creator"
									onClick={() => saveCreators((d().creators ?? []).filter((_, j) => j !== i()))}>
									<X />
								</Button>
							</div>
						)}
					</For>
					<Button variant="link" size="sm" class="h-6 w-fit gap-1 px-0 text-xs"
						onClick={() => saveCreators([...(d().creators ?? []), { creatorType: "author", lastName: "", firstName: "" }])}>
						<Plus class="size-3" /> Add creator
					</Button>
				</div>
			</div>
			<Field label="Date" value={d().date ?? ""} onSave={(v) => save({ date: v })} />
			<Field label="Publication" value={d().publicationTitle ?? ""} onSave={(v) => save({ publicationTitle: v })} />
			<Field
				label="DOI"
				value={d().DOI ?? ""}
				link={d().DOI ? "https://doi.org/" + encodeURI(d().DOI!) : undefined}
				onSave={(v) => save({ DOI: v })}
			/>
			<Field
				label="URL"
				value={d().url ?? ""}
				link={/^https?:\/\//i.test(d().url ?? "") ? d().url : undefined}
				onSave={(v) => save({ url: v })}
			/>
			<Field label="Abstract" value={d().abstractNote ?? ""} multiline onSave={(v) => save({ abstractNote: v })} />

			<SectionTitle>Tags</SectionTitle>
			<div class="flex flex-wrap items-center gap-1">
				<For each={props.d.tags}>
					{(t) => (
						<Badge round variant="secondary" class="gap-0.5 py-0 pr-0.5 pl-2 font-normal">
							{t.tag}
							<button class="rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" title="Remove tag" onClick={() => removeTag(t.tag)}>
								<X class="size-3" />
							</button>
						</Badge>
					)}
				</For>
				<Input
					class="h-6 w-28 rounded-full px-2.5 text-xs"
					placeholder="Add tag…"
					value={newTag()}
					onInput={(e) => setNewTag(e.currentTarget.value)}
					onKeyDown={(e) => e.key === "Enter" && addTag()}
					onBlur={addTag}
				/>
			</div>

			<Show when={props.d.children.length}>
				<SectionTitle>Attachments &amp; notes</SectionTitle>
				<For each={props.d.children}>
					{(c) => (
						<Show
							when={c.itemType === "note"}
							fallback={
								<div
									class={cn("flex items-center gap-2 rounded-md px-1.5 py-1", c.hasFile && "cursor-default hover:bg-accent")}
									onClick={() =>
										c.hasFile && /pdf|epub/i.test(c.contentType ?? "") && store.openAttachment(c.key, d().title || c.title)
									}
									onDblClick={() => c.hasFile && store.openAttachment(c.key, d().title || c.title)}
								>
									<Dynamic component={attachmentIcon(c.contentType, c.linkMode)} class="size-4 flex-none text-muted-foreground" />
									<span class="flex-1 truncate">{c.title}</span>
									<Show when={c.annotationCount}>
										<Badge round variant="secondary" class="px-1.5 py-0 font-normal" title="Annotations">
											{c.annotationCount}
										</Badge>
									</Show>
								</div>
							}
						>
							<Note c={c} />
						</Show>
					)}
				</For>
			</Show>
		</div>
	);
};

const DetailSkeleton: Component = () => (
	<div class="space-y-3 px-3 pt-3">
		<Skeleton class="h-3 w-24" />
		<Skeleton class="h-16 w-full" />
		<Skeleton class="h-6 w-full" />
		<Skeleton class="h-6 w-full" />
		<Skeleton class="h-6 w-2/3" />
		<Skeleton class="h-28 w-full" />
	</div>
);

export const ItemPane: Component = () => {
	const [d, { refetch }] = createResource(
		() => store.activeKey(),
		(k) => api.item(k),
	);
	createEffect(on(() => d.error, (e) => { if (e) fail("Could not load item", e); }));
	const empty = (t: string) => <div class="p-6 text-center text-muted-foreground">{t}</div>;
	return (
		<div class="h-full">
			<Show when={store.selected().size <= 1} fallback={empty(`${store.selected().size} items selected`)}>
				<Show when={store.activeKey()} fallback={empty("Select an item")}>
					<Show when={d()} fallback={d.error ? empty("Could not load item") : <DetailSkeleton />}>
						{(det) => <Detail d={det()} reload={() => refetch()} />}
					</Show>
				</Show>
			</Show>
		</div>
	);
};
