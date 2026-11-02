// Top bar (ui/src/App.tsx): panel toggles, the "Library" tab chip, sync status text and the settings icon.
// Class strings are the web UI's, resolved through tw() / textStyle().
import type { Mode, Style } from "./contracts";
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

export function TopBar(p: { leftOpen: boolean; rightOpen: boolean; onLeft: () => void; onRight: () => void }) {
	const t = (cls: string): Style => tw(cls, mode());
	const tx = (cls: string): Style => textStyle(cls, mode());
	return (
		<div style={{ ...t("flex h-10 flex-none items-center gap-1 border-b bg-topbar px-3"), width: "100%" }}>
			<PanelButton icon="panel-left" on={p.leftOpen} onClick={p.onLeft} />
			<div style={t("flex min-w-0 items-center gap-1 py-1 pr-1 pl-0.5")}>
				{/* the active tab: tabCls(true) = bg-background font-medium text-foreground shadow-sm ring-1 ring-border */}
				<div style={t("flex h-7 flex-none items-center gap-1.5 rounded-md bg-background px-3 shadow-sm ring-1 ring-border")}>
					<Icon name="library" size={14} color={tok("foreground")} />
					<text style={tx("text-[13px] font-medium text-foreground")}>Library</text>
				</div>
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
				<PanelButton icon="panel-right" on={p.rightOpen} onClick={p.onRight} />
				<PanelButton icon="settings" />
			</div>
		</div>
	);
}
