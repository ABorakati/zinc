// Settings > Shortcuts: every app action with its key, which the user can change, remove or reset (Zotero's Settings > Advanced >
// Shortcuts, which offers this for eight actions; here every command can have one). The choices live in shell/bindings.ts; the
// window's key handler, the menus and the Keyboard Shortcuts dialog all read them from there. The keys of the lists and text fields
// (arrows, Delete, 1–9, Enter…) are listed as fixed keys.
import { createSignal, onCleanup, Show, type JSX } from "solid-js";
import type { EventPayload } from "@gpuix/solid";
import { appActions, type AppAction } from "../../registry";
import { isCustomised, resetAllShortcuts, resetShortcut, setShortcut, shortcutOverrides } from "../../shell/bindings";
import { actionShortcut, chordFromEvent, isBindable, shortcutUsers } from "../../shell/shortcuts";
import { t, Txt } from "../../shell/kit";
import { toast } from "../../ui";
import { Btn, Kbd } from "../controls";
import { registerSection, registerSettings, registerSettingsProvider } from "../registry";

registerSection({
	id: "shortcuts",
	label: "Shortcuts",
	icon: "keyboard",
	order: 80,
	description: "Keyboard shortcuts of the app. Click Change and press the new keys.",
	keywords: ["keyboard", "keys", "hotkeys", "bindings", "customise", "customize", "rebind", "remap"],
});

const labelOf = (a: AppAction): string => (typeof a.label === "function" ? a.label() : a.label);

/** The heading a command is listed under (by its id, which says which feature registered it). */
function groupOf(id: string): string {
	if (id.startsWith("tab-")) return "Tabs";
	if (id.startsWith("add.") || id.startsWith("io.")) return "Adding and importing";
	if (id.startsWith("cite.") || id.startsWith("bbt.")) return "Citing";
	if (id.startsWith("search") || id.startsWith("sidebar-") || id.startsWith("tags-") || id === "advanced-search") return "Finding";
	return "Other commands";
}
const GROUP_ORDER = ["Adding and importing", "Citing", "Finding", "Tabs", "Other commands"];

/** The key cap, Change / Remove / Reset, and while recording a box that takes the next key combination. */
function ShortcutControl(p: { action: AppAction }): JSX.Element {
	const [recording, setRecording] = createSignal(false);
	const [hint, setHint] = createSignal("");
	const stop = () => {
		setRecording(false);
		setHint("");
	};
	onCleanup(stop);
	const onKey = (ev: EventPayload) => {
		const e = ev as EventPayload & { preventDefault?(): void; stopPropagation?(): void };
		e.preventDefault?.(); // the key must not also run the command it is bound to, or move focus (Tab)
		e.stopPropagation?.();
		const chord = chordFromEvent(e as never);
		if (!chord) return; // a modifier alone: wait for the key
		if (chord === "Esc") return stop();
		if (!isBindable(chord)) return void setHint("Use Ctrl or Alt with a key, or a function key (F1–F12).");
		const a = p.action;
		const taken = shortcutUsers(chord, a.id);
		for (const u of taken) setShortcut(u.id, "", u.shortcut);
		setShortcut(a.id, chord, a.shortcut);
		stop();
		if (taken.length) toast(`${chord} now runs "${labelOf(a)}"`, { description: `Removed from "${taken.map(labelOf).join('", "')}".` });
	};
	return (
		<div testId={`shortcut-${p.action.id}`} style={t("flex flex-col items-end gap-1")}>
			<div style={t("flex items-center gap-2")}>
				<Show when={recording()} fallback={<Kbd>{actionShortcut(p.action) ?? "None"}</Kbd>}>
					<div
						tabIndex={0}
						autoFocus
						testId={`shortcut-recorder-${p.action.id}`}
						onKeyDown={onKey}
						onBlur={stop}
						style={{ ...t("flex h-6 items-center rounded-md border border-primary px-2"), keyboardFocusDim: false }}
					>
						<Txt cls="text-[11px] font-medium text-foreground" wrap={false}>
							Press the new keys… (Esc cancels)
						</Txt>
					</div>
				</Show>
				<Show when={!recording()}>
					<Btn onClick={() => setRecording(true)}>Change</Btn>
					<Show when={actionShortcut(p.action)}>
						<Btn onClick={() => setShortcut(p.action.id, "", p.action.shortcut)}>Remove</Btn>
					</Show>
					<Show when={isCustomised(p.action.id)}>
						<Btn
							onClick={() => resetShortcut(p.action.id)}
						>{`Reset${p.action.shortcut ? ` to ${p.action.shortcut}` : ""}`}</Btn>
					</Show>
				</Show>
			</div>
			<Show when={hint()}>
				<Txt cls="text-xs text-destructive">{hint()}</Txt>
			</Show>
		</div>
	);
}

/** Keys of the lists, panes and fields: fixed, listed so every key is on one page. */
const FIXED: { keys: string; description: string; group: string }[] = [
	{ keys: "Up / Down", description: "Move through the items, or the sidebar's rows", group: "Item list and sidebar" },
	{ keys: "Shift+Up / Down", description: "Extend the item selection", group: "Item list and sidebar" },
	{ keys: "Left / Right", description: "Close / open an item's attachments, or a collection", group: "Item list and sidebar" },
	{ keys: "+ / -", description: "Expand / collapse all", group: "Item list and sidebar" },
	{ keys: "Home / End", description: "First / last row", group: "Item list and sidebar" },
	{ keys: "Enter", description: "Open the item's PDF, EPUB or snapshot", group: "Item list and sidebar" },
	{ keys: "Ctrl+A", description: "Select all items", group: "Item list and sidebar" },
	{
		keys: "Delete",
		description: "Move to the Trash; in a collection, remove from it; in the Trash, delete permanently",
		group: "Item list and sidebar",
	},
	{ keys: "Shift+Delete", description: "Move to the Trash without asking (from a collection too)", group: "Item list and sidebar" },
	{ keys: "1–9", description: "Add or remove the coloured tag at that position", group: "Item list and sidebar" },
	{ keys: "F2", description: "Rename the selected collection or saved search", group: "Item list and sidebar" },
	{ keys: "Delete", description: "Delete the selected collection or saved search (sidebar)", group: "Item list and sidebar" },
];

registerSettings([
	{
		id: "shortcuts.reset",
		section: "shortcuts",
		label: "Reset all shortcuts",
		description: "Put every command back on its default keys.",
		keywords: ["defaults", "restore"],
		control: () => (
			<Btn disabled={!Object.keys(shortcutOverrides()).length} onClick={resetAllShortcuts}>
				Reset all
			</Btn>
		),
	},
]);

registerSettingsProvider(() => {
	const rows = appActions()
		.map((a) => ({ a, label: labelOf(a), group: groupOf(a.id) }))
		.sort((x, y) => GROUP_ORDER.indexOf(x.group) - GROUP_ORDER.indexOf(y.group) || x.label.localeCompare(y.label));
	return [
		...rows.map(({ a, label, group }) => ({
			id: `shortcuts.action.${a.id}`,
			section: "shortcuts",
			group,
			label,
			keywords: [a.shortcut ?? "", "keyboard", "shortcut", "key", "rebind"].filter(Boolean),
			control: () => <ShortcutControl action={a} />,
		})),
		...FIXED.map((f) => ({
			id: `shortcuts.fixed.${f.keys}.${f.description}`,
			section: "shortcuts",
			group: "Fixed keys",
			label: f.description,
			keywords: [f.keys, "keyboard", "shortcut", "key"],
			control: () => <Kbd>{f.keys}</Kbd>,
		})),
	];
});
