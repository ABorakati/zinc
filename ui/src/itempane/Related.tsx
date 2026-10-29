import { createSignal, For, Show, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { Link2, Minus, Plus } from "lucide-solid";
import { reconcile } from "solid-js/store";
import { api, type ItemSummary } from "../api";
import { store } from "../store";
import { fail } from "~/lib/actions";
import { itemTypeIcon } from "~/lib/icons";
import { ipApi } from "./api";
import { usePane } from "./ctx";
import { IconBtn, Picker, Section } from "./ui";

const sub = (c: string, y: number | null) => [c, y].filter(Boolean).join(" · ");

export const RelatedSection: Component = () => {
	const { d, setD, reload } = usePane();
	const [adding, setAdding] = createSignal(false);
	const related = () => d.related ?? [];

	async function search(q: string): Promise<ItemSummary[]> {
		if (!q.trim()) return [];
		const r = await api.items({ q: q.trim(), sort: "title", dir: "asc" }, 0, 15);
		const have = new Set([d.data.key, ...related().map((x) => x.key)]);
		return r.items.filter((i) => !have.has(i.key));
	}
	async function add(it: ItemSummary) {
		setAdding(false);
		try {
			setD(reconcile(await ipApi.addRelated(d.data.key, [it.key]), { merge: true }));
		} catch (e) {
			fail("Could not add related item", e);
		}
	}
	async function remove(key: string) {
		const prev = related().map((r) => ({ ...r }));
		setD("related", prev.filter((r) => r.key !== key));
		try {
			setD(reconcile(await ipApi.removeRelated(d.data.key, [key]), { merge: true }));
		} catch (e) {
			fail("Could not remove related item", e);
			void reload();
		}
	}

	return (
		<Section
			id="related"
			title="Related"
			icon={Link2}
			count={related().length}
			actions={<IconBtn title="Add related item" onClick={() => setAdding(!adding())}><Plus /></IconBtn>}
		>
			<Show when={related().length === 0 && !adding()}>
				<div class="px-1.5 py-1 text-xs text-muted-foreground">No related items</div>
			</Show>
			<For each={related()}>
				{(r) => (
					<div
						class="group/rel flex items-center gap-1.5 rounded px-1.5 py-[3px] hover:bg-accent/60"
						data-related={r.key}
						onClick={() => store.selectOnly(r.key)}
					>
						<Dynamic component={itemTypeIcon(r.itemType)} class="size-4 flex-none text-muted-foreground" />
						<span class="min-w-0 flex-1 truncate" title={r.title}>{r.title || "Untitled"}</span>
						<span class="flex-none truncate text-[11px] text-muted-foreground">{sub(r.creatorsSummary, r.year)}</span>
						<div class="opacity-0 transition-opacity group-focus-within/rel:opacity-100 group-hover/rel:opacity-100">
							<IconBtn title="Remove relation" onClick={(e) => { e.stopPropagation(); void remove(r.key); }}><Minus /></IconBtn>
						</div>
					</div>
				)}
			</For>
			<Show when={adding()}>
				<Picker
					class="mt-1.5"
					autofocus
					placeholder={"Search items to relate…"}
					query={search}
					render={(it: ItemSummary) => (
						<>
							{it.title}
							<span class="ml-1.5 text-muted-foreground">{sub(it.creatorsSummary, it.year)}</span>
						</>
					)}
					onPick={(it) => void add(it)}
					onClose={() => setAdding(false)}
				/>
			</Show>
		</Section>
	);
};
