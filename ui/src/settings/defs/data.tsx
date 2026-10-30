// Settings backed by the server or other features: Sync, Find Full Text, Cite (Quick Copy) and Export.
// Server state is read when the Settings tab is shown (see net.ts) and written through the features' own endpoints.
import { createRoot, createSignal, Show } from "solid-js";
import { Download, FileSearch, Quote, RefreshCw } from "lucide-solid";
import { toast } from "solid-sonner";
import type { FullTextSettingsPatch, FullTextSettingsView } from "../../../../core/src/api-types";
import { Button } from "~/components/ui/button";
import { fail } from "~/lib/actions";
import { cn } from "~/lib/utils";
import { citeApi, type CiteFormat, type CiteMode, type CiteSettings, type CiteStyleInfo } from "~/cite/client";
import { openCiteSettings } from "~/cite/dialogs";
import { call as ftCall } from "~/fulltext/jobs";
import { openFullTextSettings } from "~/fulltext/Settings";
import { EXPORT_FORMATS, type ExportFormat } from "~/io/client";
import { store } from "~/store";
import { Segmented, Select, Switch, TextField, Value } from "../controls";
import { call, onSettingsShown } from "../net";
import { registerSection, registerSettings } from "../registry";

registerSection({ id: "sync", label: "Sync", icon: RefreshCw, order: 40, description: "Keeping this library and Zotero's in step.", keywords: ["zotero", "write", "backup"] });
registerSection({ id: "fulltext", label: "Find Full Text", icon: FileSearch, order: 50, description: "Where PDFs are fetched from.", keywords: ["pdf", "download", "open access", "institution"] });
registerSection({ id: "cite", label: "Cite", icon: Quote, order: 60, description: "Quick Copy: the style used by Copy Citation and Copy Bibliography.", keywords: ["citation", "bibliography", "style", "csl", "quick copy"] });
registerSection({ id: "export", label: "Export", icon: Download, order: 70, description: "Defaults for exporting items and collections.", keywords: ["bibtex", "ris", "csv", "csl json"] });

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

// ---------------------------------------------------------------- Sync (/api/sync/*)
interface SyncState {
	enabled: boolean;
	zotero: "closed" | "running" | "missing" | "error";
	dataDir: string;
	pending: number;
	lastPullAt?: string;
	lastPushAt?: string;
	lastBackup?: string;
	lastError?: string;
	conflicts: number;
	busy?: boolean;
}
const ZOTERO_LABEL: Record<SyncState["zotero"], string> = { closed: "Zotero closed", running: "Zotero running", missing: "Zotero not found", error: "Zotero unreadable" };

function ago(iso?: string): string {
	if (!iso) return "never";
	const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
	if (s < 10) return "just now";
	if (s < 90) return `${Math.round(s)} s ago`;
	if (s < 5400) return `${Math.round(s / 60)} min ago`;
	if (s < 86400 * 1.5) return `${Math.round(s / 3600)} h ago`;
	return new Date(iso).toLocaleDateString();
}

const sync = createRoot(() => {
	const [status, setStatus] = createSignal<SyncState | null>(null);
	const [unreachable, setUnreachable] = createSignal(false);
	const [working, setWorking] = createSignal(false);
	const [confirming, setConfirming] = createSignal(false);
	const refresh = async () => {
		try { setStatus(await call<SyncState>("GET", "/api/sync/status")); setUnreachable(false); } catch { setUnreachable(true); }
	};
	const run = async (path: string, body?: unknown) => {
		setWorking(true);
		try {
			setStatus(await call<SyncState>("POST", `/api/sync/${path}`, body));
			store.bumpItems(); store.bumpCollections(); store.bumpTags();
		} catch (e) { fail("Sync failed", e); } finally { setWorking(false); }
	};
	return { status, unreachable, working, confirming, setConfirming, refresh, run };
});
onSettingsShown(() => void sync.refresh());

registerSettings([
	{
		id: "sync.status", section: "sync", label: "Zotero library",
		description: "State of the Zotero data folder this library is kept in step with.",
		keywords: ["status", "sync now", "refresh", "pull", "read", "conflicts", "pending", "last sync"],
		control: () => (
			<div class="flex flex-col items-end gap-1">
				<Show when={sync.status()} fallback={<Value>{sync.unreachable() ? "Sync is not available." : "Loading…"}</Value>}>
					{(s) => (
						<>
							<Value>{ZOTERO_LABEL[s().zotero]}. Read {ago(s().lastPullAt)}; {s().pending ? `${plural(s().pending, "change")} waiting to write` : "nothing waiting to write"}; {plural(s().conflicts, "conflict")}</Value>
							<Show when={s().lastError}><span class="max-w-96 break-words text-xs text-destructive">{s().lastError}</span></Show>
							<Button variant="outline" size="sm" class="h-7 gap-1 px-2 text-xs" disabled={sync.working() || s().busy || s().zotero === "missing"} onClick={() => void sync.run("now")}>
								<RefreshCw class={cn("!size-3", (sync.working() || s().busy) && "animate-spin")} /> Sync now
							</Button>
						</>
					)}
				</Show>
			</div>
		),
	},
	{
		id: "sync.write", section: "sync", label: "Write changes into Zotero", layout: "block",
		description: "Off: Zotero's changes are still read in. On: edits made here are written to Zotero's database, only while Zotero is closed.",
		keywords: ["push", "write back", "zotero.sqlite", "database", "enable", "opt in", "backup"],
		control: () => (
			<Show when={sync.status()} fallback={<Value>{sync.unreachable() ? "Sync is not available." : "Loading…"}</Value>}>
				{(s) => (
					<div class="space-y-2">
						<div class="flex items-center gap-3">
							<Switch label="Write changes into Zotero" checked={s().enabled} disabled={sync.working() || s().zotero === "missing"}
								onChange={(on) => (on ? sync.setConfirming(true) : void sync.run("enable", { enabled: false }))} />
							<span class="text-xs text-muted-foreground">{s().enabled ? `On. Last written ${ago(s().lastPushAt)}.` : "Off"}</span>
						</div>
						<Show when={sync.confirming() && !s().enabled}>
							<div class="max-w-xl space-y-2 rounded-md bg-amber-500/10 p-2.5 text-xs">
								<p class="text-amber-800 dark:text-amber-300">
									This writes directly into Zotero's database (zotero.sqlite) and storage folder, only while Zotero is closed. A backup of zotero.sqlite
									is made before every write session (the last 5 are kept in zotero-next-backups). Make your own backup of the Zotero data folder first if you want extra safety.
								</p>
								<div class="flex gap-2">
									<Button size="sm" variant="ghost" class="h-7 px-2 text-xs" onClick={() => sync.setConfirming(false)}>Cancel</Button>
									<Button size="sm" class="h-7 px-2 text-xs" disabled={sync.working()}
										onClick={() => void sync.run("enable", { enabled: true }).then(() => sync.setConfirming(false))}>I have a backup, turn on</Button>
								</div>
							</div>
						</Show>
						<Show when={s().enabled && s().lastBackup}><Value title={s().lastBackup}>Last backup: {s().lastBackup}</Value></Show>
					</div>
				)}
			</Show>
		),
	},
	{
		id: "sync.dataDir", section: "sync", label: "Zotero data folder",
		keywords: ["directory", "path", "location", "zotero.sqlite", "storage", "files and folders"],
		control: () => <Value title={sync.status()?.dataDir}>{sync.status()?.dataDir ?? "…"}</Value>,
	},
	{ id: "sync.account", section: "sync", label: "Sync with zotero.org", description: "Zotero account sync, data and file sync.", keywords: ["account", "username", "password", "cloud", "webdav", "file syncing"], unavailable: true },
	{ id: "sync.auto", section: "sync", label: "Sync automatically", keywords: ["background", "schedule"], unavailable: true },
]);

// ---------------------------------------------------------------- Find Full Text (/api/fulltext/settings)
const fulltext = createRoot(() => {
	const [view, setView] = createSignal<FullTextSettingsView | null>(null);
	const [error, setError] = createSignal("");
	const refresh = () => ftCall<FullTextSettingsView>("GET", "/settings").then((v) => { setView(v); setError(""); }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
	const put = (patch: FullTextSettingsPatch) => ftCall<FullTextSettingsView>("PUT", "/settings", patch).then(setView).catch((e) => fail("Could not save", e));
	return { view, error, refresh, put };
});
onSettingsShown(() => void fulltext.refresh());
const ftGone = () => <Value>{fulltext.error() || "Loading…"}</Value>;

registerSettings([
	{
		id: "fulltext.institution", section: "fulltext", label: "Institution",
		description: "The library whose subscriptions are used to find PDFs.",
		keywords: ["university", "openathens", "shibboleth", "ezproxy", "proxy", "sign in", "library access", "login"],
		control: () => (
			<Show when={fulltext.view()} fallback={ftGone()}>
				{(v) => (
					<div class="flex items-center gap-2">
						<Value title={v().institution.name}>{v().institution.name}{v().isDefaultInstitution ? " (default)" : ""}</Value>
						<Button variant="outline" size="sm" class="h-7 px-2 text-xs" onClick={openFullTextSettings}>Change…</Button>
					</div>
				)}
			</Show>
		),
	},
	{
		id: "fulltext.institutional", section: "fulltext", label: "Use institutional access",
		description: "Off: open-access sources only.",
		keywords: ["open access", "subscription", "paywall", "unpaywall"],
		control: () => (
			<Show when={fulltext.view()} fallback={ftGone()}>
				{(v) => <Switch label="Use institutional access" checked={v().institutional} onChange={(institutional) => void fulltext.put({ institutional })} />}
			</Show>
		),
	},
	{
		id: "fulltext.email", section: "fulltext", label: "Unpaywall email",
		description: "Sent to Unpaywall with each lookup, as their terms ask.",
		keywords: ["open access", "contact", "address", "api"],
		control: () => (
			<Show when={fulltext.view()} fallback={ftGone()}>
				{(v) => <TextField label="Unpaywall email" type="email" placeholder="you@example.org" value={v().unpaywallEmail} onCommit={(unpaywallEmail) => void fulltext.put({ unpaywallEmail })} />}
			</Show>
		),
	},
	{
		id: "fulltext.concurrency", section: "fulltext", label: "Items fetched at once",
		description: "More is faster but harder on publisher sites.",
		keywords: ["concurrency", "parallel", "speed", "downloads", "threads"],
		control: () => (
			<Show when={fulltext.view()} fallback={ftGone()}>
				{(v) => (
					<Select label="Items fetched at once" value={String(v().concurrency)} onChange={(n) => void fulltext.put({ concurrency: +n })}
						options={[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ value: String(n), label: String(n) }))} class="min-w-20" />
				)}
			</Show>
		),
	},
	{ id: "fulltext.index", section: "fulltext", label: "Index PDF text for searching", description: "Maintain a search index of attachment text, as Zotero does.", keywords: ["indexing", "full-text", "search", "pdftotext", "characters", "pages"], unavailable: true },
]);

// ---------------------------------------------------------------- Cite (/api/cite/settings)
const cite = createRoot(() => {
	const [settings, setSettings] = createSignal<CiteSettings | null>(null);
	const [styles, setStyles] = createSignal<CiteStyleInfo[]>([]);
	const [error, setError] = createSignal("");
	const refresh = () => {
		citeApi.settings().then((s) => { setSettings(s); setError(""); }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
		citeApi.styles("").then(setStyles).catch(() => {});
	};
	const put = (patch: Partial<CiteSettings["quickCopy"]>) => citeApi.putSettings(patch).then(setSettings).catch((e) => fail("Could not save", e));
	return { settings, styles, error, refresh, put };
});
onSettingsShown(cite.refresh);
const citeGone = () => <Value>{cite.error() || "Loading…"}</Value>;

registerSettings([
	{
		id: "cite.style", section: "cite", label: "Quick Copy style",
		description: "Citation style for Copy Citation (Ctrl+Shift+A) and Copy Bibliography (Ctrl+Shift+C).",
		keywords: ["csl", "vancouver", "apa", "harvard", "nature", "lancet", "chicago", "citation style", "bibliography", "format"],
		control: () => (
			<Show when={cite.settings()} fallback={citeGone()}>
				{(s) => {
					const opts = () => {
						const list = cite.styles().map((x) => ({ value: x.id, label: x.titleShort || x.title }));
						return list.some((o) => o.value === s().quickCopy.style) ? list : [{ value: s().quickCopy.style, label: s().quickCopy.style }, ...list];
					};
					return (
						<div class="flex items-center gap-2">
							<Select label="Quick Copy style" value={s().quickCopy.style} onChange={(style) => void cite.put({ style })} options={opts()} class="max-w-56" />
							<Button variant="outline" size="sm" class="h-7 px-2 text-xs" onClick={openCiteSettings}>More styles…</Button>
						</div>
					);
				}}
			</Show>
		),
	},
	{
		id: "cite.locale", section: "cite", label: "Language",
		description: "Locale for citations, such as en-GB. Empty uses the style's own.",
		keywords: ["locale", "translation", "en-us", "en-gb", "terms"],
		control: () => (
			<Show when={cite.settings()} fallback={citeGone()}>
				{(s) => <TextField label="Quick Copy language" placeholder="Style default" value={s().quickCopy.locale} class="w-40" onCommit={(locale) => void cite.put({ locale })} />}
			</Show>
		),
	},
	{
		id: "cite.mode", section: "cite", label: "Quick Copy output",
		description: "Preselected in the Create Bibliography dialog.",
		keywords: ["citation", "bibliography", "in-text", "copy", "create bibliography"],
		control: () => (
			<Show when={cite.settings()} fallback={citeGone()}>
				{(s) => (
					<Segmented<CiteMode> label="Quick Copy output" value={s().quickCopy.mode} onChange={(mode) => void cite.put({ mode })}
						options={[{ value: "bibliography", label: "Bibliography" }, { value: "citation", label: "Citation" }]} />
				)}
			</Show>
		),
	},
	{
		id: "cite.format", section: "cite", label: "Quick Copy format",
		description: "Preselected in the Create Bibliography dialog.",
		keywords: ["html", "rtf", "text", "rich text", "clipboard"],
		control: () => (
			<Show when={cite.settings()} fallback={citeGone()}>
				{(s) => (
					<Select<CiteFormat> label="Quick Copy format" value={s().quickCopy.format} onChange={(format) => void cite.put({ format })}
						options={[{ value: "html", label: "HTML" }, { value: "text", label: "Plain text" }, { value: "rtf", label: "Rich Text (RTF)" }]} class="min-w-32" />
				)}
			</Show>
		),
	},
	{ id: "cite.wordProcessor", section: "cite", label: "Word processor plugins", description: "Install the Word, LibreOffice and Google Docs integrations.", keywords: ["word", "libreoffice", "google docs", "plugin"], unavailable: true },
]);

// ---------------------------------------------------------------- Export (remembered by the Export dialog)
const FORMAT_KEY = "zn.export.format.v1";
const NOTES_KEY = "zn.export.notes.v1";
const [exportFormat, setExportFormatSig] = createSignal<ExportFormat>((() => {
	try { const v = localStorage.getItem(FORMAT_KEY); if (EXPORT_FORMATS.some((f) => f.id === v)) return v as ExportFormat; } catch { /* ignore */ }
	return "bibtex";
})());
const [exportNotes, setExportNotesSig] = createSignal((() => { try { return localStorage.getItem(NOTES_KEY) === "1"; } catch { return false; } })());

registerSettings([
	{
		id: "export.format", section: "export", label: "Default export format",
		description: "Preselected in the Export Items and Export Collection dialogs.",
		keywords: ["bibtex", "biblatex", "ris", "csl json", "csv", "file type", "save as"],
		control: () => (
			<Select<ExportFormat> label="Default export format" value={exportFormat()}
				onChange={(f) => { setExportFormatSig(f); try { localStorage.setItem(FORMAT_KEY, f); } catch { /* ignore */ } toast.success("Default export format saved"); }}
				options={EXPORT_FORMATS.map((f) => ({ value: f.id, label: f.label, hint: f.hint }))} />
		),
	},
	{
		id: "export.notes", section: "export", label: "Include notes",
		description: "Export notes together with the items by default.",
		keywords: ["child notes", "annotations"],
		control: () => <Switch label="Include notes" checked={exportNotes()} onChange={(v) => { setExportNotesSig(v); try { localStorage.setItem(NOTES_KEY, v ? "1" : "0"); } catch { /* ignore */ } }} />,
	},
	{ id: "export.encoding", section: "export", label: "Character encoding", description: "Encoding of exported text files.", keywords: ["utf-8", "unicode", "latin"], unavailable: true },
]);
