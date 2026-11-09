// Settings > Sync, zotero.org part: source choice, API key, push and file options, status and the online-only files check.
// State and calls live in features/websync/client.ts.
import { createSignal, For, Show, type JSX } from "solid-js";
import { ago, bytes, plural } from "../../shell/net";
import { Note, NoteText, Txt, t } from "../../shell/kit";
import { webSync, type WebSyncFiles, type WebSyncMode } from "../../features/websync/client";
import { TextInput } from "../../ui";
import { confirm } from "../../ui/dialogs";
import { Btn, Choice, Toggle, Value } from "../controls";

const KEYS_URL = "https://www.zotero.org/settings/keys";

const SOURCES: { value: WebSyncMode; label: string }[] = [
	{ value: "zotero-local", label: "Local Zotero" },
	{ value: "zotero-org", label: "zotero.org" },
	{ value: "off", label: "Off" },
];
const FILES: { value: WebSyncFiles; label: string }[] = [
	{ value: "off", label: "Don't sync files" },
	{ value: "download", label: "Download only" },
	{ value: "sync", label: "Download and upload" },
];

const loading = (): JSX.Element => <Value>{webSync.reachable() ? "Loading…" : "Sync is not available."}</Value>;

/** Action error (key rejected, request failed), shown under the control it belongs to. */
const ErrorLine = (): JSX.Element => (
	<Show when={webSync.error()}>
		<Txt cls="text-xs text-destructive">{webSync.error()}</Txt>
	</Show>
);

export function SourceControl(): JSX.Element {
	return (
		<Show when={webSync.status()} fallback={loading()}>
			{(s) => (
				<div style={{ ...t("flex flex-col items-end gap-1"), maxWidth: 380 }}>
					<Choice<WebSyncMode> value={s().mode} options={SOURCES} width={170} onChange={(m) => void webSync.setMode(m)} />
					<Show when={s().mode === "zotero-org" && !s().account.keySet}>
						<Txt cls="text-xs text-muted-foreground" style={{ textAlign: "right" }}>Add an API key below to start.</Txt>
					</Show>
				</div>
			)}
		</Show>
	);
}

/**
 * The API key field. The text is masked while typing and cleared once sent: the key is never shown again (the core does not
 * return it either). The masking diffs the new field value against the dots shown to find what was typed or pasted.
 */
function SecretField(p: { value: string; onInput: (v: string) => void; onEnter: () => void; placeholder?: string; width: number }): JSX.Element {
	const DOT = "•";
	const onInput = (v: string) => {
		const shown = DOT.repeat(p.value.length);
		let pre = 0;
		while (pre < shown.length && pre < v.length && v[pre] === shown[pre]) pre++;
		let suf = 0;
		while (suf < shown.length - pre && suf < v.length - pre && v[v.length - 1 - suf] === shown[shown.length - 1 - suf]) suf++;
		const inserted = v.slice(pre, v.length - suf);
		p.onInput(p.value.slice(0, pre) + inserted + p.value.slice(p.value.length - suf));
	};
	return <TextInput value={DOT.repeat(p.value.length)} onInput={onInput} onEnter={p.onEnter} placeholder={p.placeholder} style={{ width: p.width }} />;
}

export function AccountControl(): JSX.Element {
	const [draft, setDraft] = createSignal("");
	const connect = async () => {
		const k = draft().trim();
		if (!k) return;
		if (await webSync.setKey(k)) setDraft("");
	};
	// the key belongs to another zotero.org account: unlinking the old one is a deliberate step
	const switchAccount = async () => {
		const k = draft().trim();
		if (!k) return;
		const ok = await confirm({
			title: "Switch to another zotero.org account?",
			body: "This library will stop syncing with the account it is linked to and start fresh with the new one. Nothing in the library is deleted, but changes not yet sent to the old account will be sent to the new account as new items.",
			confirmLabel: "Switch account",
			danger: true,
		});
		if (ok && (await webSync.switchAccount(k))) setDraft("");
	};
	return (
		<Show when={webSync.status()} fallback={loading()}>
			{(s) => (
				<div style={{ ...t("flex flex-col gap-2"), width: "100%" }}>
					<Show when={s().account.keySet}>
						<div style={t("flex items-center gap-3")}>
							<Txt cls="text-xs text-foreground">
								{`Connected as ${s().account.username ?? "unknown user"}${s().account.userId !== undefined ? ` (user ${s().account.userId})` : ""}`}
							</Txt>
							<Btn disabled={webSync.working()} onClick={() => void webSync.removeKey()}>Remove key</Btn>
						</div>
						<Show when={s().account.canWrite === false}>
							<Txt cls="text-xs text-muted-foreground">This key can only read the library; sending changes needs write access.</Txt>
						</Show>
						<Show when={s().account.filesAccess === false}>
							<Txt cls="text-xs text-muted-foreground">This key has no file access; attachment files cannot be synced.</Txt>
						</Show>
					</Show>
					<div style={t("flex items-center gap-2")}>
						<SecretField
							value={draft()}
							onInput={setDraft}
							onEnter={() => void connect()}
							placeholder={s().account.keySet ? "Paste a different API key" : "Paste your zotero.org API key"}
							width={300}
						/>
						<Btn primary disabled={webSync.working() || !draft().trim()} onClick={() => void connect()}>{s().account.keySet ? "Replace key" : "Connect"}</Btn>
					</div>
					<ErrorLine />
					<Show when={webSync.otherAccount() && draft().trim()}>
						<div style={t("flex items-center gap-2")}>
							<Btn disabled={webSync.working()} onClick={() => void switchAccount()}>Switch to this account…</Btn>
						</div>
					</Show>
					<Txt cls="text-xs text-muted-foreground">{`Create a key at ${KEYS_URL} with library read/write access and file access.`}</Txt>
				</div>
			)}
		</Show>
	);
}

export function PushControl(): JSX.Element {
	return (
		<Show when={webSync.status()} fallback={loading()}>
			{(s) => (
				<div style={t("flex items-center gap-3")}>
					<Toggle checked={s().push} onChange={(on) => void webSync.setOptions({ push: on })} />
					<Value>{s().push ? "On" : "Off"}</Value>
				</div>
			)}
		</Show>
	);
}

export function FilesControl(): JSX.Element {
	return (
		<Show when={webSync.status()} fallback={loading()}>
			{(s) => <Choice<WebSyncFiles> value={s().files} options={FILES} width={190} onChange={(f) => void webSync.setOptions({ files: f })} />}
		</Show>
	);
}

/** The account's group libraries: name, whether this user may edit it, what waits to be sent, and the group's own error. */
export function GroupsControl(): JSX.Element {
	return (
		<Show when={webSync.status()} fallback={loading()}>
			{(s) => (
				<Show when={s().groups?.length} fallback={<Value>{s().account.keySet ? "This account has no group libraries." : "Connect a zotero.org account to see its groups."}</Value>}>
					<div style={{ ...t("flex flex-col gap-1.5"), width: "100%" }}>
						<For each={s().groups}>
							{(g) => (
								<div style={t("flex flex-col")}>
									<Txt cls="text-xs text-foreground">
										{`${g.name}: ${g.editable ? "you can edit" : "read-only"}${g.editable && !g.filesEditable ? ", files read-only" : ""}; ${
											g.pending ? `${plural(g.pending, "change")} waiting to send` : "nothing waiting to send"
										}${g.lastPullAt ? `; last sync ${ago(g.lastPullAt)}` : "; not synced yet"}`}
									</Txt>
									<Show when={g.lastError}>
										<Txt cls="text-xs text-destructive">{g.lastError ?? ""}</Txt>
									</Show>
								</div>
							)}
						</For>
					</div>
				</Show>
			)}
		</Show>
	);
}

const clock = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function OrgStatusControl(): JSX.Element {
	return (
		<Show when={webSync.status()} fallback={loading()}>
			{(s) => {
				const waiting = () => (s().backoffUntil ? Date.parse(s().backoffUntil!) > Date.now() : false);
				return (
					<div style={{ ...t("flex flex-col items-end gap-1"), maxWidth: 380 }}>
						<Txt cls="text-xs text-muted-foreground" style={{ textAlign: "right" }}>
							{`${s().mode === "zotero-org" ? "" : "Not running. "}Last sync ${ago(s().lastPullAt)}; ${s().pending ? `${plural(s().pending, "change")} waiting to send` : "nothing waiting to send"}; ${plural(s().conflicts, "conflict")}`}
						</Txt>
						<Show when={waiting()}>
							<Txt cls="text-xs text-muted-foreground" style={{ textAlign: "right" }}>{`zotero.org asked us to wait; resuming at ${clock(s().backoffUntil!)}.`}</Txt>
						</Show>
						<Show when={s().lastError}><Txt cls="text-xs text-destructive" style={{ textAlign: "right" }}>{s().lastError ?? ""}</Txt></Show>
						<Btn icon="refresh-cw" disabled={webSync.working() || s().busy || s().mode !== "zotero-org" || !s().account.keySet} onClick={() => void webSync.syncNow()}>
							{s().busy ? "Syncing…" : "Sync now"}
						</Btn>
					</div>
				);
			}}
		</Show>
	);
}

export function FileCheckControl(): JSX.Element {
	return (
		<Show when={webSync.status()} fallback={loading()}>
			{(s) => {
				const job = () => s().fileJob;
				const jobBusy = () => !!job()?.running;
				return (
					<div style={{ ...t("flex flex-col gap-2"), width: "100%" }}>
						<div style={t("flex items-center gap-2")}>
							<Btn disabled={webSync.working() || jobBusy() || !s().account.keySet} onClick={() => void webSync.checkFiles()}>Check online-only files</Btn>
							<Show when={(webSync.check()?.missingLocally ?? 0) > 0}>
								<Btn primary disabled={webSync.working() || jobBusy()} onClick={() => void webSync.downloadMissing()}>Download missing files</Btn>
							</Show>
						</div>
						<Show when={!s().account.keySet}><Value>Connect an API key first.</Value></Show>
						<Show when={webSync.check()}>
							{(c) => (
								<Note>
									<NoteText>{`${plural(c().imported, "imported attachment")}; ${c().missingLocally} without a local file.`}</NoteText>
									<Show when={c().missingLocally > 0}>
										<NoteText>
											{`Of those: ${c().onServer} on zotero.org, ${c().notOnServer} not on zotero.org${c().unknown ? `, ${c().unknown} unknown` : ""}.`}
										</NoteText>
										<For each={c().sample.slice(0, 5)}>
											{(x) => <Txt cls="text-xs text-muted-foreground" wrap={false}>{`${x.onServer === null ? "?" : x.onServer ? "online" : "missing"}  ${x.title || x.key}`}</Txt>}
										</For>
									</Show>
								</Note>
							)}
						</Show>
						<Show when={job()}>
							{(j) => (
								<Txt cls="text-xs text-muted-foreground">
									{`${j().running ? "Downloading" : "Downloaded"} ${j().done.toLocaleString()} of ${j().total.toLocaleString()} files (${bytes(j().bytes) || "0 B"})${j().failed ? `, ${j().failed} failed` : ""}${j().running ? "…" : "."}`}
								</Txt>
							)}
						</Show>
					</div>
				);
			}}
		</Show>
	);
}
