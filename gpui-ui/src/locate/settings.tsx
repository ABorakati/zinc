// Settings > General > Locate: the search engines of the Locate menu (list with enable / reorder / remove), adding one from an
// OpenSearch description URL, importing Zotero's own locate/engines.json (read-only) and restoring the defaults.
// Registered into the general section from settings/index.ts, after defs/general (so the rows sit under its "Locate" group).
import { createSignal, For, Show, type JSX } from "solid-js";
import { Txt, t } from "../shell/kit";
import { call, errMsg } from "../shell/net";
import { Button, TextInput, Switch, toast } from "../ui";
import { Btn } from "../settings/controls";
import { registerSettings } from "../settings/registry";
import { fetchOpenSearch } from "./engines";
import {
	addEngine, engines, importFromZotero, moveEngine, removeEngine, restoreDefaultEngines, setEngineEnabled,
} from "./engines-store";

/** The Zotero data folder the core reports; null when the core cannot be reached (the import then tries ~/Zotero). */
async function zoteroDataDir(): Promise<string | null> {
	try { return (await call<{ zotero: { dataDir: string } }>("GET", "/api/files/settings")).zotero.dataDir; } catch { return null; }
}

const host = (template: string): string => { try { return new URL(template.replace(/{[^}]*}/g, "x")).host; } catch { return template; } };

function EngineList(): JSX.Element {
	return (
		<div style={{ ...t("flex flex-col"), width: "100%", maxWidth: 560 }}>
			<Show when={engines().length} fallback={<Txt cls="text-xs text-muted-foreground">No engines. Add one below or restore the defaults.</Txt>}>
				<For each={engines()}>
					{(e, i) => (
						<div style={{ ...t("flex items-center gap-3 py-1.5"), width: "100%" }}>
							<Switch checked={e.enabled} onChange={(v) => setEngineEnabled(i(), v)} />
							<div style={{ ...t("flex flex-col"), flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0, opacity: e.enabled ? 1 : 0.55 }}>
								<Txt cls="text-sm text-foreground" wrap={false}>{e.name}</Txt>
								<Txt cls="text-[11px] text-muted-foreground" wrap={false}>{host(e.urlTemplate) + (e.method === "POST" ? " (POST: not supported)" : "")}</Txt>
							</div>
							<Button variant="ghost" size="icon" icon="chevron-up" disabled={i() === 0} onClick={() => moveEngine(i(), -1)} />
							<Button variant="ghost" size="icon" icon="chevron-down" disabled={i() === engines().length - 1} onClick={() => moveEngine(i(), 1)} />
							<Button variant="ghost" size="icon" icon="trash-2" onClick={() => removeEngine(i())} />
						</div>
					)}
				</For>
			</Show>
		</div>
	);
}

function AddControl(): JSX.Element {
	const [url, setUrl] = createSignal("");
	const [busy, setBusy] = createSignal(false);
	const add = async () => {
		if (busy() || !url().trim()) return;
		setBusy(true);
		try {
			const e = await fetchOpenSearch(url());
			addEngine(e);
			setUrl("");
			toast(`Added ${e.name}`, { kind: "success", description: "It is in the Locate menu now." });
		} catch (err) {
			toast("Could not add that engine", { kind: "error", description: errMsg(err) });
		} finally { setBusy(false); }
	};
	return (
		<div style={{ ...t("flex items-center gap-2"), width: "100%", maxWidth: 560 }}>
			<TextInput value={url()} onInput={setUrl} onEnter={() => void add()} placeholder="https://example.org/opensearch.xml" style={{ flexGrow: 1 }} />
			<Btn disabled={busy() || !url().trim()} onClick={() => void add()}>{busy() ? "Adding…" : "Add engine from URL…"}</Btn>
		</div>
	);
}

function ImportControl(): JSX.Element {
	const [busy, setBusy] = createSignal(false);
	const run = async () => {
		if (busy()) return;
		setBusy(true);
		try {
			const r = importFromZotero(await zoteroDataDir());
			toast("Imported from Zotero", { kind: "success", description: `${r.added} added, ${r.replaced} replaced.` });
		} catch (err) {
			toast("Could not import", { kind: "error", description: errMsg(err) });
		} finally { setBusy(false); }
	};
	return (
		<div style={t("flex flex-wrap items-center gap-2")}>
			<Btn disabled={busy()} onClick={() => void run()}>Import from Zotero</Btn>
			<Btn onClick={() => { restoreDefaultEngines(); toast("Default engines restored", { kind: "success" }); }}>Restore defaults</Btn>
		</div>
	);
}

registerSettings([
	{
		id: "general.locateEngines", section: "general", group: "Locate", label: "Locate engines",
		description: "Search engines in an item's Locate menu, in this order. Zotero's own list is only read, never changed.",
		keywords: ["locate", "engines", "search engine", "opensearch", "google scholar", "worldcat", "lookup"],
		layout: "block",
		control: () => <EngineList />,
	},
	{
		id: "general.locateAdd", section: "general", group: "Locate", label: "Add a Locate engine",
		description: "The address of an OpenSearch description (an XML file a search site publishes).",
		keywords: ["locate", "engine", "opensearch", "add", "url", "xml"],
		layout: "block",
		control: () => <AddControl />,
	},
	{
		id: "general.locateImport", section: "general", group: "Locate", label: "Import or reset engines",
		description: "Import copies the engines from Zotero's data folder (locate/engines.json); a same-named engine is replaced.",
		keywords: ["locate", "engines", "import", "zotero", "restore", "defaults", "reset"],
		control: () => <ImportControl />,
	},
]);
