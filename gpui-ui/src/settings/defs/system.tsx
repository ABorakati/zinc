// System: the connection to the core, where the UI keeps its state, interface resets, and what is running.
import { createSignal, Show, type JSX } from "solid-js";
import { BASE_URL } from "../../api";
import { resetCols, setLeftOpen, setRightOpen } from "../../shell/layout";
import { Txt, t } from "../../shell/kit";
import { call } from "../../shell/net";
import { revealInFolder } from "../../shell/native";
import { clearPrefs, prefsPath } from "../../shell/prefs";
import { resetThemePrefs } from "../../shell/appearance";
import { confirm, toast } from "../../ui";
import { Btn, Value } from "../controls";
import { onSettingsShown, registerSection, registerSettings } from "../registry";
import { readerPrefs } from "../readerPrefs";

registerSection({
	id: "system",
	label: "System",
	icon: "wrench",
	order: 90,
	description: "The core connection, saved interface state and about.",
	keywords: ["advanced", "maintenance", "reset", "about", "version", "core", "connection"],
});

const [core, setCore] = createSignal<"checking" | "ok" | "down">("checking");
const [coreInfo, setCoreInfo] = createSignal("");
onSettingsShown(() => {
	setCore("checking");
	// any cheap read tells whether the core answers
	call<unknown[]>("GET", "/api/collections").then(
		(c) => {
			setCore("ok");
			setCoreInfo(`${c.length.toLocaleString()} collections`);
		},
		() => {
			setCore("down");
			setCoreInfo("");
		},
	);
});

function CoreControl(): JSX.Element {
	return (
		<div style={{ ...t("flex flex-col items-end gap-1"), maxWidth: 420 }}>
			<Txt cls="text-xs text-foreground">{BASE_URL}</Txt>
			<Txt cls={`text-xs ${core() === "down" ? "text-destructive" : "text-muted-foreground"}`}>
				{core() === "checking"
					? "Checking…"
					: core() === "ok"
						? `Connected${coreInfo() ? `, ${coreInfo()}` : ""}`
						: "Not reachable"}
			</Txt>
		</div>
	);
}

function resetShell(): void {
	void confirm({
		title: "Reset the interface?",
		body: "Panel sizes, theme, font, text size and Settings choices go back to their defaults. Your library is not touched.",
		confirmLabel: "Reset",
		danger: true,
	}).then((ok) => {
		if (!ok) return;
		resetThemePrefs();
		resetCols();
		readerPrefs.reset();
		setLeftOpen(true);
		setRightOpen(true);
		clearPrefs("shell.");
		toast("Interface reset", { kind: "success" });
	});
}

registerSettings([
	{
		id: "system.core",
		section: "system",
		group: "Connection",
		label: "Library core",
		description:
			"The core API this window talks to. Set ZN_URL (or ZN_DB for an in-process core) before starting the app to change it.",
		keywords: ["api", "server", "port", "url", "connection", "database"],
		control: () => <CoreControl />,
	},
	{
		id: "system.state",
		section: "system",
		group: "Interface",
		label: "Saved interface state",
		description: "Panel sizes, theme and other window choices are kept in this file.",
		keywords: ["ui-state.json", "preferences", "appdata", "config", "file"],
		control: () => (
			<div style={{ ...t("flex flex-col items-end gap-1"), maxWidth: 420 }}>
				<Txt cls="text-xs text-foreground">{prefsPath() ?? "Not saved (ZN_UI_STATE=off)"}</Txt>
				<Show when={prefsPath()}>
					<Btn onClick={() => revealInFolder(prefsPath()!)}>Show in folder</Btn>
				</Show>
			</div>
		),
	},
	{
		id: "system.panes",
		section: "system",
		group: "Interface",
		label: "Reset pane sizes",
		description: "Widths of the sidebar, item list and item pane.",
		keywords: ["layout", "resize", "panels", "splitter"],
		control: () => (
			<Btn
				onClick={() => {
					resetCols();
					toast("Pane sizes reset", { kind: "success" });
				}}
			>
				Reset
			</Btn>
		),
	},
	{
		id: "system.resetAll",
		section: "system",
		group: "Interface",
		label: "Reset the interface",
		description: "Back to the default look and layout.",
		keywords: ["restore", "defaults", "factory", "clear"],
		control: () => <Btn onClick={resetShell}>Reset…</Btn>,
	},
	{
		id: "system.about",
		section: "system",
		group: "About",
		label: "Runtime",
		description: "The native window is drawn by GPUI through GPUIX, running on Bun.",
		keywords: ["version", "bun", "gpui", "gpuix", "about", "platform"],
		control: () => <Value>{`Bun ${Bun.version} on ${process.platform}`}</Value>,
	},
]);
