// "Libraries and Collections": which collections hold the item; add / remove. Port of ui/src/itempane/Collections.tsx.
import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { Icon } from "../icons";
import { store } from "../store";
import { IconBtn, locked, Picker, Section, TRUNC, t, tok, tx } from "./kit";
import { fail, usePane } from "./model";
import { ipApi } from "./net";
import { flattenCollections, type FlatCollection } from "./util";

/** All collections flattened with their name chains (recomputed when the sidebar's tree changes). */
export const useFlatCollections = () =>
	createMemo(() =>
		flattenCollections(store.libraryId() === 1 ? store.collections() : (store.groupCollections()[store.libraryId()] ?? [])),
	);

function CollectionRow(p: { path: string[]; onRemove: () => void }): JSX.Element {
	const [hover, setHover] = createSignal(false);
	return (
		<div
			onMouseEnter={() => setHover(true)}
			onMouseLeave={() => setHover(false)}
			style={{
				...t("flex items-center gap-1.5 rounded py-[3px] w-full"),
				paddingLeft: 20,
				paddingRight: 6,
				backgroundColor: hover() ? tok("accent") : "transparent",
			}}
		>
			<Icon name="folder" size={16} color={tok("muted-foreground")} />
			<div style={{ ...t("flex items-center"), flexGrow: 1, flexShrink: 1, minWidth: 0, overflow: "hidden" }}>
				<For each={p.path}>
					{(name, i) => (
						<>
							<Show when={i() > 0}>
								<text style={{ ...tx("text-[13px] text-muted-foreground"), paddingLeft: 2, paddingRight: 2 }}>›</text>
							</Show>
							<text
								style={{
									...tx("text-[13px]"),
									color: i() < p.path.length - 1 ? tok("muted-foreground") : tok("foreground"),
									...TRUNC,
									flexShrink: i() < p.path.length - 1 ? 1 : 0,
								}}
							>
								{name}
							</text>
						</>
					)}
				</For>
			</div>
			<Show when={hover() && !locked()}>
				<IconBtn icon="minus" title="Remove from collection" onClick={p.onRemove} />
			</Show>
		</div>
	);
}

export function CollectionsSection(): JSX.Element {
	const pane = usePane();
	const flat = useFlatCollections();
	const byKey = createMemo(() => new Map(flat().map((c) => [c.key, c])));
	const [adding, setAdding] = createSignal(false);
	const mine = () => pane.detail()?.collections ?? [];

	async function add(key: string) {
		const d = pane.detail();
		if (!d) return;
		setAdding(false);
		pane.setDetail({ ...d, collections: [...d.collections, key] });
		try {
			await ipApi.addToCollection(key, [d.data.key]);
			pane.refreshList();
		} catch (e) {
			fail("Could not add to collection", e);
			void pane.reload();
		}
	}
	async function remove(key: string) {
		const d = pane.detail();
		if (!d) return;
		pane.setDetail({ ...d, collections: d.collections.filter((k) => k !== key) });
		try {
			await ipApi.removeFromCollection(key, [d.data.key]);
			pane.refreshList();
		} catch (e) {
			fail("Could not remove from collection", e);
			void pane.reload();
		}
	}
	const candidates = (q: string): FlatCollection[] => {
		const needle = q.trim().toLowerCase();
		return flat()
			.filter((c) => !mine().includes(c.key) && (!needle || c.path.join(" ").toLowerCase().includes(needle)))
			.slice(0, 50);
	};

	return (
		<Section
			id="collections"
			title="Libraries and Collections"
			icon="library"
			count={mine().length}
			actions={
				<Show when={!locked()}>
					<IconBtn icon="plus" title="Add to Collection" onClick={() => setAdding(!adding())} />
				</Show>
			}
		>
			<div style={{ ...t("flex items-center gap-1.5 px-1.5 py-[3px]") }}>
				<Icon name="library" size={16} color={tok("muted-foreground")} />
				<text style={{ ...tx("text-[13px]") }}>
					{store.libraries().find((l) => l.id === store.libraryId())?.name ?? "My Library"}
				</text>
			</div>
			<For each={mine()}>{(k) => <CollectionRow path={byKey().get(k)?.path ?? [k]} onRemove={() => void remove(k)} />}</For>
			<Show when={adding()}>
				<div style={{ marginTop: 6, width: "100%" }}>
					<Picker<FlatCollection>
						autoFocus
						listOnFocus
						placeholder="Add to collection…"
						query={candidates}
						label={(c) => c.path.join(" › ")}
						icon={() => "folder"}
						onPick={(c) => void add(c.key)}
						onClose={() => setAdding(false)}
					/>
				</div>
			</Show>
		</Section>
	);
}
