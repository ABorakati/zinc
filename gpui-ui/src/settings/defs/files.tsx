// Files and folders: the library database, the Zotero data folder (with "find my Zotero"), the linked-attachment base directory and
// the attachment storage location. Server side: core/src/files/api.ts (/api/files/*). Folder dialogs are GPUIX's native
// promptForPaths (the core's own /pick-folder needs an app-supplied dialog the external core does not have).
import { createRoot, createSignal, For, Show, type JSX } from "solid-js";
import { Note, NoteText, Txt, t } from "../../shell/kit";
import { bytes, call, errMsg, plural } from "../../shell/net";
import { canPickFolder, pickFolder, revealInFolder } from "../../shell/native";
import { toast } from "../../ui";
import { Btn, Segmented, TextField, Toggle, Value } from "../controls";
import { onSettingsShown, registerSection, registerSettings } from "../registry";

registerSection({
	id: "files", label: "Files and folders", icon: "folder-open", order: 85,
	description: "Where the library, Zotero's data and the attachments live.",
	keywords: ["files and folders", "data directory", "storage", "linked files", "zotero folder", "database", "location"],
});

interface BaseInfo { mode: "zotero" | "custom" | "none"; configured: string | null; zotero: string | null; effective: string | null; stored: { absolute: number; relative: number } }
interface StorageInfo { dir: string | null; subfolder: string; linked: boolean; ownDir: string | null; patternHelp: string }
interface FilesView {
	library: { dbPath: string | null; configPath: string | null; sizeBytes: number | null };
	zotero: { dataDir: string; source: "environment" | "settings" | "zotero"; configured: string | null };
	baseDir: BaseInfo;
	storage: StorageInfo;
}
interface DataDirInfo {
	dir: string; hasDatabase: boolean; readable: boolean; sizeBytes: number | null; itemCount: number | null; attachmentCount: number | null;
	collectionCount: number | null; lastModified: string | null; hasStorageFolder: boolean; error?: string;
}
interface Candidate extends DataDirInfo { source: string; profile?: string }
interface Located { running: boolean; baseAttachmentPath: string | null; candidates: Candidate[]; recommended: string | null; installedExe: string | null }
interface ConvertPreview { count: number; outside: number; sample: { key: string; from: string; to: string }[] }
interface MovePreview {
	count: number; totalBytes: number; onlineOnly: number; sample: { key: string; from: string; to: string }[];
	skippedByReason: { reason: string; count: number }[];
}
interface MoveReport { moved: number; bytes: number; failed: { key: string; from: string; error: string }[]; leftBehind: { key: string; path: string }[]; onlineOnly: number; skipped: number }

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "unknown");
const fail = (what: string, e: unknown) => toast(what, { kind: "error", description: errMsg(e) });

/** "Zotero library: 12,419 items, last modified 30 Oct 2026, 11:15" or why it cannot be read. */
export function describeDataDir(i: DataDirInfo): string {
	if (!i.hasDatabase) return "No zotero.sqlite in this folder.";
	if (!i.readable) return `zotero.sqlite found (${bytes(i.sizeBytes)}, modified ${when(i.lastModified)}). ${i.error ?? ""}`.trim();
	return `Zotero library: ${plural(i.itemCount ?? 0, "item")}, last modified ${when(i.lastModified)}`;
}

const files = createRoot(() => {
	const [view, setView] = createSignal<FilesView | null>(null);
	const [error, setError] = createSignal("");
	const [busy, setBusy] = createSignal(false);
	const [convert, setConvert] = createSignal<ConvertPreview | null>(null);
	const refresh = async () => {
		try {
			setView(await call<FilesView>("GET", "/api/files/settings"));
			setError("");
			setConvert(await call<ConvertPreview>("POST", "/api/files/base-dir/convert", { direction: "relative" }).catch(() => null));
		} catch (e) { setError(errMsg(e)); }
	};
	/** Send a change; the server answers with the fresh settings view. */
	const send = async <T = FilesView,>(method: string, url: string, body: unknown, what: string): Promise<T | null> => {
		setBusy(true);
		try {
			const r = await call<T>(method, url, body);
			if ((r as unknown as FilesView)?.library) setView(r as unknown as FilesView);
			return r;
		} catch (e) { fail(what, e); return null; } finally { setBusy(false); }
	};
	return { view, error, busy, convert, refresh, send };
});
onSettingsShown(() => void files.refresh());

const gone = (): JSX.Element => <Value>{files.error() || "Loading…"}</Value>;
const Col = (p: { children: JSX.Element; gap?: number }): JSX.Element => <div style={{ ...t("flex flex-col"), gap: p.gap ?? 8, minWidth: 0, flexShrink: 1 }}>{p.children}</div>;
const Row = (p: { children: JSX.Element }): JSX.Element => <div style={t("flex flex-wrap items-center gap-2")}>{p.children}</div>;
/** A path or note on one line: when it does not fit, the start is cut (the end of a path is the informative part). */
const PathText = (p: { children: string; sub?: boolean }): JSX.Element => (
	<Txt
		cls={`text-xs ${p.sub ? "text-muted-foreground" : "text-foreground"}`}
		style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis-start", minWidth: 0, flexShrink: 1, maxWidth: "100%" }}
	>
		{p.children}
	</Txt>
);

/** Native folder dialog, then `then(path)` unless cancelled. */
async function pick(then: (path: string) => unknown): Promise<void> {
	if (!canPickFolder()) { toast("No folder dialog here", { kind: "info", description: "Type the folder path instead." }); return; }
	try { const p = await pickFolder(); if (p) await then(p); } catch (e) { fail("Could not open the folder dialog", e); }
}

// ---------------------------------------------------------------- library database (read-only)

function LibraryControl(): JSX.Element {
	return (
		<Show when={files.view()} fallback={gone()}>
			{(v) => (
				<div style={{ ...t("flex flex-col items-end gap-1"), maxWidth: 420 }}>
					<PathText>{v().library.dbPath ?? "In memory"}</PathText>
					<Show when={v().library.sizeBytes}><Value>{bytes(v().library.sizeBytes)}</Value></Show>
					<Btn disabled={!v().library.dbPath} onClick={() => revealInFolder(v().library.dbPath!)}>Show in folder</Btn>
				</div>
			)}
		</Show>
	);
}

// ---------------------------------------------------------------- Zotero data folder

const [located, setLocated] = createSignal<Located | null>(null);
const [checked, setChecked] = createSignal<DataDirInfo | null>(null);
const [finding, setFinding] = createSignal(false);

async function findZotero() {
	setFinding(true);
	try { setLocated(await call<Located>("GET", "/api/files/zotero")); } catch (e) { fail("Could not look for Zotero", e); } finally { setFinding(false); }
}
async function validate(dir: string) {
	try { setChecked(await call<DataDirInfo>("POST", "/api/files/zotero/validate", { dir })); } catch (e) { fail("Could not check that folder", e); }
}
async function useZotero(dir: string | null) {
	if (await files.send("PUT", "/api/files/zotero", { dir }, "Could not use that folder")) {
		toast(dir ? "Zotero data folder changed" : "Using the Zotero data folder Zotero itself uses", { kind: "success", description: "Sync now reads from it." });
		setChecked(null);
	}
}
const SOURCE: Record<string, string> = { environment: "set by ZN_ZOTERO_DIR", settings: "chosen here", zotero: "found from Zotero's settings" };

function ZoteroFolderControl(): JSX.Element {
	return (
		<Show when={files.view()} fallback={gone()}>
			{(v) => (
				<Col>
					<Col gap={2}>
						<PathText>{v().zotero.dataDir}</PathText>
						<PathText sub>{SOURCE[v().zotero.source] ?? ""}</PathText>
					</Col>
					<Row>
						<Btn disabled={finding()} onClick={() => void findZotero()}>{finding() ? "Looking…" : "Find Zotero"}</Btn>
						<Btn onClick={() => void pick(validate)}>Browse…</Btn>
						<Btn onClick={() => void validate(v().zotero.dataDir)}>Validate</Btn>
						<Btn onClick={() => revealInFolder(v().zotero.dataDir)}>Show in folder</Btn>
						<Show when={v().zotero.configured}><Btn disabled={files.busy()} onClick={() => void useZotero(null)}>Use automatic</Btn></Show>
					</Row>
					<TextField value="" width={380} placeholder="Paste a folder path, then press Enter" onCommit={(p) => p.trim() && void validate(p.trim())} />
					<Show when={checked()}>
						{(c) => (
							<Note tone={c().readable ? "ok" : "warn"}>
								<Txt cls="text-xs font-medium text-foreground">{c().dir}</Txt>
								<NoteText tone={c().readable ? "ok" : "warn"}>{describeDataDir(c())}</NoteText>
								<Show when={c().readable}>
									<NoteText>{`${plural(c().attachmentCount ?? 0, "attachment")}, ${plural(c().collectionCount ?? 0, "collection")}, ${bytes(c().sizeBytes)}${c().hasStorageFolder ? ", has a storage folder" : ", no storage folder"}`}</NoteText>
								</Show>
								<Row>
									<Btn primary disabled={!c().hasDatabase || files.busy()} onClick={() => void useZotero(c().dir)}>Use this folder</Btn>
									<Btn onClick={() => setChecked(null)}>Dismiss</Btn>
								</Row>
							</Note>
						)}
					</Show>
					<Show when={located()}>
						{(l) => (
							<Col gap={6}>
								<Txt cls="text-xs text-muted-foreground">
									{`${l().running ? "Zotero is running right now. " : "Zotero is not running. "}${l().installedExe ? `Installed at ${l().installedExe}. ` : ""}${l().baseAttachmentPath ? `Its linked-file base directory is ${l().baseAttachmentPath}.` : "It has no linked-file base directory set."}`}
								</Txt>
								<Show when={l().candidates.length} fallback={<Note tone="warn"><NoteText tone="warn">No Zotero data folder was found in the usual places. Use Browse… to pick one.</NoteText></Note>}>
									<For each={l().candidates}>
										{(c) => (
											<div style={{ ...t("flex items-start justify-between gap-3 rounded-md border p-2"), maxWidth: 560 }}>
												<Col gap={2}>
													<Txt cls="text-xs font-medium text-foreground">{`${c.dir}${c.dir === l().recommended ? " (the one Zotero uses)" : ""}`}</Txt>
													<PathText sub>{describeDataDir(c)}</PathText>
												</Col>
												<Btn primary={c.dir === l().recommended} disabled={!c.hasDatabase || c.dir === v().zotero.dataDir || files.busy()} onClick={() => void useZotero(c.dir)}>
													{c.dir === v().zotero.dataDir ? "In use" : "Use"}
												</Btn>
											</div>
										)}
									</For>
								</Show>
							</Col>
						)}
					</Show>
				</Col>
			)}
		</Show>
	);
}

// ---------------------------------------------------------------- linked attachment base directory

const [confirmConvert, setConfirmConvert] = createSignal<"relative" | "absolute" | null>(null);
const [absPreview, setAbsPreview] = createSignal<ConvertPreview | null>(null);

async function startConvert(direction: "relative" | "absolute") {
	if (direction === "absolute") {
		try { setAbsPreview(await call<ConvertPreview>("POST", "/api/files/base-dir/convert", { direction })); } catch (e) { fail("Could not preview", e); return; }
	}
	setConfirmConvert(direction);
}
async function doConvert(direction: "relative" | "absolute") {
	const r = await files.send<{ converted: number } & FilesView>("POST", "/api/files/base-dir/convert", { direction, confirm: true }, "Could not convert the paths");
	if (r) {
		toast(`${plural(r.converted, "path")} converted`, { kind: "success", description: direction === "relative" ? "Linked files now store a path relative to the base directory." : "Linked files now store their full path." });
		setConfirmConvert(null);
		void files.refresh();
	}
}
const setBase = async (mode: BaseInfo["mode"], path?: string) => {
	if (await files.send("PUT", "/api/files/base-dir", { mode, path }, "Could not change the base directory")) void files.refresh();
};

const Sample = (p: { list: { from: string; to: string }[] }): JSX.Element => (
	<For each={p.list.slice(0, 3)}>{(s) => <NoteText mono>{`${s.from} → ${s.to}`}</NoteText>}</For>
);

function BaseDirControl(): JSX.Element {
	return (
		<Show when={files.view()} fallback={gone()}>
			{(v) => {
				const b = () => v().baseDir;
				const rel = () => files.convert();
				return (
					<Col>
						<Segmented<BaseInfo["mode"]>
							value={b().mode}
							onChange={(m) => (m === "custom" ? void pick((p) => setBase("custom", p)) : void setBase(m))}
							options={[{ value: "zotero", label: "Zotero's setting" }, { value: "custom", label: "Choose folder…" }, { value: "none", label: "None" }]}
						/>
						<Row>
							<PathText>{b().effective ?? "No base directory: linked files keep their full path."}</PathText>
							<Show when={b().effective}><Btn onClick={() => revealInFolder(b().effective!)}>Show in folder</Btn></Show>
						</Row>
						<Show when={b().mode === "custom"}>
							<TextField value={b().configured ?? ""} width={380} onCommit={(p) => p.trim() && void setBase("custom", p.trim())} />
						</Show>
						<Show when={b().mode === "zotero" && !b().zotero}>
							<Note tone="warn"><NoteText tone="warn">Zotero has no base directory set, so nothing is stored relative. Choose a folder or set one in Zotero.</NoteText></Note>
						</Show>
						<Show when={b().effective && (rel()?.count ?? 0) > 0 && confirmConvert() !== "relative"}>
							<Note>
								<NoteText>{`${plural(rel()!.count, "linked file")} inside this folder store their full path. Stored relative to the folder (Zotero's own form), they survive moving the folder: change the base directory here afterwards and they are found again.`}</NoteText>
								<Row><Btn onClick={() => void startConvert("relative")}>{`Convert ${rel()!.count.toLocaleString()} to relative…`}</Btn></Row>
							</Note>
						</Show>
						<Show when={confirmConvert() === "relative" && rel()}>
							{(p) => (
								<Note tone="warn">
									<NoteText tone="warn">{`Rewrite ${plural(p().count, "path")} as relative to ${b().effective}. Only zotero-next's database changes; no file is touched. ${p().outside ? `${plural(p().outside, "linked file")} outside the folder stay as they are.` : ""}`}</NoteText>
									<Sample list={p().sample} />
									<Row><Btn onClick={() => setConfirmConvert(null)}>Cancel</Btn><Btn primary disabled={files.busy()} onClick={() => void doConvert("relative")}>{`Convert ${p().count.toLocaleString()} paths`}</Btn></Row>
								</Note>
							)}
						</Show>
						<Show when={b().stored.relative > 0 && confirmConvert() !== "absolute"}>
							<Note>
								<NoteText>{`${plural(b().stored.relative, "linked file")} are stored relative to the base directory.`}</NoteText>
								<Row><Btn onClick={() => void startConvert("absolute")}>Convert to full paths…</Btn></Row>
							</Note>
						</Show>
						<Show when={confirmConvert() === "absolute" && absPreview()}>
							{(p) => (
								<Note tone="warn">
									<NoteText tone="warn">{`Rewrite ${plural(p().count, "path")} as full paths. No file is touched.`}</NoteText>
									<Sample list={p().sample} />
									<Row><Btn onClick={() => setConfirmConvert(null)}>Cancel</Btn><Btn primary disabled={files.busy()} onClick={() => void doConvert("absolute")}>{`Convert ${p().count.toLocaleString()} paths`}</Btn></Row>
								</Note>
							)}
						</Show>
					</Col>
				);
			}}
		</Show>
	);
}

// ---------------------------------------------------------------- attachment storage location

const [movePreview, setMovePreview] = createSignal<MovePreview | null>(null);
const [moveReport, setMoveReport] = createSignal<MoveReport | null>(null);
const [moving, setMoving] = createSignal(false);

const putStorage = (patch: Partial<Pick<StorageInfo, "subfolder" | "linked">> & { dir?: string | null }) =>
	files.send("PUT", "/api/files/storage", patch, "Could not change the storage location");

async function previewMove() {
	setMoveReport(null);
	setMoving(true);
	try { setMovePreview(await call<MovePreview>("POST", "/api/files/storage/move", {})); } catch (e) { fail("Could not preview the move", e); } finally { setMoving(false); }
}
async function runMoveNow() {
	setMoving(true);
	try {
		const r = await call<MoveReport>("POST", "/api/files/storage/move", { confirm: true });
		setMoveReport(r);
		setMovePreview(null);
		toast(`${plural(r.moved, "file")} moved`, { kind: "success", description: r.failed.length ? `${r.failed.length} failed and were left where they were.` : undefined });
	} catch (e) { fail("The move stopped", e); } finally { setMoving(false); }
}

function StorageControl(): JSX.Element {
	return (
		<Show when={files.view()} fallback={gone()}>
			{(v) => {
				const s = () => v().storage;
				return (
					<Col>
						<Segmented<"own" | "custom">
							value={s().dir ? "custom" : "own"}
							onChange={(m) => (m === "own" ? void putStorage({ dir: null }) : void pick((p) => putStorage({ dir: p })))}
							options={[{ value: "own", label: "zotero-next's folder" }, { value: "custom", label: "Choose folder…" }]}
						/>
						<Row>
							<PathText>{s().dir ?? s().ownDir ?? "In memory"}</PathText>
							<Show when={s().dir ?? s().ownDir}><Btn onClick={() => revealInFolder((s().dir ?? s().ownDir)!)}>Show in folder</Btn></Show>
						</Row>
						<Show when={s().dir}>
							<TextField value={s().dir ?? ""} width={380} onCommit={(p) => p.trim() && void putStorage({ dir: p.trim() })} />
							<Col gap={4}>
								<TextField value={s().subfolder} width={260} placeholder="Subfolder pattern, e.g. {%a}/{%y}" onCommit={(subfolder) => void putStorage({ subfolder })} />
								<PathText sub>{`Subfolder inside the storage folder. ${s().patternHelp}. Empty: no subfolders.`}</PathText>
							</Col>
							<Row>
								<Toggle checked={s().linked} onChange={(linked) => void putStorage({ linked })} />
								<PathText sub>{s().linked ? "New files are linked files in this folder (like ZotMoov)." : "New files are imported files kept in this folder."}</PathText>
							</Row>
							<Row><Btn disabled={moving()} onClick={() => void previewMove()}>{moving() ? "Working…" : "Move existing attachments to this folder…"}</Btn></Row>
						</Show>
						<Show when={movePreview()}>
							{(p) => (
								<Note tone="warn">
									<Show when={p().count > 0} fallback={<NoteText tone="warn">Nothing to move: every attachment is already in place or cannot be moved.</NoteText>}>
										<NoteText tone="warn">{`${plural(p().count, "file")} (${bytes(p().totalBytes)}) would be moved. Each file is copied, checked against the original, recorded in the database, and only then removed from its old place.`}</NoteText>
										<Sample list={p().sample} />
										<Show when={p().count > p().sample.length}><NoteText>{`… and ${(p().count - p().sample.length).toLocaleString()} more.`}</NoteText></Show>
									</Show>
									<Show when={p().onlineOnly > 0}><NoteText>{`${plural(p().onlineOnly, "online-only OneDrive file")} will be skipped (not downloaded).`}</NoteText></Show>
									<For each={p().skippedByReason}>{(r) => <NoteText>{`Skipped: ${plural(r.count, "file")}, ${r.reason}.`}</NoteText>}</For>
									<Row>
										<Btn onClick={() => setMovePreview(null)}>Cancel</Btn>
										<Show when={p().count > 0}><Btn primary disabled={moving()} onClick={() => void runMoveNow()}>{moving() ? "Moving…" : `Move ${p().count.toLocaleString()} files`}</Btn></Show>
									</Row>
								</Note>
							)}
						</Show>
						<Show when={moveReport()}>
							{(r) => (
								<Note tone={r().failed.length ? "warn" : "ok"}>
									<NoteText>{`Moved ${plural(r().moved, "file")} (${bytes(r().bytes)}). ${r().onlineOnly ? `${plural(r().onlineOnly, "online-only file")} skipped. ` : ""}${r().skipped ? `${plural(r().skipped, "file")} skipped in total. ` : ""}`}</NoteText>
									<For each={r().failed.slice(0, 5)}>{(f) => <NoteText>{`Left in place: ${f.from} (${f.error})`}</NoteText>}</For>
									<Show when={r().leftBehind.length}><NoteText>{`${plural(r().leftBehind.length, "original")} could not be deleted after copying; they are harmless duplicates.`}</NoteText></Show>
									<Row><Btn onClick={() => setMoveReport(null)}>Dismiss</Btn></Row>
								</Note>
							)}
						</Show>
					</Col>
				);
			}}
		</Show>
	);
}

registerSettings([
	{
		id: "files.library", section: "files", label: "zotero-next library",
		description: "The database file this library is kept in.",
		keywords: ["database", "sqlite", "library.sqlite", "location", "path", "show in folder", "explorer"],
		control: () => <LibraryControl />,
	},
	{
		id: "files.zoteroDir", section: "files", label: "Zotero data folder", layout: "block",
		description: "The Zotero library zotero-next syncs with and imports from. Find Zotero looks for it in Zotero's settings and the usual places.",
		keywords: ["find zotero", "locate", "existing library", "zotero.sqlite", "database", "profile", "data directory", "browse", "validate", "import"],
		control: () => <ZoteroFolderControl />,
	},
	{
		id: "files.baseDir", section: "files", label: "Linked attachment base directory", layout: "block",
		description: "Store linked file paths relative to a folder so they survive a move.",
		keywords: ["linked files", "relative path", "attachments", "base path", "onedrive"],
		control: () => <BaseDirControl />,
	},
	{
		id: "files.storageDir", section: "files", label: "Attachment storage location", layout: "block",
		description: "Where imported files are kept, in a folder of your choice, optionally sorted into subfolders and stored as linked files.",
		keywords: ["data directory", "storage folder", "move", "zotmoov", "subfolder", "pattern", "author", "year", "linked files", "move attachments"],
		control: () => <StorageControl />,
	},
	{ id: "files.feedsUpdate", section: "files", group: "Feeds", label: "Update feeds automatically", keywords: ["rss", "atom", "subscriptions"], unavailable: true },
]);
