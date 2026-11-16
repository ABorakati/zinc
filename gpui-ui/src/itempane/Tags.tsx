// Tags: chips (coloured tags with their colour, automatic tags dashed/italic-less), remove, and an add field with autocomplete from the
// library's tags. Port of ui/src/itempane/Tags.tsx.
import { For, Show, type JSX } from "solid-js";
import { Icon } from "../icons";
import { store } from "../store";
import { withAlpha } from "../theme";
import { IconBtn, locked, Picker, Section, t, tok, tx } from "./kit";
import { fail, usePane } from "./model";
import { ipApi } from "./net";

/** Tag autocomplete source: loads the (large) library tag list once the user types. */
export function createTagSource() {
	return async (q: string, exclude: string[] = []): Promise<string[]> => {
		const needle = q.trim().toLowerCase();
		if (!needle) return [];
		const all = await ipApi.tags(store.libraryId()).catch(() => []);
		return all
			.filter((x) => x.tag.toLowerCase().includes(needle) && !exclude.includes(x.tag))
			.slice(0, 12)
			.map((x) => x.tag);
	};
}

export function TagChip(p: { tag: string; automatic?: boolean; color?: string; onRemove?: () => void }): JSX.Element {
	const fg = () => (p.color ? tok("foreground") : p.automatic ? tok("muted-foreground") : tok("secondary-foreground"));
	return (
		<div
			style={{
				...t("flex items-center rounded-full"),
				maxWidth: "100%",
				paddingTop: 1,
				paddingBottom: 1,
				paddingLeft: 8,
				paddingRight: p.onRemove ? 2 : 8,
				gap: 2,
				backgroundColor: p.color ? withAlpha(p.color, 0.18) : p.automatic ? "transparent" : tok("secondary"),
				borderWidth: p.color || p.automatic ? 1 : 0,
				borderStyle: p.automatic ? "dashed" : "solid",
				borderColor: p.color ? withAlpha(p.color, 0.5) : tok("input"),
			}}
		>
			<Show when={p.color}>
				<div style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: p.color, marginRight: 3, flexShrink: 0 }} />
			</Show>
			<text
				style={{ ...tx("text-xs"), color: fg(), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}
			>
				{p.tag}
			</text>
			<Show when={p.onRemove}>
				<IconBtn icon="x" size={11} box={16} title={`Remove tag ${p.tag}`} onClick={p.onRemove} />
			</Show>
		</div>
	);
}

export function TagsSection(): JSX.Element {
	const pane = usePane();
	const suggest = createTagSource();
	const tags = () => [...(pane.detail()?.tags ?? [])].sort((a, b) => a.tag.localeCompare(b.tag, undefined, { sensitivity: "base" }));

	async function add(raw: string) {
		const d = pane.detail();
		const tag = raw.trim();
		if (!d || !tag || d.tags.some((x) => x.tag === tag)) return;
		pane.setDetail({ ...d, tags: [...d.tags, { tag, type: 0 }] });
		try {
			await ipApi.addTags(d.data.key, [tag]);
			ipApi.invalidateTags();
			pane.refreshList();
		} catch (e) {
			fail("Could not add tag", e);
			void pane.reload();
		}
	}
	async function remove(tag: string) {
		const d = pane.detail();
		if (!d) return;
		pane.setDetail({ ...d, tags: d.tags.filter((x) => x.tag !== tag) });
		try {
			await ipApi.removeTags(d.data.key, [tag]);
			pane.refreshList();
		} catch (e) {
			fail("Could not remove tag", e);
			void pane.reload();
		}
	}

	return (
		<Section id="tags" title="Tags" icon="tag" count={pane.detail()?.tags.length ?? 0}>
			<Show when={tags().length}>
				<div style={{ ...t("flex flex-wrap gap-1"), marginBottom: 6, width: "100%" }}>
					<For each={tags()}>
						{(x) => (
							<TagChip
								tag={x.tag}
								automatic={x.type === 1}
								color={pane.tagColors().get(x.tag)}
								onRemove={locked() ? undefined : () => void remove(x.tag)}
							/>
						)}
					</For>
				</div>
			</Show>
			<Show when={!locked()}>
				<Picker<string>
					placeholder="Add tag…"
					keepOpen
					query={(q) =>
						suggest(
							q,
							(pane.detail()?.tags ?? []).map((x) => x.tag),
						)
					}
					label={(x) => x}
					icon={() => "tag"}
					onPick={(x) => void add(x)}
					onSubmitText={(x) => void add(x)}
				/>
			</Show>
		</Section>
	);
}
