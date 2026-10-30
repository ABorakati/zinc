// General + Library (item list) settings.
import { createMemo, For, Show } from "solid-js";
import { ArrowDown, ArrowUp, Library, SlidersHorizontal, X } from "lucide-solid";
import { Button } from "~/components/ui/button";
import { cardLayout, type CreatorsMode, type Density } from "~/cards/layout";
import { CustomizeRows } from "~/cards/Customize";
import { columnLayout } from "~/columns/layout";
import { DEFAULT_COLUMNS, labelOf, MENU_COLUMNS } from "~/columns/defs";
import { QUICK_MODES } from "~/searches/QuickSearchMode";
import { store, type QMode, type ViewMode } from "~/store";
import { Segmented, Select, Switch } from "../controls";
import { autoRetrieveMetadata, defaultReader, READERS, setAutoRetrieveMetadata, refsOpen, setDefaultReader, setRefsOpen, setShowAutoTags, setUnloadTabsMinutes, showAutoTags, UNLOAD_CHOICES, unloadTabsMinutes, type PdfReader } from "../prefs";
import { registerSection, registerSettings } from "../registry";

registerSection({ id: "general", label: "General", icon: SlidersHorizontal, order: 10, description: "How items open and what the main window shows.", keywords: ["preferences", "options"] });
registerSection({ id: "library", label: "Library", icon: Library, order: 20, description: "The item list: table columns and card layout.", keywords: ["item list", "items", "view"] });

// ---- columns editor: the visible columns in order, plus a picker for the rest
const ColumnsEditor = () => {
	const ids = columnLayout.ids;
	const hidden = createMemo(() => MENU_COLUMNS.filter((id) => !ids().includes(id)));
	const resetDefault = () => {
		for (const id of ids()) if (!DEFAULT_COLUMNS.includes(id)) columnLayout.toggle(id, false);
		DEFAULT_COLUMNS.forEach((id, i) => { columnLayout.toggle(id, true); columnLayout.move(id, i); });
	};
	return (
		<div class="space-y-2" data-testid="settings-columns">
			<ul class="grid gap-1 sm:grid-cols-2" aria-label="Visible columns">
				<For each={ids()}>{(id, i) => (
					<li class="flex items-center gap-1 rounded-md border bg-background py-0.5 pl-2 pr-0.5 text-xs">
						<span class="min-w-0 flex-1 truncate">{labelOf(id)}</span>
						<button type="button" class="rounded p-1 hover:bg-accent disabled:opacity-30" aria-label={`Move ${labelOf(id)} earlier`} disabled={i() === 0}
							onClick={() => columnLayout.move(id, i() - 1)}><ArrowUp class="size-3" /></button>
						<button type="button" class="rounded p-1 hover:bg-accent disabled:opacity-30" aria-label={`Move ${labelOf(id)} later`} disabled={i() === ids().length - 1}
							onClick={() => columnLayout.move(id, i() + 1)}><ArrowDown class="size-3" /></button>
						<button type="button" class="rounded p-1 hover:bg-accent disabled:opacity-30" aria-label={`Hide ${labelOf(id)}`} disabled={id === "title"}
							onClick={() => columnLayout.toggle(id, false)}><X class="size-3" /></button>
					</li>
				)}</For>
			</ul>
			<div class="flex flex-wrap items-center gap-2">
				<select
					aria-label="Add a column"
					class="h-7 rounded-md border border-input bg-background px-1.5 text-xs"
					value=""
					onChange={(e) => { if (e.currentTarget.value) columnLayout.toggle(e.currentTarget.value, true); e.currentTarget.value = ""; }}
				>
					<option value="">Add column…</option>
					<For each={hidden()}>{(id) => <option value={id}>{labelOf(id)}</option>}</For>
				</select>
				<Button variant="outline" size="sm" class="h-7 px-2 text-xs" onClick={() => columnLayout.restoreOrder()}>Restore column order</Button>
				<Button variant="outline" size="sm" class="h-7 px-2 text-xs" onClick={resetDefault}>Default columns</Button>
			</div>
		</div>
	);
};

const CREATORS: { value: CreatorsMode; label: string }[] = [
	{ value: "full", label: "Full list" },
	{ value: "short", label: "3 + et al." },
	{ value: "summary", label: "Summary" },
	{ value: "off", label: "Hidden" },
];
const DENSITY: { value: Density; label: string }[] = [
	{ value: "comfortable", label: "Comfortable" },
	{ value: "compact", label: "Compact" },
];

registerSettings([
	// ---------------------------------------------------------------- General
	{
		id: "general.pdfReader", section: "general", label: "Open PDFs in", layout: "block",
		description: "Which reader a PDF opens in. Applies to new tabs; EPUBs and snapshots always use Zotero's reader.",
		keywords: ["pdf", "reader", "viewer", "zotero next", "default reader", "open attachment"],
		control: () => (
			<Segmented<PdfReader> label="Open PDFs in" value={defaultReader()} onChange={setDefaultReader}
				options={READERS.map((r) => ({ value: r.id, label: r.label, hint: r.hint }))} />
		),
	},
	{
		id: "general.quickSearch", section: "general", label: "Quick search mode",
		description: "What the filter box above the item list searches.",
		keywords: ["search", "filter", "title creator year", "all fields", "everything", "tags", "notes"],
		control: () => (
			<Select<QMode> label="Quick search mode" value={store.qmode()} onChange={store.setQMode}
				options={QUICK_MODES.map((m) => ({ value: m.mode, label: m.label, hint: m.hint }))} />
		),
	},
	{
		id: "general.autoTags", section: "general", label: "Show automatic tags",
		description: "List tags that importers and translators added automatically in the tag selector.",
		keywords: ["tags", "tag selector", "automatic", "display all tags"],
		control: () => <Switch label="Show automatic tags" checked={showAutoTags()} onChange={setShowAutoTags} />,
	},
	{
		id: "general.references", section: "general", label: "Show references beside Zotero reader tabs",
		description: "The references panel next to papers opened in Zotero's reader (the Zotero Next reader has its own References tab).",
		keywords: ["references panel", "bibliography", "citations", "side panel"],
		control: () => <Switch label="Show references panel" checked={refsOpen()} onChange={setRefsOpen} />,
	},
	{
		id: "general.unloadTabs", section: "general", label: "Unload tabs after",
		description: "Free memory by unloading reader tabs you have not looked at for a while. The tab stays in the bar and reopens where you left off; the active tab is never unloaded.",
		keywords: ["memory", "ram", "idle", "reader tabs", "suspend", "performance"],
		control: () => (
			<Select<string> label="Unload tabs after" value={String(unloadTabsMinutes())} onChange={(v) => setUnloadTabsMinutes(Number(v))}
				options={UNLOAD_CHOICES.map((m) => ({ value: String(m), label: m === 0 ? "Never" : `${m} minutes` }))} />
		),
	},
	{
		id: "general.attachPdfs", section: "general", label: "Automatically attach associated PDFs when adding items",
		keywords: ["add item", "identifier", "doi", "isbn", "import"], unavailable: true,
	},
	{
		id: "general.retrieveMetadata", section: "general", label: "Automatically retrieve metadata for PDFs",
		description: "Look up PDFs you add as standalone attachments (drag and drop, Add Attachment) and create their parent item. Right-click a PDF for Retrieve Metadata for PDF.",
		keywords: ["recognize pdf", "import", "drag and drop", "retrieve metadata", "parent item"],
		control: () => <Switch label="Automatically retrieve metadata for PDFs" checked={autoRetrieveMetadata()} onChange={setAutoRetrieveMetadata} />,
	},
	{
		id: "general.autoTag", section: "general", label: "Automatically tag items with keywords and subject headings",
		keywords: ["import", "tags"], unavailable: true,
	},
	{
		id: "general.groupBy", section: "general", label: "Group by", description: "Show items grouped (for example by item type) in the item list.",
		keywords: ["grouping", "item list"], unavailable: true,
	},

	// ---------------------------------------------------------------- Library
	{
		id: "library.viewMode", section: "library", group: "View", label: "Default view",
		description: "Show items as a table or as cards. This is also the view the library opens in.",
		keywords: ["table", "cards", "list", "layout", "default view"],
		control: () => (
			<Segmented<ViewMode> label="Default view" value={store.viewMode()} onChange={store.setViewMode}
				options={[{ value: "table", label: "Table" }, { value: "cards", label: "Cards" }]} />
		),
	},
	{
		id: "library.columns", section: "library", group: "Table", label: "Columns", layout: "block",
		description: "Which columns the item table shows and in what order. Resize columns by dragging headers; right-click a header for the same list.",
		keywords: ["table", "column picker", "visible columns", "column order", "fields", "title", "creator", "year", "date added", "restore column order"],
		control: () => <ColumnsEditor />,
	},
	{
		id: "library.cardCreators", section: "library", group: "Cards", label: "Authors on cards",
		description: "How much of the creator list each card shows.",
		keywords: ["card", "authors", "creators", "et al"],
		control: () => <Select<CreatorsMode> label="Authors on cards" value={cardLayout.layout().creators} onChange={(v) => cardLayout.set("creators", v)} options={CREATORS} />,
	},
	{
		id: "library.cardDensity", section: "library", group: "Cards", label: "Card density",
		description: "Comfortable or compact spacing.",
		keywords: ["card", "spacing", "compact", "comfortable"],
		control: () => <Segmented<Density> label="Card density" value={cardLayout.layout().density} onChange={(v) => cardLayout.set("density", v)} options={DENSITY} />,
	},
	{
		id: "library.cardStar", section: "library", group: "Cards", label: "Star toggle on cards",
		keywords: ["card", "favourite", "starred"],
		control: () => <Switch label="Star toggle on cards" checked={cardLayout.layout().star} onChange={(v) => cardLayout.set("star", v)} />,
	},
	{
		id: "library.cardTags", section: "library", group: "Cards", label: "Tag badges on cards",
		description: "Coloured tags next to the title.",
		keywords: ["card", "tags", "colour", "badges"],
		control: () => <Switch label="Tag badges on cards" checked={cardLayout.layout().tags} onChange={(v) => cardLayout.set("tags", v)} />,
	},
	{
		id: "library.cardIcons", section: "library", group: "Cards", label: "Attachment icons on cards",
		description: "Notes, PDF and attachment indicators.",
		keywords: ["card", "icons", "notes", "pdf", "attachments"],
		control: () => <Switch label="Attachment icons on cards" checked={cardLayout.layout().icons} onChange={(v) => cardLayout.set("icons", v)} />,
	},
	{
		id: "library.cardRows", section: "library", group: "Cards", label: "Customise card rows",
		description: "Choose and order the fields on the details line of each card.",
		keywords: ["card", "details line", "meta", "fields", "publication", "year", "item type"],
		control: () => (
			<div class="flex items-center gap-2">
				<CustomizeRows />
				<Show when={cardLayout.layout().meta.length}><span class="text-xs text-muted-foreground">{cardLayout.layout().meta.length} fields</span></Show>
			</div>
		),
	},
]);
