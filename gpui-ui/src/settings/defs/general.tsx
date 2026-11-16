// General: how the window starts and what the item list does by default. Settings that live in another feature's code are read
// through the shared store loosely (the list owner may rename them), and the ones the GPUI window cannot do yet say so.
import type { GroupBy, ListStore } from "../../contracts";
import { GROUP_BY, store } from "../../store";
import { leftOpen, rightOpen, setLeftOpen, setRightOpen } from "../../shell/layout";
import { Choice, Segmented, TextField, Toggle } from "../controls";
import { readState } from "../../readState";
import { registerSection, registerSettings } from "../registry";
import { openUrlResolver, setOpenUrlResolver } from "../../locate/prefs";
import { autoAttachPdfs, autoTag, setAutoAttachPdfs, setAutoTag } from "../generalPrefs";

registerSection({
	id: "general",
	label: "General",
	icon: "sliders-horizontal",
	order: 10,
	description: "How items open and what the main window shows.",
	keywords: ["preferences", "options"],
});

type QMode = "titleCreatorYear" | "fields" | "everything";
const QUICK: { value: QMode; label: string; hint: string }[] = [
	{ value: "titleCreatorYear", label: "Title, Creator, Year", hint: "Match words in the title, creators or year" },
	{ value: "fields", label: "All Fields & Tags", hint: "Match any field, creator or tag" },
	{ value: "everything", label: "Everything", hint: "Also match notes and attachment full text" },
];
const GROUPS: { value: GroupBy; label: string }[] = GROUP_BY.map((g) => ({
	value: g.id,
	label: g.id === "none" ? "No grouping" : g.label,
}));

/** The store as the list owner extends it (all optional: only what exists is used). */
type Loose = Partial<ListStore> & { qmode?: () => QMode; setQMode?: (m: QMode) => void };
const ls = (): Loose => store as unknown as Loose;

registerSettings([
	{
		id: "general.sidebar",
		section: "general",
		group: "Window",
		label: "Show the sidebar",
		description: "Collections and tags on the left of the library. The top bar button toggles it too.",
		keywords: ["panel", "collections", "left", "layout"],
		control: () => <Toggle checked={leftOpen()} onChange={setLeftOpen} />,
	},
	{
		id: "general.itemPane",
		section: "general",
		group: "Window",
		label: "Show the item pane",
		description: "Details of the selected item on the right of the library.",
		keywords: ["panel", "details", "right", "layout", "info"],
		control: () => <Toggle checked={rightOpen()} onChange={setRightOpen} />,
	},
	{
		id: "general.quickSearch",
		section: "general",
		group: "Item list",
		label: "Quick search mode",
		description: "What the filter box above the item list searches.",
		keywords: ["search", "filter", "title creator year", "all fields", "everything", "tags", "notes"],
		control: () => (
			<Choice<QMode> value={ls().qmode?.() ?? "titleCreatorYear"} options={QUICK} onChange={(m) => ls().setQMode?.(m)} width={220} />
		),
	},
	{
		id: "general.viewMode",
		section: "general",
		group: "Item list",
		label: "Default view",
		description: "Show items as cards or as a table. This is also the view the library opens in.",
		keywords: ["table", "cards", "list", "layout", "default view", "classic"],
		control: () => (
			<Segmented<"cards" | "table">
				value={ls().viewMode?.() ?? "cards"}
				onChange={(m) => ls().setViewMode?.(m)}
				options={[
					{ value: "cards", label: "Cards" },
					{ value: "table", label: "Table" },
				]}
			/>
		),
	},
	{
		id: "general.groupBy",
		section: "general",
		group: "Item list",
		label: "Group by",
		description: "Show items grouped (for example by year) in the item list.",
		keywords: ["grouping", "item list", "year", "item type"],
		control: () => (
			<Choice<GroupBy> value={ls().groupBy?.() ?? "year"} options={GROUPS} onChange={(g) => ls().setGroupBy?.(g)} width={180} />
		),
	},
	{
		id: "general.readDots",
		section: "general",
		group: "Item list",
		label: "Show unread dots",
		description: "Show a small accent dot on items you have not opened yet.",
		keywords: ["unread", "read", "dots", "status", "indicator", "new"],
		control: () => <Toggle checked={readState.enabled()} onChange={(v) => readState.setEnabled(v)} />,
	},
	{
		id: "general.openUrlResolver",
		section: "general",
		group: "Locate",
		label: "OpenURL resolver",
		description: "Your library's OpenURL address. \"Library Lookup\" in an item's Locate menu opens it with the item's details.",
		keywords: ["locate", "library lookup", "openurl", "resolver", "open url", "sfx", "alma", "link resolver", "library search"],
		layout: "block",
		control: () => (
			<TextField
				value={openUrlResolver()}
				width={380}
				placeholder="https://library.example.edu/openurl/"
				onCommit={(v) => setOpenUrlResolver(v.trim())}
			/>
		),
	},
	{
		id: "general.attachPdfs",
		section: "general",
		group: "Adding items",
		label: "Automatically attach associated PDFs when adding items",
		description: "Find and attach available full-text PDFs when adding items by identifier or importing.",
		keywords: ["add item", "identifier", "doi", "isbn", "import", "pdf", "full text"],
		control: () => <Toggle checked={autoAttachPdfs()} onChange={setAutoAttachPdfs} />,
	},
	{
		id: "general.autoTag",
		section: "general",
		group: "Adding items",
		label: "Automatically tag items with keywords and subject headings",
		description: "Add tags from keywords and subject headings found in fetched metadata or imported files.",
		keywords: ["import", "tags", "keywords", "subjects", "metadata"],
		control: () => <Toggle checked={autoTag()} onChange={setAutoTag} />,
	},
]);
