import { createSignal, For, Show, type Component } from "solid-js";
import { Folder, Library, Minus, Plus } from "lucide-solid";
import { api } from "../api";
import { store } from "../store";
import { fail } from "~/lib/actions";
import { ipApi } from "./api";
import { usePane } from "./ctx";
import { IconBtn, Picker, Section } from "./ui";

/** Ancestors-first chain of collection names for a key. */
export function collectionPath(key: string): string[] {
	const all = store.collections() ?? [];
	const byKey = new Map(all.map((c) => [c.key, c]));
	const out: string[] = [];
	for (let k: string | null | undefined = key, n = 0; k && n < 20; n++) {
		const c = byKey.get(k);
		if (!c) break;
		out.unshift(c.name);
		k = c.parentKey;
	}
	return out;
}

export const CollectionsSection: Component = () => {
	const { d, setD, reload } = usePane();
	const [adding, setAdding] = createSignal(false);
	const mine = () => d.collections;

	const sync = (list: string[]) => { setD("collections", list); setD("data", "collections", list); };
	async function add(key: string) {
		const prev = [...mine()];
		sync([...prev, key]);
		setAdding(false);
		try {
			await api.addToCollection(key, [d.data.key]);
			store.bumpCollections();
		} catch (e) {
			sync(prev);
			fail("Could not add to collection", e);
		}
	}
	async function remove(key: string) {
		const prev = [...mine()];
		sync(prev.filter((k) => k !== key));
		try {
			await ipApi.removeFromCollection(key, [d.data.key]);
			store.bumpCollections();
		} catch (e) {
			sync(prev);
			fail("Could not remove from collection", e);
			void reload();
		}
	}
	const candidates = (q: string) => {
		const needle = q.trim().toLowerCase();
		return (store.collections() ?? [])
			.filter((c) => !mine().includes(c.key))
			.map((c) => ({ key: c.key, path: collectionPath(c.key) }))
			.filter((c) => !needle || c.path.join(" ").toLowerCase().includes(needle))
			.sort((a, b) => a.path.join("\u0000").localeCompare(b.path.join("\u0000")))
			.slice(0, 50);
	};

	return (
		<Section
			id="collections"
			title="Libraries and Collections"
			icon={Library}
			count={mine().length}
			actions={<IconBtn title="Add to Collection" onClick={() => setAdding(!adding())}><Plus /></IconBtn>}
		>
			<div class="flex items-center gap-1.5 px-1.5 py-[3px]">
				<Library class="size-4 flex-none text-muted-foreground" />
				<span>My Library</span>
			</div>
			<For each={mine()}>
				{(k) => (
					<div class="group/col flex items-center gap-1.5 rounded py-[3px] pr-1.5 pl-5 hover:bg-accent/60" data-collection={k}>
						<Folder class="size-4 flex-none text-muted-foreground" />
						<span class="min-w-0 flex-1 truncate" title={collectionPath(k).join(" › ")}>
							<For each={collectionPath(k)}>
								{(name, i) => (
									<>
										<Show when={i() > 0}><span class="px-0.5 text-muted-foreground">{"›"}</span></Show>
										<span class={i() < collectionPath(k).length - 1 ? "text-muted-foreground" : ""}>{name}</span>
									</>
								)}
							</For>
						</span>
						<div class="opacity-0 transition-opacity group-focus-within/col:opacity-100 group-hover/col:opacity-100">
							<IconBtn title="Remove from collection" onClick={() => remove(k)}><Minus /></IconBtn>
						</div>
					</div>
				)}
			</For>
			<Show when={adding()}>
				<Picker
					class="mt-1.5"
					autofocus
					placeholder={"Add to collection…"}
					query={candidates}
					render={(c: { key: string; path: string[] }) => c.path.join(" › ")}
					onPick={(c) => void add(c.key)}
					onClose={() => setAdding(false)}
				/>
			</Show>
		</Section>
	);
};
