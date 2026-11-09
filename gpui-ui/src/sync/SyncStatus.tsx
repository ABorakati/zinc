// Zotero sync indicator for the top bar, with a popover (Sync now, write opt-in, conflicts) — ui/src/sync/SyncStatus.tsx.
// Mount once in the top bar:  <SyncStatus onChanged={refreshLists} />  (onChanged: a pull brought changes from Zotero in).
import { createEffect, createSignal, For, onMount, Show, type JSX } from "solid-js";
import type { EventPayload } from "@gpuix/solid";
import { Icon } from "../icons";
import { Divider, Note, NoteText, Txt, t, tok } from "../shell/kit";
import { ago } from "../shell/net";
import { Button, Popover } from "../ui";
import { syncOwner, syncOwnerNote } from "./owner";
import { showRecord, sync, ZOTERO_LABEL, type SyncConflict } from "./state";

/** "Label ......... value" rows of the popover's status block. */
function Fact(p: { label: string; children: string }): JSX.Element {
	return (
		<div style={t("flex items-start gap-3")}>
			<div style={{ width: 150, flexShrink: 0 }}><Txt cls="text-xs text-muted-foreground">{p.label}</Txt></div>
			<div style={{ flexGrow: 1, minWidth: 0 }}><Txt cls="text-xs text-foreground">{p.children}</Txt></div>
		</div>
	);
}

function ConflictCard(p: { c: SyncConflict }): JSX.Element {
	const side = (title: string, kept: boolean, body: unknown): JSX.Element => (
		<div style={{ ...t(`flex flex-col gap-0.5 rounded p-1.5 ${kept ? "bg-primary/10" : "bg-muted"}`), flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 }}>
			<Txt cls="text-xs font-medium text-foreground">{kept ? `${title} (kept)` : title}</Txt>
			<Txt cls="text-[11px] text-foreground">{showRecord(body)}</Txt>
		</div>
	);
	return (
		<div style={t("flex flex-col gap-1 rounded-md border border-border p-2")}>
			<div style={t("flex items-start justify-between gap-2")}>
				<div style={{ minWidth: 0, flexShrink: 1 }}><Txt cls="text-xs font-medium text-foreground truncate">{p.c.title}</Txt></div>
				<Button variant="ghost" size="sm" onClick={() => void sync.dismiss(p.c.id)}>Dismiss</Button>
			</div>
			<Txt cls="text-xs text-muted-foreground">{`${p.c.type}, ${ago(p.c.at)}: ${p.c.resolved === "remote" ? "Zotero's version kept" : "your version kept"}`}</Txt>
			<div style={t("flex gap-2")}>
				{side("Zinc", p.c.resolved === "local", p.c.local)}
				{side("Zotero", p.c.resolved === "remote", p.c.remote)}
			</div>
		</div>
	);
}

function PopoverBody(): JSX.Element {
	const [confirming, setConfirming] = createSignal(false);
	const s = () => sync.status();
	return (
		<Show when={syncOwner() === "self"} fallback={<Note tone="warn"><NoteText tone="warn">{syncOwnerNote()}</NoteText></Note>}>
		<Show when={s()} fallback={<Txt cls="text-xs text-muted-foreground">Sync is not available.</Txt>}>
			{(st) => (
				<div style={{ ...t("flex flex-col gap-3 p-3"), width: "100%" }}>
					<div style={t("flex items-center justify-between gap-2")}>
						<div style={{ ...t("flex flex-col"), minWidth: 0, flexShrink: 1 }}>
							<Txt cls="text-xs font-medium text-foreground">{ZOTERO_LABEL[st().zotero]}</Txt>
							<Txt cls="text-xs text-muted-foreground truncate">{st().dataDir}</Txt>
						</div>
						<Button variant="outline" size="sm" icon="refresh-cw" disabled={sync.busy() || st().zotero === "missing"} onClick={() => void sync.syncNow()}>
							Sync now
						</Button>
					</div>

					<div style={t("flex flex-col gap-0.5")}>
						<Fact label="Last read from Zotero">{ago(st().lastPullAt)}</Fact>
						<Fact label="Last written to Zotero">{st().enabled ? ago(st().lastPushAt) : "writing is off"}</Fact>
						<Fact label="Waiting to write">
							{`${st().pending}${st().pending > 0 && st().zotero === "running" ? " (written once Zotero is closed)" : ""}${st().pending > 0 && !st().enabled ? " (writing is off)" : ""}`}
						</Fact>
					</div>

					<Show when={st().lastError || sync.error()}>
						<Note tone="error">
							<div style={t("flex items-start gap-2")}>
								<Icon name="circle-alert" size={14} color={tok("destructive")} style={{ marginTop: 2 }} />
								<div style={{ minWidth: 0, flexShrink: 1 }}><Txt cls="text-xs text-destructive">{sync.error() || st().lastError || ""}</Txt></div>
							</div>
						</Note>
					</Show>

					<div style={t("flex flex-col gap-2 rounded-md border border-border p-2")}>
						<div style={t("flex items-center justify-between gap-2")}>
							<div style={t("flex flex-col")}>
								<Txt cls="text-xs font-medium text-foreground">Write changes into Zotero</Txt>
								<Txt cls="text-xs text-muted-foreground">{st().enabled ? "On" : "Off: Zotero changes are still read in."}</Txt>
							</div>
							<Show
								when={st().enabled}
								fallback={<Button variant="outline" size="sm" disabled={sync.busy()} onClick={() => setConfirming(true)}>Turn on</Button>}
							>
								<Button variant="outline" size="sm" disabled={sync.busy()} onClick={() => void sync.setEnabled(false)}>Turn off</Button>
							</Show>
						</div>
						<Show when={confirming() && !st().enabled}>
							<Note tone="warn">
								<div style={t("flex items-start gap-2")}>
									<Icon name="triangle-alert" size={14} color={tok("warning-foreground")} style={{ marginTop: 2 }} />
									<div style={{ minWidth: 0, flexShrink: 1 }}>
										<NoteText tone="warn">
											This writes directly into Zotero's database (zotero.sqlite) and storage folder, only while Zotero is closed. A backup of zotero.sqlite is made before every write session (the last 5 are kept in zotero-next-backups). Make your own backup of the Zotero data folder first if you want extra safety.
										</NoteText>
									</div>
								</div>
								<div style={t("flex justify-end gap-2")}>
									<Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>Cancel</Button>
									<Button variant="primary" size="sm" disabled={sync.busy()} onClick={() => void sync.setEnabled(true).then(() => setConfirming(false))}>
										I have a backup, turn on
									</Button>
								</div>
							</Note>
						</Show>
						<Show when={st().enabled && st().lastBackup}>
							<Txt cls="text-xs text-muted-foreground truncate">{`Last backup: ${st().lastBackup}`}</Txt>
						</Show>
					</div>

					<Divider />
					<div style={t("flex flex-col gap-1.5")}>
						<div style={t("flex items-center justify-between")}>
							<Txt cls="text-xs font-medium text-foreground">{`Conflicts (${sync.conflicts().length})`}</Txt>
							<Show when={sync.conflicts().length > 0}>
								<Button variant="ghost" size="sm" onClick={() => void sync.dismiss()}>Dismiss all</Button>
							</Show>
						</div>
						<Show
							when={sync.conflicts().length > 0}
							fallback={
								<div style={t("flex items-center gap-1.5")}>
									<Icon name="check" size={14} color={tok("muted-foreground")} />
									<Txt cls="text-xs text-muted-foreground">Nothing changed on both sides.</Txt>
								</div>
							}
						>
							<div style={{ ...t("flex flex-col gap-2"), maxHeight: 260, overflowY: "scroll", scrollbarColor: tok("border") }}>
								<For each={sync.conflicts()}>{(c) => <ConflictCard c={c} />}</For>
							</div>
						</Show>
					</div>
				</div>
			)}
		</Show>
		</Show>
	);
}

const [open, setOpen] = createSignal(false);
/** Open or close the popover from code (scripts, a keyboard shortcut). */
export const setSyncPopoverOpen = setOpen;

export function SyncStatus(p: { onChanged?: () => void }): JSX.Element {
	const [hover, setHover] = createSignal(false);
	const [rect, setRect] = createSignal({ x: 0, y: 0, width: 0, height: 0 });
	onMount(() => sync.start(p.onChanged));
	createEffect(() => sync.watchConflicts(open()));
	const st = () => sync.status();
	const problem = () => syncOwner() === "self" && (!!st()?.lastError || st()?.zotero === "error");
	const label = () => (syncOwner() === "other" ? "Sync: Zinc" : syncOwner() === "off" ? "Sync off" : st() ? ZOTERO_LABEL[st()!.zotero] : "Zotero");
	return (
		<>
			<div
				onClick={() => setOpen(!open())}
				onMouseEnter={() => setHover(true)}
				onMouseLeave={() => setHover(false)}
				onLayout={(e: EventPayload) => setRect({ x: e.x ?? 0, y: e.y ?? 0, width: e.width ?? 0, height: e.height ?? 0 })}
				aria-label="Zotero sync status"
				style={{ ...t("flex h-7 items-center gap-1.5 rounded-md px-2 cursor-pointer"), ...(hover() || open() ? t("bg-foreground/5") : {}) }}
			>
				<Icon
					name={problem() ? "circle-alert" : "refresh-cw"}
					size={14}
					color={tok(problem() ? "destructive" : syncOwner() !== "self" || st()?.zotero === "missing" ? "muted-foreground" : "foreground")}
				/>
				<Txt cls="text-xs text-foreground" wrap={false}>{label()}</Txt>
				<Show when={(st()?.pending ?? 0) > 0}>
					<div style={t("flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary/20 px-1.5")}>
						<Txt cls="text-[11px] font-semibold text-primary" wrap={false}>{String(st()!.pending)}</Txt>
					</div>
				</Show>
				<Show when={(st()?.conflicts ?? 0) > 0}>
					<Icon name="triangle-alert" size={14} color={tok("warning-foreground")} />
				</Show>
			</div>
			<Popover open={open()} onClose={() => setOpen(false)} anchor={{ rect: rect(), align: "end" }} width={416}>
				<PopoverBody />
			</Popover>
		</>
	);
}

