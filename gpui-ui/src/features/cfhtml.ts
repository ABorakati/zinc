// The Windows "HTML Format" (CF_HTML) clipboard / drag payload. No imports, so tests and the drag code can use it freely.
//
// Layout (https://learn.microsoft.com/en-us/windows/win32/dataxchg/html-clipboard-format): an ASCII header whose offsets are BYTE
// offsets into the UTF-8 document, then the HTML with the fragment between <!--StartFragment--> and <!--EndFragment-->.
//   StartHTML / EndHTML          the whole <html>…</html> text
//   StartFragment / EndFragment  only the fragment (what Word / browsers paste)

const PRE = "<html><body><!--StartFragment-->";
const POST = "<!--EndFragment--></body></html>";

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
const num = (x: number): string => String(x).padStart(10, "0");
const header = (startHtml: number, endHtml: number, startFrag: number, endFrag: number): string =>
	`Version:0.9\r\nStartHTML:${num(startHtml)}\r\nEndHTML:${num(endHtml)}\r\nStartFragment:${num(startFrag)}\r\nEndFragment:${num(endFrag)}\r\n`;

/** Wrap an HTML fragment in the CF_HTML envelope with byte-exact offsets (the header has fixed width, so one pass suffices). */
export function cfHtml(fragment: string): string {
	const headLen = header(0, 0, 0, 0).length; // ASCII
	const startFrag = headLen + bytes(PRE);
	const endFrag = startFrag + bytes(fragment);
	return header(headLen, endFrag + bytes(POST), startFrag, endFrag) + PRE + fragment + POST;
}

/** Read the four offsets back out of a CF_HTML document (for tests and diagnostics); null when the header is malformed. */
export function parseCfHtml(doc: string): { startHtml: number; endHtml: number; startFragment: number; endFragment: number } | null {
	const f = (name: string): number => {
		const m = new RegExp(`${name}:(\\d{10})`).exec(doc);
		return m ? Number(m[1]) : -1;
	};
	const r = { startHtml: f("StartHTML"), endHtml: f("EndHTML"), startFragment: f("StartFragment"), endFragment: f("EndFragment") };
	return Object.values(r).some((v) => v < 0) ? null : r;
}
