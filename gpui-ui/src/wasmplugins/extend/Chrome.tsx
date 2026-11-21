// The window chrome plugins can extend: the menubar (File / Edit / View / Go / Tools / Help), banners above the tab strip, plugin tabs
// (chips and bodies) and side panels. Banners, plugin tabs and side panels draw nothing until a plugin registers them; the menubar is
// always shown on its own row at the top of the window, and plugins can append entries to its menus.
import { createMemo, For, Show, type JSX } from "solid-js";
import type { EventPayload } from "@gpuix/solid";
import { Icon } from "../../icons";
import { appActions } from "../../registry";
import { leftOpen, rightOpen, setLeftOpen, setRightOpen, openSettings } from "../../shell/layout";
import { HIDDEN, t, tok, tx } from "../../shell/kit";
import { actionShortcut } from "../../shell/shortcuts";
import { store } from "../../store";
import { DropdownMenu, type MenuItem } from "../../ui";
import { callPlugin } from "../host";
import { conditionHolds } from "./conditions";
import { buildContext, conditionContext, pluginTabId } from "./context";
import { menuShowing, resolveTarget } from "./menus";
import { dismissedBanners, panelOpen, registries, type Owned } from "./registry";
import { iconName, lstr } from "./text";
import type { BannerSpec, MenuTarget, SidePanelRegistration, TabSpec } from "./wit";
import { PluginViewSlot } from "./viewSlot";
import { toMenuItems } from "./ToolbarSlot";

// ---- menubar ---------------------------------------------------------------------------------------------------------------

type MenubarName = "file" | "edit" | "view" | "go" | "tools" | "help";
const MENUS: { id: MenubarName; label: string }[] = [
	{ id: "file", label: "File" },
	{ id: "edit", label: "Edit" },
	{ id: "view", label: "View" },
	{ id: "go", label: "Go" },
	{ id: "tools", label: "Tools" },
	{ id: "help", label: "Help" },
];

const actionItems = (menu: "add" | "tools"): MenuItem[] =>
	appActions()
		.filter((a) => a.menu === menu && (a.when?.() ?? true))
		.map((a) => ({
			label: typeof a.label === "function" ? a.label() : a.label,
			icon: a.icon,
			shortcut: actionShortcut(a),
			onSelect: () => a.run(),
		}));

/** The app's own entries of each menu (small on purpose: the menubar exists so plugin entries have a home). */
function builtin(m: MenubarName): MenuItem[] {
	switch (m) {
		case "file":
			return actionItems("add");
		case "edit":
			return [{ label: "Select all items", shortcut: "Ctrl+A", onSelect: () => store.selectAll() }];
		case "view":
			return [
				{ label: "Collections sidebar", checked: leftOpen(), onSelect: () => setLeftOpen(!leftOpen()) },
				{ label: "Item pane", checked: rightOpen(), onSelect: () => setRightOpen(!rightOpen()) },
				{ separator: true },
				{ label: "List view", checked: store.viewMode() === "cards", onSelect: () => store.setViewMode("cards") },
				{ label: "Classic table", checked: store.viewMode() === "table", onSelect: () => store.setViewMode("table") },
			];
		case "go":
			return [
				{ label: "Library", icon: "library", onSelect: () => store.setActiveTab("library") },
				{ label: "Settings", icon: "settings", onSelect: () => openSettings() },
			];
		case "tools":
			return actionItems("tools");
		case "help": {
			const report = appActions().find((a) => a.id === "report-problem" && (a.when?.() ?? true));
			return report
				? [
						{
							label: typeof report.label === "function" ? report.label() : report.label,
							icon: report.icon,
							onSelect: () => report.run(),
						},
					]
				: [];
		}
		default:
			return [];
	}
}

/** Built-in entries, then the plugins' (a separator between). */
export function menubarItems(m: MenubarName): MenuItem[] {
	const base = builtin(m);
	const plug = toMenuItems(resolveTarget(`menubar-${m}` as MenuTarget, conditionContext()));
	const out = [...base, ...(base.length && plug.length ? [{ separator: true } as MenuItem] : []), ...plug];
	return out.length ? out : [{ label: "(empty)", disabled: true }];
}

export function Menubar(): JSX.Element {
	return (
		<div testId="plugin-menubar" style={t("flex flex-none items-center gap-0.5")}>
			<For each={MENUS}>
				{(m) => (
					<DropdownMenu
						items={() => menubarItems(m.id)}
						width={220}
						trigger={
							<div
								role="button"
								aria-label={m.label}
								onMouseEnter={() => void menuShowing(`menubar-${m.id}` as MenuTarget, buildContext())}
								style={{
									...t("flex h-6 flex-none items-center rounded px-2"),
									cursor: "pointer",
									hover: t("bg-foreground/5"),
								}}
							>
								<text style={{ ...tx("text-[12px] text-muted-foreground"), whiteSpace: "nowrap" }}>{m.label}</text>
							</div>
						}
					/>
				)}
			</For>
		</div>
	);
}

// ---- banners ---------------------------------------------------------------------------------------------------------------

const TONE: Record<BannerSpec["kind"], { bg: string; fg: string; icon: string }> = {
	info: { bg: "primary-tint", fg: "primary-deep", icon: "info" },
	warning: { bg: "warning", fg: "warning-foreground", icon: "triangle-alert" },
	error: { bg: "destructive", fg: "destructive-foreground", icon: "circle-alert" },
};

function Banner(p: { b: Owned<BannerSpec> }): JSX.Element {
	const tone = () => TONE[p.b.reg.kind] ?? TONE.info;
	const shown = () =>
		!dismissedBanners.get(p.b.plugin, p.b.id) && (!p.b.reg.tabKinds?.length || p.b.reg.tabKinds.includes(conditionContext().tab.kind));
	return (
		<Show when={shown()}>
			<div
				testId={`plugin-banner-${p.b.plugin}-${p.b.id}`}
				style={{ ...t("flex flex-none items-center gap-2 px-4 py-1.5"), width: "100%", backgroundColor: tok(tone().bg) }}
			>
				<Icon name={tone().icon} size={14} color={tok(tone().fg)} />
				<text style={{ ...tx("text-[13px]"), color: tok(tone().fg), flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
					{lstr(p.b.reg.text)}
				</text>
				<For each={p.b.reg.actions}>
					{(a) => (
						<div
							role="button"
							aria-label={lstr(a.label, a.id)}
							onClick={() =>
								void callPlugin(p.b.plugin, "extend-handlers", "on-banner-action", [p.b.id, a.id]).catch(() => {})
							}
							style={{ ...t("flex h-6 items-center rounded-md border px-2"), cursor: "pointer", borderColor: tok(tone().fg) }}
						>
							<text style={{ ...tx("text-xs"), color: tok(tone().fg), whiteSpace: "nowrap" }}>{lstr(a.label, a.id)}</text>
						</div>
					)}
				</For>
				<Show when={p.b.reg.dismissable}>
					<div
						role="button"
						aria-label="Dismiss"
						onClick={() => dismissedBanners.set(p.b.plugin, p.b.id, true)}
						style={{ cursor: "pointer" }}
					>
						<Icon name="x" size={14} color={tok(tone().fg)} />
					</div>
				</Show>
			</div>
		</Show>
	);
}

export function PluginBanners(): JSX.Element {
	return (
		<Show when={registries.banners.list().length}>
			<div style={{ ...t("flex flex-col flex-none"), width: "100%" }}>
				<For each={registries.banners.list()}>{(b) => <Banner b={b} />}</For>
			</div>
		</Show>
	);
}

// ---- tabs ------------------------------------------------------------------------------------------------------------------

const TAB = "flex h-7 flex-none items-center rounded-md";

function titleOf(s: TabSpec): string {
	return lstr(s.title, s.tabId);
}

async function closePluginTab(plugin: string, tabId: string): Promise<void> {
	try {
		const keep = (await callPlugin(plugin, "extend-handlers", "on-tab-closing", [tabId])) as boolean;
		if (keep === false) return;
	} catch {
		/* a failing handler does not keep the tab open */
	}
	registries.tabs.remove(plugin, tabId);
	if (store.activeTab() === pluginTabId(plugin, tabId)) store.setActiveTab("library");
}

/** Chips of plugin tabs, for the tab strip (pinned ones first, then by `index`). */
export function PluginTabChips(): JSX.Element {
	const list = createMemo(() => {
		const l = registries.tabs.list().slice();
		l.sort((a, b) => Number(b.reg.pinned) - Number(a.reg.pinned) || (a.reg.index ?? 1e9) - (b.reg.index ?? 1e9));
		return l;
	});
	return (
		<For each={list()}>
			{(tab) => {
				const id = () => pluginTabId(tab.plugin, tab.id);
				const active = () => store.activeTab() === id();
				const fg = () => tok(active() ? "foreground" : "muted-foreground");
				return (
					<div
						testId={`plugin-tab-${tab.plugin}-${tab.id}`}
						style={{
							...t(`${TAB} pr-1 max-w-56`),
							...(active() ? t("bg-background shadow-sm ring-1 ring-border") : {}),
						}}
					>
						<div
							onClick={() => store.setActiveTab(id())}
							style={{ ...t("flex h-full min-w-0 flex-1 items-center gap-1.5 pl-3 pr-1 cursor-pointer") }}
						>
							<Icon name={iconName(tab.reg.icon, "puzzle")} size={14} color={fg()} style={{ flexShrink: 0 }} />
							<text style={{ ...tx(`text-[13px] ${active() ? "font-medium" : ""}`), color: fg(), whiteSpace: "nowrap" }}>
								{titleOf(tab.reg)}
							</text>
						</div>
						<Show when={tab.reg.closable}>
							<div
								onClick={() => void closePluginTab(tab.plugin, tab.id)}
								style={{ ...t("flex size-[22px] flex-none items-center justify-center rounded cursor-pointer") }}
							>
								<Icon name="x" size={12} color={tok("muted-foreground")} />
							</div>
						</Show>
					</div>
				);
			}}
		</For>
	);
}

/** Bodies of plugin tabs: mounted when first shown, then kept (hidden while another tab is active). */
export function PluginTabBodies(): JSX.Element {
	return (
		<For each={registries.tabs.list()}>
			{(tab) => {
				const id = () => pluginTabId(tab.plugin, tab.id);
				const active = () => store.activeTab() === id();
				return (
					<div
						testId={`plugin-tab-body-${tab.plugin}-${tab.id}`}
						style={{
							display: "flex",
							flexDirection: "column",
							flexGrow: 1,
							minHeight: 0,
							width: "100%",
							...t("bg-background"),
							...(active() ? {} : HIDDEN),
						}}
					>
						<PluginViewSlot
							plugin={tab.plugin}
							view={tab.id}
							surface="tab"
							params={{
								window: 1,
								tabID: id(),
								kind: tab.reg.kind,
								state: tab.reg.state ? JSON.parse(tab.reg.state) : null,
								item: tab.reg.item ?? null,
							}}
							visible={active()}
						/>
					</div>
				);
			}}
		</For>
	);
}

// ---- side panels -----------------------------------------------------------------------------------------------------------

const fitsTab = (p: Owned<SidePanelRegistration>, tabKind: string) =>
	(p.reg.tabKinds?.length ? p.reg.tabKinds : ["library"]).includes(tabKind);

/** Panels docked on one side of the library (or, with `tab`, of a reader tab). */
export function PluginSidePanels(p: { side: "left" | "right"; tabKind?: string }): JSX.Element {
	const kind = () => p.tabKind ?? "library";
	const list = () =>
		registries.sidePanels.list().filter((s) => s.reg.side === p.side && fitsTab(s, kind()) && panelOpen.get(s.plugin, s.id));
	return (
		<For each={list()}>
			{(s) => (
				<div
					testId={`plugin-panel-${s.plugin}-${s.id}`}
					style={{
						...t("flex flex-col flex-none rounded-[14px] bg-background shadow-raised overflow-hidden"),
						width: s.reg.defaultWidth,
						minWidth: s.reg.minWidth,
						height: "100%",
						marginLeft: p.side === "right" ? 12 : 0,
						marginRight: p.side === "left" ? 12 : 0,
					}}
				>
					<div style={{ ...t("flex h-9 flex-none items-center gap-1.5 px-3 border-b border-border-soft") }}>
						<Icon name={iconName(s.reg.icon)} size={14} color={tok("muted-foreground")} />
						<text style={{ ...tx("text-[12px] font-semibold text-foreground"), flexGrow: 1 }}>{lstr(s.reg.title, s.id)}</text>
						<div
							role="button"
							aria-label="Close panel"
							onClick={() => panelOpen.set(s.plugin, s.id, false)}
							style={{ cursor: "pointer" }}
						>
							<Icon name="x" size={14} color={tok("muted-foreground")} />
						</div>
					</div>
					<div style={{ flexGrow: 1, minHeight: 0, width: "100%" }}>
						<PluginViewSlot
							plugin={s.plugin}
							view={s.id}
							surface="side-panel"
							params={{ window: 1, tabID: store.activeTab(), tabType: kind(), side: s.reg.side }}
						/>
					</div>
				</div>
			)}
		</For>
	);
}

/** Buttons that show and hide the registered side panels (top bar). */
export function PluginPanelToggles(p: { tabKind?: string }): JSX.Element {
	const list = () =>
		registries.sidePanels.list().filter((s) => fitsTab(s, p.tabKind ?? "library") && conditionHolds(undefined, conditionContext()));
	return (
		<For each={list()}>
			{(s) => {
				const on = () => !!panelOpen.get(s.plugin, s.id);
				return (
					<div
						role="button"
						aria-label={lstr(s.reg.title, s.id)}
						onClick={(_e: EventPayload) => panelOpen.set(s.plugin, s.id, !on())}
						style={{
							...t("flex size-7 flex-none items-center justify-center rounded-md"),
							cursor: "pointer",
							...(on() ? t("bg-border") : {}),
							hover: on() ? undefined : t("bg-foreground/5"),
						}}
					>
						<Icon name={iconName(s.reg.icon)} size={16} color={tok(on() ? "foreground" : "muted-foreground")} />
					</div>
				);
			}}
		</For>
	);
}
