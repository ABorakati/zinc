// Top bar (ui/src/App.tsx): panel toggles, the tab strip ("Library" + one chip per open reader), sync status text and the settings icon.
// Class strings are the web UI's, resolved through tw() / textStyle().
import { createSignal, For } from "solid-js";
import type { EventPayload } from "@gpuix/solid";
import { isReaderTab, type Mode, type ReaderTab, type Style } from "./contracts";
import { Icon } from "./icons";
import { store } from "./store";
import { textStyle, tokens, tw } from "./theme";

const mode = (): Mode => store.mode();
const tok = (name: string): string => tokens[mode()][name] ?? "#888";

/** panelBtn(on): size-7 items-center justify-center rounded-md; on -> bg-border text-foreground, else muted with hover tint. */
function PanelButton(p: { icon: string; on?: boolean; onClick?: () => void }) {
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
			<Icon name={p.icon} size={16} color={tok(p.on ? "foreground" : "muted-foreground")} />
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
			<text style={{ ...textStyle(`text-[13px] ${p.active ? "font-medium" : ""}`, mode()), color: fg(), whiteSpace: "nowrap" }}>Library</text>
		</div>
	);
}

/** A reader tab: file-text icon, title (truncated at max-w-56 = 224px incl. padding), close button (shown on hover / when active). */
function ReaderTabChip(p: { tab: ReaderTab; active: boolean }) {
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
				<Icon name="file-text" size={14} color={fg()} style={{ flexShrink: 0 }} />
				<text style={{ ...textStyle(`min-w-0 truncate text-[13px] ${p.active ? "font-medium" : ""}`, mode()), color: fg(), flexShrink: 1 }}>{p.tab.title || "Reader"}</text>
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

export function TopBar(p: { leftOpen: boolean; rightOpen: boolean; onLeft: () => void; onRight: () => void }) {
	const t = (cls: string): Style => tw(cls, mode());
	const tx = (cls: string): Style => textStyle(cls, mode());
	const onLibrary = () => store.activeTab() === "library";
	const readers = () => store.tabs().filter(isReaderTab);
	return (
		<div style={{ ...t("flex h-10 flex-none items-center gap-1 border-b bg-topbar px-3"), width: "100%" }}>
			{/* the panel toggles belong to the library layout (disabled on a reader tab, as the web UI) */}
			<div style={{ opacity: onLibrary() ? 1 : 0.3 }}>
				<PanelButton icon="panel-left" on={p.leftOpen} onClick={() => onLibrary() && p.onLeft()} />
			</div>
			<div style={t("flex min-w-0 items-center gap-1 py-1 pr-1 pl-0.5")}>
				<LibraryTabChip active={onLibrary()} onClick={() => store.setActiveTab("library")} />
				<For each={readers()}>{(tab) => <ReaderTabChip tab={tab} active={store.activeTab() === tab.id} />}</For>
			</div>
			<div style={{ flexGrow: 1 }} />
			<div style={t("flex flex-none items-center gap-1")}>
				{/* SyncStatus: ghost button h-7 gap-1.5 px-2 text-xs */}
				<div style={{ ...t("flex h-7 items-center gap-1.5 rounded-md px-2"), hover: t("bg-foreground/5") }}>
					<Icon name="refresh-cw" size={14} color={tok("foreground")} />
					<text style={tx("text-xs text-foreground")}>Zotero running</text>
					<div style={t("flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary/20 px-1.5")}>
						<text style={tx("text-[11px] font-semibold text-primary")}>13</text>
					</div>
				</div>
				<div style={{ opacity: onLibrary() ? 1 : 0.3 }}>
					<PanelButton icon="panel-right" on={p.rightOpen} onClick={() => onLibrary() && p.onRight()} />
				</div>
				<PanelButton icon="settings" />
			</div>
		</div>
	);
}
