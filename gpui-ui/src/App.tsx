// The library window: top bar, then sidebar | list card (toolbar, sort bar, cards) | item-pane card on the canvas.
// Layout and class strings follow ui/src/App.tsx (Library / LibraryPanels / GutterHandle); sizes are the default
// column fractions [0.18, 0.54, 0.28] (the web UI's resizable panels are fixed here).
import { createSignal, ErrorBoundary, For, Show, type JSX } from "solid-js";
import { isReaderTab, type Mode, type ReaderTab, type Style } from "./contracts";
import { Icon } from "./icons";
import { Sidebar } from "./Sidebar";
import { CardList } from "./cards/CardList";
import { Reader } from "./reader/Reader";
import { store } from "./store";
import { textStyle, tokens, tw } from "./theme";
import { SortBar, Toolbar } from "./Toolbar";
import { TopBar } from "./TopBar";

const mode = (): Mode => store.mode();
const t = (cls: string): Style => tw(cls, mode());

/** const card = "min-w-0 rounded-[14px] bg-background shadow-raised" */
const CARD = "min-w-0 rounded-[14px] bg-background shadow-raised";

/** ItemPane empty(): flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground */
function ItemPaneEmpty() {
	return (
		<div style={{ ...t("flex flex-col items-center justify-center gap-2 p-6"), height: "100%", width: "100%" }}>
			<Icon name="file-text" size={40} strokeWidth={1.25} color={tokens[mode()]["muted-foreground"]!} style={{ opacity: 0.4 }} />
			<text style={{ ...textStyle("text-muted-foreground", mode()), textAlign: "center" }}>Select an item to view its details</text>
		</div>
	);
}

/** GPUIX has no display:none that takes the box out of the layout: collapse it and hide it (what tw() does for `hidden`). The subtree stays mounted. */
const HIDDEN: Style = { display: "none", visibility: "hidden", width: 0, height: 0, flexGrow: 0, flexShrink: 1, overflow: "hidden", padding: 0, paddingTop: 0, paddingBottom: 0, paddingLeft: 0, paddingRight: 0 };

/**
 * A reader tab's content. Contract with the reader: `<Reader attachmentKey title active />`, filling its parent; it resolves the
 * PDF from the attachment key (via the core) and, when `active` is false, stays mounted but frees its page bitmaps.
 */
function ReaderTabView(p: { tab: ReaderTab }): JSX.Element {
	const active = () => store.activeTab() === p.tab.id;
	return (
		<div style={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0, width: "100%", backgroundColor: tokens[mode()]["canvas"], ...(active() ? {} : HIDDEN) }}>
			<ErrorBoundary fallback={(err) => (
				<div style={{ ...t("flex flex-col items-center justify-center gap-2 p-6"), width: "100%", height: "100%" }}>
					<text style={{ ...textStyle("text-foreground", mode()), textAlign: "center" }}>{`Could not open "${p.tab.title}"`}</text>
					<text style={{ ...textStyle("text-xs text-muted-foreground", mode()), textAlign: "center" }}>{String((err as Error)?.message ?? err)}</text>
				</div>
			)}>
				<Reader attachmentKey={p.tab.id} title={p.tab.title} active={active()} />
			</ErrorBoundary>
		</div>
	);
}

export function App() {
	const [leftOpen, setLeftOpen] = createSignal(true);
	const [rightOpen, setRightOpen] = createSignal(true);
	return (
		<div style={{ ...t("flex flex-col bg-canvas"), width: "100%", height: "100%" }}>
			<TopBar leftOpen={leftOpen()} rightOpen={rightOpen()} onLeft={() => setLeftOpen(!leftOpen())} onRight={() => setRightOpen(!rightOpen())} />
			{/* Library: the canvas shows 12px above, right and below the cards; the sidebar carries its own left padding.
			    Kept mounted (just not displayed) while a reader tab is active, so the list keeps its scroll position. */}
			<div style={{ ...t("flex flex-1 min-h-0 pt-3 pr-3 pb-3"), paddingLeft: leftOpen() ? 0 : 12, width: "100%", ...(store.activeTab() === "library" ? {} : HIDDEN) }}>
				<Show when={leftOpen()}>
					<div style={{ width: "18%", flexShrink: 0, minWidth: 0, display: "flex", flexDirection: "column", height: "100%" }}>
						{/* the Sidebar draws the zn-sidebar padding itself */}
						<div style={{ ...t("flex flex-col min-h-0"), height: "100%" }}>
							<Sidebar />
						</div>
					</div>
					<div style={{ width: 12, flexShrink: 0 }} />
				</Show>
				<div style={{ ...t(`${CARD} flex flex-col overflow-hidden`), flexGrow: 1, flexShrink: 1, minWidth: 0, height: "100%" }}>
					<Toolbar />
					<SortBar />
					<div style={{ flexGrow: 1, minHeight: 0, width: "100%", display: "flex", flexDirection: "column" }}>
						<CardList />
					</div>
				</div>
				<Show when={rightOpen()}>
					<div style={{ width: 12, flexShrink: 0 }} />
					<div style={{ ...t(`${CARD} overflow-hidden`), width: "28%", flexShrink: 0, height: "100%" }}>
						<ItemPaneEmpty />
					</div>
				</Show>
			</div>
			{/* Reader tabs: full width below the top bar, one per open attachment, all kept mounted */}
			<For each={store.tabs().filter(isReaderTab)}>{(tab) => <ReaderTabView tab={tab} />}</For>
		</div>
	);
}
