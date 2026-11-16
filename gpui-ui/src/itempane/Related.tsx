// Related items (Zotero's dc:relation): list, open, add through a search picker, remove. Port of ui/src/itempane/Related.tsx.
import { createSignal, For, Show, type JSX } from "solid-js";
import { Icon, itemTypeIconName } from "../icons";
import { store } from "../store";
import { Empty, IconBtn, locked, Picker, Section, TRUNC, t, tok, tx } from "./kit";
import { fail, usePane } from "./model";
import { ipApi } from "./net";

const sub = (c: string | undefined, y: number | null | undefined) => [c, y].filter(Boolean).join(" · ");

interface Found {
	key: string;
	title: string;
	creatorsSummary?: string;
	year?: number | null;
}

function RelatedRow(p: {
	r: { key: string; itemType: string; title: string; creatorsSummary: string; year: number | null };
	onRemove?: () => void;
}): JSX.Element {
	const [hover, setHover] = createSignal(false);
	return (
		<div
			onMouseEnter={() => setHover(true)}
			onMouseLeave={() => setHover(false)}
			onClick={() => store.selectItem(p.r.key)}
			style={{
				...t("flex items-center gap-1.5 rounded px-1.5 py-[3px] w-full"),
				cursor: "pointer",
				backgroundColor: hover() ? tok("accent") : "transparent",
			}}
		>
			<Icon name={itemTypeIconName(p.r.itemType)} size={16} color={tok("muted-foreground")} />
			<text style={{ ...tx("text-[13px]"), ...TRUNC, flexGrow: 1, flexShrink: 1 }}>{p.r.title || "Untitled"}</text>
			<text style={{ ...tx("text-[11px] text-muted-foreground"), ...TRUNC, flexShrink: 2, maxWidth: 110 }}>
				{sub(p.r.creatorsSummary, p.r.year)}
			</text>
			<Show when={hover()}>
				<div onClick={(e) => (e as { stopPropagation?: () => void }).stopPropagation?.()}>
					<Show when={p.onRemove}>
						<IconBtn icon="minus" title="Remove relation" onClick={p.onRemove} />
					</Show>
				</div>
			</Show>
		</div>
	);
}

export function RelatedSection(): JSX.Element {
	const pane = usePane();
	const [adding, setAdding] = createSignal(false);
	const related = () => pane.detail()?.related ?? [];

	async function search(q: string): Promise<Found[]> {
		if (!q.trim()) return [];
		const r = await ipApi.searchItems(q.trim(), 15, store.libraryId());
		const have = new Set([pane.detail()?.data.key, ...related().map((x) => x.key)]);
		return r.items.filter((i) => !have.has(i.key));
	}
	async function add(it: Found) {
		const d = pane.detail();
		if (!d) return;
		setAdding(false);
		try {
			pane.setDetail(await ipApi.addRelated(d.data.key, [it.key]));
		} catch (e) {
			fail("Could not add related item", e);
		}
	}
	async function remove(key: string) {
		const d = pane.detail();
		if (!d) return;
		pane.setDetail({ ...d, related: related().filter((x) => x.key !== key) });
		try {
			pane.setDetail(await ipApi.removeRelated(d.data.key, [key]));
		} catch (e) {
			fail("Could not remove related item", e);
			void pane.reload();
		}
	}

	return (
		<Section
			id="related"
			title="Related"
			icon="link-2"
			count={related().length}
			actions={
				<Show when={!locked()}>
					<IconBtn icon="plus" title="Add related item" onClick={() => setAdding(!adding())} />
				</Show>
			}
		>
			<Show when={related().length === 0 && !adding()}>
				<Empty text="No related items" />
			</Show>
			<For each={related()}>{(r) => <RelatedRow r={r} onRemove={locked() ? undefined : () => void remove(r.key)} />}</For>
			<Show when={adding()}>
				<div style={{ marginTop: 6, width: "100%" }}>
					<Picker<Found>
						autoFocus
						placeholder="Search items to relate…"
						query={search}
						label={(it) => it.title || "Untitled"}
						sub={(it) => sub(it.creatorsSummary, it.year)}
						onPick={(it) => void add(it)}
						onClose={() => setAdding(false)}
					/>
				</div>
			</Show>
		</Section>
	);
}
