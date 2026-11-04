// The window: top bar, then the tab bodies on the canvas — Library (sidebar | list card | item-pane card in resizable columns), one
// reader per open attachment, and the Settings tab. Layout and class strings follow ui/src/App.tsx (Library / LibraryPanels /
// GutterHandle). Panel visibility and column sizes persist (shell/layout.ts -> ui-state.json). <OverlayHost/> (menus, dialogs,
// popovers, toasts) is mounted once at the root, followed by the overlays features registered.
import { createEffect, createMemo, createSignal, ErrorBoundary, For, Show, type JSX } from "solid-js";
import { isDocTab, isWebTab, type Mode, type ReaderTab, type Style, type WebTab } from "./contracts";
import { Icon } from "./icons";
import { overlays } from "./registry";
import { Sidebar } from "./Sidebar";
import { CardList } from "./cards/CardList";
import { ItemPane } from "./itempane";
import { Reader } from "./reader/Reader";
import { SettingsPage } from "./settings";
import { getCols, leftOpen, panelKey, setCols, SETTINGS_TAB, settingsOpen } from "./shell/layout";
import { HIDDEN } from "./shell/kit";
import { setWindowTitle } from "./shell/native";
import { store } from "./store";
import { textStyle, tokens, tw } from "./theme";
import { SortBar, Toolbar } from "./Toolbar";
import { TopBar } from "./TopBar";
import { WebTabView } from "./webview/WebTabView";
import { OverlayHost, Resizable } from "./ui";

const mode = (): Mode => store.mode();
const t = (cls: string): Style => tw(cls, mode());

/** const card = "min-w-0 rounded-[14px] bg-background shadow-raised" */
const CARD = "min-w-0 rounded-[14px] bg-background shadow-raised";
const CARD_R = 14;

// GPUI clips children to a rectangle, not to the card's rounded outline: a child that paints a background into a corner (a selected
// or hovered row at the bottom of the list, the item pane's tinted header) squares it off. These masks paint the window background
// over the area outside each corner's arc, so the card always reads rounded. (svg alpha tinted by style.color, see icons.tsx)
const CORNER = (t: string) =>
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CARD_R} ${CARD_R}"><path transform="${t}" d="M0 0H${CARD_R}A${CARD_R} ${CARD_R} 0 0 0 0 ${CARD_R}Z" fill="#000"/></svg>`;
const CORNERS = [
	{ src: CORNER(""), pos: { top: 0, left: 0 } },
	{ src: CORNER(`translate(${CARD_R} 0) scale(-1 1)`), pos: { top: 0, right: 0 } },
	{ src: CORNER(`translate(0 ${CARD_R}) scale(1 -1)`), pos: { bottom: 0, left: 0 } },
	{ src: CORNER(`translate(${CARD_R} ${CARD_R}) scale(-1 -1)`), pos: { bottom: 0, right: 0 } },
];
function CornerMasks(): JSX.Element {
	return (
		<For each={CORNERS}>
			{(c) => <svg source={c.src} style={{ position: "absolute", ...c.pos, width: CARD_R, height: CARD_R, color: tokens[mode()]["canvas"], pointerEvents: "none" }} />}
		</For>
	);
}

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
	return <ErrorBoundary fallback={() => <ItemPaneEmpty />}><ItemPane /></ErrorBoundary>;
}

/**
 * A reader tab's content. Contract with the reader: `<Reader attachmentKey title active />`, filling its parent; it resolves the
 * PDF from the attachment key (via the core) and, when `active` is false, stays mounted but frees its page bitmaps.
 */
function ReaderTabView(p: { tab: ReaderTab | WebTab }): JSX.Element {
	const active = () => store.activeTab() === p.tab.id;
	return (
		<div style={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0, width: "100%", backgroundColor: tokens[mode()]["canvas"], ...(active() ? {} : HIDDEN) }}>
			<ErrorBoundary fallback={(err) => (
				<div style={{ ...t("flex flex-col items-center justify-center gap-2 p-6"), width: "100%", height: "100%" }}>
					<text style={{ ...textStyle("text-foreground", mode()), textAlign: "center" }}>{`Could not open "${p.tab.title}"`}</text>
					<text style={{ ...textStyle("text-xs text-muted-foreground", mode()), textAlign: "center" }}>{String((err as Error)?.message ?? err)}</text>
				</div>
			)}>
				<Show when={isWebTab(p.tab)} fallback={<Reader attachmentKey={p.tab.id} title={p.tab.title} active={active()} />}><WebTabView tab={p.tab as WebTab} /></Show>
			</ErrorBoundary>
		</div>
	);
}

/** The Settings tab body; mounted on first open and kept (search text, section) while another tab is active. */
function SettingsTabView(): JSX.Element {
	const active = () => store.activeTab() === SETTINGS_TAB;
	return (
		<div style={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0, width: "100%", backgroundColor: tokens[mode()]["background"], ...(active() ? {} : HIDDEN) }}>
			<ErrorBoundary fallback={(err) => (
				<div style={{ ...t("flex flex-col items-center justify-center gap-2 p-6"), width: "100%", height: "100%" }}>
					<text style={{ ...textStyle("text-foreground", mode()), textAlign: "center" }}>Settings could not be shown</text>
					<text style={{ ...textStyle("text-xs text-muted-foreground", mode()), textAlign: "center" }}>{String((err as Error)?.message ?? err)}</text>
				</div>
			)}>
				<SettingsPage active={active()} />
			</ErrorBoundary>
		</div>
	);
}

/** Minimum column fractions (ui/src/App.tsx: sidebar 0.1, list 0.25, item pane 0.15). */
const MINS = { sidebar: 0.1, list: 0.25, pane: 0.15 };

/** The panels present for one combination of sidebar / item-pane visibility; rebuilt when that combination changes. */
function LibraryPanels(p: { k: string }): JSX.Element {
	const left = p.k[0] === "1", right = p.k[1] === "1";
	const [cols, setColsSig] = createSignal(getCols(p.k));
	const panels: JSX.Element[] = [];
	const mins: number[] = [];
	if (left) {
		// the Sidebar draws the zn-sidebar padding itself
		panels.push(
			<div style={{ ...t("flex flex-col min-h-0"), height: "100%", width: "100%", minWidth: 0 }}>
				<Sidebar />
			</div>,
		);
		mins.push(MINS.sidebar);
	}
	panels.push(
		<div style={{ ...t(`${CARD} flex flex-col overflow-hidden`), position: "relative", height: "100%", width: "100%" }}>
			<Toolbar />
			<SortBar />
			<div style={{ flexGrow: 1, minHeight: 0, width: "100%", display: "flex", flexDirection: "column" }}>
				<CardList />
			</div>
			<CornerMasks />
		</div>,
	);
	mins.push(MINS.list);
	if (right) {
		panels.push(
			<div style={{ ...t(`${CARD} overflow-hidden`), position: "relative", height: "100%", width: "100%" }}>
				<ItemPaneSlot />
				<CornerMasks />
			</div>,
		);
		mins.push(MINS.pane);
	}
	return (
		<Resizable sizes={cols()} minSizes={mins} gutter={12} line={false} onSizes={(s) => { setColsSig(s); setCols(p.k, s); }}>
			{panels}
		</Resizable>
	);
}

export function App() {
	const panelsKey = createMemo(panelKey);
	const onLibrary = () => store.activeTab() === "library";

	// window title: the reader's document, Settings, or the app name
	createEffect(() => {
		const id = store.activeTab();
		const reader = store.tabs().filter(isDocTab).find((x) => x.id === id);
		setWindowTitle(reader ? `${reader.title || "Reader"} - zotero-next` : id === SETTINGS_TAB ? "Settings - zotero-next" : "zotero-next");
	});

	return (
		<div style={{ ...t("flex flex-col bg-canvas"), width: "100%", height: "100%" }}>
			<TopBar />
			{/* Library: the canvas shows 12px above, right and below the cards; the sidebar carries its own left padding.
			    Kept mounted (just not displayed) while another tab is active, so the list keeps its scroll position. */}
			<div style={{ ...t("flex flex-1 min-h-0 pt-3 pr-3 pb-3"), paddingLeft: leftOpen() ? 0 : 12, width: "100%", ...(onLibrary() ? {} : HIDDEN) }}>
				<Show when={panelsKey()} keyed>{(k) => <LibraryPanels k={k} />}</Show>
			</div>
			{/* Reader tabs: full width below the top bar, one per open attachment, all kept mounted */}
			<For each={store.tabs().filter(isDocTab)}>{(tab) => <ReaderTabView tab={tab} />}</For>
			<Show when={settingsOpen()}><SettingsTabView /></Show>
			{/* menus, dialogs, popovers, toasts; then the features' always-mounted overlays */}
			<OverlayHost />
			<For each={overlays()}>{(o) => o.render()}</For>
		</div>
	);
}
