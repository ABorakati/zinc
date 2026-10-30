import { createEffect, createSignal, For, on, Show, type Component } from "solid-js";
import { toast } from "solid-sonner";
import { fail } from "~/lib/actions";
import { sanitizeNote } from "~/sanitize";
import { store } from "~/store";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "~/components/ui/dialog";
import {
	bumpCite, citeApi, copyRich, downloadText, type CiteFormat, type CiteFormatResult, type CiteMode, type CiteSettings,
} from "./client";
import { StylePicker } from "./StylePicker";

const LOCALES: [string, string][] = [
	["", "Style default"], ["en-US", "English (US)"], ["en-GB", "English (UK)"], ["de-DE", "Deutsch"], ["fr-FR", "Francais"],
	["es-ES", "Espanol"], ["it-IT", "Italiano"], ["nl-NL", "Nederlands"], ["pt-BR", "Portugues (Brasil)"], ["sv-SE", "Svenska"],
	["pl-PL", "Polski"], ["ru-RU", "Russian"], ["zh-CN", "Chinese (Simplified)"], ["ja-JP", "Japanese"],
];
const FILE: Record<CiteFormat, { ext: string; mime: string; label: string }> = {
	html: { ext: "html", mime: "text/html", label: "HTML" },
	text: { ext: "txt", mime: "text/plain", label: "Plain text" },
	rtf: { ext: "rtf", mime: "application/rtf", label: "RTF" },
};

const selectCls =
	"h-7 w-full rounded-md border border-input bg-background px-2 text-[13px] outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30";

const Field: Component<{ label: string; children: any }> = (p) => (
	<label class="grid gap-1 text-[13px]"><span class="font-medium">{p.label}</span>{p.children}</label>
);

// ---------------------------------------------------------------- Create Bibliography

const [bibOpen, setBibOpen] = createSignal(false);
const [bibTitle, setBibTitle] = createSignal("");
const [bibKeys, setBibKeys] = createSignal<string[]>([]);
const [bibLoadingKeys, setBibLoadingKeys] = createSignal(false);

/** Open the Create Bibliography dialog for item keys (or a loader that resolves them, e.g. for a collection). */
export async function openBibliography(title: string, keys: string[] | (() => Promise<string[]>)) {
	setBibTitle(title);
	setBibKeys([]);
	setBibOpen(true);
	if (Array.isArray(keys)) { setBibKeys(keys); return; }
	setBibLoadingKeys(true);
	try {
		setBibKeys(await keys());
	} catch (e) {
		fail("Could not list the collection's items", e);
		setBibOpen(false);
	} finally {
		setBibLoadingKeys(false);
	}
}

export const BibliographyDialog: Component = () => {
	const [style, setStyle] = createSignal("vancouver");
	const [locale, setLocale] = createSignal("");
	const [mode, setMode] = createSignal<CiteMode>("bibliography");
	const [format, setFormat] = createSignal<CiteFormat>("html");
	const [result, setResult] = createSignal<CiteFormatResult | null>(null);
	const [error, setError] = createSignal("");
	const [working, setWorking] = createSignal(false);
	let seq = 0;

	// defaults from the Quick Copy settings each time the dialog opens
	createEffect(on(bibOpen, (open) => {
		if (!open) return;
		setResult(null);
		setError("");
		citeApi.settings().then((s) => {
			setStyle(s.quickCopy.style); setLocale(s.quickCopy.locale); setMode(s.quickCopy.mode); setFormat(s.quickCopy.format);
		}, () => { /* keep defaults */ });
	}));

	createEffect(() => {
		const keys = bibKeys();
		const st = style(), loc = locale(), md = mode();
		if (!bibOpen() || keys.length === 0) return;
		const my = ++seq;
		setWorking(true);
		setError("");
		citeApi.format({ keys, style: st, locale: loc, mode: md, format: ["html", "text", "rtf"] }).then(
			(r) => { if (my === seq) { setResult(r); setWorking(false); } },
			(e) => { if (my === seq) { setResult(null); setError(e instanceof Error ? e.message : String(e)); setWorking(false); } },
		);
	});

	const copy = async () => {
		const r = result();
		if (!r) return;
		try {
			await copyRich(r.html ?? "", r.text ?? "");
			toast.success(mode() === "citation" ? "Citation copied" : "Bibliography copied");
		} catch (e) { fail("Could not copy to the clipboard", e); }
	};
	const save = () => {
		const r = result();
		const f = format();
		if (!r) return;
		downloadText(`${mode() === "citation" ? "citations" : "bibliography"}.${FILE[f].ext}`, r[f] ?? "", FILE[f].mime);
	};
	const preview = () => {
		const r = result();
		if (!r) return "";
		return format() === "html" ? sanitizeNote(r.html ?? "") : "";
	};

	return (
		<Dialog open={bibOpen()} onOpenChange={setBibOpen}>
			<DialogContent class="max-h-[95vh] max-w-4xl overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Create Bibliography</DialogTitle>
					<DialogDescription>{bibTitle()}{bibKeys().length ? ` — ${bibKeys().length} item${bibKeys().length === 1 ? "" : "s"}` : ""}</DialogDescription>
				</DialogHeader>
				<StylePicker value={style()} onChange={(id) => setStyle(id)} itemKeys={bibKeys().slice(0, 3)} />
				<div class="grid grid-cols-3 gap-3">
					<Field label="Output mode">
						<select class={selectCls} value={mode()} onChange={(e) => setMode(e.currentTarget.value as CiteMode)}>
							<option value="bibliography">Bibliography</option>
							<option value="citation">Citations</option>
						</select>
					</Field>
					<Field label="Output format">
						<select class={selectCls} value={format()} onChange={(e) => setFormat(e.currentTarget.value as CiteFormat)}>
							<For each={Object.entries(FILE)}>{([k, v]) => <option value={k}>{v.label}</option>}</For>
						</select>
					</Field>
					<Field label="Language">
						<select class={selectCls} value={locale()} onChange={(e) => setLocale(e.currentTarget.value)}>
							<For each={LOCALES}>{([k, v]) => <option value={k}>{v}</option>}</For>
						</select>
					</Field>
				</div>
				<div class="max-h-48 min-h-16 overflow-auto rounded-md border bg-muted/30 p-2 text-[13px]" aria-live="polite">
					<Show when={!error()} fallback={<span class="text-destructive">{error()}</span>}>
						<Show when={!bibLoadingKeys() && !working()} fallback={<span class="text-muted-foreground">Formatting…</span>}>
							<Show when={format() === "html"} fallback={<pre class="whitespace-pre-wrap font-sans">{result()?.[format()] ?? ""}</pre>}>
								<div innerHTML={preview()} />
							</Show>
						</Show>
					</Show>
				</div>
				<DialogFooter class="gap-2 sm:gap-0">
					<Button variant="outline" size="sm" disabled={!result()} onClick={save}>Save as .{FILE[format()].ext}</Button>
					<Button size="sm" disabled={!result()} onClick={copy}>Copy to Clipboard</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

// ---------------------------------------------------------------- Citation Style Settings (Quick Copy)

const [settingsOpen, setSettingsOpen] = createSignal(false);
export const openCiteSettings = () => setSettingsOpen(true);

export const CiteSettingsDialog: Component = () => {
	const [cur, setCur] = createSignal<CiteSettings["quickCopy"]>({ style: "vancouver", locale: "", mode: "bibliography", format: "html" });
	createEffect(on(settingsOpen, (open) => {
		if (open) citeApi.settings().then((s) => setCur(s.quickCopy), (e) => fail("Could not load citation settings", e));
	}));
	const save = async () => {
		try {
			await citeApi.putSettings(cur());
			bumpCite();
				toast.success("Quick Copy settings saved");
			setSettingsOpen(false);
		} catch (e) { fail("Could not save settings", e); }
	};
	return (
		<Dialog open={settingsOpen()} onOpenChange={setSettingsOpen}>
			<DialogContent class="max-h-[95vh] max-w-4xl overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Citation Style Settings</DialogTitle>
					<DialogDescription>Quick Copy defaults, used by Copy Bibliography (Ctrl+Shift+C), Copy Citation (Ctrl+Shift+A) and as the starting point of Create Bibliography.</DialogDescription>
				</DialogHeader>
				<StylePicker value={cur().style} onChange={(id) => setCur({ ...cur(), style: id })} itemKeys={[...store.selected()].slice(0, 3)} />
				<div class="grid grid-cols-3 gap-3">
					<Field label="Output mode">
						<select class={selectCls} value={cur().mode} onChange={(e) => setCur({ ...cur(), mode: e.currentTarget.value as CiteMode })}>
							<option value="bibliography">Bibliography</option>
							<option value="citation">Citations</option>
						</select>
					</Field>
					<Field label="Output format">
						<select class={selectCls} value={cur().format} onChange={(e) => setCur({ ...cur(), format: e.currentTarget.value as CiteFormat })}>
							<For each={Object.entries(FILE)}>{([k, v]) => <option value={k}>{v.label}</option>}</For>
						</select>
					</Field>
					<Field label="Language">
						<select class={selectCls} value={cur().locale} onChange={(e) => setCur({ ...cur(), locale: e.currentTarget.value })}>
							<For each={LOCALES}>{([k, v]) => <option value={k}>{v}</option>}</For>
						</select>
					</Field>
				</div>
				<DialogFooter class="gap-2 sm:gap-0">
					<Button variant="outline" size="sm" onClick={() => setSettingsOpen(false)}>Cancel</Button>
					<Button size="sm" onClick={save}>Save</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

export const CiteDialogs: Component = () => (
	<>
		<BibliographyDialog />
		<CiteSettingsDialog />
	</>
);
