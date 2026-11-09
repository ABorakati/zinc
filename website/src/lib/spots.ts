// Hotspots on the app screenshots: numbered dots that, on hover, focus or tap, zoom the screenshot towards that part and show
// what it does. Keyed by the screenshot's base name (without -light/-dark: both captures share one layout). x and y are percentages
// of the image. Wording follows the user guide (docs/user-guide/*.md).

/** `shows`: a screenshot of the app after that control is clicked; selecting the spot swaps to it instead of zooming. */
export interface Spot { x: number; y: number; title: string; text: string; shows?: string }

export const SPOTS: Record<string, Spot[]> = {
	"library-cards": [
		{ x: 8.6, y: 49, title: "Collections your way", text: "Give collections colours and icons, pin favourites, and group them into sections you name: here Pinned, Projects and Topics." },
		{ x: 61.4, y: 9.6, title: "Cards or Classic", text: "Switch between cards and a sortable table at any time.", shows: "classic-table-dark.png" },
		{ x: 40, y: 15, title: "Group and sort", text: "Group by year, item type or publication, and sort on up to four levels." },
		{ x: 65.7, y: 15, title: "Customise", text: "Choose what each card shows, and Comfortable or Compact density." },
		{ x: 24.3, y: 27.5, title: "Coloured tags", text: "Tags with a colour show as badges on the card." },
		{ x: 35.7, y: 33.6, title: "One-click actions", text: "Open the PDF or web page, copy a citation, find the full text, or open notes." },
		{ x: 81.4, y: 76, title: "Citation key", text: "A Better BibTeX citation key on every item. Pin it to keep it." },
	],
	"classic-table": [
		{ x: 27, y: 18.8, title: "Your columns", text: "Pick the table's columns from Zotero's full list. The arrows mark the sort levels." },
		{ x: 21.4, y: 22.4, title: "Grouped by year", text: "Each group gets a collapsible header with a count." },
		{ x: 41.4, y: 15, title: "Multi-level sort", text: "Up to four levels: here year, then date added." },
		{ x: 85, y: 13.8, title: "Item pane", text: "Edit the details, with notes, attachments, collections, tags and related items in tabs." },
		{ x: 8.6, y: 62, title: "Sections", text: "Collections grouped into sections you name, each with its own colour and icon." },
	],
	"pdf-reader-annotations": [
		{ x: 6.8, y: 6.6, title: "Side panel", text: "Thumbnails, outline, annotations, figures and tables, the paper's references, and supplementary files." },
		{ x: 8.2, y: 31.8, title: "Annotations", text: "Every annotation with its page, comment and tags. Search them, and filter by colour or tag." },
		{ x: 57.9, y: 90.5, title: "Highlights", text: "Highlight, underline, note, ink, image and eraser, in colours. They are stored in the library, so they sync." },
		{ x: 77.9, y: 91, title: "Hover to preview", text: "Hover a figure mention or a citation to see the figure or the reference. Click to pin the card." },
		{ x: 85, y: 3, title: "Annotation tools", text: "Pick a tool and colour, then mark up the page." },
		{ x: 95, y: 3, title: "Reading view", text: "Reflow the paper into one column in your own font, size and width.", shows: "reading-view-table.png" },
	],
	"reading-view-table": [
		{ x: 50, y: 35, title: "Tables as cards", text: "Figures and tables stay in place as cards you can open." },
		{ x: 33.2, y: 72.6, title: "Linked mentions", text: "\"Table 3\" and in-text citations are links. Back returns you to where you were." },
		{ x: 97.2, y: 6.9, title: "Your typography", text: "Font, text size, line spacing and text width." },
		{ x: 8.6, y: 6.9, title: "Contents", text: "Jump to any section of the paper." },
		{ x: 2.6, y: 6.9, title: "Back to the PDF", text: "Return to the original pages, at the same place.", shows: "pdf-reader-annotations-light.png" },
	],
	"settings-reader": [
		{ x: 35.7, y: 7.2, title: "Search settings", text: "Type to find any setting." },
		{ x: 5, y: 23, title: "Sections", text: "Appearance, General, Reader, Sync, Shortcuts, Files and folders, Integrations and System." },
		{ x: 60.6, y: 29.3, title: "Page appearance", text: "How PDF pages are tinted: follow the app theme, or choose a tint." },
		{ x: 67.1, y: 70.1, title: "Reading view by default", text: "Open PDFs reflowed instead of as pages." },
		{ x: 61.3, y: 77.6, title: "Reading typography", text: "Font, text size, line spacing and text width for the reading view." },
	],
	"word-sidebar": [
		{ x: 10, y: 9.2, title: "Ribbon tab", text: "Sidebar, Add/Edit Citation, Bibliography and Refresh, in their own tab." },
		{ x: 47.3, y: 45.6, title: "Live citations", text: "Zotero-compatible citation fields: Zotero itself can still refresh and edit them." },
		{ x: 37.4, y: 69.5, title: "Bibliography", text: "Built in any CSL style, from the same styles as the app." },
		{ x: 90.9, y: 41.8, title: "Cited here", text: "The sidebar shows the item cited where the cursor is." },
		{ x: 89.7, y: 79.4, title: "Edit citation", text: "Locator, prefix, suffix and several items; split or merge citations." },
		{ x: 91.4, y: 90.7, title: "Search your library", text: "Find and insert references without opening the app." },
	],
};

export const spotsFor = (file: string): Spot[] => SPOTS[file.replace(/\.png$/, "").replace(/-(light|dark)$/, "")] ?? [];
