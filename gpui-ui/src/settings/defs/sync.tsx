// Sync (Zotero data folder). Shortcuts moved to ./shortcuts.tsx. The sync rows share the top-bar indicator's state (../../sync/state).
import { createSignal, Show, type JSX } from "solid-js";
import { Note, NoteText, Txt, t } from "../../shell/kit";
import { ago, plural } from "../../shell/net";
import { syncOwner, syncOwnerNote } from "../../sync/owner";
import { sync, ZOTERO_LABEL } from "../../sync/state";
import { webSync } from "../../features/websync/client";
import { isBrowserLibrary } from "../../shell/libraryMode";
import { Btn, Toggle, Value } from "../controls";
import { onSectionShown, registerSection, registerSettings } from "../registry";
import { AccountControl, FileCheckControl, FilesControl, GroupsControl, OrgStatusControl, PushControl, SourceControl } from "./sync-org";

registerSection({
	id: "sync",
	label: "Sync",
	icon: "refresh-cw",
	order: 40,
	description: "Keeping this library and Zotero's in step.",
	keywords: ["zotero", "write", "backup"],
});
onSectionShown("sync", () => {
	if (!sync.start()) void sync.refresh();
	void webSync.refresh();
});

const loading = (): JSX.Element => <Value>{sync.reachable() ? "Loading…" : "Sync is not available."}</Value>;

/** Another zotero-next (or ZN_SYNC=0) owns the sync: say so instead of the status of a sync service that is not running here. */
const ownerNote = (): JSX.Element => (
	<Txt cls="text-xs text-muted-foreground" style={{ textAlign: "right", maxWidth: 380 }}>
		{syncOwnerNote()}
	</Txt>
);

function WriteControl(): JSX.Element {
	const [confirming, setConfirming] = createSignal(false);
	return (
		<Show when={syncOwner() === "self"} fallback={ownerNote()}>
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
									This writes directly into Zotero's database (zotero.sqlite) and storage folder, only while Zotero is
									closed. A backup of zotero.sqlite is made before every write session (the last 5 are kept in
									zotero-next-backups). Make your own backup of the Zotero data folder first if you want extra safety.
								</NoteText>
								<div style={t("flex gap-2")}>
									<Btn onClick={() => setConfirming(false)}>Cancel</Btn>
									<Btn
										primary
										disabled={sync.busy()}
										onClick={() => void sync.setEnabled(true).then(() => setConfirming(false))}
									>
										I have a backup, turn on
									</Btn>
								</div>
							</Note>
						</Show>
						<Show when={s().enabled && s().lastBackup}>
							<Value>{`Last backup: ${s().lastBackup}`}</Value>
						</Show>
					</div>
				)}
			</Show>
		</Show>
	);
}

registerSettings([
	{
		id: "sync.status",
		section: "sync",
		label: "Zotero library",
		description: "State of the Zotero data folder this library is kept in step with.",
		keywords: ["status", "sync now", "refresh", "pull", "read", "conflicts", "pending", "last sync"],
		control: () => (
			<Show when={syncOwner() === "self"} fallback={ownerNote()}>
				<Show when={sync.status()} fallback={loading()}>
					{(s) => (
						<div style={{ ...t("flex flex-col items-end gap-1"), maxWidth: 380 }}>
							<Txt cls="text-xs text-muted-foreground" style={{ textAlign: "right" }}>
								{`${ZOTERO_LABEL[s().zotero]}. Read ${ago(s().lastPullAt)}; ${s().pending ? `${plural(s().pending, "change")} waiting to write` : "nothing waiting to write"}; ${plural(s().conflicts, "conflict")}`}
							</Txt>
							<Show when={s().lastError}>
								<Txt cls="text-xs text-destructive" style={{ textAlign: "right" }}>
									{s().lastError ?? ""}
								</Txt>
							</Show>
							<Btn icon="refresh-cw" disabled={sync.busy() || s().zotero === "missing"} onClick={() => void sync.syncNow()}>
								Sync now
							</Btn>
						</div>
					)}
				</Show>
			</Show>
		),
	},
	{
		id: "sync.write",
		section: "sync",
		label: "Write changes into Zotero",
		layout: "block",
		description:
			"Off: Zotero's changes are still read in. On: edits made here are written to Zotero's database, only while Zotero is closed.",
		keywords: ["push", "write back", "zotero.sqlite", "database", "enable", "opt in", "backup"],
		control: () => <WriteControl />,
	},
	{
		id: "sync.dataDir",
		section: "sync",
		label: "Zotero data folder",
		description: "Change it under Files and folders.",
		keywords: ["directory", "path", "location", "zotero.sqlite", "storage", "files and folders"],
		control: () => <Value>{sync.status()?.dataDir ?? "…"}</Value>,
	},
	{
		id: "sync.source",
		section: "sync",
		label: "Sync source",
		description:
			"Where this library gets Zotero's changes from. Only one runs: Zotero already syncs to zotero.org on its own, so using both would pass every change back and forth.",
		keywords: ["zotero.org", "web api", "cloud", "account", "local zotero", "off", "mode"],
		control: () => <SourceControl />,
	},
	{
		id: "sync.org.key",
		section: "sync",
		label: "zotero.org account",
		layout: "block",
		// a getter: the browser flag is set when the page starts, after this module may first load
		get description() {
			return isBrowserLibrary()
				? "The API key is stored in this browser's extension storage. Only Zinc can read it; it is never sent to web pages."
				: "An API key from your zotero.org account. It is kept in the system's secret store, never in the library.";
		},
		keywords: ["api key", "key", "username", "password", "login", "account", "zotero.org", "connect"],
		control: () => <AccountControl />,
	},
	{
		id: "sync.org.push",
		section: "sync",
		label: "Send changes to zotero.org",
		description: "Off: zotero.org's changes are read in, nothing is sent. On: edits made here are uploaded.",
		keywords: ["push", "upload", "write", "zotero.org", "opt in"],
		control: () => <PushControl />,
	},
	{
		id: "sync.org.files",
		section: "sync",
		label: "Attachment files",
		description: "Whether the files of attachments follow along. Metadata of attachments always syncs.",
		keywords: ["download", "upload", "pdf", "storage", "zotero.org", "file syncing"],
		control: () => <FilesControl />,
	},
	{
		id: "sync.org.groups",
		section: "sync",
		label: "Group libraries",
		layout: "block",
		description:
			"Groups of the connected account are synced with it. A group you may not edit is read-only here, and nothing is ever sent to it.",
		keywords: ["groups", "group libraries", "shared", "read-only", "zotero.org"],
		control: () => <GroupsControl />,
	},
	{
		id: "sync.org.status",
		section: "sync",
		label: "zotero.org status",
		keywords: ["status", "sync now", "last sync", "conflicts", "pending", "backoff", "error", "zotero.org"],
		control: () => <OrgStatusControl />,
	},
	{
		id: "sync.org.check",
		section: "sync",
		label: "Online-only files",
		layout: "block",
		description:
			"Attachment files that are on zotero.org but not on this computer. Download them before removing them from zotero.org's storage.",
		keywords: ["check", "missing files", "download missing", "storage", "purge", "zotero.org"],
		control: () => <FileCheckControl />,
	},
	{ id: "sync.auto", section: "sync", label: "Sync automatically", keywords: ["background", "schedule"], unavailable: true },
]);
