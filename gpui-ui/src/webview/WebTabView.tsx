// A web tab's body: a placeholder (canvas, "Opening ..." / the error) that fills the tab area and reports its rect, and a module-level
// controller that decides where the shared WebView2 (host.ts) is: over the active web tab's area, hidden while another tab is active or
// while a menu / dialog / popover is open (the popup window is above everything GPUIX draws, so overlays would be hidden behind it).
import { createEffect, createRoot, createSignal, onCleanup, Show, type JSX } from "solid-js";
import type { EventPayload } from "@gpuix/solid";
import { api, apiRequest } from "../api";
import { isWebTab, type Mode, type Style, type WebTab } from "../contracts";
import { HIDDEN } from "../shell/kit";
import { store } from "../store";
import { textStyle, tokens, tw } from "../theme";
import { overlayLayers, type Rect } from "../ui/core";
import { openAttachmentExternally } from "../ui/openExternal";
import { webTabUrl } from "./config";
import { hide, hostError, hostState, onPageMessage, release, setBackground, show, type PageMessage } from "./host";

const mode = (): Mode => store.mode();
const t = (cls: string): Style => tw(cls, mode());

const [rects, setRects] = createSignal<Record<string, Rect>>({});

/** What the reader page asks of its host (the Electrobun shell's onMessage in ui/src/App.tsx). */
function onPage(m: PageMessage): void {
	if (m.type === "open-link" && typeof m.url === "string") void api.openUrl(m.url).catch(() => {});
	else if (m.type === "open-item" && typeof m.key === "string") {
		store.setActiveTab("library");
		store.selectItem(m.key);
	} else if (m.type === "open-attachment" && typeof m.key === "string")
		store.openAttachment(m.key, typeof m.title === "string" ? m.title : "", "");
	else if (m.type === "reference-added") store.refresh();
}

// One controller for all web tabs. It lives outside any tab so a tab that is not active cannot fight the active one over the window.
createRoot(() => {
	onPageMessage(onPage);
	createEffect(() => {
		const tab = store.tabs().find((x) => x.id === store.activeTab());
		if (!tab || !isWebTab(tab)) return hide();
		const r = rects()[tab.id],
			url = webTabUrl(tab.attachmentKey);
		if (!r || !url || overlayLayers().length > 0) return hide();
		setBackground(tokens[mode()]["background"] ?? "#000000");
		show(url, r);
	});
	// the last web tab closed: destroy the WebView2 (its processes are the memory cost)
	createEffect(() => {
		if (!store.tabs().some(isWebTab)) release();
	});
});

export function WebTabView(p: { tab: WebTab }): JSX.Element {
	const active = () => store.activeTab() === p.tab.id;
	onCleanup(() =>
		setRects((r) => {
			const { [p.tab.id]: _gone, ...rest } = r;
			return rest;
		}),
	);
	const failed = () => hostState() === "error";
	const openExternal = () => void openAttachmentExternally(p.tab.attachmentKey).catch(() => {});
	return (
		<div
			onLayout={(e: EventPayload) => {
				const r = { x: e.x ?? 0, y: e.y ?? 0, width: e.width ?? 0, height: e.height ?? 0 };
				if (r.width > 0 && r.height > 0) setRects((all) => ({ ...all, [p.tab.id]: r }));
			}}
			style={{
				...t("flex flex-col items-center justify-center gap-2 p-6"),
				flexGrow: 1,
				minHeight: 0,
				width: "100%",
				backgroundColor: tokens[mode()]["background"],
				...(active() ? {} : HIDDEN),
			}}
		>
			<Show
				when={failed()}
				fallback={
					<text
						style={{ ...textStyle("text-xs text-muted-foreground", mode()), textAlign: "center" }}
					>{`Opening "${p.tab.title}"...`}</text>
				}
			>
				<text
					style={{ ...textStyle("text-foreground", mode()), textAlign: "center" }}
				>{`Could not show "${p.tab.title}" in the web view`}</text>
				<text style={{ ...textStyle("text-xs text-muted-foreground", mode()), textAlign: "center" }}>{hostError()}</text>
				<div onClick={openExternal} style={{ ...t("rounded-md border px-3 py-1.5 cursor-pointer"), hover: t("bg-foreground/5") }}>
					<text style={textStyle("text-xs text-foreground", mode())}>Open in default app</text>
				</div>
			</Show>
		</div>
	);
}
