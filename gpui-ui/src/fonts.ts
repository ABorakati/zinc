// The UI's fonts (ui/src/fonts.css) registered with GPUIX. GPUIX takes TTF/OTF bytes and names the family by what the file
// declares, so the variable Google Fonts TTFs under assets/fonts are registered as-is ("Inter", "Manrope", "IBM Plex Sans",
// "Source Sans 3", "Source Serif 4"); one variable file covers every weight (fontWeight 100..900 picks the instance).
//
// Default look (reader-next/src/viewer/theme.ts DEFAULT_THEME): Inter for the interface, Source Serif 4 for item titles
// and year headings (Tailwind `font-title`). styles.css falls back to Manrope when no theme is stored.
//
// Registering a font blocks the JS thread (measured: Inter ~240 ms, Source Serif 4 ~180 ms, the rest ~15 ms each, the first
// call also initialising the text system), and that thread also drives window creation. So only what the UI draws with is
// registered, and main.tsx does it AFTER the window is up and the first items are on screen (registerFontsStaged: one font per
// timer tick, so frames keep painting in between). The other sans choices (Manrope, IBM Plex Sans, Source Sans 3) are registered
// only when chosen (setSansFont).
import { readFileSync } from "node:fs";
import { fontFamilyNames } from "./theme";
import { mark } from "./trace";

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

/** Font files per family name. */
const FILE_OF: Record<string, string[]> = {
	Inter: ["Inter-Variable.ttf"],
	"Source Serif 4": ["SourceSerif4-Variable.ttf", "SourceSerif4-Italic-Variable.ttf"],
	Manrope: ["Manrope-Variable.ttf"],
	"IBM Plex Sans": ["IBMPlexSans-Variable.ttf"],
	"Source Sans 3": ["SourceSans3-Variable.ttf"],
};

interface FontHost { registerFont?: (bytes: Buffer) => void }
const RENDER_HOST = Symbol.for("@gpuix/solid/render-host");

const registered = new Set<string>();
let host: FontHost | undefined; // the renderer fonts were registered with; later sans choices go to it
let timer: ReturnType<typeof setTimeout> | undefined;

function hostRenderer(): FontHost | undefined {
	return (globalThis as unknown as Record<symbol, { renderer?: FontHost } | undefined>)[RENDER_HOST]?.renderer;
}

/** Files the UI needs now and has not registered yet: the chosen sans first (it is on screen first), then the title serif. */
function wanted(): string[] {
	return [...(FILE_OF[fontFamily.sans] ?? []), ...(FILE_OF[fontFamily.title] ?? [])].filter((f) => !registered.has(f));
}

function registerFile(r: FontHost, f: string): void {
	if (registered.has(f)) return;
	if (!r.registerFont) throw new Error("fonts: this renderer has no registerFont");
	registered.add(f);
	try {
		mark(`font-start-${f}`);
		r.registerFont(readFileSync(new URL(f, dir)));
		mark(`font-done-${f}`);
	} catch (e) {
		registered.delete(f);
		console.error(`[fonts] could not register ${f}:`, e instanceof Error ? e.message : e);
	}
}

/**
 * Switch the interface font (Settings > Appearance: Inter | Manrope | IBM Plex Sans | Source Sans 3). Registers that font's file
 * on demand once fonts have been set up (otherwise registerFonts() picks it up). Text already drawn keeps its old family until
 * it re-renders.
 */
export function setSansFont(id: keyof typeof families | string) {
	fontFamily.sans = (families as Record<string, string>)[id] ?? id;
	if (host) for (const f of wanted()) registerFile(host, f);
}

/**
 * Register the fonts the UI draws with, all at once (scripts and tests). Pass the renderer (`t.renderer` from createTestRoot,
 * or `useGpuixRequired()`) when you have one. With no argument it uses the renderer `render()` mounts: called before render()
 * it waits (polling briefly) until that renderer exists; text that already named a family repaints once it is registered.
 * Calling it again only adds a sans font chosen since.
 */
export function registerFonts(renderer?: FontHost): void {
	const r = renderer ?? hostRenderer();
	if (r) {
		host = r;
		for (const f of wanted()) registerFile(r, f);
		return;
	}
	if (timer) return;
	let tries = 0;
	const poll = () => {
		timer = undefined;
		const h = hostRenderer();
		if (h) registerFonts(h);
		else if (++tries < 200) timer = setTimeout(poll, 10);
		else console.error("[fonts] no GPUIX renderer appeared; fonts not registered");
	};
	timer = setTimeout(poll, 0);
}

/**
 * Like registerFonts() but one file per timer tick, so the JS thread (which also pumps the window) returns to the event loop
 * between the 100-250 ms registrations. For use once the window is up (main.tsx). `done` runs after the last file.
 */
export function registerFontsStaged(renderer?: FontHost, done?: () => void): void {
	const r = renderer ?? hostRenderer();
	if (!r) return registerFonts(renderer);
	host = r;
	const step = () => {
		const f = wanted()[0];
		if (!f) return done?.();
		registerFile(r, f);
		setTimeout(step, 16);
	};
	setTimeout(step, 0);
}
