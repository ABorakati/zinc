// Text -> LaTeX for the Better BibTeX / BibLaTeX exporters: unicode to LaTeX (or minimal escaping when unicode is
// kept), a small HTML subset (<i> <b> <sup> <sub> <sc> <nc>), and BBT's case protection of capitalised words
// ({{Words}}). Behaviour follows Better BibTeX's documented output (MIT, see core/src/bbt/NOTICE); the code is original.
import { decodeEntities } from "../../io/common";

export interface TexOptions {
	flavor: "bibtex" | "biblatex";
	/** write non-ASCII as LaTeX commands (otherwise keep unicode and only escape LaTeX specials) */
	ascii: boolean;
	/** protect capitalised words in this text (titles) */
	protect: boolean;
	/** names: letter accents in braces ({\'e}) so BibTeX sorts and abbreviates them right */
	creator?: boolean;
}

const SPECIALS: Record<string, string> = {
	"\\": "\\textbackslash{}", "{": "\\{", "}": "\\}", "&": "\\&", "%": "\\%", "$": "\\$", "#": "\\#", "_": "\\_",
	"~": "\\textasciitilde{}", "^": "\\textasciicircum{}",
};
const SYMBOLS: Record<string, string> = {
	"–": "--", "—": "---", "‘": "`", "’": "'", "“": "``", "”": "''", " ": "~", "…": "\\ldots{}",
	"©": "\\copyright{}", "®": "\\textregistered{}", "£": "\\pounds{}", "§": "\\S{}", "°": "\\textdegree{}",
	"±": "$\\pm$", "×": "$\\times$", "÷": "$\\div$", "µ": "$\\mu$", "≤": "$\\leq$", "≥": "$\\geq$",
	"≠": "$\\neq$", "≈": "$\\approx$", "∞": "$\\infty$", "→": "$\\rightarrow$", "←": "$\\leftarrow$",
	"·": "\\textperiodcentered{}", "•": "\\textbullet{}", "−": "$-$", "½": "$\\frac{1}{2}$", "¿": "?`", "¡": "!`",
	"ß": "{\\ss}", "ø": "{\\o}", "Ø": "{\\O}", "æ": "{\\ae}", "Æ": "{\\AE}", "œ": "{\\oe}", "Œ": "{\\OE}",
	"ł": "{\\l}", "Ł": "{\\L}", "ı": "{\\i}", "ð": "{\\dh}", "Ð": "{\\DH}", "þ": "{\\th}", "Þ": "{\\TH}",
	"đ": "{\\dj}", "Đ": "{\\DJ}", "ŋ": "{\\ng}", "Ŋ": "{\\NG}", "å": "{\\aa}", "Å": "{\\AA}",
};
const GREEK: Record<string, string> = {
	α: "alpha", β: "beta", γ: "gamma", δ: "delta", ε: "epsilon", ζ: "zeta", η: "eta", θ: "theta", ι: "iota", κ: "kappa", λ: "lambda",
	μ: "mu", ν: "nu", ξ: "xi", π: "pi", ρ: "rho", σ: "sigma", τ: "tau", υ: "upsilon", φ: "phi", χ: "chi", ψ: "psi", ω: "omega",
	Γ: "Gamma", Δ: "Delta", Θ: "Theta", Λ: "Lambda", Ξ: "Xi", Π: "Pi", Σ: "Sigma", Φ: "Phi", Ψ: "Psi", Ω: "Omega",
};
// combining mark -> [command, braced]: symbol accents take the letter directly (\'e), letter accents a group (\v{c})
const ACCENT: Record<string, [string, boolean]> = {
	"̀": ["`", false], "́": ["'", false], "̂": ["^", false], "̃": ["~", false], "̄": ["=", false],
	"̇": [".", false], "̈": ['"', false], "̆": ["u", true], "̊": ["r", true], "̋": ["H", true],
	"̌": ["v", true], "̣": ["d", true], "̧": ["c", true], "̨": ["k", true], "̱": ["b", true],
};

/** One character (or grapheme with combining marks) to LaTeX. */
function encodeChar(ch: string, o: TexOptions): string {
	const sp = SPECIALS[ch];
	if (sp) return sp;
	if (ch === "<" || ch === ">") return o.ascii && o.flavor === "bibtex" ? (ch === "<" ? "\\textless{}" : "\\textgreater{}") : ch;
	if (ch.charCodeAt(0) < 0x80) return ch;
	if (!o.ascii) return ch;
	const sym = SYMBOLS[ch];
	if (sym) return sym;
	const g = GREEK[ch];
	if (g) return `$\\${g}$`;
	const d = ch.normalize("NFD");
	if (d.length === 2 && /[A-Za-z]/.test(d[0]!)) {
		const acc = ACCENT[d[1]!];
		if (acc) {
			const [cmd, braced] = acc;
			const tex = braced ? `\\${cmd}{${d[0]}}` : d[0] === "i" ? `\\${cmd}{\\i}` : `\\${cmd}${d[0]}`;
			return o.creator ? `{${tex}}` : tex;
		}
	}
	return ch;
}

export function encodeChars(text: string, o: TexOptions): string {
	let out = "";
	for (const ch of text.normalize("NFC")) out += encodeChar(ch, o);
	return out;
}

// ---------------------------------------------------------------- case protection

const lc = "\\p{Ll}\\p{Lt}\\p{Lm}\\p{Lo}\\p{Mn}\\p{Mc}\\p{Nd}\\p{Nl}";
const LC = `\\p{Lu}${lc}`;
const protectedWord = `[${lc}]*[\\p{Lu}][${LC}]*`;
const RE = {
	protectedWords: new RegExp(`^(${protectedWord})((([-\\s\\u00a0])(${protectedWord}))|(-\\d+))*`, "u"),
	unprotectedWord: new RegExp(`^[${LC}]+`, "u"),
	leadingUnprotectedWord: new RegExp(`^([\\p{Lu}][${lc}]*)[\\s\\u00a0.\\-\\u2000-\\u206F\\\\'!"#$%&()*+,/:;<=>?@\\[\\]^_\`{|}~]`, "u"),
	whitespace: /^[ \t\n\r ]+/,
	sentenceEnd: /^[:?]/,
	url: /^(https?|mailto):\/\/[^\s]+/,
};

type Piece = { text: string; nocase: boolean };

/** Split plain text into pieces; nocase pieces need {{...}} protection. */
export function protectPieces(text: string, sentenceStart: { v: boolean }): Piece[] {
	const out: Piece[] = [];
	const push = (t: string, nocase: boolean) => {
		const last = out[out.length - 1];
		if (last && last.nocase === nocase) last.text += t;
		else out.push({ text: t, nocase });
	};
	let rest = text;
	while (rest) {
		let m: RegExpExecArray | null;
		if ((m = RE.whitespace.exec(rest))) {
			push(m[0], false);
			rest = rest.slice(m[0].length);
			continue;
		}
		if ((m = RE.sentenceEnd.exec(rest))) {
			push(m[0], false);
			rest = rest.slice(m[0].length);
			continue;
		}
		if (sentenceStart.v && (m = RE.leadingUnprotectedWord.exec(`${rest} `))) {
			sentenceStart.v = false;
			push(m[1]!, false);
			rest = rest.slice(m[1]!.length);
			continue;
		}
		sentenceStart.v = false;
		if ((m = RE.protectedWords.exec(rest))) {
			push(m[0], true);
			rest = rest.slice(m[0].length);
		} else if ((m = RE.url.exec(rest))) {
			push(m[0], true);
			rest = rest.slice(m[0].length);
		} else if ((m = RE.unprotectedWord.exec(rest))) {
			push(m[0], false);
			rest = rest.slice(m[0].length);
		} else {
			const ch = Array.from(rest)[0]!;
			push(ch, false);
			rest = rest.slice(ch.length);
		}
	}
	return out;
}

// ---------------------------------------------------------------- HTML subset

type Tok = { tag: string; close: boolean; nocase?: boolean } | { text: string };
function tokens(html: string): Tok[] {
	const out: Tok[] = [];
	const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s[^<>]*)?)\/?>/g;
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html))) {
		if (m.index > last) out.push({ text: html.slice(last, m.index) });
		const tag = m[2]!.toLowerCase();
		out.push({ tag, close: m[1] === "/", nocase: tag === "nc" || (tag === "span" && /class\s*=\s*["'][^"']*nocase/i.test(m[3]!)) });
		last = m.index + m[0].length;
	}
	if (last < html.length) out.push({ text: html.slice(last) });
	return out;
}

/**
 * Encode a literal text field. `html` allows the simple tags; plain text is escaped as is.
 * Protected words come out as {{Word}} (BBT's brace protection).
 */
export function textToLatex(source: string, o: TexOptions, opts: { html?: boolean } = {}): string {
	const html = opts.html !== false;
	const toks = html ? tokens(source) : [{ text: source } as Tok];
	const sentence = { v: true };
	let out = "";
	let nocaseDepth = 0;
	const closers: string[] = [];
	const kinds: ("nocase" | "fmt" | "other")[] = []; // open tags, so each close tag undoes the right thing
	for (const t of toks) {
		if ("tag" in t) {
			const open = !t.close;
			const emph = o.flavor === "bibtex" ? "\\emph{" : "\\mkbibemph{";
			const map: Record<string, string> = { i: emph, em: emph, b: "\\textbf{", strong: "\\textbf{", sup: "\\textsuperscript{", sub: "\\textsubscript{", sc: "\\textsc{", code: "\\texttt{", tt: "\\texttt{" };
			if (open) {
				if (t.tag === "br") out += "\\\\ ";
				else if (t.nocase) {
					kinds.push("nocase");
					nocaseDepth++;
					out += "{{";
					closers.push("}}");
				} else if (map[t.tag]) {
					kinds.push("fmt");
					out += map[t.tag];
					closers.push("}");
				} else kinds.push("other");
			} else {
				const k = kinds.pop();
				if (k === "nocase") nocaseDepth--;
				if (k === "nocase" || k === "fmt") out += closers.pop() ?? "";
			}
			continue; // other tags: dropped, their text is kept
		}
		const text = html ? decodeEntities(t.text) : t.text;
		if (nocaseDepth > 0 || !o.protect) {
			if (o.protect) sentence.v = false;
			out += encodeChars(text, o);
			continue;
		}
		for (const p of protectPieces(text, sentence)) {
			const enc = encodeChars(p.text, o);
			out += p.nocase ? `{{${enc}}}` : enc;
		}
	}
	while (closers.length) out += closers.pop();
	return out;
}

/** Verbatim fields (url, doi, file): only unbalanced braces are removed. */
export function verbatim(value: string): string {
	let v = value;
	const braces: { c: string; pos: number }[] = [];
	for (let i = 0; i < v.length; i++) {
		if (v[i] === "{") braces.unshift({ c: "{", pos: i });
		else if (v[i] === "}") {
			if (braces.length && braces[0]!.c === "{") braces.shift();
			else braces.unshift({ c: "", pos: i });
		}
	}
	for (const b of braces) v = v.slice(0, b.pos) + v.slice(b.pos + 1);
	return v;
}
