// Reader: defaults of the native PDF viewer, and of its reflowed "Reading view" (the article view of the web reader: the toolbar's
// "Reading view" button; font, size, spacing, width and theme are also in the view's own "Aa" panel).
import { Btn, Choice, Toggle } from "../controls";
import { READING_FONTS, readerPrefs, readingView, ZOOM_CHOICES, zoomLabel, type PageAppearance, type ReadingTheme, type ScrollModePref, type SidebarStart, type SpreadModePref } from "../readerPrefs";
import { registerSection, registerSettings } from "../registry";

registerSection({ id: "reader", label: "Reader", icon: "file-text", order: 30, description: "Defaults of the PDF reader and its Reading view.", keywords: ["reader", "pdf", "viewer", "reading view"] });

const SCROLL: { value: ScrollModePref; label: string; hint: string }[] = [
	{ value: "vertical", label: "Vertical scrolling", hint: "Pages one below the other" },
	{ value: "horizontal", label: "Horizontal scrolling", hint: "Pages side by side" },
	{ value: "wrapped", label: "Wrapped scrolling", hint: "As many pages per row as fit" },
];
const SPREADS: { value: SpreadModePref; label: string; hint: string }[] = [
	{ value: "none", label: "No spreads", hint: "One page at a time" },
	{ value: "odd", label: "Odd spreads", hint: "Pages 1-2, 3-4, …" },
	{ value: "even", label: "Even spreads", hint: "Page 1 alone, then 2-3, 4-5, …" },
];

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
		id: "reader.scrollMode", section: "reader", label: "Scroll mode",
		description: "How the pages of a PDF opened for the first time are laid out. Change it for one document in the reader's View menu.",
		keywords: ["layout", "scrolling", "vertical", "horizontal", "wrapped", "page layout"],
		control: () => <Choice<ScrollModePref> value={readerPrefs.scrollMode()} onChange={readerPrefs.setScrollMode} options={SCROLL} width={200} />,
	},
	{
		id: "reader.spreadMode", section: "reader", label: "Page spreads",
		description: "Show two pages side by side, like an open book.",
		keywords: ["spread", "two-page", "two page", "facing pages", "book", "odd", "even", "layout"],
		control: () => <Choice<SpreadModePref> value={readerPrefs.spreadMode()} onChange={readerPrefs.setSpreadMode} options={SPREADS} width={200} />,
	},
	{
		id: "reader.reset", section: "reader", label: "Restore reader defaults",
		keywords: ["reset"],
		control: () => <Btn onClick={readerPrefs.reset}>Restore defaults</Btn>,
	},

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
