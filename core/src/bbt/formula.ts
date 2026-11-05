// Better BibTeX citation-key formula language: parser and evaluator.
//
// Modelled on Better BibTeX's documented formula syntax (https://retorque.re/zotero-better-bibtex/citing/), MIT; the
// implementation here is original (BBT compiles the formula as JavaScript; this is a small purpose-built parser).
//
//   formula   := alternative ((";" | "|") alternative)*       first alternative that yields text wins
//   alternative := expression
//   expression  := term ("?" expression ":" expression)?
//   term        := and ("||" and)*                              first non-empty
//   and         := comparison ("&&" comparison)*                right side only if left is non-empty
//   comparison  := sum ((">" | ">=" | "<" | "<=" | "==" | "!=") number)?    shorthand for .len(op, n)
//   sum         := postfix ("+" postfix)*                       concatenation
//   postfix     := primary ("." filter ["(" args ")"])*
//   primary     := function ["(" args ")"] | Field | "text" | 'text' | "(" expression ")"
// Functions start with a lowercase letter (auth, shorttitle, year, ...), field access with an uppercase letter
// (Title, DOI, ...). A filter or comparison that fails "skips" to the next alternative.
import { dateParts, normalizeDate } from "../io/common";
import { getSchema } from "../schema-data";
import { nopunct, parseExtra, stripHtml, titleWords, transliterate } from "./text";
import type { ZoteroItemData, Creator } from "../api-types";

export class FormulaError extends Error {
	constructor(message: string, public position = -1) {
		super(message);
	}
}

class Skip extends Error {}
const skip = (): never => {
	throw new Skip("skip");
};

// ---------------------------------------------------------------- tokens

type Tok =
	| { k: "num"; v: number; at: number }
	| { k: "str"; v: string; at: number }
	| { k: "re"; v: RegExp; at: number }
	| { k: "id"; v: string; at: number }
	| { k: "p"; v: string; at: number }
	| { k: "end"; v: ""; at: number };

function tokenize(src: string): Tok[] {
	const out: Tok[] = [];
	let i = 0;
	const prevAllowsRegex = () => {
		const p = out[out.length - 1];
		return !p || (p.k === "p" && (p.v === "(" || p.v === "," || p.v === "="));
	};
	while (i < src.length) {
		const c = src[i]!;
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		const at = i;
		if (c === '"' || c === "'") {
			let s = "";
			i++;
			for (;;) {
				if (i >= src.length) throw new FormulaError("unterminated string", at);
				const d = src[i]!;
				if (d === "\\" && i + 1 < src.length) {
					const n = src[i + 1]!;
					s += n === "n" ? "\n" : n === "t" ? "\t" : n;
					i += 2;
					continue;
				}
				if (d === c) {
					i++;
					break;
				}
				s += d;
				i++;
			}
			out.push({ k: "str", v: s, at });
			continue;
		}
		if (c === "/" && prevAllowsRegex()) {
			let j = i + 1;
			let inClass = false;
			for (; j < src.length; j++) {
				const d = src[j]!;
				if (d === "\\") j++;
				else if (d === "[") inClass = true;
				else if (d === "]") inClass = false;
				else if (d === "/" && !inClass) break;
			}
			if (j >= src.length) throw new FormulaError("unterminated regular expression", at);
			const body = src.slice(i + 1, j);
			let k = j + 1;
			let flags = "";
			while (k < src.length && /[a-z]/.test(src[k]!)) flags += src[k++];
			try {
				out.push({ k: "re", v: new RegExp(body, flags), at });
			} catch (e) {
				throw new FormulaError(`bad regular expression: ${(e as Error).message}`, at);
			}
			i = k;
			continue;
		}
		if (/[0-9]/.test(c)) {
			const m = /^\d+(?:\.\d+)?/.exec(src.slice(i))!;
			out.push({ k: "num", v: Number(m[0]), at });
			i += m[0].length;
			continue;
		}
		if (/[A-Za-z_$]/.test(c)) {
			const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i))!;
			out.push({ k: "id", v: m[0], at });
			i += m[0].length;
			continue;
		}
		const two = src.slice(i, i + 2);
		if (["||", "&&", ">=", "<=", "==", "!="].includes(two)) {
			out.push({ k: "p", v: two, at });
			i += 2;
			continue;
		}
		if ("+.(),?:><[]|;=-".includes(c)) {
			out.push({ k: "p", v: c, at });
			i++;
			continue;
		}
		throw new FormulaError(`unexpected character ${JSON.stringify(c)}`, at);
	}
	out.push({ k: "end", v: "", at: src.length });
	return out;
}

// ---------------------------------------------------------------- AST

type ArgVal = number | string | boolean | RegExp | ArgVal[];
interface Args {
	pos: ArgVal[];
	named: Record<string, ArgVal>;
}
type Node =
	| { t: "call"; name: string; args: Args; at: number }
	| { t: "field"; name: string; at: number }
	| { t: "str"; v: string }
	| { t: "filter"; input: Node; name: string; args: Args; at: number }
	| { t: "cat"; parts: Node[] }
	| { t: "or"; parts: Node[] }
	| { t: "and"; parts: Node[] }
	| { t: "cond"; test: Node; yes: Node; no: Node }
	| { t: "cmp"; input: Node; op: string; n: number };

export interface Compiled {
	source: string;
	alternatives: Node[];
}

class Parser {
	private i = 0;
	constructor(private toks: Tok[]) {}
	private get cur(): Tok {
		return this.toks[this.i]!;
	}
	private isP(v: string): boolean {
		return this.cur.k === "p" && this.cur.v === v;
	}
	private eat(v: string): void {
		if (!this.isP(v)) throw new FormulaError(`expected "${v}"${this.cur.k === "end" ? " but the formula ended" : ` but found "${this.cur.v}"`}`, this.cur.at);
		this.i++;
	}
	formulas(): Node[] {
		const alts: Node[] = [];
		for (;;) {
			if (this.cur.k === "end" || this.isP("|") || this.isP(";")) {
				if (this.cur.k !== "end") {
					this.i++;
					continue; // empty alternative
				}
				break;
			}
			alts.push(this.expression());
			if (this.isP("|") || this.isP(";")) {
				this.i++;
				continue;
			}
			const after = this.toks[this.i] as Tok;
			if (after.k !== "end") throw new FormulaError(`unexpected "${after.v}"`, after.at);
			break;
		}
		if (!alts.length) throw new FormulaError("the formula is empty");
		return alts;
	}
	expression(): Node {
		const test = this.orExpr();
		if (this.isP("?")) {
			this.i++;
			const yes = this.expression();
			this.eat(":");
			const no = this.expression();
			return { t: "cond", test, yes, no };
		}
		return test;
	}
	private orExpr(): Node {
		const parts = [this.andExpr()];
		while (this.isP("||")) {
			this.i++;
			parts.push(this.andExpr());
		}
		return parts.length === 1 ? parts[0]! : { t: "or", parts };
	}
	private andExpr(): Node {
		const parts = [this.cmpExpr()];
		while (this.isP("&&")) {
			this.i++;
			parts.push(this.cmpExpr());
		}
		return parts.length === 1 ? parts[0]! : { t: "and", parts };
	}
	private cmpExpr(): Node {
		const left = this.sum();
		const t = this.cur;
		if (t.k === "p" && [">", "<", ">=", "<=", "==", "!="].includes(t.v)) {
			this.i++;
			const n = this.cur;
			if (n.k !== "num") throw new FormulaError("a comparison needs a number on the right", n.at);
			this.i++;
			return { t: "cmp", input: left, op: t.v, n: n.v };
		}
		return left;
	}
	private sum(): Node {
		const parts = [this.postfix()];
		while (this.isP("+")) {
			this.i++;
			parts.push(this.postfix());
		}
		return parts.length === 1 ? parts[0]! : { t: "cat", parts };
	}
	private postfix(): Node {
		let node = this.primary();
		while (this.isP(".")) {
			this.i++;
			const id = this.cur;
			if (id.k !== "id") throw new FormulaError("expected a filter name after \".\"", id.at);
			this.i++;
			const args = this.isP("(") ? this.args() : { pos: [], named: {} };
			node = { t: "filter", input: node, name: id.v, args, at: id.at };
		}
		return node;
	}
	private primary(): Node {
		const t = this.cur;
		if (t.k === "str") {
			this.i++;
			return { t: "str", v: t.v };
		}
		if (t.k === "p" && t.v === "(") {
			this.i++;
			const e = this.expression();
			this.eat(")");
			return e;
		}
		if (t.k === "id") {
			this.i++;
			const args = this.isP("(") ? this.args() : { pos: [], named: {} };
			return /^[A-Z]/.test(t.v) ? { t: "field", name: t.v, at: t.at } : { t: "call", name: t.v, args, at: t.at };
		}
		if (t.k === "end") throw new FormulaError("the formula ended unexpectedly", t.at);
		throw new FormulaError(`unexpected "${t.v}"`, t.at);
	}
	private args(): Args {
		this.eat("(");
		const out: Args = { pos: [], named: {} };
		if (this.isP(")")) {
			this.i++;
			return out;
		}
		for (;;) {
			const t = this.cur;
			const nx = this.toks[this.i + 1];
			if (t.k === "id" && nx && nx.k === "p" && nx.v === "=") {
				this.i += 2;
				out.named[t.v] = this.argValue();
			} else out.pos.push(this.argValue());
			if (this.isP(",")) {
				this.i++;
				continue;
			}
			break;
		}
		this.eat(")");
		return out;
	}
	private argValue(): ArgVal {
		const t = this.cur;
		if (t.k === "num" || t.k === "str" || t.k === "re") {
			this.i++;
			return t.v;
		}
		if (t.k === "p" && t.v === "-") {
			this.i++;
			const n = this.cur;
			if (n.k !== "num") throw new FormulaError("expected a number after \"-\"", n.at);
			this.i++;
			return -n.v;
		}
		if (t.k === "p" && t.v === "[") {
			this.i++;
			const arr: ArgVal[] = [];
			if (!this.isP("]")) {
				for (;;) {
					arr.push(this.argValue());
					if (this.isP(",")) {
						this.i++;
						continue;
					}
					break;
				}
			}
			this.eat("]");
			return arr;
		}
		if (t.k === "p" && (t.v === ">" || t.v === "<" || t.v === ">=" || t.v === "<=" || t.v === "==" || t.v === "!=")) {
			this.i++;
			return t.v;
		}
		if (t.k === "id") {
			this.i++;
			if (t.v === "true") return true;
			if (t.v === "false") return false;
			return t.v; // a bare word is text: type(book)
		}
		throw new FormulaError(`bad argument "${t.v}"`, t.at);
	}
}

/** Parse a formula; throws FormulaError (with the character position) when it is not valid. */
export function compile(source: string): Compiled {
	const alternatives = new Parser(tokenize(source)).formulas();
	validate(alternatives);
	return { source, alternatives };
}

function validate(alts: Node[]): void {
	const walk = (n: Node): void => {
		switch (n.t) {
			case "call":
				if (!FUNCTIONS[n.name.toLowerCase()]) throw new FormulaError(`unknown function "${n.name}"`, n.at);
				break;
			case "filter":
				if (!FILTERS[n.name.toLowerCase()]) throw new FormulaError(`unknown filter ".${n.name}"`, n.at);
				walk(n.input);
				break;
			case "cat":
			case "or":
			case "and":
				n.parts.forEach(walk);
				break;
			case "cond":
				walk(n.test);
				walk(n.yes);
				walk(n.no);
				break;
			case "cmp":
				walk(n.input);
				break;
		}
	};
	alts.forEach(walk);
}

// ---------------------------------------------------------------- evaluation context

export interface FormulaConfig {
	skipWords: Set<string>;
	/** transliterate generated keys / names to ASCII */
	fold: boolean;
	/** characters removed from the key */
	unsafeChars: string;
	/** default duplicate postfix template */
	postfix?: string;
}
export const MARK = "\x1a";

type CreatorKind = "author" | "editor" | "translator" | "collaborator" | "*";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

interface ParsedDate {
	Y: string; y: string; m: string; d: string; oY: string; oy: string; om: string; od: string; H: string; M: string; S: string;
}
function parseDate(d: string, orig = ""): ParsedDate {
	const out: ParsedDate = { Y: "", y: "", m: "", d: "", oY: "", oy: "", om: "", od: "", H: "", M: "", S: "" };
	const fill = (raw: string, prefix: "" | "o") => {
		if (!raw) return;
		const parts = dateParts(normalizeDate(raw));
		if (!parts) {
			// century / verbatim
			const c = /^(\d{1,2})(?:st|nd|rd|th)?\s+century/i.exec(raw);
			if (c) out[`${prefix}Y` as "Y"] = `${c[1]}xx`;
			return;
		}
		const y = String(parts[0]);
		out[`${prefix}Y` as "Y"] = y;
		out[`${prefix}y` as "y"] = String(parts[0]! % 100);
		if (parts[1]) out[`${prefix}m` as "m"] = String(parts[1]);
		if (parts[2]) out[`${prefix}d` as "d"] = String(parts[2]);
	};
	fill(d, "");
	fill(orig, "o");
	if (!out.Y) Object.assign(out, { Y: out.oY, y: out.oy, m: out.om, d: out.od });
	if (!out.oY) Object.assign(out, { oY: out.Y, oy: out.y, om: out.m, od: out.d });
	return out;
}

const padYear = (year: string, length: number): string =>
	year ? year.replace(/[0-9]+/, (y) => (y.length >= length ? y : `0000${y}`.slice(-length))) : "";

function sprintf(template: string, vars: Record<string, string>): string {
	return template.replace(/%\((\w+)\)(?:\.(\d+))?s/g, (_m, name: string, prec?: string) => {
		const v = vars[name] ?? "";
		return prec ? Array.from(v).slice(0, Number(prec)).join("") : v;
	});
}

const lowerWord = /^\p{Ll}/u;
function parseParticles(lastName: string): { family: string; particle: string } {
	const words = lastName.split(/\s+/).filter(Boolean);
	let i = 0;
	while (i < words.length - 1 && lowerWord.test(words[i]!)) i++;
	return { family: words.slice(i).join(" "), particle: words.slice(0, i).join(" ") };
}

interface CreatorView {
	creatorType: string;
	lastName: string;
	firstName: string;
	name: string;
}

export class Ctx {
	readonly data: ZoteroItemData;
	readonly itemType: string;
	readonly primary: string;
	readonly creators: CreatorView[];
	readonly extra: ReturnType<typeof parseExtra>;
	readonly date: ParsedDate;
	readonly title: string;
	postfix: { template: string; offset: number };
	nameTemplate = "%(f)s";
	nameTransliterate: boolean;
	nameSpace = " ";
	translit: "minimal" | "german" = "minimal";

	constructor(data: ZoteroItemData, readonly cfg: FormulaConfig) {
		this.data = data;
		this.postfix = { template: cfg.postfix ?? "%(a)s", offset: 0 };
		this.itemType = String(data.itemType);
		this.primary = getSchema().itemTypes.find((t) => t.itemType === this.itemType)?.creatorTypes.find((c) => c.primary)?.creatorType ?? "author";
		this.extra = parseExtra(typeof data.extra === "string" ? data.extra : "");
		this.creators = ((data.creators ?? []) as Creator[]).map((c) => ({
			creatorType: c.creatorType,
			lastName: stripHtml((c.lastName ?? c.name ?? "").replace(/^"(.*)"$/, "$1")).trim(),
			firstName: stripHtml(c.firstName ?? "").trim(),
			name: stripHtml(c.name ?? "").trim(),
		}));
		this.date = parseDate(String(data.date ?? ""), this.extra.kv.originaldate ?? "");
		this.title = stripHtml(String(data.title ?? ""));
		this.nameTransliterate = cfg.fold;
		const lang = String(data.language ?? "").toLowerCase();
		if (/^de\b|^german|^deu/.test(lang)) this.translit = "german";
	}

	field(name: string): string {
		const d = this.data as Record<string, unknown>;
		const direct = d[name];
		if (typeof direct === "string" || typeof direct === "number") return stripHtml(String(direct));
		const t = getSchema().itemTypes.find((x) => x.itemType === this.itemType);
		const lc = name.toLowerCase();
		const f = t?.fields.find((x) => x.field.toLowerCase() === lc) ?? t?.fields.find((x) => x.baseField?.toLowerCase() === lc);
		if (f) {
			const v = d[f.field];
			if (typeof v === "string" || typeof v === "number") return stripHtml(String(v));
			return "";
		}
		if (lc === "dateadded" || lc === "datemodified") return String(d[lc === "dateadded" ? "dateAdded" : "dateModified"] ?? "").replace(/[ T].*/, "");
		return this.extra.kv[norm(name)] ?? "";
	}

	trans(s: string): string {
		return transliterate(s, this.translit);
	}

	initials(c: CreatorView, all = true): string {
		if (!c.firstName) return "";
		let ini = all ? c.firstName : Array.from(c.firstName)[0] ?? "";
		ini = ini.replace(/[^\p{Lu}\p{Lt}]/gu, "");
		ini = this.trans(ini);
		return ini.replace(/[^\p{Lu}]/gu, "");
	}

	nameOf(c: CreatorView, template: string): string {
		const last = c.lastName || c.name;
		const { family } = parseParticles(last);
		const vars: Record<string, string> = { f: last, F: family || last, g: c.firstName, I: this.initials(c), i: this.initials(c, false) };
		if (this.nameTransliterate) {
			vars.f = this.trans(vars.f!);
			vars.F = this.trans(vars.F!);
			vars.g = this.trans(vars.g!);
		}
		let name = sprintf(template, vars);
		if (this.nameSpace.trim()) name = name.replace(/\s+/g, this.nameSpace);
		return name;
	}

	/** Creators by role. `*` = author, else editor, translator, collaborator. */
	byKind(kind: CreatorKind, template = this.nameTemplate): string[] {
		const lists: Record<string, string[]> = { author: [], editor: [], translator: [], collaborator: [] };
		for (const c of this.creators) {
			const name = this.nameOf(c, template);
			if (!name) continue;
			const ct = c.creatorType;
			if (ct === "editor" || ct === "seriesEditor") lists.editor!.push(name);
			else if (ct === "translator") lists.translator!.push(name);
			else if (ct === this.primary || ct === "author") lists.author!.push(name);
			else lists.collaborator!.push(name);
		}
		const order = kind === "*" ? ["author", "editor", "translator", "collaborator"] : [kind];
		for (const k of order) if (lists[k]!.length) return lists[k]!;
		return [];
	}

	words(title: string, withNopunct = true): string[] {
		return titleWords(title, { skipWords: this.cfg.skipWords, nopunct: withNopunct, fold: this.cfg.fold });
	}
}
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// ---------------------------------------------------------------- functions

type Fn = { params: string[]; run: (c: Ctx, a: any[]) => string };
const kindArg = (v: unknown): CreatorKind => (v === "author" || v === "editor" || v === "translator" || v === "collaborator" ? v : "*");
const tmpl = (c: Ctx, ini: unknown): string => (ini ? `${c.nameTemplate}%(I)s` : c.nameTemplate);

const FUNCTIONS: Record<string, Fn> = {
	auth: {
		params: ["n", "m", "creator", "initials"],
		run: (c, [n = 0, m = 1, creator, initials = false]) => {
			const family = n ? c.nameTemplate.replace(/%\(([fg][_a-z]*)\)s/gi, `%($1).${n}s`) : c.nameTemplate;
			return c.byKind(kindArg(creator), initials ? `${family}%(I)s` : family)[m - 1] ?? "";
		},
	},
	authorsn: {
		params: ["n", "creator", "initials", "sep"],
		run: (c, [n = 0, creator, initials = false, sep = " "]) => {
			let a = c.byKind(kindArg(creator), tmpl(c, initials));
			if (n && n < a.length) a = a.slice(0, n).concat("EtAl");
			return a.join(sep);
		},
	},
	authforeini: { params: ["creator"], run: (c, [creator]) => c.byKind(kindArg(creator), "%(I)s")[0] ?? "" },
	authorlastforeini: { params: ["creator"], run: (c, [creator]) => c.byKind(kindArg(creator), "%(I)s").at(-1) ?? "" },
	authorlast: {
		params: ["creator", "initials"],
		run: (c, [creator, initials = false]) => c.byKind(kindArg(creator), tmpl(c, initials)).at(-1) ?? "",
	},
	authorsalpha: {
		params: ["creator", "initials", "sep"],
		run: (c, [creator, initials = false, sep = " "]) => {
			const a = c.byKind(kindArg(creator), initials ? "%(F)s%(I)s" : "%(F)s");
			if (!a.length) return "";
			if (a.length === 1) return a[0]!.slice(0, 3);
			if (a.length <= 4) return a.map((x) => x.slice(0, 1)).join(sep);
			return `${a.slice(0, 3).map((x) => x.slice(0, 1)).join(sep)}+`;
		},
	},
	authini: {
		params: ["n", "creator", "initials", "sep"],
		run: (c, [n = 0, creator, initials = false, sep = "."]) =>
			c.byKind(kindArg(creator), tmpl(c, initials)).map((x) => (n ? x.slice(0, n) : x)).join(sep),
	},
	authorini: {
		params: ["creator", "initials", "sep"],
		run: (c, [creator, initials = false, sep = "."]) => {
			const a = c.byKind(kindArg(creator), tmpl(c, initials));
			if (!a.length) return "";
			const first = a.shift()!;
			return [first.slice(0, 5)].concat(a.map((x) => x.slice(0, 1)).join(sep)).join(sep);
		},
	},
	authauthea: {
		params: ["creator", "initials", "sep"],
		run: (c, [creator, initials = false, sep = "."]) => {
			const a = c.byKind(kindArg(creator), tmpl(c, initials));
			return a.slice(0, 2).concat(a.length > 2 ? ["ea"] : []).join(sep);
		},
	},
	authetal: {
		params: ["creator", "initials", "sep"],
		run: (c, [creator, initials = false, sep = " "]) => {
			const a = c.byKind(kindArg(creator), tmpl(c, initials));
			if (!a.length) return "";
			return a.length === 2 ? a.join(sep) : a.slice(0, 1).concat(a.length > 1 ? ["EtAl"] : []).join(sep);
		},
	},
	authetal2: {
		params: ["creator", "initials", "sep"],
		run: (c, [creator, initials = false, sep = "."]) => {
			const a = c.byKind(kindArg(creator), tmpl(c, initials));
			if (!a.length) return "";
			return a.length === 2 ? a.join(sep) : a.slice(0, 1).concat(a.length > 1 ? ["etal"] : []).join(sep);
		},
	},
	authshort: {
		params: ["creator", "initials", "sep"],
		run: (c, [creator, initials = false, sep = "."]) => {
			const a = c.byKind(kindArg(creator), tmpl(c, initials));
			if (a.length === 0) return "";
			if (a.length === 1) return a[0]!;
			return a.slice(0, 3).map((x) => x.slice(0, 1)).join(sep) + (a.length > 3 ? "+" : "");
		},
	},
	creatornames: {
		params: ["template", "transliterate", "space"],
		run: (c, [template, tr, space]) => {
			if (template !== undefined) c.nameTemplate = String(template);
			if (tr !== undefined) c.nameTransliterate = !!tr;
			if (space !== undefined) c.nameSpace = String(space);
			return "";
		},
	},
	creators: {
		params: ["n", "type", "name", "etal", "sep", "min", "max"],
		run: (c, [n = 0, type, name = "", etal = "", sep = " ", min = 0, max = 0]) => creators(c, n, type, name, etal, sep, min, max),
	},
	authors: {
		params: ["n", "name", "etal", "sep"],
		run: (c, [n = 0, name = "", etal = "", sep = " "]) => creators(c, n, [["primary"]], name, etal, sep, 0, 0),
	},
	editors: {
		params: ["n", "name", "etal", "sep"],
		run: (c, [n = 0, name = "", etal = "", sep = " "]) => creators(c, n, "editor", name, etal, sep, 0, 0),
	},
	journal: {
		params: ["abbrev"],
		run: (c, [abbrev = "abbrev+auto"]) => {
			if (abbrev === "off" || abbrev === "full") return c.field("publicationTitle");
			return c.field("journalAbbreviation") || c.field("publicationTitle");
		},
	},
	firstpage: { params: [], run: (c) => c.field("pages").split(/[-\s,–]/)[0] ?? "" },
	lastpage: { params: [], run: (c) => c.field("pages").split(/[-\s,–]/).pop() ?? "" },
	keyword: {
		params: ["n"],
		run: (c, [n = 0]) => {
			const tags = ((c.data.tags ?? []) as { tag: string }[]).map((t) => t.tag).sort();
			return tags[n] ?? "";
		},
	},
	shorttitle: {
		params: ["n", "m"],
		run: (c, [n = 3, m = 0]) => c.words(c.title).slice(0, n).map((w, i) => (i < m ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" "),
	},
	veryshorttitle: {
		params: ["n", "m"],
		run: (c, [n = 1, m = 0]) => c.words(c.title).slice(0, n).map((w, i) => (i < m ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" "),
	},
	title: { params: [], run: (c) => c.words(c.title).join(" ") },
	shortyear: { params: [], run: (c) => formatDate(c.date, "%y") },
	year: { params: [], run: (c) => padYear(formatDate(c.date, "%-Y"), 2) },
	date: { params: ["format"], run: (c, [format = "%Y-%m-%d"]) => formatDate(c.date, String(format)) },
	origyear: { params: [], run: (c) => padYear(formatDate(c.date, "%-oY"), 2) },
	origdate: { params: [], run: (c) => formatDate(c.date, "%oY-%om-%od") },
	month: { params: [], run: (c) => MONTHS[Number(c.date.m) - 1] ?? "" },
	type: {
		params: ["allowed"],
		run: (c, a) => {
			const allowed = a.flat().map((x: unknown) => String(x).toLowerCase());
			if (!allowed.length) return c.itemType;
			if (!allowed.includes(c.itemType.toLowerCase())) skip();
			return "";
		},
	},
	language: {
		params: ["names"],
		run: (c, a) => {
			const want = a.flat().map((x: unknown) => String(x).toLowerCase());
			const lang = String(c.data.language ?? "").toLowerCase();
			if (!want.some((w: string) => lang === w || lang.startsWith(`${w}-`) || lang.startsWith(`${w}_`))) skip();
			return "";
		},
	},
	library: { params: [], run: () => "" }, // single user library: always matches
	group: { params: ["name"], run: () => skip() }, // there are no group libraries to match
	item: { params: ["id"], run: (c, [id = "key"]) => (id === "id" ? c.data.key : c.data.key) },
	field: { params: ["name"], run: (c, [name]) => c.field(String(name)) },
	zotero: {
		params: [],
		run: (c) => {
			c.postfix = { template: "-%(n)s", offset: 0 };
			const a = c.byKind("*", "%(f)s")[0] ?? "";
			const y = c.date.Y;
			const t = (c.title.match(/[\p{L}\p{N}]+/gu) ?? []).find((w) => w.length > 3) ?? "";
			return `${a}${t ? t[0]!.toUpperCase() + t.slice(1).toLowerCase() : ""}${y}`;
		},
	},
	extra: {
		params: ["variable"],
		run: (c, [variable]) => {
			const names = String(variable).toLowerCase().trim().split(/\s*\/\s*/).filter(Boolean);
			for (const n of names) {
				const tex = c.extra.tex[n.replace(/^tex\./, "")];
				if (tex) return tex.value;
				const kv = c.extra.kv[norm(n)];
				if (kv) return kv;
			}
			return "";
		},
	},
	pinned: { params: [], run: () => "" },
	postfix: {
		params: ["format", "start"],
		run: (c, [format = "%(a)s", start = 0]) => {
			c.postfix = { template: String(format), offset: postfixStart(start) };
			return "";
		},
	},
	infix: {
		params: ["format", "start"],
		run: (c, [format = "%(a)s", start = 0]) => {
			c.postfix = { template: String(format), offset: postfixStart(start) };
			return MARK;
		},
	},
	transliterate: {
		params: ["mode"],
		run: (c, [mode]) => {
			c.translit = mode === "german" || mode === "de" ? "german" : "minimal";
			return "";
		},
	},
	creatortypes: {
		params: ["match"],
		run: (c, [match]) => {
			const list = `${c.itemType}:${c.creators.map((x) => `${x.name ? 1 : 2}${x.creatorType}`).join(",")}`;
			if (match instanceof RegExp && !match.test(list)) skip();
			return match instanceof RegExp ? "" : list;
		},
	},
	inspirehep: { params: [], run: () => skip() },
};
// BBT aliases
FUNCTIONS.getfield = FUNCTIONS.field!;

function postfixStart(start: unknown): number {
	if (typeof start === "number") return start;
	let n = 0;
	const a = "A".charCodeAt(0) + 1;
	for (const ch of String(start).toUpperCase().replace(/[^A-Z]/g, "")) n = n * 26 + (ch.charCodeAt(0) - a);
	return n;
}

function creators(c: Ctx, nIn: unknown, type: unknown, name: unknown, etalIn: unknown, sep: unknown, min: unknown, max: unknown): string {
	const template = String(name || c.nameTemplate);
	let etal = String(etalIn ?? "");
	const types = c.creators.map((x) => x.creatorType);
	const include: string[] = [];
	const exclude: string[] = [];
	const resolve = (t: string) => (t === "*" ? types[0] ?? "" : t === "primary" ? c.primary : t);
	const spec = type === undefined || type === "" ? [["primary", "editor", "translator", "*"]] : type;
	if (typeof spec === "string") include.push(resolve(spec));
	else {
		for (let t of spec as unknown[]) {
			if (Array.isArray(t)) t = t.map((x) => resolve(String(x))).find((x) => types.includes(x));
			if (!t) continue;
			const s = String(t);
			(s[0] === "-" ? exclude : include).push(s.replace(/^-/, ""));
		}
	}
	let list = c.creators
		.filter((x) => !include.length || include.includes(x.creatorType))
		.filter((x) => !exclude.length || !exclude.includes(x.creatorType))
		.map((x) => c.nameOf(x, template));
	if ((Number(min) && list.length < Number(min)) || (Number(max) && list.length > Number(max))) skip();
	const s = String(sep ?? " ");
	if (!nIn) etal = "";
	else {
		let range: [number, number];
		if (Array.isArray(nIn)) {
			range = [Number(nIn[0]), Number(nIn[1])];
			etal = "";
		} else {
			const n = Number(nIn);
			if (n >= list.length) etal = "";
			range = [1, n];
		}
		list = list.slice(range[0] - 1, range[1]);
		if (etal && !etal.replace(/[a-z]/gi, "").length) etal = `${s}${etal}`;
	}
	return list.join(s) + etal;
}

function formatDate(date: ParsedDate, format: string): string {
	if (!date.Y && !date.oY) return "";
	let keep = true;
	const parts = format.split(/(%-?o?[a-z]|%%)/i).map((spec, i) => {
		if (i % 2 === 0) return spec;
		if (spec === "%%") return "%";
		const pad = spec[1] !== "-";
		const field = spec.slice(pad ? 1 : 2) as keyof ParsedDate;
		if (!(field in date)) throw new FormulaError(`date format: unsupported ${JSON.stringify(spec)}`);
		let v = date[field];
		if (!v) return null;
		if (pad) v = padYear(v, field === "Y" || field === "oY" ? 4 : 2);
		return v;
	});
	return parts
		.filter((f, i, arr) => {
			if (i % 2 === 0) keep = keep && !!arr[i + 1];
			else keep = keep && !!f;
			return keep;
		})
		.join("");
}

// ---------------------------------------------------------------- filters

type Filter = { params: string[]; run: (c: Ctx, input: string, a: any[]) => string };
const lenOf = (s: string) => s.replace(/\s/g, "").replace(MARK, "").length;
function lenTest(input: string, rel: unknown, n: number): string {
	const l = lenOf(input);
	const ok = { "<": l < n, "<=": l <= n, "==": l === n, "!=": l !== n, ">=": l >= n, ">": l > n }[String(rel)];
	if (ok === undefined) throw new FormulaError(`unexpected length comparison ${String(rel)}`);
	if (!ok) skip();
	return input;
}
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const cleanText = (c: Ctx, s: string, spaces = false) => c.trans(s).replace(spaces ? /[\\"#%'(),={}~�]/g : /[\\"#%'(),={}~�\s]/g, "").trim();

const FILTERS: Record<string, Filter> = {
	lower: { params: [], run: (_c, s) => s.toLowerCase() },
	upper: { params: [], run: (_c, s) => s.toUpperCase() },
	len: { params: ["relation", "length"], run: (_c, s, [rel = ">", n = 0]) => lenTest(s, rel, Number(n)) },
	default: { params: ["text"], run: (_c, s, [t = ""]) => s || String(t) },
	discard: { params: [], run: () => "" },
	capitalize: { params: ["wordstart"], run: (_c, s, [re]) => s.replace(re instanceof RegExp ? re : /((?<=^|\s)[a-z])/g, (m) => m.toUpperCase()) },
	condense: { params: ["sep"], run: (_c, s, [sep = ""]) => s.replace(/\s+/g, String(sep)) },
	prefix: { params: ["prefix"], run: (_c, s, [p = ""]) => (s && p ? `${p}${s}` : s) },
	postfix: { params: ["postfix"], run: (_c, s, [p = ""]) => (s && p ? `${s}${p}` : s) },
	abbr: { params: ["chars"], run: (_c, s, [n = 1]) => s.split(/\s+/).map((w) => w.slice(0, Number(n))).join("") },
	ascii: { params: [], run: (_c, s) => s.replace(/[^ -~]/g, "").split(/\s+/).join(" ").trim() },
	alphanum: { params: [], run: (_c, s) => s.replace(/[^\p{L}\p{N}]/gu, "").split(/\s+/).join(" ").trim() },
	nopunct: { params: ["dash"], run: (_c, s, [d = "-"]) => nopunct(s, String(d)) },
	nopunctordash: { params: [], run: (_c, s) => nopunct(s, "") },
	skipwords: {
		params: ["nopunct"],
		run: (c, s, [np = false]) => titleWords(s, { skipWords: c.cfg.skipWords, nopunct: !!np, fold: c.cfg.fold }).join(" "),
	},
	select: {
		params: ["start", "n"],
		run: (_c, s, [startIn = 1, nIn]) => {
			const values = s.split(/\s+/);
			let end = values.length;
			let start = Number(startIn);
			if (start === 0) start = 1;
			start = start < 0 ? end + start : start - 1;
			if (nIn !== undefined) end = start + Math.max(1, Number(nIn));
			return values.slice(start, end).join(" ");
		},
	},
	substring: {
		params: ["start", "n"],
		run: (_c, s, [start = 1, n]) => {
			const len = n === undefined ? s.length : Number(n);
			return s.slice(Number(start) - 1, Number(start) - 1 + len);
		},
	},
	clean: { params: [], run: (c, s) => cleanText(c, s, true) },
	transliterate: { params: ["mode"], run: (c, s, [mode]) => transliterate(s, mode === "german" || mode === "de" ? "german" : c.translit) },
	replace: {
		params: ["find", "replace"],
		run: (_c, s, [find, rep = ""]) => {
			if (!find) return s;
			const re = find instanceof RegExp ? find : new RegExp(escRe(String(find)), "ig");
			return s.replace(re, String(rep));
		},
	},
	match: {
		params: ["match", "clean"],
		run: (c, s, [match, cl = false]) => {
			if (!match) return s;
			const cleaned = (t: string) => (cl ? cleanText(c, t, true) : t);
			const re = match instanceof RegExp ? match : new RegExp(escRe(cleaned(String(match))), "i");
			const m = cleaned(s).match(re);
			if (!m) skip();
			const offset = re.global ? 0 : 1;
			return m!.length === offset ? s : m!.slice(offset).join(" ");
		},
	},
	find: {
		params: ["match", "passthrough"],
		run: (c, s, [match, pass = false]) => {
			try {
				return FILTERS.match!.run(c, s, [match, false]);
			} catch (e) {
				if (e instanceof Skip) return pass ? s : "";
				throw e;
			}
		},
	},
	numeric: { params: [], run: (_c, s) => (Number.isNaN(parseInt(s, 10)) ? "" : s) },
	formatdate: { params: ["format"], run: (_c, s, [f = "%Y-%m-%d"]) => formatDate(parseDate(s), String(f)) },
	localtime: {
		params: [],
		run: (_c, s) => {
			if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}Z?$/.test(s)) return "";
			const d = new Date(`${s.replace(" ", "T").replace(/Z$/, "")}Z`);
			d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
			return d.toISOString().replace(".000Z", "").replace("T", " ");
		},
	},
	acronym: { params: ["list", "reload", "passthrough"], run: (_c, s, [, , pass = false]) => (pass ? s : "") },
	ideographs: { params: [], run: (_c, s) => s },
	jieba: { params: [], run: (_c, s) => s },
	kuromoji: { params: [], run: (_c, s) => s },
	pinyin: { params: [], run: (_c, s) => s },
};
FILTERS.fold = FILTERS.transliterate!;
FILTERS.splitideographs = FILTERS.ideographs!;

// ---------------------------------------------------------------- evaluate

function bind(spec: { params: string[] }, a: Args, at: number, what: string): any[] {
	const out: any[] = [...a.pos];
	for (const [k, v] of Object.entries(a.named)) {
		const idx = spec.params.indexOf(k);
		if (idx < 0) throw new FormulaError(`${what} has no parameter "${k}"`, at);
		out[idx] = v;
	}
	return out;
}

function evalNode(n: Node, c: Ctx): string {
	switch (n.t) {
		case "str":
			return n.v;
		case "field":
			return c.field(n.name);
		case "call": {
			const f = FUNCTIONS[n.name.toLowerCase()]!;
			return f.run(c, bind(f, n.args, n.at, n.name));
		}
		case "filter": {
			const f = FILTERS[n.name.toLowerCase()]!;
			return f.run(c, evalNode(n.input, c), bind(f, n.args, n.at, `.${n.name}`));
		}
		case "cat":
			return n.parts.map((p) => evalNode(p, c)).join("");
		case "or": {
			for (const p of n.parts.slice(0, -1)) {
				try {
					const r = evalNode(p, c);
					if (r) return r;
				} catch (e) {
					if (!(e instanceof Skip)) throw e;
				}
			}
			return evalNode(n.parts.at(-1)!, c);
		}
		case "and": {
			for (const p of n.parts.slice(0, -1)) {
				try {
					if (!evalNode(p, c)) return "";
				} catch (e) {
					if (e instanceof Skip) return "";
					throw e;
				}
			}
			return evalNode(n.parts.at(-1)!, c);
		}
		case "cond": {
			let ok = false;
			try {
				ok = !!evalNode(n.test, c);
			} catch (e) {
				if (!(e instanceof Skip)) throw e;
			}
			return evalNode(ok ? n.yes : n.no, c);
		}
		case "cmp":
			return lenTest(evalNode(n.input, c), n.op, n.n);
	}
}

export interface Generated {
	/** key text; MARK (\x1a) marks where a duplicate postfix goes */
	text: string;
	postfix: { template: string; offset: number };
}

/** Run a compiled formula for an item: the first alternative that yields text. */
export function generate(f: Compiled, data: ZoteroItemData, cfg: FormulaConfig): Generated {
	let text = "";
	let ctx = new Ctx(data, cfg);
	for (let i = 0; i < f.alternatives.length; i++) {
		ctx = new Ctx(data, cfg);
		try {
			text = evalNode(f.alternatives[i]!, ctx);
		} catch (e) {
			if (!(e instanceof Skip)) throw e;
			text = "";
		}
		if (text.replace(MARK, "").trim()) break;
		text = "";
	}
	if (text && cfg.fold) text = transliterate(text, ctx.translit);
	const unsafe = new RegExp(`[${cfg.unsafeChars.replace(/[\]\\^-]/g, "\\$&")}\\uFFFD\\s]`, "g");
	text = text.replace(unsafe, "");
	if (text && !text.includes(MARK)) text += MARK;
	return { text, postfix: ctx.postfix };
}

/** Format a duplicate postfix: `%(a)s` letters (a, b, ... aa), `%(A)s` capitals, `%(n)s` numbers (1-based). */
export function formatPostfix(template: string, index: number): string {
	const alpha = (n: number) => {
		let s = "";
		let x = n;
		do {
			s = String.fromCharCode(97 + (x % 26)) + s;
			x = Math.floor(x / 26) - 1;
		} while (x >= 0);
		return s;
	};
	return template
		.replace(/%\(a\)s/g, alpha(index))
		.replace(/%\(A\)s/g, alpha(index).toUpperCase())
		.replace(/%\(n\)(?:0?(\d+)d|s)/g, (_m, w?: string) => String(index + 1).padStart(w ? Number(w) : 0, "0"));
}

/** Check a postfix template: it needs exactly one of %(a)s, %(A)s, %(n)s. */
export function validPostfix(template: string): boolean {
	return (template.match(/%\((?:a|A|n)\)(?:0?\d+d|s)/g) ?? []).length === 1;
}
