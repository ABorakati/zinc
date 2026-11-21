// The differential checks. A = Zotero's load(html); H1 = Zotero's save(A); B = the bridge's random edits of A.
//   R1  our roundtrip(A) deep-equals A (and keeps citation / annotation / image attrs byte for byte, key order included)
//   R2a Zinc's parse.ts: parse(html) == A            R2b Zinc's serialize.ts: serializeNote(A, html) == H1 (byte-equal)
//   E0  the bridge edited without an error (model invariants hold after every step)
//   E1  Zotero's schema accepts B (Node.fromJSON(B).check())
//   E2  Zotero's load(save(B)) == B: nothing the editor holds changes when the saved note is reopened
//   E3  citation / image / annotation attrs in B that are also in A are byte-identical to the original
//   E4  Zinc's serializeNote(B) == Zotero's save(B)
import type { NoteNode, NoteParser } from "../../src/notes/native/parse";
import { serializeNote, stableDoc } from "../../src/notes/native/serialize";
import type { Bridge } from "./bridge";
import type { Oracle } from "./oracle";

export const CHECKS = ["R1", "R2a", "R2b", "R2c", "E0", "E1", "E2", "E3", "E4"] as const;
export interface Failure {
	check: string;
	detail: string;
	/** the kind of the failure, stable while the shrinker cuts the note down: a smaller note must fail the same way */
	sig: string;
}
export interface Env {
	oracle: Oracle;
	bridge: Bridge;
	parser: NoteParser;
	steps: number;
}

/** JSON with object keys sorted at every depth (what "deep-equal" means for ProseMirror JSON) */
export function canon(v: unknown): string {
	return JSON.stringify(v, (_k, x) =>
		x && typeof x === "object" && !Array.isArray(x)
			? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
			: x,
	);
}

const short = (v: unknown, n = 90) => {
	const s = typeof v === "string" ? JSON.stringify(v) : (JSON.stringify(v) ?? "undefined");
	return s.length > n ? s.slice(0, n) + "…" : s;
};

const kind = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

/** The type of the document node a path (`$.content[1].content[0].attrs.x`) goes through last, and the rest of the path after it. */
function nodeAt(root: any, path: string): { type: string; rest: string } {
	let node = root;
	let type = node?.type ?? "?";
	const segs = path.slice(1).match(/\.[A-Za-z_]+|\[\d+\]/g) ?? [];
	let i = 0;
	while (i + 1 < segs.length && segs[i] === ".content" && /^\[\d+\]$/.test(segs[i + 1]!)) {
		node = node?.content?.[Number(segs[i + 1]!.slice(1, -1))];
		type = node?.type ?? `${type}/?`;
		i += 2;
	}
	return {
		type,
		rest: segs
			.slice(i)
			.join("")
			.replace(/\[\d+\]/g, "[]"),
	};
}

/** The first place two JSON values differ: its path, the two values, and a signature (node type, rest of the path, value kinds). */
export function firstDiff(
	a: unknown,
	b: unknown,
	path = "$",
	root: { a: unknown; b: unknown } = { a, b },
): { text: string; sig: string } | null {
	if (canon(a) === canon(b)) return null;
	if (Array.isArray(a) && Array.isArray(b)) {
		for (let i = 0; i < Math.max(a.length, b.length); i++) {
			const d = firstDiff(a[i], b[i], `${path}[${i}]`, root);
			if (d) return d;
		}
	} else if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
		const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
		for (const k of keys) {
			const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, root);
			if (d) return d;
		}
	}
	const here = nodeAt(root.a, path);
	const there = nodeAt(root.b, path);
	const t = here.type === there.type ? here.type : `${here.type}/${there.type}`;
	const vals = typeof a === "string" && typeof b === "string" && a.length < 24 && b.length < 24 && /type$/.test(path) ? ` ${a}/${b}` : "";
	// the node that is only on one side: its own type
	const extra = a === undefined ? ` +${(b as any)?.type ?? kind(b)}` : b === undefined ? ` -${(a as any)?.type ?? kind(a)}` : "";
	return { text: `${path}: ${short(a)} vs ${short(b)}`, sig: `${t}${here.rest} ${kind(a)}/${kind(b)}${vals}${extra}` };
}

/** The first differing token of two canonical HTML token lists, with a signature (tag names and short attribute values). */
function tokenDiff(a: string[], b: string[]): { text: string; sig: string } {
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	const gen = (t: string | undefined) =>
		t === undefined ? "<end>" : t.startsWith("#text") ? "#text" : t.replace(/="([^"]{13,})"/g, '="…"');
	const ctx = a.slice(Math.max(0, i - 2), i).join(" ");
	return {
		text: `token ${i}: ${short(a[i], 120)} vs ${short(b[i], 120)} (after ${short(ctx, 80)})`,
		sig: `${gen(a[i])} vs ${gen(b[i])}`,
	};
}

function firstStringDiff(a: string, b: string): { text: string; sig: string } {
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	const from = Math.max(0, i - 30);
	return { text: `at ${i}: …${JSON.stringify(a.slice(from, i + 50))} vs …${JSON.stringify(b.slice(from, i + 50))}`, sig: "bytes" };
}

/** attrs of every node that must round-trip untouched, in document order: [type, attrs as JSON text] */
export function rawAttrs(doc: unknown): [string, string][] {
	const out: [string, string][] = [];
	const walk = (n: any) => {
		if (["citation", "image", "highlight", "underline_annotation"].includes(n.type)) out.push([n.type, JSON.stringify(n.attrs)]);
		for (const c of n.content ?? []) walk(c);
	};
	walk(doc);
	return out;
}

async function quietly<T>(f: () => T | Promise<T>): Promise<T> {
	const { log, warn } = console;
	console.log = console.warn = () => {};
	try {
		return await f();
	} finally {
		console.log = log;
		console.warn = warn;
	}
}

/** Colours as the CSSOM prints them: Gecko (Zotero) and jsdom print `rgb(255, 32, 32)` for a note's `color: #ff2020`, linkedom keeps the text. */
function withCanonColors(oracle: Oracle, doc: unknown): unknown {
	const walk = (n: any): any => {
		const o = { ...n };
		if (o.attrs && typeof o.attrs.background === "string") o.attrs = { ...o.attrs, background: oracle.cssColor(o.attrs.background) };
		if (o.marks)
			o.marks = o.marks.map((m: any) => {
				if (!(m.attrs && typeof m.attrs.color === "string" && m.attrs.color)) return m;
				let color = oracle.cssColor(m.attrs.color);
				// Zotero's backgroundColor parse rule adds 50% alpha to the palette's hex colours; Gecko hands it rgb(), so it never fires there
				const half = /^rgba\((\d+), (\d+), (\d+), 0\.5\)$/.exec(color);
				if (m.type === "backgroundColor" && half && PALETTE_RGB.includes(`rgb(${half[1]}, ${half[2]}, ${half[3]})`))
					color = `rgb(${half[1]}, ${half[2]}, ${half[3]})`;
				return { ...m, attrs: { ...m.attrs, color } };
			});
		if (o.content) o.content = o.content.map(walk);
		return o;
	};
	return walk(doc);
}

/** Zotero's highlight palette (`HIGHLIGHT_COLORS`) without its alpha, as the CSSOM prints it. */
const PALETTE_RGB = ["#ff6666", "#f19837", "#ffd400", "#5fb236", "#a28ae5", "#e56eee", "#2ea8e5", "#aaaaaa"].map(
	(h) => `rgb(${[1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(", ")})`,
);

/**
 * What Zotero's own editor does to a document when the note is saved and opened again (a `load(save(doc))` that is not the identity
 * by design, so not a bug of ours): the edits of a user would show the same. Applied to both sides of E2.
 *  - text is NFC-normalised on save.
 *  - white space: HTML collapses and trims it (text blocks), drops a newline right after <pre>, and a text node of only white space
 *    can vanish; two spaces are written as space + NBSP. Compared with all white space removed.
 *  - a note that is one empty text block is saved as "" and opens as an empty paragraph.
 *  - buildToHTML unwraps a list item's lone <p>: its indent, align and dir are not written.
 *  - an image's originalSrc and tempSrc are not written; an ordered list's start that is NaN (null) is not either.
 *  - column widths: see below.
 *  - a table cell's background-color style is read again as a backgroundColor mark on its text.
 */
export function reloadNormal(doc: any): any {
	const ws = /[ \t\n\r\f\u00a0]+/g;
	const emptyPara = { type: "paragraph", attrs: { indent: null, align: null, dir: null } };
	const walk = (n: any, cell: boolean, soleInItem: boolean): any => {
		let o = { ...n };
		const inCell = cell || ((o.type === "table_cell" || o.type === "table_header") && !!o.attrs?.background);
		if (o.marks && inCell) o.marks = o.marks.filter((m: any) => m.type !== "backgroundColor");
		if (o.type === "text") {
			o.text = o.text.replace(ws, "").normalize("NFC");
			if (o.marks && !o.marks.length) delete o.marks;
			return o.text ? o : null;
		}
		// fixTables copies a column's width into every cell of it each time a table opens, and does not do so for the cells it adds
		if (o.attrs && "colwidth" in o.attrs) o.attrs = { ...o.attrs, colwidth: null };
		// an ordered list start that is not a number (NaN) is not written
		if (o.type === "orderedList" && o.attrs && o.attrs.order === null) o.attrs = { ...o.attrs, order: 1 };
		if (o.type === "image" && o.attrs) o.attrs = { ...o.attrs, originalSrc: null, tempSrc: null };
		if (o.type === "paragraph" && soleInItem) o.attrs = { indent: null, align: null, dir: null };
		if (o.content) {
			const sole = o.type === "listItem" && o.content.length === 1;
			const kids: any[] = [];
			for (const c of o.content) {
				const w = walk(c, inCell, sole);
				if (!w) continue;
				const last = kids[kids.length - 1];
				if (w.type === "text" && last?.type === "text" && canon(last.marks) === canon(w.marks)) last.text += w.text;
				else kids.push(w);
			}
			if (kids.length) o.content = kids;
			else delete o.content;
		}
		if (o.marks && !o.marks.length) delete o.marks;
		return o;
	};
	const d = walk(doc, false, false);
	const only = d.content?.length === 1 ? d.content[0] : null;
	if (only && ["paragraph", "heading", "codeBlock", "math_display"].includes(only.type) && !only.content)
		return { type: "doc", content: [emptyPara] };
	return d;
}

/** Failures of one note. A failure with check "oracle" means the generator or the oracle, not the code under test, broke. */
export async function runChecks(env: Env, html: string, seed: number, only?: string): Promise<Failure[]> {
	const want = (prefix: string) => !only || only.startsWith(prefix) || (prefix === "R2" && only === "R2c");
	return quietly(async () => {
		const fails: Failure[] = [];
		const fail = (check: string, detail: string, sig = detail.replace(/[0-9]+/g, "#").slice(0, 60)) =>
			fails.push({ check, detail, sig });
		const failD = (check: string, d: { text: string; sig: string }) => fail(check, d.text, d.sig);
		const { oracle, bridge, parser } = env;
		const asDoc = (x: unknown) => stableDoc(withCanonColors(oracle, x) as NoteNode);

		let A: ReturnType<Oracle["load"]>;
		let H1: string;
		try {
			A = oracle.load(html);
			H1 = oracle.save(A.doc, A.metadata);
		} catch (e) {
			return [{ check: "oracle", detail: String((e as Error)?.stack ?? e).slice(0, 300), sig: "oracle" }];
		}

		// R1
		if (want("R1"))
			try {
				const r = await bridge.call({ op: "roundtrip", doc: A.doc });
				if (r.error) fail("R1", `bridge: ${r.error}`, "bridge error");
				else {
					const d = firstDiff(A.doc, r.doc);
					if (d) failD("R1", d);
					else {
						const a = rawAttrs(A.doc);
						const b = rawAttrs(r.doc);
						for (let i = 0; i < a.length; i++)
							if (a[i]![1] !== b[i]?.[1]) {
								fail(
									"R1",
									`${a[i]![0]} attrs differ byte-wise (key order?): ${short(a[i]![1], 140)} vs ${short(b[i]?.[1], 140)}`,
									"attrs bytes",
								);
								break;
							}
					}
				}
			} catch (e) {
				fail("R1", `bridge: ${(e as Error).message} ${bridge.stderr.slice(-200)}`, "bridge died");
			}

		// R2
		// Not ported to parse.ts: prosemirror-tables' fixTables, which Zotero runs on a table with overlapping, missing or overlong
		// cells (ragged rows, spans past the table). Such a table opens differently in Zinc's read-only view; the doc it saves is the oracle's.
		if (want("R2") && !A.ran.includes("fixTables"))
			try {
				const d = firstDiff(asDoc(parser.parse(html)), asDoc(A.doc));
				if (d) failD("R2a", d);
			} catch (e) {
				fail("R2a", `throws: ${(e as Error).message}`, "throws");
			}
		const zinc = (doc: NoteNode, compare: string, check: string) => {
			try {
				const out = serializeNote(doc, html);
				if (out !== compare) {
					const d = tokenDiff(oracle.canonHtml(out), oracle.canonHtml(compare));
					// R2b: the notes differ as HTML; R2c: only in bytes (attribute order, entity forms, `style` formatting: linkedom vs Gecko)
					if (d.sig !== "<end> vs <end>" && oracle.canonHtml(out).join("\n") !== oracle.canonHtml(compare).join("\n"))
						failD(check, d);
					else if (check === "R2b") failD("R2c", firstStringDiff(out, compare));
				}
			} catch (e) {
				fail(check, `throws: ${(e as Error).message}`, "throws");
			}
		};
		if (want("R2")) zinc(A.doc as NoteNode, H1, "R2b");

		// edits
		let B: any;
		if (want("E"))
			try {
				const r = await bridge.call({ op: "edit", doc: A.doc, seed, steps: env.steps });
				if (r.error)
					fail(
						"E0",
						r.error,
						r.error
							.replace(/[0-9]+/g, "#")
							.replace(/^step # \(.*?\): /, "")
							.slice(0, 60),
					);
				else B = r.doc;
			} catch (e) {
				fail("E0", `${(e as Error).message} ${bridge.stderr.slice(-300)}`, "bridge died");
			}
		if (B) {
			let valid = true;
			try {
				oracle.check(B);
			} catch (e) {
				valid = false;
				fail(
					"E1",
					String((e as Error).message).slice(0, 300),
					String((e as Error).message)
						.replace(/[0-9]+/g, "#")
						.replace(/<.*>/, "<…>")
						.slice(0, 60),
				);
			}
			// E3 does not need a valid document
			const was = rawAttrs(A.doc);
			const orig = new Set(was.map(([t, a]) => `${t} ${a}`));
			for (const [t, a] of rawAttrs(B)) {
				if (orig.has(`${t} ${a}`)) continue;
				// a changed attrs object is a changed copy of an original when it has the same node id; annotations have none
				const id = JSON.parse(a).nodeID;
				const before = id && was.find(([tt, aa]) => tt === t && JSON.parse(aa).nodeID === id);
				if (before) fail("E3", `${t} attrs changed: ${short(before[1], 120)} -> ${short(a, 120)}`, `${t} changed`);
				else if (t !== "image" && t !== "citation")
					fail("E3", `${t} attrs not in the original note: ${short(a, 160)}`, `${t} invented`);
				else fail("E3", `${t} attrs not in the original note: ${short(a, 160)}`, `${t} invented`);
				break;
			}
			if (valid) {
				try {
					const H2 = oracle.save(B, A.metadata);
					const again = oracle.load(H2);
					const d = firstDiff(reloadNormal(asDoc(B)), reloadNormal(asDoc(again.doc)));
					if (d) fail("E2", `${d.text} [load ran: ${again.ran.join(",") || "nothing"}]`, d.sig);
					zinc(B as NoteNode, H2, "E4");
				} catch (e) {
					fail("E2", `oracle save/load throws: ${(e as Error).message}`, "throws");
				}
			}
		}
		return fails;
	});
}
