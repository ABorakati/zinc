// PDF viewer + Reading view settings of the zotero-next reader (reader-next/). Stored in localStorage under the keys the
// reader reads; open reader tabs follow live through the `storage` event (see settings/readerPrefs.ts).
import { BookOpenText, FileText } from "lucide-solid";
import { Button } from "~/components/ui/button";
import { FONTS, LIMITS, type FontKind, type ThemeKind } from "../../../../reader-next/src/reflow/settings";
import type { SidebarStart } from "../../../../reader-next/src/viewer/prefs";
import { Segmented, Select, Slider, Switch, TextField } from "../controls";
import { appearance, reading, resetReading, resetViewer, setAppearance, setReading, setViewer, viewer, type AppearanceMode } from "../readerPrefs";
import { registerSection, registerSettings } from "../registry";

registerSection({ id: "viewer", label: "PDF viewer", icon: FileText, order: 30, description: "Defaults of the Zotero Next PDF reader.", keywords: ["reader", "pdf", "zotero next"] });
registerSection({ id: "reading", label: "Reading view", icon: BookOpenText, order: 35, description: "The reflowed article view of the Zotero Next reader.", keywords: ["reader", "reflow", "typography", "zotero next"] });

const ZOOMS = ["width", "page", "0.5", "0.75", "1", "1.25", "1.5", "2", "3"];
const zoomLabel = (v: string) => (v === "width" ? "Fit width" : v === "page" ? "Fit page" : `${Math.round(+v * 100)}%`);
/** Stored zoom (mode or scale) -> nearest option value. */
const zoomValue = (): string => {
	const z = viewer().zoom;
	if (typeof z === "string") return z;
	return ZOOMS.slice(2).reduce((best, o) => (Math.abs(+o - z) < Math.abs(+best - z) ? o : best));
};

const APPEARANCE: { value: AppearanceMode; label: string; hint: string }[] = [
	{ value: "normal", label: "Normal", hint: "White pages as in the PDF" },
	{ value: "dark", label: "Dark", hint: "Inverted pages, images keep their colours" },
	{ value: "sepia", label: "Sepia", hint: "Warm paper tint" },
	{ value: "custom", label: "Custom colour", hint: "Tint pages with a colour of your choice" },
	{ value: "reading", label: "Match reading view", hint: "Use the reading view's background and text colours" },
];
const SIDEBAR: { value: SidebarStart; label: string }[] = [
	{ value: "remember", label: "As I left it" },
	{ value: "open", label: "Always open" },
	{ value: "closed", label: "Always closed" },
];
const THEMES: { value: ThemeKind; label: string }[] = [
	{ value: "light", label: "Light" },
	{ value: "sepia", label: "Sepia" },
	{ value: "dark", label: "Dark" },
	{ value: "custom", label: "Custom" },
];
const FONT_OPTIONS: { value: FontKind; label: string }[] = [
	...FONTS.map((f) => ({ value: f.id as FontKind, label: `${f.label} (${f.group})` })),
	{ value: "custom", label: "Other installed font…" },
];

registerSettings([
	// ---------------------------------------------------------------- PDF viewer
	{
		id: "viewer.zoom", section: "viewer", label: "Default zoom",
		description: "Zoom for a PDF opened for the first time. Documents you have opened before keep their own zoom and position.",
		keywords: ["fit width", "fit page", "scale", "magnification", "percent"],
		control: () => (
			<Select label="Default zoom" value={zoomValue()} onChange={(v) => setViewer({ zoom: v === "width" || v === "page" ? v : +v })}
				options={ZOOMS.map((v) => ({ value: v, label: zoomLabel(v) }))} />
		),
	},
	{
		id: "viewer.appearance", section: "viewer", label: "Page appearance",
		description: "How the PDF pages are tinted. Also changeable from the palette button in the reader; changes apply to open tabs.",
		keywords: ["theme", "dark mode", "night", "sepia", "colour", "background", "invert"],
		control: () => (
			<Select<AppearanceMode> label="Page appearance" value={appearance().mode} onChange={(mode) => setAppearance({ mode })}
				options={APPEARANCE.map((a) => ({ value: a.value, label: a.label, hint: a.hint }))} />
		),
	},
	{
		id: "viewer.appearanceColor", section: "viewer", label: "Custom page colour",
		description: "Used when the page appearance is Custom colour.",
		keywords: ["background", "tint", "colour", "color"],
		control: () => (
			<input type="color" aria-label="Custom page colour" class="h-7 w-12 cursor-pointer rounded border border-input bg-transparent p-0.5 disabled:opacity-50"
				disabled={appearance().mode !== "custom"} value={appearance().custom} onInput={(e) => setAppearance({ custom: e.currentTarget.value })} />
		),
	},
	{
		id: "viewer.sidebar", section: "viewer", label: "Side panel on open",
		description: "Outline, thumbnails and the reader's other tabs.",
		keywords: ["sidebar", "outline", "thumbnails", "panel", "contents"],
		control: () => <Select<SidebarStart> label="Side panel on open" value={viewer().sidebar} onChange={(sidebar) => setViewer({ sidebar })} options={SIDEBAR} />,
	},
	{
		id: "viewer.openReading", section: "viewer", label: "Open PDFs in the reading view",
		description: "Start in the reflowed article view instead of the page view. You can switch back with the toolbar button.",
		keywords: ["reflow", "reading view", "default", "article", "open by default"],
		control: () => <Switch label="Open PDFs in the reading view" checked={reading().openByDefault} onChange={(openByDefault) => setReading({ openByDefault })} />,
	},
	{
		id: "viewer.reset", section: "viewer", label: "Restore viewer defaults",
		description: "Default zoom, side panel and page appearance. Reading view settings are separate.",
		keywords: ["reset"],
		control: () => (
			<Button variant="outline" size="sm" class="h-7 px-2 text-xs" onClick={() => { resetViewer(); setAppearance({ mode: "normal" }); }}>Restore defaults</Button>
		),
	},
	{
		id: "viewer.scrollMode", section: "viewer", label: "Scroll mode and page layout",
		description: "Vertical, horizontal, wrapped or two-page spreads.", keywords: ["spread", "layout", "scrolling"], unavailable: true,
	},

	// ---------------------------------------------------------------- Reading view
	{
		id: "reading.font", section: "reading", label: "Font",
		description: "Typeface of the article text. Bookerly is used only when installed on this computer.",
		keywords: ["typeface", "serif", "sans", "charter", "literata", "inter", "georgia", "dyslexic", "atkinson", "lexend"],
		control: () => <Select<FontKind> label="Font" value={reading().font} onChange={(font) => setReading({ font })} options={FONT_OPTIONS} />,
	},
	{
		id: "reading.customFont", section: "reading", label: "Other font name",
		description: "Any font installed on this computer, by name. Used when Font is set to \"Other installed font\".",
		keywords: ["custom font", "installed font"],
		control: () => (
			<TextField label="Other font name" placeholder="e.g. Palatino Linotype" value={reading().customFont} disabled={reading().font !== "custom"}
				onCommit={(customFont) => setReading({ customFont })} />
		),
	},
	{
		id: "reading.size", section: "reading", label: "Text size",
		keywords: ["font size", "bigger", "smaller", "px"],
		control: () => <Slider label="Text size" min={LIMITS.size[0]} max={LIMITS.size[1]} step={1} value={reading().size} onChange={(size) => setReading({ size })} format={(v) => `${v} px`} />,
	},
	{
		id: "reading.lineHeight", section: "reading", label: "Line spacing",
		keywords: ["leading", "line height", "spacing"],
		control: () => (
			<Slider label="Line spacing" min={LIMITS.lineHeight[0]} max={LIMITS.lineHeight[1]} step={0.05} value={reading().lineHeight}
				onChange={(lineHeight) => setReading({ lineHeight })} format={(v) => v.toFixed(2)} />
		),
	},
	{
		id: "reading.width", section: "reading", label: "Text width",
		description: "Maximum width of the text column.",
		keywords: ["column", "margins", "measure", "line length"],
		control: () => <Slider label="Text width" min={LIMITS.width[0]} max={LIMITS.width[1]} step={10} value={reading().width} onChange={(width) => setReading({ width })} format={(v) => `${v} px`} />,
	},
	{
		id: "reading.justify", section: "reading", label: "Justify text",
		keywords: ["alignment", "align", "justified", "ragged"],
		control: () => <Switch label="Justify text" checked={reading().justify} onChange={(justify) => setReading({ justify })} />,
	},
	{
		id: "reading.theme", section: "reading", label: "Theme",
		description: "Background and text colours of the reading view.",
		keywords: ["dark mode", "light", "sepia", "night", "colour", "background"],
		control: () => <Segmented<ThemeKind> label="Reading theme" value={reading().theme} onChange={(theme) => setReading({ theme })} options={THEMES} />,
	},
	{
		id: "reading.customBg", section: "reading", label: "Custom background",
		description: "Used when the theme is Custom; the text colour is chosen for contrast.",
		keywords: ["colour", "color", "background", "tint"],
		control: () => (
			<input type="color" aria-label="Custom reading background" class="h-7 w-12 cursor-pointer rounded border border-input bg-transparent p-0.5 disabled:opacity-50"
				disabled={reading().theme !== "custom"} value={reading().customBg} onInput={(e) => setReading({ customBg: e.currentTarget.value })} />
		),
	},
	{
		id: "reading.reset", section: "reading", label: "Restore reading view defaults",
		description: "Typography and theme. \"Open PDFs in the reading view\" is kept.",
		keywords: ["reset", "default"],
		control: () => <Button variant="outline" size="sm" class="h-7 px-2 text-xs" onClick={resetReading}>Restore defaults</Button>,
	},
]);
