import { For, Show, type Component } from "solid-js";
import { Tag, X } from "lucide-solid";
import { api } from "../api";
import { store } from "../store";
import { fail } from "~/lib/actions";
import { cn } from "~/lib/utils";
import { usePane } from "./ctx";
import { Picker, Section } from "./ui";

/**
 * The library's tag list, fetched once per change of the tag list (store.tagsRev) and shared app-wide. It is
 * large (MBs, about a second on a big library), so the item pane must not fetch it per item shown: that made
 * every click through the item list wait on it.
 */
let tagCache: { rev: number; list: Promise<Awaited<ReturnType<typeof api.tags>>> } | null = null;
export function allTags() {
	const rev = store.tagsRev();
	if (!tagCache || tagCache.rev !== rev) {
		const list = api.tags();
		list.catch(() => { if (tagCache?.list === list) tagCache = null; }); // retry next time
		tagCache = { rev, list };
	}
	return tagCache.list;
}

/** Tag autocomplete source: loads the tag list only once the user types. */
export function createTagSource() {
	return async (q: string, exclude: string[] = []) => {
		const needle = q.trim().toLowerCase();
		if (!needle) return [];
		const all = await allTags().catch(() => []);
		return all.filter((t) => t.tag.toLowerCase().includes(needle) && !exclude.includes(t.tag)).slice(0, 12).map((t) => t.tag);
	};
}

export const TagsSection: Component = () => {
	const { d, setD, reload } = usePane();
	const suggest = createTagSource();
	const tags = () => [...d.tags].sort((a, b) => a.tag.localeCompare(b.tag, undefined, { sensitivity: "base" }));

	async function add(raw: string) {
		const t = raw.trim();
		if (!t || d.tags.some((x) => x.tag === t)) return;
		const prev = d.tags.map((x) => ({ ...x }));
		setD("tags", [...prev, { tag: t, type: 0 }]);
		try {
			await api.addTags(d.data.key, [t]);
			store.bumpTags();
		} catch (e) {
			setD("tags", prev);
			fail("Could not add tag", e);
		}
	}
	async function remove(t: string) {
		const prev = d.tags.map((x) => ({ ...x }));
		setD("tags", prev.filter((x) => x.tag !== t));
		try {
			await api.removeTags(d.data.key, [t]);
			store.bumpTags();
		} catch (e) {
			fail("Could not remove tag", e);
			void reload();
		}
	}

	return (
		<Section id="tags" title="Tags" icon={Tag} count={d.tags.length}>
			<Show when={d.tags.length}>
				<div class="mb-1.5 flex flex-wrap gap-1">
					<For each={tags()}>
						{(t) => (
							<span
								data-tag={t.tag}
								data-automatic={t.type === 1 ? "" : undefined}
								title={t.type === 1 ? "Automatic tag" : undefined}
								class={cn(
									"group/tag inline-flex max-w-full items-center gap-0.5 rounded-full py-px pr-0.5 pl-2 text-xs",
									t.type === 1
										? "border border-dashed border-input bg-transparent text-muted-foreground italic"
										: "bg-secondary text-secondary-foreground",
								)}
							>
								<span class="truncate">{t.tag}</span>
								<button
									type="button"
									aria-label={`Remove tag ${t.tag}`}
									title="Remove tag"
									class="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
									onClick={() => remove(t.tag)}
								>
									<X class="size-3" />
								</button>
							</span>
						)}
					</For>
				</div>
			</Show>
			<Picker
				placeholder={"Add tag…"}
				ariaLabel="Add tag"
				keepOpen
				query={(q) => suggest(q, d.tags.map((x) => x.tag))}
				render={(t: string) => t}
				onPick={(t) => void add(t)}
				onSubmitText={(t) => void add(t)}
			/>
		</Section>
	);
};
