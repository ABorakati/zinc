// A small Fluent (.ftl) implementation: enough for plugin strings. Supported: messages and terms, multi-line values, attributes
// (`.name = ...`), comments, placeables of variables `{ $x }`, message and term references (with attributes), string and number
// literals, selects with plural-category and exact keys (`*[other]` default), and the functions NUMBER and DATETIME with named
// options. Not supported: parameterised terms' argument scoping beyond passing them, `-term` variant selection by `[key]` on
// references, bidi isolation marks, and the full error-recovery rules (a broken entry is skipped and reported).

export type Expr =
	| { t: "str"; v: string }
	| { t: "num"; v: number }
	| { t: "var"; name: string }
	| { t: "msg"; id: string; attr?: string }
	| { t: "term"; id: string; attr?: string; args?: Record<string, Expr> }
	| { t: "fn"; name: string; pos: Expr[]; named: Record<string, Expr> }
	| { t: "select"; selector: Expr; variants: Variant[] }
	| { t: "pattern"; v: Pattern };

export interface Variant {
	key: { t: "id"; v: string } | { t: "num"; v: number };
	value: Pattern;
	def: boolean;
}

export type PatternElement = string | Expr;
export type Pattern = PatternElement[];

export interface Message {
	value?: Pattern;
	attrs: Record<string, Pattern>;
}

export interface Resource {
	messages: Map<string, Message>;
	terms: Map<string, Message>;
	errors: string[];
}

const ID = /^-?[A-Za-z][A-Za-z0-9_-]*/;

class Reader {
	pos = 0;
	constructor(readonly s: string) {}
	get eof() {
		return this.pos >= this.s.length;
	}
	peek(n = 0) {
		return this.s[this.pos + n];
	}
	skipWs() {
		while (!this.eof && /\s/.test(this.s[this.pos])) this.pos++;
	}
	expect(ch: string) {
		this.skipWs();
		if (this.s[this.pos] !== ch) throw new Error(`expected "${ch}" at ${this.pos}`);
		this.pos++;
	}
	startsWith(x: string) {
		return this.s.startsWith(x, this.pos);
	}
	ident(): string {
		const m = /^[A-Za-z][A-Za-z0-9_-]*/.exec(this.s.slice(this.pos, this.pos + 200));
		if (!m) throw new Error(`expected an identifier at ${this.pos}`);
		this.pos += m[0].length;
		return m[0];
	}
}

/** `text` is the dedented body of one value or attribute (placeables may span lines). */
function parsePattern(r: Reader, stop?: (r: Reader) => boolean): Pattern {
	const out: PatternElement[] = [];
	let text = "";
	const flush = () => {
		if (text) out.push(text);
		text = "";
	};
	while (!r.eof) {
		if (stop?.(r)) break;
		const ch = r.peek();
		if (ch === "{") {
			flush();
			r.pos++;
			out.push(parsePlaceable(r));
		} else {
			text += ch;
			r.pos++;
		}
	}
	flush();
	return out;
}

function parsePlaceable(r: Reader): Expr {
	r.skipWs();
	let e: Expr;
	if (r.peek() === "{") {
		r.pos++;
		e = { t: "pattern", v: [parsePlaceable(r)] };
	} else e = parseInline(r);
	r.skipWs();
	if (r.startsWith("->")) {
		r.pos += 2;
		const variants: Variant[] = [];
		for (;;) {
			r.skipWs();
			if (r.peek() === "}") break;
			let def = false;
			if (r.peek() === "*") {
				def = true;
				r.pos++;
			}
			r.expect("[");
			r.skipWs();
			let key: Variant["key"];
			const nm = /^-?\d+(\.\d+)?/.exec(r.s.slice(r.pos, r.pos + 40));
			if (nm) {
				key = { t: "num", v: Number(nm[0]) };
				r.pos += nm[0].length;
			} else {
				const start = r.pos;
				while (!r.eof && r.peek() !== "]") r.pos++;
				key = { t: "id", v: r.s.slice(start, r.pos).trim() };
			}
			r.skipWs();
			r.expect("]");
			// a variant's value runs to the next line that starts a variant or closes the select
			const value = parsePattern(r, (rd) => {
				if (rd.peek() !== "\n") return false;
				let i = rd.pos + 1;
				while (i < rd.s.length && (rd.s[i] === " " || rd.s[i] === "\t")) i++;
				const c = rd.s[i];
				return c === "[" || c === "}" || (c === "*" && rd.s[i + 1] === "[");
			});
			variants.push({ key, def, value: trimPattern(value) });
		}
		r.expect("}");
		if (!variants.some((v) => v.def)) throw new Error("a select needs a default variant (*[other])");
		return { t: "select", selector: e, variants };
	}
	r.expect("}");
	return e;
}

function trimPattern(p: Pattern): Pattern {
	const out = [...p];
	if (typeof out[0] === "string") out[0] = out[0].replace(/^\s+/, "");
	const last = out.length - 1;
	if (typeof out[last] === "string") out[last] = (out[last] as string).replace(/\s+$/, "");
	return out.filter((x) => x !== "");
}

function parseInline(r: Reader): Expr {
	r.skipWs();
	const c = r.peek();
	if (c === '"') {
		let v = "";
		r.pos++;
		while (!r.eof && r.peek() !== '"') {
			if (r.peek() === "\\") {
				const n = r.peek(1);
				if (n === "u") {
					v += String.fromCodePoint(parseInt(r.s.slice(r.pos + 2, r.pos + 6), 16));
					r.pos += 6;
					continue;
				}
				v += n;
				r.pos += 2;
				continue;
			}
			v += r.peek();
			r.pos++;
		}
		r.pos++;
		return { t: "str", v };
	}
	const nm = /^-?\d+(\.\d+)?/.exec(r.s.slice(r.pos, r.pos + 40));
	if (nm) {
		r.pos += nm[0].length;
		return { t: "num", v: Number(nm[0]) };
	}
	if (c === "$") {
		r.pos++;
		return { t: "var", name: r.ident() };
	}
	if (c === "-") {
		r.pos++;
		const id = r.ident();
		let attr: string | undefined;
		if (r.peek() === ".") {
			r.pos++;
			attr = r.ident();
		}
		let args: Record<string, Expr> | undefined;
		if (r.peek() === "(") args = parseCallArgs(r).named;
		return { t: "term", id, attr, args };
	}
	const id = r.ident();
	if (r.peek() === "(") {
		const a = parseCallArgs(r);
		return { t: "fn", name: id, pos: a.pos, named: a.named };
	}
	let attr: string | undefined;
	if (r.peek() === ".") {
		r.pos++;
		attr = r.ident();
	}
	return { t: "msg", id, attr };
}

function parseCallArgs(r: Reader): { pos: Expr[]; named: Record<string, Expr> } {
	r.expect("(");
	const pos: Expr[] = [];
	const named: Record<string, Expr> = {};
	for (;;) {
		r.skipWs();
		if (r.peek() === ")") {
			r.pos++;
			break;
		}
		const save = r.pos;
		const m = /^[A-Za-z][A-Za-z0-9_-]*/.exec(r.s.slice(r.pos, r.pos + 100));
		if (m && /^\s*:/.test(r.s.slice(r.pos + m[0].length, r.pos + m[0].length + 20))) {
			r.pos += m[0].length;
			r.skipWs();
			r.expect(":");
			named[m[0]] = parseInline(r);
		} else {
			r.pos = save;
			pos.push(parseInline(r));
		}
		r.skipWs();
		if (r.peek() === ",") r.pos++;
	}
	return { pos, named };
}

interface RawEntry {
	id: string;
	isTerm: boolean;
	/** lines after the `=`: the first is the rest of the id line, the others are indented continuation lines */
	lines: string[];
}

function dedent(lines: string[]): string {
	let min = Infinity;
	for (const l of lines.slice(1)) if (l.trim()) min = Math.min(min, /^[ \t]*/.exec(l)![0].length);
	if (!Number.isFinite(min)) min = 0;
	return lines.map((l, i) => (i === 0 ? l.replace(/^\s+/, "") : l.slice(Math.min(min, /^[ \t]*/.exec(l)![0].length)))).join("\n");
}

export function parseFluent(source: string): Resource {
	const res: Resource = { messages: new Map(), terms: new Map(), errors: [] };
	const lines = source.replace(/^﻿/, "").split(/\r\n|\r|\n/);
	const entries: RawEntry[] = [];
	let cur: RawEntry | undefined;
	for (const line of lines) {
		const head = /^(-?[A-Za-z][A-Za-z0-9_-]*)[ \t]*=(.*)$/.exec(line);
		if (head) {
			cur = { id: head[1].replace(/^-/, ""), isTerm: head[1].startsWith("-"), lines: [head[2]] };
			entries.push(cur);
		} else if (/^[ \t]+\S/.test(line) || (line.trim() === "" && cur)) {
			cur?.lines.push(line);
		} else if (line.startsWith("#")) {
			cur = undefined; // a comment ends the entry
		} else if (line.trim()) {
			cur = undefined;
			res.errors.push(`skipped: ${line.slice(0, 60)}`);
		}
	}
	for (const e of entries) {
		try {
			// split off attributes: a continuation line whose first non-blank text is `.name =`
			const valueLines: string[] = [];
			const attrs: Array<{ name: string; lines: string[] }> = [];
			let curAttr: { name: string; lines: string[] } | undefined;
			let depth = 0;
			for (const [i, l] of e.lines.entries()) {
				const am = i > 0 && depth === 0 ? /^[ \t]+\.([A-Za-z][A-Za-z0-9_-]*)[ \t]*=(.*)$/.exec(l) : null;
				if (am) {
					curAttr = { name: am[1], lines: [am[2]] };
					attrs.push(curAttr);
				} else (curAttr ? curAttr.lines : valueLines).push(l);
				for (const ch of l) depth += ch === "{" ? 1 : ch === "}" ? -1 : 0;
			}
			const toPattern = (ls: string[]): Pattern | undefined => {
				while (ls.length && !ls[ls.length - 1].trim()) ls.pop();
				const body = dedent(ls);
				if (!body.trim()) return undefined;
				const r = new Reader(body);
				const p = trimPattern(parsePattern(r));
				return p.length ? p : undefined;
			};
			const msg: Message = { value: toPattern(valueLines), attrs: {} };
			for (const a of attrs) {
				const p = toPattern(a.lines);
				if (p) msg.attrs[a.name] = p;
			}
			if (!msg.value && !Object.keys(msg.attrs).length) throw new Error("no value");
			(e.isTerm ? res.terms : res.messages).set(e.id, msg);
		} catch (err) {
			res.errors.push(`${e.id}: ${(err as Error).message}`);
		}
	}
	return res;
}

export type FluentArg = string | number | Date;

export interface FormatContext {
	locale: string;
	lookup(id: string): Message | undefined;
	term(id: string): Message | undefined;
	onError?(message: string): void;
}

/** Formats one message (or `message.attribute`). Returns undefined when the id is unknown. */
export function formatMessage(ctx: FormatContext, id: string, args: Record<string, FluentArg>): string | undefined {
	const dot = id.indexOf(".");
	const base = dot < 0 ? id : id.slice(0, dot);
	const attr = dot < 0 ? undefined : id.slice(dot + 1);
	const m = ctx.lookup(base);
	if (!m) return undefined;
	const p = attr ? m.attrs[attr] : m.value;
	if (!p) return undefined;
	return resolvePattern(ctx, p, args, 0);
}

function resolvePattern(ctx: FormatContext, p: Pattern, args: Record<string, FluentArg>, depth: number): string {
	if (depth > 20) return "{???}";
	let out = "";
	for (const el of p) out += typeof el === "string" ? el : stringify(ctx, evalExpr(ctx, el, args, depth + 1), args, depth + 1);
	return out;
}

type Value = string | number | Date | { missing: string };

function stringify(ctx: FormatContext, v: Value, _args: Record<string, FluentArg>, _depth: number): string {
	if (typeof v === "string") return v;
	if (typeof v === "number") return new Intl.NumberFormat(ctx.locale).format(v);
	if (v instanceof Date) return new Intl.DateTimeFormat(ctx.locale, { dateStyle: "medium" }).format(v);
	return `{${v.missing}}`;
}

function evalExpr(ctx: FormatContext, e: Expr, args: Record<string, FluentArg>, depth: number): Value {
	switch (e.t) {
		case "str":
			return e.v;
		case "num":
			return e.v;
		case "var": {
			if (e.name in args) return args[e.name];
			ctx.onError?.(`missing argument $${e.name}`);
			return { missing: `$${e.name}` };
		}
		case "msg": {
			const m = ctx.lookup(e.id);
			const p = m && (e.attr ? m.attrs[e.attr] : m.value);
			if (!p) {
				ctx.onError?.(`unknown message ${e.id}`);
				return { missing: e.id };
			}
			return resolvePattern(ctx, p, args, depth);
		}
		case "term": {
			const m = ctx.term(e.id);
			const p = m && (e.attr ? m.attrs[e.attr] : m.value);
			if (!p) {
				ctx.onError?.(`unknown term -${e.id}`);
				return { missing: `-${e.id}` };
			}
			const termArgs: Record<string, FluentArg> = {};
			for (const [k, v] of Object.entries(e.args ?? {})) {
				const val = evalExpr(ctx, v, args, depth);
				if (typeof val === "string" || typeof val === "number" || val instanceof Date) termArgs[k] = val;
			}
			return resolvePattern(ctx, p, termArgs, depth);
		}
		case "pattern":
			return resolvePattern(ctx, e.v, args, depth);
		case "fn": {
			const pos = e.pos.map((x) => evalExpr(ctx, x, args, depth));
			const named: Record<string, string | number> = {};
			for (const [k, v] of Object.entries(e.named)) {
				const val = evalExpr(ctx, v, args, depth);
				if (typeof val === "string" || typeof val === "number") named[k] = val;
			}
			if (e.name === "NUMBER") {
				const n = pos[0];
				if (typeof n !== "number") return typeof n === "string" ? n : { missing: "NUMBER()" };
				return new Intl.NumberFormat(ctx.locale, numberOptions(named)).format(n);
			}
			if (e.name === "DATETIME") {
				const d = pos[0];
				if (!(d instanceof Date)) return { missing: "DATETIME()" };
				return new Intl.DateTimeFormat(ctx.locale, dateOptions(named)).format(d);
			}
			ctx.onError?.(`unknown function ${e.name}`);
			return { missing: `${e.name}()` };
		}
		case "select": {
			const sel = evalExpr(ctx, e.selector, args, depth);
			const num = typeof sel === "number" ? sel : undefined;
			const text = typeof sel === "string" ? sel : undefined;
			let chosen: Variant | undefined;
			for (const v of e.variants) {
				if (v.key.t === "num" ? num === v.key.v : text === v.key.v) {
					chosen = v;
					break;
				}
			}
			if (!chosen && num !== undefined) {
				const cat = new Intl.PluralRules(ctx.locale).select(num);
				chosen = e.variants.find((v) => v.key.t === "id" && v.key.v === cat);
			}
			chosen ??= e.variants.find((v) => v.def)!;
			return resolvePattern(ctx, chosen.value, args, depth);
		}
	}
}

function numberOptions(o: Record<string, string | number>): Intl.NumberFormatOptions {
	const r: Intl.NumberFormatOptions = {};
	if (typeof o.minimumFractionDigits === "number") r.minimumFractionDigits = o.minimumFractionDigits;
	if (typeof o.maximumFractionDigits === "number") r.maximumFractionDigits = o.maximumFractionDigits;
	if (typeof o.minimumIntegerDigits === "number") r.minimumIntegerDigits = o.minimumIntegerDigits;
	if (o.useGrouping === "false") r.useGrouping = false;
	if (typeof o.style === "string") r.style = o.style as Intl.NumberFormatOptions["style"];
	if (typeof o.currency === "string") r.currency = o.currency;
	return r;
}

function dateOptions(o: Record<string, string | number>): Intl.DateTimeFormatOptions {
	const r: Intl.DateTimeFormatOptions = {};
	for (const k of ["dateStyle", "timeStyle", "weekday", "year", "month", "day", "hour", "minute", "second", "timeZone"] as const) {
		if (typeof o[k] === "string") (r as Record<string, unknown>)[k] = o[k];
	}
	if (!Object.keys(r).length) r.dateStyle = "medium";
	return r;
}
