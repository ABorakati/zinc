// Create Bibliography, Citation Style Settings (Quick Copy defaults) and the Quick Copy action itself.
import { createEffect, createSignal, on, onMount, Show, type JSX } from "solid-js";
import { copyRich } from "../platform";
import { saveTextToFolder } from "../io/client";
import { Button, openDialog, Select, toast } from "../../ui";
import { ErrorLine, Field, Footer, Para, Scroll, SettingRow, SettingsBody, t, Txt } from "../kit";
import { errMsg, htmlToText, plural } from "../text";
import { bumpCite, citeApi, citeRev, FILE, LOCALES, type CiteFormat, type CiteFormatResult, type CiteMode, type CiteSettings, type CiteStyleInfo } from "./client";
import { StylePicker } from "./StylePicker";

const fail = (what: string, e: unknown) => toast(what, { kind: "error", description: errMsg(e) });
const MODES = [{ value: "bibliography" as CiteMode, label: "Bibliography" }, { value: "citation" as CiteMode, label: "Citations" }];
const FORMAT_OPTS = (Object.keys(FILE) as CiteFormat[]).map((k) => ({ value: k, label: FILE[k].label }));
const LOCALE_OPTS = LOCALES.map(([value, label]) => ({ value, label }));

/** Quick Copy: format the items in the Quick Copy style and put HTML + plain text on the clipboard. */
export async function quickCopy(keys: string[], mode: CiteMode): Promise<void> {
	if (keys.length === 0) return;
	try {
		const s = (await citeApi.settings()).quickCopy;
		const r = await citeApi.format({ keys, style: s.style, locale: s.locale, mode, format: ["html", "text"] });
		await copyRich(r.html ?? "", r.text ?? "");
		toast(`${mode === "citation" ? "Citation" : "Bibliography"} copied (${plural(r.keys.length, "item")}, ${s.style})`, { kind: "success" });
	} catch (e) {
		fail(mode === "citation" ? "Could not copy the citation" : "Could not copy the bibliography", e);
	}
}

// ---------------------------------------------------------------- Create Bibliography

function BibliographyDialog(p: { title: string; keys: string[] | (() => Promise<string[]>); close: () => void }): JSX.Element {
	const [keys, setKeys] = createSignal<string[]>(Array.isArray(p.keys) ? p.keys : []);
	const [loadingKeys, setLoadingKeys] = createSignal(!Array.isArray(p.keys));
	const [style, setStyle] = createSignal("vancouver");
	const [locale, setLocale] = createSignal("");
	const [mode, setMode] = createSignal<CiteMode>("bibliography");
	const [format, setFormat] = createSignal<CiteFormat>("html");
	const [result, setResult] = createSignal<CiteFormatResult | null>(null);
	const [error, setError] = createSignal("");
	const [working, setWorking] = createSignal(false);
	const [pick, setPick] = createSignal(false);
	let seq = 0;

	onMount(() => {
		// defaults from the Quick Copy settings each time the dialog opens
		citeApi.settings().then((s) => { setStyle(s.quickCopy.style); setLocale(s.quickCopy.locale); setMode(s.quickCopy.mode); setFormat(s.quickCopy.format); }, () => {});
		if (!Array.isArray(p.keys)) {
			p.keys().then(setKeys, (e) => { fail("Could not list the collection's items", e); p.close(); }).finally(() => setLoadingKeys(false));
		}
	});

	createEffect(() => {
		const ks = keys(), st = style(), loc = locale(), md = mode();
		if (ks.length === 0) return;
		const my = ++seq;
		setWorking(true);
		setError("");
		citeApi.format({ keys: ks, style: st, locale: loc, mode: md, format: ["html", "text", "rtf"] }).then(
			(r) => { if (my === seq) { setResult(r); setWorking(false); } },
			(e) => { if (my === seq) { setResult(null); setError(errMsg(e)); setWorking(false); } },
		);
	});

	const copy = async () => {
		const r = result();
		if (!r) return;
		try { await copyRich(r.html ?? "", r.text ?? ""); toast(mode() === "citation" ? "Citation copied" : "Bibliography copied", { kind: "success" }); }
		catch (e) { fail("Could not copy to the clipboard", e); }
	};
	const save = async () => {
		const r = result();
		const f = format();
		if (!r) return;
		try {
			const path = await saveTextToFolder(`${mode() === "citation" ? "citations" : "bibliography"}.${FILE[f].ext}`, r[f] ?? "");
			if (path) toast("Saved", { kind: "success", description: path });
		} catch (e) { fail("Could not save the file", e); }
	};
	const previewLines = () => {
		const r = result();
		if (!r) return [];
		return (format() === "html" ? htmlToText(r.html ?? "") : (r[format()] ?? "")).split("\n");
	};

	return (
		<div style={{ ...t("flex flex-col gap-3"), width: "100%" }}>
			<Txt class="text-sm text-muted-foreground">{`${p.title}${keys().length ? ` — ${plural(keys().length, "item")}` : ""}`}</Txt>
			<Show when={pick()} fallback={
				<>
					<div style={t("flex flex-row items-center gap-2 rounded-md border px-3 py-2")}>
						<Txt class="text-xs text-muted-foreground">Style</Txt>
						<Txt class="text-[13px] font-medium text-foreground" style={{ flexGrow: 1 }}>{style()}</Txt>
						<Button variant="outline" size="sm" onClick={() => setPick(true)}>Choose style…</Button>
					</div>
					<div style={{ ...t("flex flex-row gap-3"), width: "100%" }}>
						<Field label="Output mode" style={{ flexGrow: 1 }}><Select value={mode()} onChange={setMode} options={MODES} /></Field>
						<Field label="Output format" style={{ flexGrow: 1 }}><Select value={format()} onChange={setFormat} options={FORMAT_OPTS} /></Field>
						<Field label="Language" style={{ flexGrow: 1 }}><Select value={locale()} onChange={setLocale} options={LOCALE_OPTS} /></Field>
					</div>
					<Scroll border height={190} style={{ padding: 8 }}>
						<Show when={!error()} fallback={<ErrorLine>{error()}</ErrorLine>}>
							<Show when={!loadingKeys() && !working()} fallback={<Txt class="text-[13px] text-muted-foreground">Formatting…</Txt>}>
								{previewLines().map((l) => <Para class="text-[13px] text-foreground" style={{ flexShrink: 0 }}>{l}</Para>)}
							</Show>
						</Show>
					</Scroll>
					<Footer>
						<Button variant="outline" size="sm" disabled={!result()} onClick={() => void save()}>{`Save as .${FILE[format()].ext}…`}</Button>
						<Button variant="primary" size="sm" disabled={!result()} onClick={() => void copy()}>Copy to Clipboard</Button>
					</Footer>
				</>
			}>
				<StylePicker value={style()} itemKeys={keys().slice(0, 3)} onChange={(id) => { setStyle(id); setPick(false); }} />
				<Footer><Button variant="outline" size="sm" onClick={() => setPick(false)}>Back</Button></Footer>
			</Show>
		</div>
	);
}

/** Open the Create Bibliography dialog for item keys (or a loader that resolves them, e.g. for a collection). */
export const openBibliography = (title: string, keys: string[] | (() => Promise<string[]>)) =>
	openDialog<void>((close) => <BibliographyDialog title={title} keys={keys} close={() => close()} />, { title: "Create Bibliography", width: 860 });

// ---------------------------------------------------------------- Citation Style Settings (Quick Copy)

function CiteSettingsDialog(p: { itemKeys: string[]; close: () => void }): JSX.Element {
	const [cur, setCur] = createSignal<CiteSettings["quickCopy"]>({ style: "vancouver", locale: "", mode: "bibliography", format: "html" });
	onMount(() => void citeApi.settings().then((s) => setCur(s.quickCopy), (e) => fail("Could not load citation settings", e)));
	const save = async () => {
		try {
			await citeApi.putSettings(cur());
			bumpCite();
			toast("Quick Copy settings saved", { kind: "success" });
			p.close();
		} catch (e) { fail("Could not save settings", e); }
	};
	return (
		<div style={{ ...t("flex flex-col gap-3"), width: "100%" }}>
			<Para class="text-sm text-muted-foreground">Quick Copy defaults, used by Copy Bibliography (Ctrl+Shift+C), Copy Citation (Ctrl+Shift+A) and as the starting point of Create Bibliography.</Para>
			<StylePicker value={cur().style} itemKeys={p.itemKeys} onChange={(id: string, _info?: CiteStyleInfo) => setCur({ ...cur(), style: id })} />
			<div style={{ ...t("flex flex-row gap-3"), width: "100%" }}>
				<Field label="Output mode" style={{ flexGrow: 1 }}><Select value={cur().mode} onChange={(mode) => setCur({ ...cur(), mode })} options={MODES} /></Field>
				<Field label="Output format" style={{ flexGrow: 1 }}><Select value={cur().format} onChange={(format) => setCur({ ...cur(), format })} options={FORMAT_OPTS} /></Field>
				<Field label="Language" style={{ flexGrow: 1 }}><Select value={cur().locale} onChange={(locale) => setCur({ ...cur(), locale })} options={LOCALE_OPTS} /></Field>
			</div>
			<Footer>
				<Button variant="outline" size="sm" onClick={p.close}>Cancel</Button>
				<Button variant="primary" size="sm" onClick={() => void save()}>Save</Button>
			</Footer>
		</div>
	);
}
export const openCiteSettings = (itemKeys: string[] = []) =>
	openDialog<void>((close) => <CiteSettingsDialog itemKeys={itemKeys} close={() => close()} />, { title: "Citation Style Settings", width: 860 });

/** Settings > Cite: the Quick Copy settings inline, plus "Browse all styles…". */
export function CiteSettingsSection(): JSX.Element {
	const [settings, setSettings] = createSignal<CiteSettings | null>(null);
	const [styles, setStyles] = createSignal<CiteStyleInfo[]>([]);
	const [error, setError] = createSignal("");
	const reload = () => {
		citeApi.settings().then((s) => { setSettings(s); setError(""); }, (e) => setError(errMsg(e)));
		citeApi.styles().then(setStyles, () => {});
	};
	onMount(reload);
	createEffect(on(citeRev, reload, { defer: true }));
	const put = (patch: Partial<CiteSettings["quickCopy"]>) => citeApi.putSettings(patch).then(setSettings, (e) => fail("Could not save", e));
	const styleOpts = () => {
		const s = settings()!.quickCopy.style;
		const l = styles().map((x) => ({ value: x.id, label: x.titleShort || x.title }));
		return l.some((o) => o.value === s) ? l : [{ value: s, label: s }, ...l];
	};
	return (
		<SettingsBody>
			<Show when={settings()} fallback={<Txt class="text-[13px] text-muted-foreground">{error() || "Loading…"}</Txt>}>
				{(s) => (
					<>
						<SettingRow label="Quick Copy style" description="Citation style for Copy Citation (Ctrl+Shift+A) and Copy Bibliography (Ctrl+Shift+C).">
							<Select value={s().quickCopy.style} onChange={(style) => void put({ style })} options={styleOpts()} width={220} />
							<Button variant="outline" size="sm" onClick={() => void openCiteSettings()}>Browse all styles…</Button>
						</SettingRow>
						<SettingRow label="Language" description="Locale for citations, such as en-GB. Empty uses the style's own.">
							<Select value={s().quickCopy.locale} onChange={(locale) => void put({ locale })} options={LOCALE_OPTS} width={180} />
						</SettingRow>
						<SettingRow label="Quick Copy output" description="Preselected in the Create Bibliography dialog.">
							<Select value={s().quickCopy.mode} onChange={(mode) => void put({ mode })} options={MODES} width={160} />
						</SettingRow>
						<SettingRow label="Quick Copy format" description="Preselected in the Create Bibliography dialog.">
							<Select value={s().quickCopy.format} onChange={(format) => void put({ format })} options={FORMAT_OPTS} width={160} />
						</SettingRow>
					</>
				)}
			</Show>
		</SettingsBody>
	);
}
