import type { Component } from "solid-js";
import { FileSearch, Files } from "lucide-solid";
import { toast } from "solid-sonner";
import { api } from "../api";
import { store } from "../store";
import { addItemsToCollection, fail } from "~/lib/actions";
import { findFullText } from "~/lib/fulltext";
import { createTagSource } from "./Tags";
import { collectionPath } from "./Collections";
import { Picker, TextBtn } from "./ui";

export const MultiSelect: Component = () => {
	const keys = () => [...store.selected()];
	const suggest = createTagSource();

	async function addTag(raw: string) {
		const t = raw.trim();
		if (!t) return;
		try {
			await Promise.all(keys().map((k) => api.addTags(k, [t])));
			store.bumpTags();
			toast.success(`Added tag "${t}" to ${keys().length} items`);
		} catch (e) {
			fail("Could not add tag", e);
		}
	}
	const collections = (q: string) => {
		const needle = q.trim().toLowerCase();
		return (store.collections() ?? [])
			.map((c) => ({ key: c.key, path: collectionPath(c.key) }))
			.filter((c) => !needle || c.path.join(" ").toLowerCase().includes(needle))
			.sort((a, b) => a.path.join("\u0000").localeCompare(b.path.join("\u0000")))
			.slice(0, 50);
	};

	return (
		<div class="flex h-full flex-col items-center gap-3 px-4 pt-10 text-center" data-testid="ip-multi">
			<Files class="size-10 text-muted-foreground/50" strokeWidth={1.25} />
			<div class="text-sm font-medium">{keys().length} items selected</div>
			<div class="flex w-full max-w-64 flex-col gap-2 text-left">
				<div>
					<div class="mb-1 text-xs text-muted-foreground">Add tag to all</div>
					<Picker
						placeholder={"Tag name…"}
						ariaLabel="Add tag to selected items"
						query={(q) => suggest(q)}
						render={(t: string) => t}
						onPick={(t) => void addTag(t)}
						onSubmitText={(t) => void addTag(t)}
					/>
				</div>
				<div>
					<div class="mb-1 text-xs text-muted-foreground">Add all to collection</div>
					<Picker
						placeholder={"Choose collection…"}
						ariaLabel="Add selected items to collection"
						query={collections}
						render={(c: { key: string; path: string[] }) => c.path.join(" › ")}
						onPick={(c) => void addItemsToCollection(c.key, c.path[c.path.length - 1], keys())}
					/>
				</div>
				<TextBtn class="mt-1 h-7 justify-center" onClick={() => findFullText(keys())}>
					<FileSearch /> Find Full Text
				</TextBtn>
			</div>
		</div>
	);
};
