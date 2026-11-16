// Text helpers for the citation-key formulas and the exporters: transliteration, punctuation, title words,
// Extra-field parsing. Behaviour modelled on Better BibTeX (MIT, see NOTICE); written from its documented behaviour.

const SPECIAL: Record<string, string> = {
	ø: "o",
	Ø: "O",
	ł: "l",
	Ł: "L",
	ß: "ss",
	æ: "ae",
	Æ: "AE",
	œ: "oe",
	Œ: "OE",
	đ: "d",
	Đ: "D",
	ð: "d",
	Ð: "D",
	þ: "th",
	Þ: "Th",
	ı: "i",
	ħ: "h",
	Ħ: "H",
	ŋ: "ng",
	Ŋ: "NG",
	ĸ: "k",
	ŧ: "t",
	Ŧ: "T",
	"’": "'",
	"‘": "'",
	"“": '"',
	"”": '"',
	"–": "-",
	"—": "-",
	" ": " ",
};
const GERMAN: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue", Ä: "Ae", Ö: "Oe", Ü: "Ue" };
const CYRILLIC: Record<string, string> = {
	а: "a",
	б: "b",
	в: "v",
	г: "g",
	д: "d",
	е: "e",
	ё: "e",
	ж: "zh",
	з: "z",
	и: "i",
	й: "i",
	к: "k",
	л: "l",
	м: "m",
	н: "n",
	о: "o",
	п: "p",
	р: "r",
	с: "s",
	т: "t",
	у: "u",
	ф: "f",
	х: "kh",
	ц: "ts",
	ч: "ch",
	ш: "sh",
	щ: "shch",
	ъ: "",
	ы: "y",
	ь: "",
	э: "e",
	ю: "yu",
	я: "ya",
	і: "i",
	ї: "yi",
	є: "ye",
	ґ: "g",
};
const GREEK: Record<string, string> = {
	α: "a",
	β: "b",
	γ: "g",
	δ: "d",
	ε: "e",
	ζ: "z",
	η: "e",
	θ: "th",
	ι: "i",
	κ: "k",
	λ: "l",
	μ: "m",
	ν: "n",
	ξ: "x",
	ο: "o",
	π: "p",
	ρ: "r",
	σ: "s",
	ς: "s",
	τ: "t",
	υ: "u",
	φ: "ph",
	χ: "ch",
	ψ: "ps",
	ω: "o",
};

/** Unicode -> ASCII (BBT: transliterate / fold). Characters with no ASCII form become U+FFFD (removed as unsafe by the key step). */
export function transliterate(input: string, mode: "minimal" | "german" = "minimal"): string {
	let out = "";
	for (const ch of input.normalize("NFC")) {
		const code = ch.codePointAt(0)!;
		if (code < 0x80) {
			out += ch;
			continue;
		}
		const lower = ch.toLowerCase();
		const cyr = CYRILLIC[lower] ?? GREEK[lower];
		if (mode === "german" && GERMAN[ch]) out += GERMAN[ch];
		else if (SPECIAL[ch] !== undefined) out += SPECIAL[ch];
		else if (cyr !== undefined) out += ch === lower ? cyr : cyr.charAt(0).toUpperCase() + cyr.slice(1);
		else {
			const base = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
			out += /^[\x00-\x7f]+$/.test(base) ? base : "�";
		}
	}
	return out;
}

const PUNCT = /[\p{Pe}\p{Pf}\p{Pi}\p{Po}\p{Ps}]/gu;
const DASH = /[\p{Pd}─－―]/gu;
/** BBT nopunct: dashes become `dash`, other punctuation is removed. */
export function nopunct(text: string, dash = "-"): string {
	return text.replace(DASH, dash).replace(PUNCT, "");
}

export function stripHtml(s: string): string {
	if (!s) return "";
	if (!s.includes("<")) return s;
	return s
		.replace(/<[^>]*>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

export const DEFAULT_SKIP_WORDS =
	"a,ab,aboard,about,above,across,after,against,al,along,amid,among,an,and,anti,around,as,at,before,behind,below,beneath,beside,besides,between,beyond,but,by,d,da,das,de,del,dell,dello,dei,degli,della,dell,delle,dem,den,der,des,despite,die,do,down,du,during,ein,eine,einem,einen,einer,eines,el,en,et,except,for,from,gli,i,il,in,inside,into,is,l,la,las,le,les,like,lo,los,near,nor,of,off,on,onto,or,over,past,per,plus,round,save,since,so,some,sur,than,the,through,to,toward,towards,un,una,unas,under,underneath,une,unlike,uno,unos,until,up,upon,versus,via,von,while,with,within,without,yet,zu,zum";

export interface TitleWordOptions {
	skipWords: Set<string>;
	nopunct?: boolean;
	fold?: boolean;
}

/** The significant words of a title (BBT titleWords). */
export function titleWords(title: string, o: TitleWordOptions): string[] {
	if (!title) return [];
	let t = title.replace(/<\/?(?:i|b|sc|nc|code|span[^>]*)>|["]/gi, "").replace(/[/:]/g, " ");
	t = stripHtml(t);
	let words = t
		.split(/\s+/)
		.map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
		.filter((w) => w && !o.skipWords.has(w.toLowerCase()));
	if (o.nopunct) words = words.map((w) => nopunct(w, ""));
	words = words.filter(
		(w) => w && !(Array.from(w).length === 1 && !/^\d+$/.test(w) && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(w)),
	);
	if (o.skipWords.size) words = words.filter((w) => !o.skipWords.has(w.toLowerCase()));
	if (o.fold) words = words.map((w) => transliterate(w));
	return words;
}

// ---------------------------------------------------------------- Extra

export interface TexField {
	value: string;
	/** "" (escape), "raw" (`=`), "cased" (capitalised prefix: apply case protection) */
	mode: "" | "raw" | "cased";
	/** only for this flavour when set */
	only?: "bibtex" | "biblatex";
}
export interface ExtraFields {
	/** label (lowercased) -> value, for `Label: value` lines */
	kv: Record<string, string>;
	tex: Record<string, TexField>;
	/** pinned key from a `Citation Key:` line */
	citationKey: string;
	/** lines that are not recognised as fields */
	rest: string[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
export const normLabel = norm;

/** Parse Extra: `Citation Key: x`, `tex.field: v` / `tex.field= raw`, other `Label: value` lines. */
export function parseExtra(extra: string | undefined): ExtraFields {
	const out: ExtraFields = { kv: {}, tex: {}, citationKey: "", rest: [] };
	for (const line of String(extra ?? "").split(/\r?\n/)) {
		const t = /^\s*(tex|bibtex|biblatex)\.([A-Za-z0-9_.-]+)\s*([:=])\s*(.*)$/i.exec(line);
		if (t) {
			const prefix = t[1]!;
			const cased = /^[A-Z]/.test(prefix); // TeX.corp: capitalised prefix = apply case protection
			const name = t[2]!.toLowerCase();
			const lf = t[1]!.toLowerCase();
			out.tex[name] = {
				value: t[4]!.trim(),
				mode: t[3] === "=" ? "raw" : cased ? "cased" : "",
				only: lf === "bibtex" ? "bibtex" : lf === "biblatex" ? "biblatex" : undefined,
			};
			continue;
		}
		const m = /^\s*([A-Za-z][A-Za-z -]*?)\s*:\s*(.+?)\s*$/.exec(line);
		if (m) {
			const label = m[1]!;
			if (norm(label) === "citationkey") {
				if (!out.citationKey) out.citationKey = m[2]!;
				continue;
			}
			out.kv[norm(label)] = m[2]!;
			out.rest.push(line);
			continue;
		}
		if (line.trim()) out.rest.push(line);
	}
	return out;
}

/** Extra without its `Citation Key:` line(s). */
export function stripCitationKeyLine(extra: string): string {
	return extra
		.split(/\r?\n/)
		.filter((l) => !/^\s*citation\s*key\s*:/i.test(l))
		.join("\n")
		.trim();
}
