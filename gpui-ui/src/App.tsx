// The library window: top bar, then sidebar | list card (toolbar, sort bar, cards) | item-pane card on the canvas.
// Layout and class strings follow ui/src/App.tsx (Library / LibraryPanels / GutterHandle); sizes are the default
// column fractions [0.18, 0.54, 0.28] (the web UI's resizable panels are fixed here).
import { createSignal, Show } from "solid-js";
import type { Mode, Style } from "./contracts";
import { Icon } from "./icons";
import { Sidebar } from "./Sidebar";
import { CardList } from "./cards/CardList";
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

export function App() {
	const [leftOpen, setLeftOpen] = createSignal(true);
	const [rightOpen, setRightOpen] = createSignal(true);
	return (
		<div style={{ ...t("flex flex-col bg-canvas"), width: "100%", height: "100%" }}>
			<TopBar leftOpen={leftOpen()} rightOpen={rightOpen()} onLeft={() => setLeftOpen(!leftOpen())} onRight={() => setRightOpen(!rightOpen())} />
			{/* Library: the canvas shows 12px above, right and below the cards; the sidebar carries its own left padding */}
			<div style={{ ...t("flex flex-1 min-h-0 pt-3 pr-3 pb-3"), paddingLeft: leftOpen() ? 0 : 12, width: "100%" }}>
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
		</div>
	);
}
