// Sync (Zotero data folder) and Shortcuts. The sync rows share the top-bar indicator's state (../../sync/state).
import { createSignal, Show, type JSX } from "solid-js";
import { appActions } from "../../registry";
import { Note, NoteText, Txt, t } from "../../shell/kit";
import { ago, plural } from "../../shell/net";
import { sync, ZOTERO_LABEL } from "../../sync/state";
import { Btn, Kbd, Toggle, Value } from "../controls";
import { onSettingsShown, registerSection, registerSettings, registerSettingsProvider } from "../registry";

registerSection({ id: "sync", label: "Sync", icon: "refresh-cw", order: 40, description: "Keeping this library and Zotero's in step.", keywords: ["zotero", "write", "backup"] });
registerSection({ id: "shortcuts", label: "Shortcuts", icon: "keyboard", order: 80, description: "Keyboard shortcuts of the app.", keywords: ["keyboard", "keys", "hotkeys", "bindings"] });
onSettingsShown(() => { sync.start(); void sync.refresh(); });

const loading = (): JSX.Element => <Value>{sync.reachable() ? "Loading…" : "Sync is not available."}</Value>;

function WriteControl(): JSX.Element {
	const [confirming, setConfirming] = createSignal(false);
	return (
		<Show when={sync.status()} fallback={loading()}>
			{(s) => (
				<div style={t("flex flex-col gap-2")}>
					<div style={t("flex items-center gap-3")}>
						<Toggle checked={s().enabled} onChange={(on) => (on ? setConfirming(true) : void sync.setEnabled(false))} />
						<Value>{s().enabled ? `On. Last written ${ago(s().lastPushAt)}.` : "Off"}</Value>
					</div>
					<Show when={confirming() && !s().enabled}>
						<Note tone="warn">
							<NoteText tone="warn">
								This writes directly into Zotero's database (zotero.sqlite) and storage folder, only while Zotero is closed. A backup of zotero.sqlite is made before every write session (the last 5 are kept in zotero-next-backups). Make your own backup of the Zotero data folder first if you want extra safety.
							</NoteText>
							<div style={t("flex gap-2")}>
								<Btn onClick={() => setConfirming(false)}>Cancel</Btn>
								<Btn primary disabled={sync.busy()} onClick={() => void sync.setEnabled(true).then(() => setConfirming(false))}>I have a backup, turn on</Btn>
							</div>
						</Note>
					</Show>
					<Show when={s().enabled && s().lastBackup}><Value>{`Last backup: ${s().lastBackup}`}</Value></Show>
				</div>
			)}
		</Show>
	);
}

registerSettings([
	{
		id: "sync.status", section: "sync", label: "Zotero library",
		description: "State of the Zotero data folder this library is kept in step with.",
		keywords: ["status", "sync now", "refresh", "pull", "read", "conflicts", "pending", "last sync"],
		control: () => (
			<Show when={sync.status()} fallback={loading()}>
				{(s) => (
					<div style={{ ...t("flex flex-col items-end gap-1"), maxWidth: 380 }}>
						<Txt cls="text-xs text-muted-foreground" style={{ textAlign: "right" }}>
							{`${ZOTERO_LABEL[s().zotero]}. Read ${ago(s().lastPullAt)}; ${s().pending ? `${plural(s().pending, "change")} waiting to write` : "nothing waiting to write"}; ${plural(s().conflicts, "conflict")}`}
						</Txt>
						<Show when={s().lastError}><Txt cls="text-xs text-destructive" style={{ textAlign: "right" }}>{s().lastError ?? ""}</Txt></Show>
						<Btn icon="refresh-cw" disabled={sync.busy() || s().zotero === "missing"} onClick={() => void sync.syncNow()}>Sync now</Btn>
					</div>
				)}
			</Show>
		),
	},
	{
		id: "sync.write", section: "sync", label: "Write changes into Zotero", layout: "block",
		description: "Off: Zotero's changes are still read in. On: edits made here are written to Zotero's database, only while Zotero is closed.",
		keywords: ["push", "write back", "zotero.sqlite", "database", "enable", "opt in", "backup"],
		control: () => <WriteControl />,
	},
	{
		id: "sync.dataDir", section: "sync", label: "Zotero data folder",
		description: "Change it under Files and folders.",
		keywords: ["directory", "path", "location", "zotero.sqlite", "storage", "files and folders"],
		control: () => <Value>{sync.status()?.dataDir ?? "…"}</Value>,
	},
	{ id: "sync.account", section: "sync", label: "Sync with zotero.org", description: "Zotero account sync, data and file sync.", keywords: ["account", "username", "password", "cloud", "webdav", "file syncing"], unavailable: true },
	{ id: "sync.auto", section: "sync", label: "Sync automatically", keywords: ["background", "schedule"], unavailable: true },

	{ id: "shortcuts.customise", section: "shortcuts", label: "Change shortcuts", description: "Rebind keys to other combinations.", keywords: ["customise", "customize", "rebind", "remap"], unavailable: true },
]);

/** Built-in shortcuts of the shell, listed with the registered actions'. */
const BUILTIN: { keys: string; description: string }[] = [
	{ keys: "Ctrl+,", description: "Open Settings" },
	{ keys: "Ctrl+W", description: "Close the current tab" },
	{ keys: "Esc", description: "Clear the settings search" },
];

registerSettingsProvider(() => {
	const seen = new Set<string>();
	const rows = [
		...BUILTIN.map((b) => ({ ...b, group: "General" })),
		...appActions()
			.filter((a) => a.shortcut)
			.map((a) => ({ keys: a.shortcut!, description: typeof a.label === "function" ? a.label() : a.label, group: "Actions" })),
	];
	return rows
		.filter((r) => { const k = `${r.keys}|${r.description}`; if (seen.has(k)) return false; seen.add(k); return true; })
		.map((r) => ({
			id: `shortcuts.${r.group}.${r.keys}.${r.description}`,
			section: "shortcuts",
			group: r.group,
			label: r.description,
			keywords: [r.keys, "keyboard", "shortcut", "key"],
			control: () => <Kbd>{r.keys}</Kbd>,
		}));
});
