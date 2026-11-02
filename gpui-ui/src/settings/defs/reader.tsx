// Reader: defaults of the native PDF viewer. The reflowed "reading view" of the web UI's second reader does not exist in the
// native reader, so its settings are listed as not available.
import { Btn, Choice } from "../controls";
import { readerPrefs, ZOOM_CHOICES, zoomLabel, type PageAppearance, type SidebarStart } from "../readerPrefs";
import { registerSection, registerSettings } from "../registry";

registerSection({ id: "reader", label: "Reader", icon: "file-text", order: 30, description: "Defaults of the PDF reader.", keywords: ["reader", "pdf", "viewer"] });

const SIDEBAR: { value: SidebarStart; label: string }[] = [
	{ value: "remember", label: "As I left it" },
	{ value: "open", label: "Always open" },
	{ value: "closed", label: "Always closed" },
];
const PAGES: { value: PageAppearance; label: string; hint: string }[] = [
	{ value: "app", label: "Follow the app theme", hint: "Dark pages in dark mode" },
	{ value: "normal", label: "Normal", hint: "White pages as in the PDF" },
	{ value: "dark", label: "Dark", hint: "Inverted pages" },
	{ value: "sepia", label: "Sepia", hint: "Warm paper tint" },
];

registerSettings([
	{
		id: "reader.zoom", section: "reader", label: "Default zoom",
		description: "Zoom for a PDF opened for the first time.",
		keywords: ["fit width", "fit page", "scale", "magnification", "percent"],
		control: () => (
			<Choice<string> value={readerPrefs.zoomKey()} onChange={readerPrefs.setZoomKey} options={ZOOM_CHOICES.map((v) => ({ value: v, label: zoomLabel(v) }))} width={160} />
		),
	},
	{
		id: "reader.pages", section: "reader", label: "Page appearance",
		description: "How the PDF pages are tinted.",
		keywords: ["theme", "dark mode", "night", "sepia", "colour", "background", "invert"],
		control: () => <Choice<PageAppearance> value={readerPrefs.pageAppearance()} onChange={readerPrefs.setPageAppearance} options={PAGES} width={220} />,
	},
	{
		id: "reader.sidebar", section: "reader", label: "Side panel on open",
		description: "Outline and thumbnails.",
		keywords: ["sidebar", "outline", "thumbnails", "panel", "contents"],
		control: () => <Choice<SidebarStart> value={readerPrefs.sidebar()} onChange={readerPrefs.setSidebar} options={SIDEBAR} width={160} />,
	},
	{
		id: "reader.reset", section: "reader", label: "Restore reader defaults",
		keywords: ["reset"],
		control: () => <Btn onClick={readerPrefs.reset}>Restore defaults</Btn>,
	},
	{ id: "reader.scrollMode", section: "reader", label: "Scroll mode and page layout", description: "Vertical, horizontal, wrapped or two-page spreads.", keywords: ["spread", "layout", "scrolling"], unavailable: true },
	{ id: "reader.readingView", section: "reader", group: "Reading view", label: "Reading view", description: "The reflowed article view: font, size, line spacing, width, theme.", keywords: ["reflow", "typography", "font", "article"], unavailable: "Not in the native reader" },
]);
