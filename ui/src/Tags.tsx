import { createMemo, createResource, createSignal, For, Show, type Component } from "solid-js";
import { api } from "./api";
import { store } from "./store";
import { fail } from "~/lib/actions";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";

export const TagList: Component = () => {
	const [tags] = createResource(() => store.tagsRev(), () => api.tags().catch((e) => { fail("Could not load tags", e); return []; }));
	const [f, setF] = createSignal("");
	const shown = createMemo(() => {
		const q = f().toLowerCase();
		return (tags() ?? []).filter((t) => t.tag.toLowerCase().includes(q)).slice(0, 500);
	});
	return (
		<div class="flex h-full min-h-0 flex-col">
			<div class="flex-none px-2 pt-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Tags</div>
			<Input class="mx-2 mb-1.5 w-auto flex-none" placeholder="Filter tags" value={f()} onInput={(e) => setF(e.currentTarget.value)} />
			<div class="flex min-h-0 flex-1 flex-wrap content-start gap-1 overflow-y-auto px-2 pb-2">
				<Show when={!tags.loading || tags()} fallback={
					<For each={[48, 64, 40, 56, 72]}>{(w) => <Skeleton class="h-5 rounded-full" style={{ width: w + "px" }} />}</For>
				}>
					<For each={shown()}>{(t) => (
						<Badge round variant={store.tag() === t.tag ? "default" : "outline"}
							class="cursor-default px-2 py-0 font-normal hover:border-primary"
							title={`${t.count} items`} role="button"
							onClick={() => store.setTag(store.tag() === t.tag ? null : t.tag)}>{t.tag}</Badge>
					)}</For>
				</Show>
			</div>
		</div>
	);
};
