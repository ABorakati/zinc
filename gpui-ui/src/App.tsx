// The window: top bar, then the tab bodies on the canvas — Library (the frame of shell/Frame.tsx: sidebar | centre column | right
// column, with the item list and the item pane as panes), one reader per open attachment, and the Settings tab. Class strings
// follow ui/src/App.tsx. The library layout persists (shell/layout.ts -> ui-state.json; docs/developer-guide/layouts.md).
// <OverlayHost/> (menus, dialogs, popovers, toasts) is mounted once at the root, followed by the overlays features registered.
import { createEffect, ErrorBoundary, For, Show, type JSX } from "solid-js";
import { isDocTab, isWebTab, type Mode, type ReaderTab, type Style, type WebTab } from "./contracts";
import { overlays } from "./registry";
import { Sidebar } from "./Sidebar";
import { Reader } from "./reader/Reader";
import { SettingsPage } from "./settings";
import { libraryLayout, leftOpen, setLibraryLayout, SETTINGS_TAB, settingsOpen } from "./shell/layout";
import { REGION } from "./shell/builtinPanes";
import { Frame } from "./shell/Frame";
import { HIDDEN } from "./shell/kit";
import { setWindowTitle } from "./shell/native";
import { logBoundary } from "./shell/errorlog";
import { store } from "./store";
import { textStyle, tokens, tw } from "./theme";
import { TopBar } from "./TopBar";
import { WebTabView } from "./webview/WebTabView";
import { OverlayHost, toast } from "./ui";
import { handleFileDrop } from "./features/additems/client";
import { PluginBanners, PluginSidePanels, PluginTabBodies } from "./wasmplugins/extend/Chrome";
import { buildContext, conditionContext } from "./wasmplugins/extend/context";
import { dropWithPlugins } from "./wasmplugins/extend/drop";

const mode = (): Mode => store.mode();
const t = (cls: string): Style => tw(cls, mode());

/**
 * A reader tab's content. Contract with the reader: `<Reader attachmentKey title active />`, filling its parent; it resolves the
 * PDF from the attachment key (via the core) and, when `active` is false, stays mounted but frees its page bitmaps.
 */
function ReaderTabView(p: { tab: ReaderTab | WebTab }): JSX.Element {
	const active = () => store.activeTab() === p.tab.id;
	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				flexGrow: 1,
				minHeight: 0,
				width: "100%",
				backgroundColor: tokens[mode()]["canvas"],
				...(active() ? {} : HIDDEN),
			}}
		>
			<ErrorBoundary
				fallback={(err) => {
					logBoundary(isWebTab(p.tab) ? "web tab" : "reader", err, isWebTab(p.tab) ? "ui" : "reader"); // not the title: it is the user's content
					return (
						<div style={{ ...t("flex flex-col items-center justify-center gap-2 p-6"), width: "100%", height: "100%" }}>
							<text
								style={{ ...textStyle("text-foreground", mode()), textAlign: "center" }}
							>{`Could not open "${p.tab.title}"`}</text>
							<text style={{ ...textStyle("text-xs text-muted-foreground", mode()), textAlign: "center" }}>
								{String((err as Error)?.message ?? err)}
							</text>
						</div>
					);
				}}
			>
				<Show
					when={isWebTab(p.tab)}
					fallback={
						<Reader
							attachmentKey={p.tab.id}
							title={p.tab.title}
							itemKey={(p.tab as ReaderTab).itemKey}
							editable={store.libraryEditable((p.tab as ReaderTab).library ?? 1)}
							filesEditable={store.libraryFilesEditable((p.tab as ReaderTab).library ?? 1)}
							active={active()}
						/>
					}
				>
					<WebTabView tab={p.tab as WebTab} />
				</Show>
			</ErrorBoundary>
		</div>
	);
}

/** The Settings tab body; mounted on first open and kept (search text, section) while another tab is active. */
function SettingsTabView(): JSX.Element {
	const active = () => store.activeTab() === SETTINGS_TAB;
	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				flexGrow: 1,
				minHeight: 0,
				width: "100%",
				backgroundColor: tokens[mode()]["background"],
				...(active() ? {} : HIDDEN),
			}}
		>
			<ErrorBoundary
				fallback={(err) => {
					logBoundary("settings", err);
					return (
						<div style={{ ...t("flex flex-col items-center justify-center gap-2 p-6"), width: "100%", height: "100%" }}>
							<text style={{ ...textStyle("text-foreground", mode()), textAlign: "center" }}>
								Settings could not be shown
							</text>
							<text style={{ ...textStyle("text-xs text-muted-foreground", mode()), textAlign: "center" }}>
								{String((err as Error)?.message ?? err)}
							</text>
						</div>
					);
				}}
			>
				<SettingsPage active={active()} />
			</ErrorBoundary>
		</div>
	);
}

/** The library's frame: the sidebar on the left (it draws the zn-sidebar padding itself; cacheRegion as the panes' cards), the
 * item list and the item pane as panes (shell/builtinPanes.tsx). */
function LibraryFrame(): JSX.Element {
	return (
		<Frame
			view="library"
			layout={libraryLayout}
			setLayout={setLibraryLayout}
			leftMinPx={140}
			left={() => (
				<div style={{ ...t("flex flex-col min-h-0"), height: "100%", width: "100%", minWidth: 0, ...REGION }}>
					<Sidebar />
				</div>
			)}
		/>
	);
}

export function App() {
	const onLibrary = () => store.activeTab() === "library";

	// window title: the reader's document, Settings, or the app name
	createEffect(() => {
		const id = store.activeTab();
		const reader = store
			.tabs()
			.filter(isDocTab)
			.find((x) => x.id === id);
		setWindowTitle(reader ? `${reader.title || "Reader"} - Zinc` : id === SETTINGS_TAB ? "Settings - Zinc" : "Zinc");
	});

	return (
		<div
			style={{ ...t("flex flex-col bg-canvas"), width: "100%", height: "100%" }}
			onFileDrop={(e) => {
				// a plugin's `window` drop target (wasmplugins/extend/drop.ts) may take the files first; `ignored` falls through
				void dropWithPlugins("window", e.paths ?? [], buildContext(), {}, conditionContext()).then((taken) => {
					if (taken) return;
					if (store.canEdit()) void handleFileDrop(e.paths ?? [], { x: e.x, y: e.y });
					else toast("This library is read-only", { description: "Files cannot be added to it." });
				});
			}}
		>
			<PluginBanners />
			<TopBar />
			{/* Library: the canvas shows 12px above, right and below the cards; the sidebar carries its own left padding.
			    Kept mounted (just not displayed) while another tab is active, so the list keeps its scroll position. */}
			<div
				style={{
					...t("flex flex-1 min-h-0 pt-3 pr-3 pb-3"),
					paddingLeft: leftOpen() ? 0 : 12,
					width: "100%",
					...(onLibrary() ? {} : HIDDEN),
				}}
			>
				<PluginSidePanels side="left" />
				<LibraryFrame />
				<PluginSidePanels side="right" />
			</div>
			{/* Reader tabs: full width below the top bar, one per open attachment, all kept mounted */}
			<For each={store.tabs().filter(isDocTab)}>{(tab) => <ReaderTabView tab={tab} />}</For>
			<PluginTabBodies />
			<Show when={settingsOpen()}>
				<SettingsTabView />
			</Show>
			{/* menus, dialogs, popovers, toasts; then the features' always-mounted overlays */}
			<OverlayHost />
			<For each={overlays()}>{(o) => o.render()}</For>
		</div>
	);
}
