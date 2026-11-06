// LaTeX <-> Unicode for BibTeX field values.

const ACCENT_CMD: Record<string, string> = {
	"`": "\u0300", "'": "\u0301", "^": "\u0302", "~": "\u0303", "=": "\u0304", "u": "\u0306", ".": "\u0307", '"': "\u0308",
	"r": "\u030a", "H": "\u030b", "v": "\u030c", "d": "\u0323", "c": "\u0327", "k": "\u0328", "b": "\u0331",
};
const COMBINING_TO_CMD: Record<string, string> = {};
for (const [cmd, mark] of Object.entries(ACCENT_CMD)) COMBINING_TO_CMD[mark] = cmd;

const SPECIAL_CMD: Record<string, string> = {
	ss: "\u00df", o: "\u00f8", O: "\u00d8", ae: "\u00e6", AE: "\u00c6", oe: "\u0153", OE: "\u0152", aa: "\u00e5", AA: "\u00c5",
	l: "\u0142", L: "\u0141", i: "i", j: "j", dh: "\u00f0", DH: "\u00d0", th: "\u00fe", TH: "\u00de", dj: "\u0111", DJ: "\u0110",
	ng: "\u014b", NG: "\u014a",
};
const SPECIAL_TO_LATEX: Record<string, string> = {
	"\u00df": "{\\ss}", "\u00f8": "{\\o}", "\u00d8": "{\\O}", "\u00e6": "{\\ae}", "\u00c6": "{\\AE}", "\u0153": "{\\oe}", "\u0152": "{\\OE}",
	"\u0142": "{\\l}", "\u0141": "{\\L}", "\u0131": "{\\i}", "\u00f0": "{\\dh}", "\u00d0": "{\\DH}", "\u00fe": "{\\th}", "\u00de": "{\\TH}",
	"\u0111": "{\\dj}", "\u0110": "{\\DJ}", "\u014b": "{\\ng}", "\u014a": "{\\NG}",
};
const SYMBOL_TO_LATEX: Record<string, string> = {
	"\u2013": "--", "\u2014": "---", "\u2018": "`", "\u2019": "'", "\u201c": "``", "\u201d": "''", "\u00a0": "~",
	"\u2026": "\\ldots{}", "\u00a9": "\\copyright{}", "\u00ae": "\\textregistered{}", "\u00b1": "$\\pm$", "\u00d7": "$\\times$",
	"\u00b5": "$\\mu$", "\u00a3": "\\pounds{}", "\u00a7": "\\S{}", "\u00b0": "\\textdegree{}",
};
const ASCII_SPECIAL: Record<string, string> = {
	"\\": "\\textbackslash{}", "{": "\\{", "}": "\\}", "&": "\\&", "%": "\\%", "$": "\\$", "#": "\\#", "_": "\\_",
	"~": "\\textasciitilde{}", "^": "\\textasciicircum{}",
};

/** Unicode text -> LaTeX source for a BibTeX field. Characters without a LaTeX form stay as they are. */
export function toLatex(input: string): string {
	let out = "";
	for (const ch of input.normalize("NFC")) {
		if (ASCII_SPECIAL[ch]) out += ASCII_SPECIAL[ch];
		else if (SPECIAL_TO_LATEX[ch]) out += SPECIAL_TO_LATEX[ch];
		else if (SYMBOL_TO_LATEX[ch]) out += SYMBOL_TO_LATEX[ch];
		else if (ch.charCodeAt(0) < 0x80) out += ch;
		else {
			const d = ch.normalize("NFD");
			const cmd = d.length === 2 && /[A-Za-z]/.test(d[0]!) ? COMBINING_TO_CMD[d[1]!] : undefined;
			if (!cmd) out += ch;
			else if (cmd === "r" && (d[0] === "a" || d[0] === "A")) out += d[0] === "a" ? "{\\aa}" : "{\\AA}";
			else {
				const letter = d[0] === "i" && cmd !== "c" && cmd !== "k" ? "\\i" : d[0]!;
				out += /[A-Za-z]/.test(cmd) ? `{\\${cmd}{${letter}}}` : `{\\${cmd}${letter.length > 1 ? `{${letter}}` : letter}}`;
			}
		}
	}
	return out;
}

// private-use placeholders protect literal braces and backslashes while commands are processed
const LB = "\ue000";
const RB = "\ue001";
const BS = "\ue002";
const TILDE = "\ue003"; // a literal "~" (\textasciitilde): a bare ~ in LaTeX is a non-breaking space and becomes " "

/** LaTeX source -> plain Unicode text (accents, dashes, escapes, braces removed). */
export function fromLatex(input: string): string {
	let s = input;
	s = s.replace(/\\(?:textbackslash|backslash)(?:\s*\{\})?/g, BS);
	s = s.replace(/\\textasciitilde(?:\s*\{\})?/g, TILDE).replace(/\\textasciicircum(?:\s*\{\})?/g, "^").replace(/\\\^\{\}/g, "^");
	s = s.replace(/\\([&%$#_])/g, "$1");
	s = s.replace(/\\\{/g, LB).replace(/\\\}/g, RB);
	// accents: \'e \'{e} \'{\i} {\'e} \"o ...
	// the accented letter is a bare letter, {letter}, or the dotless \i / \j
	const LETTER = String.raw`(?:\{\s*(?:\\([ij])|([A-Za-z]))\s*\}|\\([ij])(?![A-Za-z])|([A-Za-z]))`;
	const accent = (m: string, cmd: string, ...g: (string | undefined)[]) => {
		const letter = g[0] || g[1] || g[2] || g[3];
		const mark = ACCENT_CMD[cmd];
		return mark && letter ? (letter + mark).normalize("NFC") : m;
	};
	s = s.replace(new RegExp(String.raw`\\([` + "`" + String.raw`'^~=".])\s*` + LETTER, "g"), accent);
	s = s.replace(new RegExp(String.raw`\\([uHvrdckb])(?:\s*\{\s*(?:\\([ij])|([A-Za-z]))\s*\}|\s+(?:\\([ij])(?![A-Za-z])|([A-Za-z])))`, "g"), accent);
	s = s.replace(/\\(ss|oe|OE|ae|AE|aa|AA|dh|DH|dj|DJ|th|TH|ng|NG|o|O|l|L|i|j)(?![A-Za-z])(?:\{\}|\s)?/g, (_m, c: string) => SPECIAL_CMD[c]!);
	s = s.replace(/\\(?:textendash)(?:\s*\{\})?/g, "\u2013").replace(/\\(?:textemdash)(?:\s*\{\})?/g, "\u2014");
	s = s.replace(/\\ldots(?:\s*\{\})?|\\dots(?:\s*\{\})?/g, "\u2026").replace(/\\textquoteright(?:\s*\{\})?/g, "\u2019");
	s = s.replace(/\\textquotesingle(?:\s*\{\})?/g, "'").replace(/\\textquoteleft(?:\s*\{\})?/g, "‘").replace(/\\textquotedblleft(?:\s*\{\})?/g, "“").replace(/\\textquotedblright(?:\s*\{\})?/g, "”");
	s = s.replace(/\\(?:textit|textbf|emph|textsc|texttt|textrm|textsf|textnormal|mbox|url|path|mathrm|mathit|text|textsuperscript|textsubscript)\s*\{([^{}]*)\}/g, "$1");
	s = s.replace(/\\href\s*\{[^{}]*\}\s*\{([^{}]*)\}/g, "$1");
	s = s.replace(/\\(?:newline|par)\b\s*/g, "\n").replace(/\\[ ,;:!]/g, " ").replace(/\\\\/g, "\n");
	s = s.replace(/---/g, "\u2014").replace(/--/g, "\u2013").replace(/``/g, "\u201c").replace(/''/g, "\u201d");
	s = s.replace(/[{}]/g, "");
	s = s.replace(/~/g, " ");
	s = s.split(LB).join("{").split(RB).join("}").split(BS).join("\\").split(TILDE).join("~");
	return s.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}
