// Settings > Advanced > Files and Folders: library location, the Zotero data folder (with "find my Zotero"),
// the linked-attachment base directory and the attachment storage location. Server side: core/src/files/api.ts.
import { createRoot, createSignal, For, Show, type JSX } from "solid-js";
import { toast } from "solid-sonner";
import { Button } from "~/components/ui/button";
import { fail } from "~/lib/actions";
import { Segmented, Switch, TextField, Value } from "./controls";
import { call, onSettingsShown } from "./net";

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

const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;
export function bytes(n: number | null | undefined): string {
	if (n == null) return "";
	if (n < 1024) return `${n} B`;
	const u = ["KB", "MB", "GB", "TB"];
	let v = n / 1024, i = 0;
	while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
	return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "unknown");
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
		} catch (e) { setError(msg(e)); }
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

const gone = () => <Value>{files.error() || "Loading…"}</Value>;
const Note = (p: { children: JSX.Element; tone?: "warn" | "ok" }) => (
	<div class={`max-w-xl rounded-md p-2.5 text-xs ${p.tone === "warn" ? "bg-amber-500/10 text-amber-800 dark:text-amber-300" : "bg-muted/60 text-muted-foreground"}`}>{p.children}</div>
);
const Btn = (p: { children: JSX.Element; onClick: () => void; disabled?: boolean; primary?: boolean }) => (
	<Button variant={p.primary ? "default" : "outline"} size="sm" class="h-7 px-2 text-xs" disabled={p.disabled} onClick={p.onClick}>{p.children}</Button>
);

async function browse(start?: string | null): Promise<string | null> {
	try {
		return (await call<{ path: string | null }>("POST", "/api/files/pick-folder", { start: start ?? undefined })).path;
	} catch (e) { toast.error("Could not open the folder dialog", { description: msg(e) }); return null; }
}
/** Native folder dialog, then `then(path)` unless cancelled. */
const pick = (start: string | null | undefined, then: (path: string) => unknown): void => void browse(start).then((p) => { if (p) void then(p); });
const reveal = (what: "library" | "zotero" | "baseDir" | "storage") =>
	void call("POST", "/api/files/reveal", { what }).catch((e) => toast.error("Could not show the folder", { description: msg(e) }));

// ---------------------------------------------------------------- library database (read-only)

export const LibraryControl = () => (
	<Show when={files.view()} fallback={gone()}>
		{(v) => (
			<div class="flex flex-col items-end gap-1">
				<Value title={v().library.dbPath ?? ""}>{v().library.dbPath ?? "In memory"}</Value>
				<Show when={v().library.sizeBytes}><Value>{bytes(v().library.sizeBytes)}</Value></Show>
				<Btn disabled={!v().library.dbPath} onClick={() => reveal("library")}>Show in folder</Btn>
			</div>
		)}
	</Show>
);

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
		toast.success(dir ? "Zotero data folder changed" : "Using the Zotero data folder Zotero itself uses", { description: "Sync now reads from it." });
		setChecked(null);
	}
}
const SOURCE: Record<string, string> = { environment: "set by ZN_ZOTERO_DIR", settings: "chosen here", zotero: "found from Zotero's settings" };

export const ZoteroFolderControl = () => (
	<Show when={files.view()} fallback={gone()}>
		{(v) => (
			<div class="space-y-2">
				<div class="flex flex-col gap-1">
					<span class="break-all text-xs" title={v().zotero.dataDir}>{v().zotero.dataDir}</span>
					<span class="text-xs text-muted-foreground">{SOURCE[v().zotero.source]}</span>
				</div>
				<div class="flex flex-wrap items-center gap-2">
					<Btn disabled={finding()} onClick={() => void findZotero()}>{finding() ? "Looking…" : "Find Zotero"}</Btn>
					<Btn onClick={() => pick(v().zotero.dataDir, validate)}>Browse…</Btn>
					<Btn onClick={() => void validate(v().zotero.dataDir)}>Validate</Btn>
					<Btn onClick={() => reveal("zotero")}>Show in folder</Btn>
					<Show when={v().zotero.configured}><Btn disabled={files.busy()} onClick={() => void useZotero(null)}>Use automatic</Btn></Show>
				</div>
				<div class="flex items-center gap-2">
					<TextField label="Zotero data folder path" placeholder="Paste a folder path, then press Enter" class="w-96" value="" onCommit={(p) => p.trim() && void validate(p.trim())} />
				</div>
				<Show when={checked()}>
					{(c) => (
						<Note tone={c().readable ? "ok" : "warn"}>
							<div class="break-all font-medium">{c().dir}</div>
							<div>{describeDataDir(c())}</div>
							<Show when={c().readable}><div>{plural(c().attachmentCount ?? 0, "attachment")}, {plural(c().collectionCount ?? 0, "collection")}, {bytes(c().sizeBytes)}{c().hasStorageFolder ? ", has a storage folder" : ", no storage folder"}</div></Show>
							<div class="mt-1.5 flex gap-2">
								<Btn primary disabled={!c().hasDatabase || files.busy()} onClick={() => void useZotero(c().dir)}>Use this folder</Btn>
								<Btn onClick={() => setChecked(null)}>Dismiss</Btn>
							</div>
						</Note>
					)}
				</Show>
				<Show when={located()}>
					{(l) => (
						<div class="max-w-xl space-y-1.5">
							<span class="block text-xs text-muted-foreground">
								{l().running ? "Zotero is running right now. " : "Zotero is not running. "}
								{l().installedExe ? `Installed at ${l().installedExe}. ` : ""}
								{l().baseAttachmentPath ? `Its linked-file base directory is ${l().baseAttachmentPath}.` : "It has no linked-file base directory set."}
							</span>
							<Show when={l().candidates.length} fallback={<Note tone="warn">No Zotero data folder was found in the usual places. Use Browse… to pick one.</Note>}>
								<For each={l().candidates}>{(c) => (
									<div class="flex items-start justify-between gap-3 rounded-md border p-2 text-xs">
										<div class="min-w-0">
											<div class="break-all font-medium">{c.dir}{c.dir === l().recommended ? " (the one Zotero uses)" : ""}</div>
											<div class="text-muted-foreground">{describeDataDir(c)}</div>
										</div>
										<Btn primary={c.dir === l().recommended} disabled={!c.hasDatabase || c.dir === v().zotero.dataDir || files.busy()} onClick={() => void useZotero(c.dir)}>
											{c.dir === v().zotero.dataDir ? "In use" : "Use"}
										</Btn>
									</div>
								)}</For>
							</Show>
						</div>
					)}
				</Show>
			</div>
		)}
	</Show>
);

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
		toast.success(`${plural(r.converted, "path")} converted`, { description: direction === "relative" ? "Linked files now store a path relative to the base directory." : "Linked files now store their full path." });
		setConfirmConvert(null);
		void files.refresh();
	}
}
const setBase = async (mode: BaseInfo["mode"], path?: string) => {
	if (await files.send("PUT", "/api/files/base-dir", { mode, path }, "Could not change the base directory")) void files.refresh();
};

export const BaseDirControl = () => (
	<Show when={files.view()} fallback={gone()}>
		{(v) => {
			const b = () => v().baseDir;
			const rel = () => files.convert();
			return (
				<div class="space-y-2">
					<Segmented<BaseInfo["mode"]> label="Base directory source" value={b().mode} onChange={(m) => (m === "custom" ? pick(b().configured ?? b().zotero, (p) => setBase("custom", p)) : void setBase(m))}
						options={[{ value: "zotero", label: "Zotero's setting", hint: "Follow Zotero's own base directory" }, { value: "custom", label: "Choose folder…" }, { value: "none", label: "None" }]} />
					<div class="flex items-center gap-2">
						<span class="break-all text-xs" title={b().effective ?? ""}>{b().effective ?? "No base directory: linked files keep their full path."}</span>
						<Show when={b().effective}><Btn onClick={() => reveal("baseDir")}>Show in folder</Btn></Show>
					</div>
					<Show when={b().mode === "custom"}>
						<TextField label="Base directory path" class="w-96" value={b().configured ?? ""} onCommit={(p) => p.trim() && void setBase("custom", p.trim())} />
					</Show>
					<Show when={b().mode === "zotero" && !b().zotero}><Note tone="warn">Zotero has no base directory set, so nothing is stored relative. Choose a folder or set one in Zotero.</Note></Show>
					<Show when={b().effective && (rel()?.count ?? 0) > 0 && confirmConvert() !== "relative"}>
						<Note>
							{plural(rel()!.count, "linked file")} inside this folder store their full path. Stored relative to the folder (Zotero's own form), they survive moving the folder: change the base directory here afterwards and they are found again.
							<div class="mt-1.5"><Btn onClick={() => void startConvert("relative")}>Convert {rel()!.count.toLocaleString()} to relative…</Btn></div>
						</Note>
					</Show>
					<Show when={confirmConvert() === "relative" && rel()}>
						{(p) => (
							<Note tone="warn">
								<div>Rewrite {plural(p().count, "path")} as relative to {b().effective}. Only zotero-next's database changes; no file is touched. {p().outside ? `${plural(p().outside, "linked file")} outside the folder stay as they are.` : ""}</div>
								<For each={p().sample.slice(0, 3)}>{(s) => <div class="break-all font-mono text-[11px]">{s.from} → {s.to}</div>}</For>
								<div class="mt-1.5 flex gap-2"><Btn onClick={() => setConfirmConvert(null)}>Cancel</Btn><Btn primary disabled={files.busy()} onClick={() => void doConvert("relative")}>Convert {p().count.toLocaleString()} paths</Btn></div>
							</Note>
						)}
					</Show>
					<Show when={b().stored.relative > 0 && confirmConvert() !== "absolute"}>
						<Note>
							{plural(b().stored.relative, "linked file")} are stored relative to the base directory.
							<div class="mt-1.5"><Btn onClick={() => void startConvert("absolute")}>Convert to full paths…</Btn></div>
						</Note>
					</Show>
					<Show when={confirmConvert() === "absolute" && absPreview()}>
						{(p) => (
							<Note tone="warn">
								<div>Rewrite {plural(p().count, "path")} as full paths. No file is touched.</div>
								<For each={p().sample.slice(0, 3)}>{(s) => <div class="break-all font-mono text-[11px]">{s.from} → {s.to}</div>}</For>
								<div class="mt-1.5 flex gap-2"><Btn onClick={() => setConfirmConvert(null)}>Cancel</Btn><Btn primary disabled={files.busy()} onClick={() => void doConvert("absolute")}>Convert {p().count.toLocaleString()} paths</Btn></div>
							</Note>
						)}
					</Show>
				</div>
			);
		}}
	</Show>
);

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
		toast.success(`${plural(r.moved, "file")} moved`, { description: r.failed.length ? `${r.failed.length} failed and were left where they were.` : undefined });
	} catch (e) { fail("The move stopped", e); } finally { setMoving(false); }
}

export const StorageControl = () => (
	<Show when={files.view()} fallback={gone()}>
		{(v) => {
			const s = () => v().storage;
			return (
				<div class="space-y-2">
					<Segmented<"own" | "custom"> label="Attachment storage" value={s().dir ? "custom" : "own"}
						onChange={(m) => (m === "own" ? void putStorage({ dir: null }) : pick(s().dir ?? s().ownDir, (p) => putStorage({ dir: p })))}
						options={[{ value: "own", label: "zotero-next's folder" }, { value: "custom", label: "Choose folder…" }]} />
					<div class="flex items-center gap-2">
						<span class="break-all text-xs" title={s().dir ?? s().ownDir ?? ""}>{s().dir ?? s().ownDir ?? "In memory"}</span>
						<Btn onClick={() => reveal("storage")}>Show in folder</Btn>
					</div>
					<Show when={s().dir}>
						<TextField label="Storage folder path" class="w-96" value={s().dir ?? ""} onCommit={(p) => p.trim() && void putStorage({ dir: p.trim() })} />
						<div class="space-y-1">
							<TextField label="Subfolder pattern" placeholder="e.g. {%a}/{%y}" class="w-64" value={s().subfolder} onCommit={(subfolder) => void putStorage({ subfolder })} />
							<span class="block max-w-xl text-xs text-muted-foreground">Subfolder inside the storage folder. {s().patternHelp}. Empty: no subfolders.</span>
						</div>
						<div class="flex items-center gap-3">
							<Switch label="Store as linked files" checked={s().linked} disabled={files.busy()} onChange={(linked) => void putStorage({ linked })} />
							<span class="text-xs text-muted-foreground">{s().linked ? "New files are linked files in this folder (like ZotMoov)." : "New files are imported files kept in this folder."}</span>
						</div>
						<div class="flex items-center gap-2 pt-1">
							<Btn disabled={moving()} onClick={() => void previewMove()}>{moving() ? "Working…" : "Move existing attachments to this folder…"}</Btn>
						</div>
					</Show>
					<Show when={movePreview()}>
						{(p) => (
							<Note tone="warn">
								<Show when={p().count > 0} fallback={<div>Nothing to move: every attachment is already in place or cannot be moved.</div>}>
									<div class="font-medium">{plural(p().count, "file")} ({bytes(p().totalBytes)}) would be moved. Each file is copied, checked against the original, recorded in the database, and only then removed from its old place.</div>
									<For each={p().sample}>{(x) => <div class="break-all font-mono text-[11px]">{x.from} → {x.to}</div>}</For>
									<Show when={p().count > p().sample.length}><div>… and {(p().count - p().sample.length).toLocaleString()} more.</div></Show>
								</Show>
								<Show when={p().onlineOnly > 0}><div class="mt-1">{plural(p().onlineOnly, "online-only OneDrive file")} will be skipped (not downloaded).</div></Show>
								<For each={p().skippedByReason}>{(r) => <div class="mt-0.5">Skipped: {plural(r.count, "file")}, {r.reason}.</div>}</For>
								<div class="mt-1.5 flex gap-2">
									<Btn onClick={() => setMovePreview(null)}>Cancel</Btn>
									<Show when={p().count > 0}><Btn primary disabled={moving()} onClick={() => void runMoveNow()}>{moving() ? "Moving…" : `Move ${p().count.toLocaleString()} files`}</Btn></Show>
								</div>
							</Note>
						)}
					</Show>
					<Show when={moveReport()}>
						{(r) => (
							<Note tone={r().failed.length ? "warn" : "ok"}>
								<div>Moved {plural(r().moved, "file")} ({bytes(r().bytes)}). {r().onlineOnly ? `${plural(r().onlineOnly, "online-only file")} skipped. ` : ""}{r().skipped ? `${plural(r().skipped, "file")} skipped in total. ` : ""}</div>
								<For each={r().failed.slice(0, 5)}>{(f) => <div class="break-all">Left in place: {f.from} ({f.error})</div>}</For>
								<Show when={r().leftBehind.length}><div>{plural(r().leftBehind.length, "original")} could not be deleted after copying; they are harmless duplicates.</div></Show>
								<div class="mt-1.5"><Btn onClick={() => setMoveReport(null)}>Dismiss</Btn></div>
							</Note>
						)}
					</Show>
				</div>
			);
		}}
	</Show>
);
