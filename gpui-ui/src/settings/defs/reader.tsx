// Reader: defaults of the native PDF viewer, and of its reflowed "Reading view" (the article view of the web reader: the toolbar's
// "Reading view" button; font, size, spacing, width and theme are also in the view's own "Aa" panel).
import { Btn, Choice, Toggle } from "../controls";
import { READING_FONTS, readerPrefs, readingView, ZOOM_CHOICES, zoomLabel, type PageAppearance, type ReadingTheme, type SidebarStart } from "../readerPrefs";
import { registerSection, registerSettings } from "../registry";

registerSection({ id: "reader", label: "Reader", icon: "file-text", order: 30, description: "Defaults of the PDF reader and its Reading view.", keywords: ["reader", "pdf", "viewer", "reading view"] });

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
const READING_THEMES: { value: ReadingTheme; label: string }[] = [
	{ value: "light", label: "Light" },
	{ value: "sepia", label: "Sepia" },
	{ value: "dark", label: "Dark" },
];
/** Numeric choices as select options; the current value is added when it is not one of the presets (the view's own panel steps it freely). */
const numOptions = (cur: number, presets: number[], label: (n: number) => string) =>
	[...new Set([...presets, cur])].sort((a, b) => a - b).map((n) => ({ value: String(n), label: label(n) }));

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

	// ---- Reading view
	{
		id: "reader.readingView.default", section: "reader", group: "Reading view", label: "Open PDFs in the reading view by default",
		description: "The reflowed article view instead of the PDF pages. Switch any time with the \"Reading view\" button in the reader's toolbar.",
		keywords: ["reflow", "article", "reading mode", "default view"],
		control: () => <Toggle checked={readingView.settings().openByDefault} onChange={(v) => readingView.set({ openByDefault: v })} />,
	},
	{
		id: "reader.readingView.font", section: "reader", group: "Reading view", label: "Font",
		keywords: ["typography", "typeface", "serif", "sans"],
		control: () => (
			<Choice<string> value={readingView.settings().font} onChange={(v) => readingView.set({ font: v as never })} options={READING_FONTS.map((f) => ({ value: f.id, label: f.label }))} width={200} />
		),
	},
	{
		id: "reader.readingView.size", section: "reader", group: "Reading view", label: "Text size",
		keywords: ["font size", "typography"],
		control: () => (
			<Choice<string> value={String(readingView.settings().size)} onChange={(v) => readingView.set({ size: Number(v) })} options={numOptions(readingView.settings().size, [14, 16, 17, 18, 20, 22, 24, 28], (n) => `${n} px`)} width={120} />
		),
	},
	{
		id: "reader.readingView.lineHeight", section: "reader", group: "Reading view", label: "Line spacing",
		keywords: ["leading", "typography"],
		control: () => (
			<Choice<string> value={String(readingView.settings().lineHeight)} onChange={(v) => readingView.set({ lineHeight: Number(v) })} options={numOptions(readingView.settings().lineHeight, [1.3, 1.45, 1.6, 1.8, 2], (n) => n.toFixed(2))} width={120} />
		),
	},
	{
		id: "reader.readingView.width", section: "reader", group: "Reading view", label: "Text width",
		description: "Widest the text column gets.",
		keywords: ["column", "measure", "typography"],
		control: () => (
			<Choice<string> value={String(readingView.settings().width)} onChange={(v) => readingView.set({ width: Number(v) })} options={numOptions(readingView.settings().width, [520, 600, 680, 760, 880, 1000], (n) => `${n} px`)} width={120} />
		),
	},
	{
		id: "reader.readingView.theme", section: "reader", group: "Reading view", label: "Reading theme",
		keywords: ["colour", "sepia", "dark", "background"],
		control: () => <Choice<ReadingTheme> value={readingView.settings().theme} onChange={(v) => readingView.set({ theme: v })} options={readingView.settings().theme === "custom" ? [...READING_THEMES, { value: "custom", label: "Custom colour" }] : READING_THEMES} width={160} />,
	},
	{
		id: "reader.readingView.reset", section: "reader", group: "Reading view", label: "Restore reading view defaults",
		description: "Font, size, spacing, width and theme (the choice above stays).",
		keywords: ["reset"],
		control: () => <Btn onClick={readingView.reset}>Restore defaults</Btn>,
	},
]);
