// Bundled reading fonts (OFL, from @fontsource-variable): Latin and Latin Extended only, to keep the app small.
// Faces are declared up front; the browser downloads a file only when text uses that font.
const files = import.meta.glob("../../node_modules/@fontsource-variable/*/files/*-latin{,-ext}-wght-*.woff2", {
	query: "?url", import: "default", eager: true,
}) as Record<string, string>;

const FAMILY: Record<string, string> = {
	"literata": "Literata Variable",
	"source-serif-4": "Source Serif 4 Variable",
	"merriweather": "Merriweather Variable",
	"inter": "Inter Variable",
	"source-sans-3": "Source Sans 3 Variable",
	"lexend": "Lexend Variable",
	"atkinson-hyperlegible-next": "Atkinson Hyperlegible Next Variable",
};

const RANGE = {
	latin: "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
	"latin-ext": "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
};

export function fontFaceCss(): string {
	let css = "";
	for (const [path, url] of Object.entries(files)) {
		const m = /@fontsource-variable\/([^/]+)\/files\/.+-(latin|latin-ext)-wght-(normal|italic)\.woff2$/.exec(path);
		const family = m && FAMILY[m[1]];
		if (!m || !family) continue;
		css += `@font-face{font-family:'${family}';font-style:${m[3]};font-display:swap;font-weight:100 900;src:url(${JSON.stringify(url)}) format('woff2-variations');unicode-range:${RANGE[m[2] as keyof typeof RANGE]}}\n`;
	}
	return css;
}

let installed = false;
/** Add the @font-face rules to the document once. */
export function installFonts(doc: Document = document) {
	if (installed) return;
	installed = true;
	const style = doc.createElement("style");
	style.dataset.rnFonts = "";
	style.textContent = fontFaceCss();
	doc.head.append(style);
}
