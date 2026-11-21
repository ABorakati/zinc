// Top bar (ui/src/App.tsx): panel toggles, the tab strip ("Library" + one chip per open reader), sync status text and the settings icon.
// Class strings are the web UI's, resolved through tw() / textStyle().
import { createSignal, For, Show } from "solid-js";
import type { EventPayload } from "@gpuix/solid";
import { isDocTab, type Mode, type ReaderTab, type Style, type WebTab } from "./contracts";
import { Icon } from "./icons";
import { closeSettings, leftOpen, openSettings, rightOpen, setLeftOpen, setRightOpen, SETTINGS_TAB, settingsOpen } from "./shell/layout";
import { refreshLibraryLists } from "./sync/state";
import { SyncStatus } from "./sync/SyncStatus";
import { store } from "./store";
import { textStyle, tokens, tw } from "./theme";
import { Menubar, PluginPanelToggles, PluginTabChips } from "./wasmplugins/extend/Chrome";
import { PluginToolbarSlot } from "./wasmplugins/extend/ToolbarSlot";

const mode = (): Mode => store.mode();
const tok = (name: string): string => tokens[mode()][name] ?? "#888";

/** panelBtn(on): size-7 items-center justify-center rounded-md; on -> bg-border text-foreground, else muted with hover tint. */
function PanelButton(p: { icon: string; on?: boolean; accent?: boolean; onClick?: () => void }) {
	return (
		<div
			onClick={p.onClick}
			style={{
				...tw("flex size-7 flex-none items-center justify-center rounded-md", mode()),
				cursor: "pointer",
				...(p.on ? tw("bg-border", mode()) : {}),
				hover: p.on ? undefined : tw("bg-foreground/5", mode()),
			}}
		>
			<Icon name={p.icon} size={16} color={tok(p.accent ? "primary" : p.on ? "foreground" : "muted-foreground")} />
		</div>
	);
}

/** tabCls(active): group relative flex h-7 max-w-56 flex-none items-center gap-1.5 rounded-md px-3 text-[13px] text-muted-foreground
 *  hover:bg-foreground/5 hover:text-foreground; active -> bg-background font-medium text-foreground shadow-sm ring-1 ring-border. */
const TAB = "flex h-7 flex-none items-center rounded-md";

/** The Library tab (not closable). */
function LibraryTabChip(p: { active: boolean; onClick: () => void }) {
	const [hover, setHover] = createSignal(false);
	const fg = () => tok(p.active || hover() ? "foreground" : "muted-foreground");
	return (
		<div
			onClick={p.onClick}
			onMouseEnter={() => setHover(true)}
			onMouseLeave={() => setHover(false)}
			style={{
				...tw(`${TAB} gap-1.5 px-3 cursor-pointer`, mode()),
				...(p.active ? tw("bg-background shadow-sm ring-1 ring-border", mode()) : hover() ? tw("bg-foreground/5", mode()) : {}),
			}}
		>
			<Icon name="library" size={14} color={fg()} />
			<text style={{ ...textStyle(`text-[13px] ${p.active ? "font-medium" : ""}`, mode()), color: fg(), whiteSpace: "nowrap" }}>
				Library
			</text>
		</div>
	);
}

/** A reader tab: file-text icon, title (truncated at max-w-56 = 224px incl. padding), close button (shown on hover / when active). */
function ReaderTabChip(p: { tab: ReaderTab | WebTab; active: boolean }) {
	const [hover, setHover] = createSignal(false);
	const [overClose, setOverClose] = createSignal(false);
	const fg = () => tok(p.active || hover() ? "foreground" : "muted-foreground");
	return (
		<div
			onMouseEnter={() => setHover(true)}
			onMouseLeave={() => setHover(false)}
			style={{
				...tw(`${TAB} pr-1 max-w-56`, mode()),
				...(p.active ? tw("bg-background shadow-sm ring-1 ring-border", mode()) : hover() ? tw("bg-foreground/5", mode()) : {}),
			}}
		>
			{/* the clickable body is its own element so a click on the x never also switches tabs; a middle click closes */}
			<div
				onClick={(e: EventPayload) => (e.button === 1 ? store.closeTab(p.tab.id) : store.setActiveTab(p.tab.id))}
				style={{ ...tw("flex h-full min-w-0 flex-1 items-center gap-1.5 pl-3 pr-1 cursor-pointer", mode()) }}
			>
				<Icon
					name={p.tab.kind === "web" ? (/epub/i.test(p.tab.contentType) ? "book-open" : "globe") : "file-text"}
					size={14}
					color={fg()}
					style={{ flexShrink: 0 }}
				/>
				<text
					style={{
						...textStyle(`min-w-0 truncate text-[13px] ${p.active ? "font-medium" : ""}`, mode()),
						color: fg(),
						flexShrink: 1,
					}}
				>
					{p.tab.title || "Reader"}
				</text>
			</div>
			<div
				onClick={() => store.closeTab(p.tab.id)}
				onMouseEnter={() => setOverClose(true)}
				onMouseLeave={() => setOverClose(false)}
				style={{
					...tw("flex size-[22px] flex-none items-center justify-center rounded cursor-pointer", mode()),
					opacity: p.active || hover() ? 1 : 0,
					...(overClose() ? tw("bg-foreground/10", mode()) : {}),
				}}
			>
				<Icon name="x" size={12} color={tok(overClose() ? "foreground" : "muted-foreground")} />
			</div>
		</div>
	);
}

/** The Settings tab (closable), shown after the readers once opened. */
function SettingsTabChip(p: { active: boolean }) {
	const [hover, setHover] = createSignal(false);
	const [overClose, setOverClose] = createSignal(false);
	const fg = () => tok(p.active || hover() ? "foreground" : "muted-foreground");
	return (
		<div
			onMouseEnter={() => setHover(true)}
			onMouseLeave={() => setHover(false)}
			style={{
				...tw(`${TAB} pr-1 max-w-56`, mode()),
				...(p.active ? tw("bg-background shadow-sm ring-1 ring-border", mode()) : hover() ? tw("bg-foreground/5", mode()) : {}),
			}}
		>
			<div
				onClick={() => store.setActiveTab(SETTINGS_TAB)}
				style={{ ...tw("flex h-full min-w-0 flex-1 items-center gap-1.5 pl-3 pr-1 cursor-pointer", mode()) }}
			>
				<Icon name="settings" size={14} color={fg()} style={{ flexShrink: 0 }} />
				<text style={{ ...textStyle(`text-[13px] ${p.active ? "font-medium" : ""}`, mode()), color: fg(), whiteSpace: "nowrap" }}>
					Settings
				</text>
			</div>
			<div
				onClick={closeSettings}
				onMouseEnter={() => setOverClose(true)}
				onMouseLeave={() => setOverClose(false)}
				style={{
					...tw("flex size-[22px] flex-none items-center justify-center rounded cursor-pointer", mode()),
					opacity: p.active || hover() ? 1 : 0,
					...(overClose() ? tw("bg-foreground/10", mode()) : {}),
				}}
			>
				<Icon name="x" size={12} color={tok(overClose() ? "foreground" : "muted-foreground")} />
			</div>
		</div>
	);
}

/** GPUIX cache region; typed because the host style type does not list the key. */
const REGION: Style = { cacheRegion: true };

export function TopBar() {
	const t = (cls: string): Style => tw(cls, mode());
	const tx = (cls: string): Style => textStyle(cls, mode());
	const onLibrary = () => store.activeTab() === "library";
	const readers = () => store.tabs().filter(isDocTab);
	return (
		// cacheRegion: drawn by its own cached GPUI view, replayed while the list scrolls
		<div style={{ ...t("flex flex-col flex-none bg-topbar"), width: "100%", ...REGION }}>
			{/* Application menubar (File / Edit / View / Go / Tools / Help), always shown above the tab strip; plugins can append entries */}
			<div style={{ ...t("flex h-7 flex-none items-center border-b bg-topbar px-2"), width: "100%" }}>
				<Menubar />
			</div>
			<div style={{ ...t("flex h-10 flex-none items-center gap-1 border-b bg-topbar px-3"), width: "100%" }}>
				{/* the panel toggles belong to the library layout (disabled on a reader tab, as the web UI) */}
				<div style={{ opacity: onLibrary() ? 1 : 0.3 }}>
					<PanelButton icon="panel-left" on={leftOpen()} onClick={() => onLibrary() && setLeftOpen(!leftOpen())} />
				</div>
				<div style={t("flex min-w-0 items-center gap-1 py-1 pr-1 pl-0.5")}>
					<LibraryTabChip active={onLibrary()} onClick={() => store.setActiveTab("library")} />
					<For each={readers()}>{(tab) => <ReaderTabChip tab={tab} active={store.activeTab() === tab.id} />}</For>
					<PluginTabChips />
					<Show when={settingsOpen()}>
						<SettingsTabChip active={store.activeTab() === SETTINGS_TAB} />
					</Show>
				</div>
				<div style={{ flexGrow: 1 }} />
				<div style={t("flex flex-none items-center gap-1")}>
					{/* Zotero sync: indicator + popover; refresh the lists when changes arrive from Zotero */}
					<PluginToolbarSlot slot="top-bar" />
					<PluginPanelToggles />
					<SyncStatus onChanged={() => refreshLibraryLists(store)} />
					<div style={{ opacity: onLibrary() ? 1 : 0.3 }}>
						<PanelButton icon="panel-right" on={rightOpen()} onClick={() => onLibrary() && setRightOpen(!rightOpen())} />
					</div>
					<PanelButton icon="settings" accent={store.activeTab() === SETTINGS_TAB} onClick={openSettings} />
				</div>
			</div>
		</div>
	);
}
