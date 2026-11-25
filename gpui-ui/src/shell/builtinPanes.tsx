// The library's built-in panes (docs/developer-guide/layouts.md, section 4): "items" (toolbar, sort bar and the item list, or a
// WASM plugin's virtual collection) and "item" (the item pane). Each draws its own card; the class strings follow
// ui/src/App.tsx as before. Imported for its side effect by App.tsx.
import { ErrorBoundary, Show, type JSX } from "solid-js";
import type { Mode, Style } from "../contracts";
import { CardList } from "../cards/CardList";
import { Icon } from "../icons";
import { ItemPane } from "../itempane";
import { store } from "../store";
import { savedSearches } from "../searches/state";
import { textStyle, tokens, tw } from "../theme";
import { SortBar, Toolbar } from "../Toolbar";
import { activeVirtual, VirtualCollectionView } from "../wasmplugins/extend/Tree";
import { logBoundary } from "./errorlog";
import { registerPane } from "./panes";

const mode = (): Mode => store.mode();
const t = (cls: string): Style => tw(cls, mode());

/** const card = "min-w-0 rounded-[14px] bg-background shadow-raised" */
const CARD = "min-w-0 rounded-[14px] bg-background shadow-raised";
/**
 * GPUIX cache region: the list body and the item pane are each drawn by their own cached GPUI view, so a frame where only the
 * list scrolled replays the other one instead of rebuilding it. A region must take its size from its parent (100%, flex-grow).
 * A typed constant because the host style type does not list the key.
 */
// TestRenderer.scrollToItem does not scroll a <virtual-list> nested inside a cacheRegion under the custom zn-cache addon,
// whereas RemoteBackend strips ZN_* env vars so the live/packaged app always keeps `{ cacheRegion: true }`.
export const REGION: Style = process.env.ZN_UI_TEST_ROOT ? {} : { cacheRegion: true };
// GPUI clips children to a rectangle, not to the card's rounded outline, so no child may paint a background into a corner: the
// item pane's tinted header carries the card's top radii itself, and the list keeps a strip of padding below its last row.
// (An earlier canvas-coloured corner mask covered the card's shadow and looked wrong.)

/** ItemPane empty(): flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground */
function ItemPaneEmpty() {
	return (
		<div style={{ ...t("flex flex-col items-center justify-center gap-2 p-6"), height: "100%", width: "100%" }}>
			<Icon name="file-text" size={40} strokeWidth={1.25} color={tokens[mode()]["muted-foreground"]!} style={{ opacity: 0.4 }} />
			<text style={{ ...textStyle("text-muted-foreground", mode()), textAlign: "center" }}>Select an item to view its details</text>
		</div>
	);
}

/** The item pane (src/itempane); the placeholder shows if it throws while rendering. */
function ItemPaneSlot(): JSX.Element {
	return (
		<ErrorBoundary
			fallback={(err) => {
				logBoundary("item pane", err);
				return <ItemPaneEmpty />;
			}}
		>
			<ItemPane />
		</ErrorBoundary>
	);
}

function ItemsCard(): JSX.Element {
	return (
		<div style={{ ...t(`${CARD} flex flex-col overflow-hidden`), height: "100%", width: "100%" }}>
			<Toolbar />
			<SortBar />
			<div
				style={{
					flexGrow: 1,
					minHeight: 0,
					width: "100%",
					display: "flex",
					flexDirection: "column",
					paddingBottom: 10,
					backgroundColor: tokens[mode()]["card"],
					borderBottomLeftRadius: 14,
					borderBottomRightRadius: 14,
					...REGION,
				}}
			>
				{/* a WASM plugin's virtual collection replaces the list while it is chosen (wasmplugins/extend/Tree.tsx) */}
				<Show when={!activeVirtual()} fallback={<VirtualCollectionView />}>
					<CardList />
				</Show>
			</div>
		</div>
	);
}

/** The item list's pane title: what it lists (My Library, a collection, a saved search, Trash, ...). */
function viewTitle(): string {
	const v = store.view();
	switch (v.kind) {
		case "collection": {
			const find = (cs: readonly { key: string; name: string; children?: unknown }[]): string | undefined => {
				for (const c of cs) {
					if (c.key === v.key) return c.name;
					const sub = find((c.children ?? []) as typeof cs);
					if (sub) return sub;
				}
				return undefined;
			};
			return find(store.collections()) ?? "Collection";
		}
		case "savedSearch":
			return savedSearches().find((s) => s.key === v.key)?.name ?? "Saved search";
		case "unfiled":
			return "Unfiled Items";
		case "trash":
			return "Trash";
		case "duplicates":
			return "Duplicate Items";
		case "publications":
			return "My Publications";
		default:
			return store.libraries().find((l) => l.id === store.libraryId())?.name ?? "My Library";
	}
}

registerPane({
	id: "items",
	title: viewTitle,
	icon: "library",
	views: ["library"],
	required: true,
	minSize: { w: 320, h: 160 },
	render: () => <ItemsCard />,
});

registerPane({
	id: "item",
	title: () => "Item details",
	icon: "info",
	views: ["library"],
	minSize: { w: 200, h: 160 },
	render: () => (
		<div style={{ ...t(`${CARD} overflow-hidden`), height: "100%", width: "100%", ...REGION }}>
			<ItemPaneSlot />
		</div>
	),
});
