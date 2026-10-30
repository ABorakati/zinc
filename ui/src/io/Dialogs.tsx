import { createSignal, For, Show, type Component } from "solid-js";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { EXPORT_FORMATS, exportTarget, runExport, setExportTarget, type ExportFormat, type ExportTarget } from "./client";

const FORMAT_KEY = "zn.export.format.v1";
const NOTES_KEY = "zn.export.notes.v1";
const loadFormat = (): ExportFormat => {
	try {
		const v = localStorage.getItem(FORMAT_KEY);
		if (EXPORT_FORMATS.some((f) => f.id === v)) return v as ExportFormat;
	} catch { /* ignore */ }
	return "bibtex";
};
const loadNotes = (): boolean => {
	try { return localStorage.getItem(NOTES_KEY) === "1"; } catch { return false; }
};

const close = () => setExportTarget(null);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

const ExportDialog: Component<{ target: ExportTarget }> = (p) => {
	const [format, setFormat] = createSignal<ExportFormat>(loadFormat());
	const [notes, setNotes] = createSignal(loadNotes());
	const [busy, setBusy] = createSignal(false);
	const what = () => (p.target.kind === "items" ? plural(p.target.keys.length, "selected item") : `the collection "${p.target.name}" and its subcollections`);
	async function submit() {
		if (busy()) return;
		try {
			localStorage.setItem(FORMAT_KEY, format());
			localStorage.setItem(NOTES_KEY, notes() ? "1" : "0");
		} catch { /* ignore */ }
		setBusy(true);
		const ok = await runExport(p.target, format(), notes());
		setBusy(false);
		if (ok) close();
	}
	return (
		<Dialog open onOpenChange={(o) => !o && close()}>
			<DialogContent class="max-w-sm">
				<DialogHeader>
					<DialogTitle>{p.target.kind === "items" ? "Export Items" : "Export Collection"}</DialogTitle>
					<DialogDescription>Save {what()} as a file.</DialogDescription>
				</DialogHeader>
				<div class="flex flex-col gap-1" role="radiogroup" aria-label="Format">
					<For each={EXPORT_FORMATS}>
						{(f) => (
							<label class="flex cursor-pointer items-baseline gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent has-[:checked]:bg-accent">
								<input type="radio" name="zn-export-format" class="accent-primary" checked={format() === f.id} onChange={() => setFormat(f.id)} />
								<span class="font-medium">{f.label}</span>
								<span class="text-xs text-muted-foreground">{f.hint}</span>
							</label>
						)}
					</For>
				</div>
				<Checkbox checked={notes()} onChange={setNotes} label={<span class="text-sm">Include notes</span>} />
				<Show when={format() === "csv" && notes()}>
					<p class="text-xs text-muted-foreground">Notes go into the Notes column as plain text.</p>
				</Show>
				<DialogFooter class="gap-2">
					<Button variant="outline" size="sm" onClick={close}>Cancel</Button>
					<Button size="sm" disabled={busy()} onClick={() => void submit()}>{busy() ? "Exporting…" : "Export"}</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

export const IoDialogs: Component = () => <Show when={exportTarget()}>{(t) => <ExportDialog target={t()} />}</Show>;
