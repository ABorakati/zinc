// Shell state that outlives a session: which side panels are shown, the column sizes for each combination, and the Settings tab
// (an extra tab beside Library and the readers, like the web UI's SETTINGS_TAB). Everything lives in ui-state.json ("shell.*").
import { createSignal } from "solid-js";
import { isDocTab } from "../contracts";
import { registerAppAction } from "../registry";
import { store, uiState } from "../store";
import { bindUiState, isBool, persisted, getPref, setPref } from "./prefs";

bindUiState(uiState); // prefs are written by store.ts's single ui-state.json writer

export const SETTINGS_TAB = "settings";

// ---- side panels (top-bar toggles)
export const [leftOpen, setLeftOpen] = persisted("shell.panelLeft", true, isBool);
export const [rightOpen, setRightOpen] = persisted("shell.panelRight", true, isBool);

// ---- column sizes: fractions summing to 1, per combination of visible panels ("11" both, "10" sidebar only, "01" item pane only, "00")
export const DEFAULT_COLS: Record<string, number[]> = { "11": [0.18, 0.54, 0.28], "10": [0.22, 0.78], "01": [0.64, 0.36], "00": [1] };
const colsKey = (k: string) => `shell.cols.${k}`;
const validCols =
	(k: string) =>
	(v: unknown): number[] | undefined => {
		const want = DEFAULT_COLS[k]!.length;
		return Array.isArray(v) && v.length === want && v.every((n) => typeof n === "number" && n > 0.02) ? (v as number[]) : undefined;
	};
const [colsRev, bumpCols] = createSignal(0);
/** Stored sizes for a panel combination (falls back to the defaults). */
export function getCols(k: string): number[] {
	colsRev();
	return getPref(colsKey(k), DEFAULT_COLS[k]!, validCols(k));
}
export function setCols(k: string, sizes: number[]): void {
	setPref(
		colsKey(k),
		sizes.map((n) => +n.toFixed(4)),
	);
	// no bump: the Resizable owns the live sizes while it is mounted; the stored copy is read when it is next created
}
export function resetCols(): void {
	for (const k of Object.keys(DEFAULT_COLS)) setPref(colsKey(k), undefined);
	bumpCols((n) => n + 1);
}
/** The "11"/"10"/"01"/"00" key for the current panel visibility. */
export const panelKey = (): string => `${+leftOpen()}${+rightOpen()}`;

// ---- Settings tab
const [settingsOpen, setSettingsOpen] = createSignal(false);
export { settingsOpen };

/** Open the Settings tab (or focus it). */
export function openSettings(): void {
	setSettingsOpen(true);
	store.setActiveTab(SETTINGS_TAB);
}
/** Close the Settings tab; the library (or the last reader) becomes active when it was. */
export function closeSettings(): void {
	if (!settingsOpen()) return;
	setSettingsOpen(false);
	if (store.activeTab() === SETTINGS_TAB) {
		const tabs = store.tabs();
		store.setActiveTab(tabs[tabs.length - 1]?.id ?? "library");
	}
}

/** Close whichever tab is active (Ctrl+W); the library tab stays. */
export function closeActiveTab(): void {
	const id = store.activeTab();
	if (id === SETTINGS_TAB) closeSettings();
	else store.closeTab(id);
}

registerAppAction({ id: "tab-close", label: "Close tab", icon: "x", menu: "none", shortcut: "Ctrl+W", run: closeActiveTab });

// ---- moving between tabs (Zotero's tab keys): the order of the top bar, Library, the documents, then Settings
/** Tab ids in the top bar's order. */
export const tabOrder = (): string[] => [
	"library",
	...store
		.tabs()
		.filter(isDocTab)
		.map((t) => t.id),
	...(settingsOpen() ? [SETTINGS_TAB] : []),
];
/** Go `delta` tabs along, wrapping around. */
export function stepTab(delta: number): void {
	const list = tabOrder();
	const i = Math.max(0, list.indexOf(store.activeTab()));
	store.setActiveTab(list[(i + delta + list.length) % list.length]!);
}
/** The n-th tab (1-based); 9 is the last, as in browsers and Zotero. */
export function gotoTab(n: number): void {
	const list = tabOrder();
	const id = n >= 9 ? list[list.length - 1] : list[n - 1];
	if (id) store.setActiveTab(id);
}
registerAppAction({ id: "tab-next", label: "Next tab", menu: "none", shortcut: "Ctrl+Tab", run: () => stepTab(1) });
registerAppAction({ id: "tab-previous", label: "Previous tab", menu: "none", shortcut: "Ctrl+Shift+Tab", run: () => stepTab(-1) });
registerAppAction({ id: "tab-next-page", label: "Next tab (Page Down)", menu: "none", shortcut: "Ctrl+PageDown", run: () => stepTab(1) });
registerAppAction({
	id: "tab-previous-page",
	label: "Previous tab (Page Up)",
	menu: "none",
	shortcut: "Ctrl+PageUp",
	run: () => stepTab(-1),
});
for (let n = 1; n <= 9; n++)
	registerAppAction({
		id: `tab-goto-${n}`,
		label: n === 9 ? "Go to the last tab" : `Go to tab ${n}`,
		menu: "none",
		shortcut: `Ctrl+${n}`,
		run: () => gotoTab(n),
	});
