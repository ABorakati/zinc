// The collection tree and the list under a plugin's control: decorations (a badge, an icon, a colour on a row) and virtual collections
// (rows whose items come from the plugin). A virtual collection is shown in the list area by `VirtualCollectionView` (a plain list of the
// plugin's items: no sorting, grouping or columns in v1); choosing any other row of the tree leaves it.
import { createEffect, createResource, createRoot, createSignal, For, on, Show, type JSX } from "solid-js";
import { api, type ItemDetail } from "../../api";
import { Icon } from "../../icons";
import { ListItem, ROW_HOVER, ROW_STATIC, labelCls, muted, pill, rowClick, tx, t, tok, type Entry } from "../../sidebar/parts";
import { store } from "../../store";
import { callPlugin } from "../host";
import { decorationFor } from "./data";
import { invalidationRev, registries, type Owned } from "./registry";
import { iconName, lstr } from "./text";
import { colorOf } from "./style";
import type { VirtualCollectionRegistration } from "./wit";

// ---- decorations -----------------------------------------------------------------------------------------------------------

/** The plugin badge / icon after a collection's name. Nothing while no plugin registered a decoration. */
export function PluginDecoration(p: { collectionKey: string }): JSX.Element {
	const d = () =>
		registries.decorations.list().length
			? decorationFor({ kind: "collection", library: store.libraryOfCollection(p.collectionKey), key: p.collectionKey }, store.itemsRev())
			: undefined;
	return (
		<Show when={d()}>
			{(x) => (
				<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 4, marginRight: 6, flexShrink: 0 }}>
					<Show when={x().icon}>
						<Icon name={iconName(x().icon, "circle")} size={12} color={colorOf(x().color) ?? muted()} />
					</Show>
					<Show when={x().badge}>
						<text style={{ ...tx("text-[11px] font-semibold"), color: colorOf(x().color) ?? tok("primary"), whiteSpace: "nowrap" }}>{x().badge!}</text>
					</Show>
				</div>
			)}
		</Show>
	);
}

// ---- virtual collections ---------------------------------------------------------------------------------------------------

export interface ActiveVirtual {
	plugin: string;
	id: string;
}
const [activeVirtual, setActiveVirtual] = createSignal<ActiveVirtual | null>(null);
export { activeVirtual, setActiveVirtual };

// choosing another view of the tree leaves the virtual collection
createRoot(() => createEffect(on(() => [store.view(), store.libraryId()], () => setActiveVirtual(null), { defer: true })));

function VirtualRow(p: { v: Owned<VirtualCollectionRegistration> }): JSX.Element {
	const sel = () => activeVirtual()?.plugin === p.v.plugin && activeVirtual()?.id === p.v.id;
	return (
		<ListItem>
			<div
				role="treeitem"
				aria-selected={sel()}
				aria-label={lstr(p.v.reg.label, p.v.id)}
				testId={`plugin-virtual-${p.v.plugin}-${p.v.id}`}
				onClick={rowClick(() => setActiveVirtual({ plugin: p.v.plugin, id: p.v.id }))}
				style={{ ...t(ROW_STATIC), cursor: "pointer", paddingLeft: 26, ...(sel() ? pill(true) : { hover: t(ROW_HOVER) }) }}
			>
				<Icon name={iconName(p.v.reg.icon, "folder-search")} size={15} color={muted()} />
				<text style={{ ...tx(labelCls(sel())), overflow: "hidden", whiteSpace: "nowrap", minWidth: 0, flexGrow: 1, flexBasis: 0 }}>
					{lstr(p.v.reg.label, p.v.id)}
				</text>
			</div>
		</ListItem>
	);
}

/** Rows of the plugins' virtual collections, for the end of the Collections group (of My Library, or the libraries they name). */
export function virtualCollectionEntries(): Entry[] {
	const lib = store.libraryId();
	return registries.virtuals
		.list()
		.filter((v) => (v.reg.libraries?.length ? v.reg.libraries : [1]).includes(lib))
		.sort((a, b) => a.reg.order - b.reg.order)
		.map((v) => ({
			id: `c:virtual:${v.plugin}:${v.id}`,
			render: () => <VirtualRow v={v} />,
			nav: { selected: () => activeVirtual()?.plugin === v.plugin && activeVirtual()?.id === v.id, activate: () => setActiveVirtual({ plugin: v.plugin, id: v.id }) },
		}));
}

interface Page {
	keys: string[];
	total: number;
}

const PAGE = 200;

/** The list of a virtual collection: asks `on-virtual-collection-items`, then reads each item once. */
export function VirtualCollectionView(): JSX.Element {
	return (
		<Show when={activeVirtual()} keyed>
			{(a) => <VirtualList a={a} />}
		</Show>
	);
}

function VirtualList(p: { a: ActiveVirtual }): JSX.Element {
	const reg = () => registries.virtuals.lookup(p.a.plugin, p.a.id);
	const [page] = createResource(
		() => ({ rev: invalidationRev("virtual", p.a.plugin, p.a.id), q: store.filter(), tags: store.tagFilter(), itemsRev: store.itemsRev() }),
		async (s): Promise<Page> => {
			const r = (await callPlugin(p.a.plugin, "extend-handlers", "on-virtual-collection-items", [
				p.a.id,
				store.libraryId(),
				{ searchText: s.q || undefined, tagFilter: [...s.tags] },
				0,
				PAGE,
			])) as Page;
			return { keys: r.keys, total: r.total };
		},
	);
	const [items] = createResource(
		() => page()?.keys,
		async (keys) => {
			const out: ItemDetail[] = [];
			for (let i = 0; i < keys.length; i += 8) {
				const got = await Promise.allSettled(keys.slice(i, i + 8).map((k) => api.item(k)));
				for (const g of got) if (g.status === "fulfilled") out.push(g.value);
			}
			return out;
		},
	);
	return (
		<div testId="plugin-virtual-list" style={{ ...t("flex flex-col"), width: "100%", height: "100%", overflow: "scroll" }}>
			<div style={{ ...t("flex items-center gap-2 px-4 py-2 border-b border-border-soft"), flexShrink: 0 }}>
				<Icon name={iconName(reg()?.reg.icon, "folder-search")} size={14} color={muted()} />
				<text style={{ ...tx("text-[13px] font-semibold text-foreground"), flexGrow: 1 }}>{lstr(reg()?.reg.label, p.a.id)}</text>
				<text style={{ ...tx("text-xs text-muted-foreground") }}>{`${page()?.total ?? 0} items`}</text>
				<div role="button" aria-label="Back to the library" onClick={() => setActiveVirtual(null)} style={{ cursor: "pointer" }}>
					<text style={{ ...tx("text-xs text-primary") }}>Back to library</text>
				</div>
			</div>
			<For each={items() ?? []}>
				{(d) => (
					<div
						role="button"
						onClick={() => store.selectItem(d.data.key)}
						style={{ ...t("flex flex-col px-4 py-1.5 border-b border-border-soft"), cursor: "pointer", hover: t("bg-foreground/5") }}
					>
						<text style={{ ...tx("text-[13px] text-foreground") }}>{String(d.data.title ?? "(untitled)")}</text>
						<text style={{ ...tx("text-xs text-muted-foreground") }}>{`${String(d.data.itemType ?? "")}  ${String(d.data.date ?? "")}`}</text>
					</div>
				)}
			</For>
			<Show when={page.error}>
				<text style={{ ...tx("text-xs text-muted-foreground"), padding: 16 }}>The plugin did not answer.</text>
			</Show>
		</div>
	);
}
