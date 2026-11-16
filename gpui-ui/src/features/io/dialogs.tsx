// Export dialog (format + notes, then a folder is picked) and the Settings > Export section.
import { createSignal, For, onMount, Show, type JSX } from "solid-js";
import { Button, Checkbox, openDialog, Select, Switch } from "../../ui";
import { Choice, Footer, Para, SettingRow, SettingsBody, t, Txt } from "../kit";
import { plural } from "../text";
import { translateApi } from "../translate/client";
import { runTranslatorExport } from "../translate/export";
import { TranslatorFormats } from "../translate/TranslatorFormats";
import type { TranslatorFormat } from "../translate/logic";
import {
	EXPORT_FORMATS,
	exportFormat,
	exportNotes,
	runExport,
	setExportFormat,
	setExportNotes,
	type ExportFormat,
	type ExportTarget,
} from "./client";

function ExportDialog(p: { target: ExportTarget; close: () => void }): JSX.Element {
	const [format, setFormat] = createSignal<ExportFormat>(exportFormat());
	const [notes, setNotes] = createSignal(exportNotes());
	const [busy, setBusy] = createSignal(false);
	const [more, setMore] = createSignal<TranslatorFormat[]>([]); // Zotero translator formats (empty when the core has none)
	const [tr, setTr] = createSignal<string | null>(null);
	onMount(() => void translateApi.exportFormats().then(setMore, () => {}));
	const what = () =>
		p.target.kind === "items"
			? plural(p.target.keys.length, "selected item")
			: `the collection "${p.target.name}" and its subcollections`;
	async function submit() {
		if (busy()) return;
		setExportFormat(format());
		setExportNotes(notes());
		setBusy(true);
		const ok = tr() ? await runTranslatorExport(p.target, tr()!, notes()) : await runExport(p.target, format(), notes());
		setBusy(false);
		if (ok) p.close();
	}
	return (
		<div style={{ ...t("flex flex-col gap-3"), width: "100%" }}>
			<Para class="text-sm text-muted-foreground">{`Save ${what()} as a file. You choose the folder next.`}</Para>
			<div style={t("flex flex-col gap-1")}>
				<For each={EXPORT_FORMATS}>
					{(f) => (
						<Choice
							selected={!tr() && format() === f.id}
							label={f.label}
							hint={f.hint}
							onClick={() => {
								setTr(null);
								setFormat(f.id);
							}}
						/>
					)}
				</For>
			</div>
			<Show when={more().length}>
				<TranslatorFormats formats={more()} selected={tr()} onPick={setTr} />
			</Show>
			<Checkbox checked={notes()} onChange={setNotes} label="Include notes" />
			<Show when={format() === "csv" && notes()}>
				<Txt class="text-xs text-muted-foreground">Notes go into the Notes column as plain text.</Txt>
			</Show>
			<Show when={format() === "rdf"}>
				<Txt class="text-xs text-muted-foreground">
					The folder also gets the attachment files, in files/1, files/2…, the way Zotero writes them.
				</Txt>
			</Show>
			<Footer>
				<Button variant="outline" size="sm" onClick={p.close}>
					Cancel
				</Button>
				<Button variant="primary" size="sm" disabled={busy()} onClick={() => void submit()}>
					{busy() ? "Exporting…" : "Export…"}
				</Button>
			</Footer>
		</div>
	);
}

export const openExportDialog = (target: ExportTarget) =>
	openDialog<void>((close) => <ExportDialog target={target} close={() => close()} />, {
		title: target.kind === "items" ? "Export Items" : "Export Collection",
		width: 400,
	});

/** Settings > Export: the defaults the dialog starts with. */
export function ExportSettings(): JSX.Element {
	return (
		<SettingsBody>
			<SettingRow label="Default export format" description="Preselected in the Export Items and Export Collection dialogs.">
				<Select<ExportFormat>
					value={exportFormat()}
					onChange={setExportFormat}
					width={200}
					options={EXPORT_FORMATS.map((f) => ({ value: f.id, label: f.label, hint: f.hint }))}
				/>
			</SettingRow>
			<SettingRow label="Include notes" description="Export notes together with the items by default.">
				<Switch checked={exportNotes()} onChange={setExportNotes} />
			</SettingRow>
		</SettingsBody>
	);
}
