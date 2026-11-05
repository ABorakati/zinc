// Settings > Better BibTeX: the citation key formula (live preview, validated), key options, "Refresh all citation keys", export
// options and the list of automatic exports (contract: core/src/bbt/types.ts, client.ts here).
import { createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { join } from "node:path";
import { Btn, Choice, SettingRow, TextField, Toggle, Value } from "../../settings/controls";
import { Button, Select, TextInput, toast } from "../../ui";
import { Chip, Line, t, Txt } from "../kit";
import { pickPaths } from "../platform";
import { collectionOptions, selectedKeys } from "../shared";
import { errMsg } from "../text";
import { ago } from "../../shell/net";
import { bbtApi, bumpBbt, type AutoExport, type BbtExportFormat, type BbtSettings } from "./client";
import {
	autoExportLines, canSaveFormula, debounce, defaultExportName, FORMAT_OPTIONS, formulaChecked, formulaTyped, parseSeconds, QUICK_COPY_OPTIONS,
	settingsPatch, staleKeysNote, TRIGGER_OPTIONS, type FormulaState,
} from "./logic";

const fail = (what: string, e: unknown) => toast(what, { kind: "error", description: errMsg(e) });
const DOI_URL = [
	{ value: "both" as const, label: "Keep both" },
	{ value: "doi" as const, label: "DOI only" },
	{ value: "url" as const, label: "URL only" },
];

function AutoExportRow(p: { e: AutoExport; busy: boolean; onRun: () => void; onRemove: () => void }): JSX.Element {
	const lines = () => autoExportLines(p.e, ago);
	return (
		<div style={{ ...t("flex flex-col gap-1 py-2 border-b"), width: "100%" }}>
			<div style={t("flex items-center gap-2")}>
				<Line class="text-[13px] font-medium text-foreground">{lines().title}</Line>
				<Show when={p.e.status === "error"}><Chip tone="warning">error</Chip></Show>
			</div>
			<Txt class="text-xs text-muted-foreground">{lines().detail}</Txt>
			<Txt class={`text-xs ${lines().error ? "text-destructive" : "text-muted-foreground"}`}>{lines().status}</Txt>
			<div style={t("flex items-center gap-2")}>
				<Btn disabled={p.busy} onClick={p.onRun}>{p.busy ? "Exporting…" : "Export now"}</Btn>
				<Btn onClick={p.onRemove}>Remove</Btn>
			</div>
		</div>
	);
}

function AddAutoExport(p: { onAdded: () => void }): JSX.Element {
	const [format, setFormat] = createSignal<BbtExportFormat>("betterbibtex");
	const [scope, setScope] = createSignal("library");
	const [trigger, setTrigger] = createSignal<"change" | "idle">("change");
	const [path, setPath] = createSignal("");
	const [working, setWorking] = createSignal(false);
	const scopeOpts = () => [{ value: "library", label: "Whole library" }, ...collectionOptions().map((c) => ({ value: c.key, label: c.label }))];
	const scopeName = () => scopeOpts().find((o) => o.value === scope())?.label.split(" / ").pop() ?? "export";
	const browse = async () => {
		const dir = (await pickPaths({ directories: true, prompt: "Export into this folder" }))?.[0];
		if (dir) setPath(join(dir, defaultExportName(scope() === "library" ? "My Library" : scopeName(), format())));
	};
	const add = async () => {
		if (!path().trim()) return;
		setWorking(true);
		try {
			await bbtApi.addAutoExport({ path: path().trim(), format: format(), scope: scope() === "library" ? { type: "library" } : { type: "collection", key: scope() }, trigger: trigger() });
			setPath("");
			toast("Automatic export added", { kind: "success" });
			p.onAdded();
		} catch (e) { fail("Could not add the automatic export", e); }
		finally { setWorking(false); }
	};
	return (
		<div style={{ ...t("flex flex-col gap-2 py-3"), width: "100%" }}>
			<Txt class="text-xs font-medium text-foreground">Add an automatic export</Txt>
			<div style={t("flex flex-wrap items-center gap-2")}>
				<Select value={format()} onChange={setFormat} options={FORMAT_OPTIONS} width={160} />
				<Select value={scope()} onChange={setScope} options={scopeOpts()} width={200} />
				<Select value={trigger()} onChange={setTrigger} options={TRIGGER_OPTIONS} width={120} />
			</div>
			<div style={t("flex items-center gap-2")}>
				<div style={{ flexGrow: 1, minWidth: 0 }}><TextInput value={path()} onInput={setPath} onEnter={() => void add()} placeholder="Path of the file to write, e.g. C:\Users\me\refs.bib" /></div>
				<Btn onClick={() => void browse()}>Choose folder…</Btn>
				<Button variant="primary" size="sm" disabled={!path().trim() || working()} onClick={() => void add()}>{working() ? "Adding…" : "Add"}</Button>
			</div>
		</div>
	);
}

export function BbtSettingsSection(): JSX.Element {
	const [settings, setSettings] = createSignal<BbtSettings | null>(null);
	const [stale, setStale] = createSignal(0);
	const [error, setError] = createSignal("");
	const [draft, setDraft] = createSignal("");
	const [formula, setFormula] = createSignal<FormulaState>({ status: "idle", formula: "" });
	const [refreshing, setRefreshing] = createSignal(false);
	const [exports, setExports] = createSignal<AutoExport[]>([]);
	const [running, setRunning] = createSignal<Set<number>>(new Set());

	const check = debounce((f: string) => {
		bbtApi.formula(f, selectedKeys()[0]).then(
			(r) => setFormula((s) => formulaChecked(s, f, r)),
			(e) => setFormula((s) => formulaChecked(s, f, { ok: false, error: errMsg(e) })),
		);
	}, 300);
	const typed = (v: string) => {
		setDraft(v);
		setFormula(formulaTyped(v));
		if (v.trim()) check(v); else check.cancel();
	};

	const load = () => bbtApi.settings().then((s) => {
		setSettings(s);
		setError("");
		if (formula().status === "idle" || draft() === "") { setDraft(s.citekeyFormat); setFormula({ status: "pending", formula: s.citekeyFormat }); check(s.citekeyFormat); }
	}, (e) => setError(errMsg(e)));
	const loadExports = () => void bbtApi.autoExports().then(setExports, () => {});
	onMount(() => {
		void load();
		loadExports();
		const timer = setInterval(loadExports, 4000);
		onCleanup(() => { clearInterval(timer); check.cancel(); });
	});

	const put = (patch: Partial<BbtSettings>) => {
		const s = settings();
		if (!s) return Promise.resolve();
		return bbtApi.putSettings(settingsPatch(s, patch)).then((r) => { setSettings(r.settings); setStale(r.staleKeys); bumpBbt(); }, (e) => fail("Could not save", e));
	};
	const seconds = (key: "autoExportDelay" | "autoExportIdle") => (v: string) => {
		const n = parseSeconds(v);
		if (n === undefined) toast("Enter a whole number of seconds", { kind: "error" });
		else void put({ [key]: n });
	};
	const refreshAll = async () => {
		setRefreshing(true);
		try {
			const r = await bbtApi.refresh();
			setStale(0);
			bumpBbt();
			toast(r.updated ? `Regenerated ${r.updated.toLocaleString()} citation key${r.updated === 1 ? "" : "s"}` : "All citation keys were up to date", { kind: "success" });
		} catch (e) { fail("Could not refresh the citation keys", e); }
		finally { setRefreshing(false); }
	};
	const runNow = async (e: AutoExport) => {
		setRunning((s) => new Set(s).add(e.id));
		try { const r = await bbtApi.runAutoExport(e.id); setExports((l) => l.map((x) => (x.id === r.id ? r : x))); }
		catch (err) { fail("Export failed", err); }
		finally { setRunning((s) => { const n = new Set(s); n.delete(e.id); return n; }); loadExports(); }
	};
	const remove = (e: AutoExport) => void bbtApi.removeAutoExport(e.id).then(loadExports, (err) => fail("Could not remove the automatic export", err));
	const saveFormula = () => {
		const f = draft();
		void put({ citekeyFormat: f }).then(() => { void bbtApi.settings().then((s) => { setSettings(s); if (s.citekeyFormat !== f) typed(s.citekeyFormat); }, () => {}); });
	};

	const preview = (): JSX.Element => {
		const f = formula();
		if (f.status === "error") return <Txt class="text-xs text-destructive">{f.position != null ? `${f.error} (at character ${f.position + 1})` : f.error}</Txt>;
		if (f.status === "ok") return <Txt class="text-xs text-muted-foreground">{`Preview${selectedKeys().length ? " for the selected item" : ""}: ${f.preview || "(empty)"}`}</Txt>;
		return <Txt class="text-xs text-muted-foreground">{f.status === "pending" ? "Checking…" : ""}</Txt>;
	};

	return (
		<div style={{ ...t("flex flex-col"), width: "100%" }}>
			<Show when={settings()} fallback={<Txt class="text-[13px] text-muted-foreground">{error() || "Loading…"}</Txt>}>
				{(s) => (
					<>
						<SettingRow layout="block" label="Citation key formula" description="Better BibTeX formula, e.g. auth.lower + shorttitle(3,3) + year. Separate alternatives with | or ;." control={() => (
								<div style={{ ...t("flex flex-col gap-1.5"), width: "100%" }}>
									<TextInput value={draft()} onInput={typed} onEnter={() => { if (canSaveFormula(formula(), s().citekeyFormat)) saveFormula(); }} placeholder="auth.lower + shorttitle(3,3) + year" />
									{preview()}
									<div style={t("flex items-center gap-2")}>
										<Button variant="primary" size="sm" disabled={!canSaveFormula(formula(), s().citekeyFormat)} onClick={saveFormula}>Save formula</Button>
										<Show when={draft() !== s().citekeyFormat}><Btn onClick={() => typed(s().citekeyFormat)}>Revert</Btn></Show>
									</div>
								</div>
						)} />
						<SettingRow label="Refresh all citation keys" description={staleKeysNote(stale()) || "Regenerate every key that is not pinned from the current formula."} control={() => (
							<Btn primary={stale() > 0} disabled={refreshing()} onClick={() => void refreshAll()}>{refreshing() ? "Refreshing…" : "Refresh all citation keys"}</Btn>
						)} />
						<SettingRow label="Transliterate keys to ASCII" description="Fold accented letters, so Müller gives muller." control={() => <Toggle checked={s().citekeyFold} onChange={(v) => void put({ citekeyFold: v })} />} />
						<SettingRow label="Keys differing only in case are duplicates" control={() => <Toggle checked={s().keyCaseInsensitive} onChange={(v) => void put({ keyCaseInsensitive: v })} />} />
						<SettingRow label="Skip words" description="Comma-separated words the title functions leave out." control={() => <TextField value={s().skipWords} width={260} onCommit={(v) => void put({ skipWords: v })} />} />
						<SettingRow label="Duplicate postfix" description="Added to a key that already exists: %(a)s gives a, b, c…, %(A)s gives A, B, C…, %(n)s gives 1, 2, 3…" control={() => <TextField value={s().postfix} width={140} onCommit={(v) => void put({ postfix: v })} />} />
						<SettingRow label="Characters removed from keys" control={() => <TextField value={s().citekeyUnsafeChars} width={200} onCommit={(v) => void put({ citekeyUnsafeChars: v })} />} />

						<SettingRow label="Better BibTeX: ASCII output" description="Write non-ASCII characters as LaTeX commands." control={() => <Toggle checked={s().asciiBibTeX} onChange={(v) => void put({ asciiBibTeX: v })} />} />
						<SettingRow label="Better BibLaTeX: ASCII output" description="Off keeps unicode characters." control={() => <Toggle checked={s().asciiBibLaTeX} onChange={(v) => void put({ asciiBibLaTeX: v })} />} />
						<SettingRow label="Protect capitalisation in titles" description="Wrap capitalised words in braces so BibTeX keeps their case." control={() => <Toggle checked={s().exportBraceProtection} onChange={(v) => void put({ exportBraceProtection: v })} />} />
						<SettingRow label="DOI and URL" description="Which to keep when an item has both." control={() => <Choice value={s().doiAndUrl} options={DOI_URL} onChange={(v) => void put({ doiAndUrl: v })} width={140} />} />
						<SettingRow label="Export child notes" control={() => <Toggle checked={s().exportNotes} onChange={(v) => void put({ exportNotes: v })} />} />
						<SettingRow label="Export Extra as note" control={() => <Toggle checked={s().exportExtraAsNote} onChange={(v) => void put({ exportExtraAsNote: v })} />} />
						<SettingRow label="Copy citation key format" description="What Copy Citation Key puts on the clipboard." control={() => (
							<Choice value={s().quickCopy} options={QUICK_COPY_OPTIONS} onChange={(v) => void put({ quickCopy: v })} width={200} />
						)} />
						<SettingRow label="LaTeX cite command" description="For the LaTeX format: cite gives \cite{key}." control={() => <TextField value={s().citeCommand} width={140} onCommit={(v) => void put({ citeCommand: v })} />} />
						<SettingRow label="Auto-export delay (seconds)" description="Wait this long after the last change before an on-change export rewrites its file." control={() => <TextField value={String(s().autoExportDelay)} width={80} onCommit={seconds("autoExportDelay")} />} />
						<SettingRow label="Auto-export idle time (seconds)" description="Quiet time before a when-idle export rewrites its file." control={() => <TextField value={String(s().autoExportIdle)} width={80} onCommit={seconds("autoExportIdle")} />} last />
					</>
				)}
			</Show>

			<div style={{ ...t("flex flex-col gap-1 pt-4"), width: "100%" }}>
				<Txt class="text-sm font-medium text-foreground">Automatic exports</Txt>
				<Txt class="text-xs text-muted-foreground">Keep a .bib, CSL JSON or CSL YAML file up to date as the library changes.</Txt>
				<Show when={exports().length === 0}><Value>No automatic exports yet.</Value></Show>
				<For each={exports()}>{(e) => <AutoExportRow e={e} busy={running().has(e.id) || e.status === "running"} onRun={() => void runNow(e)} onRemove={() => remove(e)} />}</For>
				<AddAutoExport onAdded={loadExports} />
			</div>
		</div>
	);
}
