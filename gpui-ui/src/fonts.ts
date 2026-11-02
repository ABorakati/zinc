// The UI's fonts (ui/src/fonts.css) registered with GPUIX. GPUIX takes TTF/OTF bytes and names the family by what the file
// declares, so the variable Google Fonts TTFs under assets/fonts are registered as-is ("Inter", "Manrope", "IBM Plex Sans",
// "Source Sans 3", "Source Serif 4"); one variable file covers every weight (fontWeight 100..900 picks the instance).
//
// Default look (reader-next/src/viewer/theme.ts DEFAULT_THEME): Inter for the interface, Source Serif 4 for item titles
// and year headings (Tailwind `font-title`). styles.css falls back to Manrope when no theme is stored.
import { readFileSync } from "node:fs";
import { fontFamilyNames } from "./theme";

const dir = new URL("../assets/fonts/", import.meta.url);

/** Family names as the font files declare them. */
export const families = {
	inter: "Inter",
	manrope: "Manrope",
	plex: "IBM Plex Sans",
	source: "Source Sans 3",
	serif: "Source Serif 4",
} as const;

/** The two families the UI draws with: interface text and the serif for titles. Matches tw()'s font-sans / font-title. */
export const fontFamily: { sans: string; title: string } = fontFamilyNames;

/** Switch the interface font (Settings > Appearance: Inter | Manrope | IBM Plex Sans | Source Sans 3); clears nothing, call before first render. */
export function setSansFont(id: keyof typeof families | string) {
	fontFamily.sans = (families as Record<string, string>)[id] ?? id;
}

const FILES = [
	"Inter-Variable.ttf",
	"SourceSerif4-Variable.ttf",
	"SourceSerif4-Italic-Variable.ttf",
	"Manrope-Variable.ttf",
	"IBMPlexSans-Variable.ttf",
	"SourceSans3-Variable.ttf",
];

interface FontHost { registerFont?: (bytes: Buffer) => void }
const RENDER_HOST = Symbol.for("@gpuix/solid/render-host");

let done = false;
let timer: ReturnType<typeof setTimeout> | undefined;

function hostRenderer(): FontHost | undefined {
	return (globalThis as unknown as Record<symbol, { renderer?: FontHost } | undefined>)[RENDER_HOST]?.renderer;
}

function registerAll(r: FontHost): void {
	if (!r.registerFont) throw new Error("fonts: this renderer has no registerFont");
	for (const f of FILES) {
		try {
			r.registerFont(readFileSync(new URL(f, dir)));
		} catch (e) {
			console.error(`[fonts] could not register ${f}:`, e instanceof Error ? e.message : e);
		}
	}
}

/**
 * Register the fonts. Pass the renderer (`t.renderer` from createTestRoot, or `useGpuixRequired()`) when you have one.
 * With no argument it uses the renderer `render()` mounts: called before render() it waits (polling briefly) until that
 * renderer exists, so `registerFonts(); render(...)` in main.tsx works; text that already named a family repaints once it
 * is registered. Calling it again is a no-op.
 */
export function registerFonts(renderer?: FontHost): void {
	if (done) return;
	const r = renderer ?? hostRenderer();
	if (r) {
		done = true;
		registerAll(r);
		return;
	}
	if (timer) return;
	let tries = 0;
	const poll = () => {
		timer = undefined;
		if (done) return;
		const h = hostRenderer();
		if (h) {
			done = true;
			registerAll(h);
		} else if (++tries < 200) timer = setTimeout(poll, 10);
		else console.error("[fonts] no GPUIX renderer appeared; fonts not registered");
	};
	timer = setTimeout(poll, 0);
}
