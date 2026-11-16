// CslFormatter.formatDocument keeps one citeproc engine per document and only reprocesses inserted, edited and deleted
// citations. Whatever it does, its result must be what format() (a new engine, every citation in order) gives for the same
// document: this replays random edit sequences and compares the two after every edit.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CslFormatter, type DocCitation, type FormatResult, type StyleSource } from "../../src/cite/docformat";
import type { CslItem } from "../../src/cite/docfields";

const FIX = join(import.meta.dir, "fixtures");
const src: StyleSource = {
	styleXml: async (id) => readFileSync(join(FIX, `${id}.csl`), "utf8"),
	localeXml: async (l) => (l === "en-US" ? readFileSync(join(FIX, "locales-en-US.xml"), "utf8") : null),
};

function rng(seed: number) {
	let s = seed;
	return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}

// shared surnames and years, so the author-date style has to disambiguate (initials, 2020a/2020b)
const SUR = ["Smith", "Jones", "Patel", "Chen", "Garcia", "Kim"];
const GIV = ["Anna", "Ben", "Carla", "David"];
function makeItems(n: number, r: () => number, version = 0): Map<string, CslItem> {
	const m = new Map<string, CslItem>();
	for (let i = 1; i <= n; i++) {
		const author = Array.from({ length: 1 + Math.floor(r() * 4) }, () => ({
			family: SUR[Math.floor(r() * SUR.length)]!,
			given: GIV[Math.floor(r() * GIV.length)]!,
		}));
		m.set(String(i), {
			id: String(i),
			type: "article-journal",
			title: `Outcomes study ${i}${version ? ` (rev ${version})` : ""}`,
			author,
			"container-title": "Journal of Tests",
			volume: String(1 + (i % 30)),
			page: `${10 * i}-${10 * i + 9}`,
			issued: { "date-parts": [[2018 + Math.floor(r() * 4)]] },
		} as unknown as CslItem);
	}
	return m;
}

function compare(a: FormatResult, b: FormatResult): string[] {
	const diffs: string[] = [];
	for (const [cid, out] of b.citations) {
		const got = a.citations.get(cid);
		if (got?.rtf !== out.rtf || got?.plain !== out.plain) diffs.push(`${cid}: "${got?.plain}" != "${out.plain}"`);
	}
	for (const cid of a.citations.keys()) if (!b.citations.has(cid)) diffs.push(`${cid}: extra`);
	const ea = a.bibliography?.all.map((e) => [e.ids.join(","), JSON.stringify(e.runs), e.omitted]) ?? [];
	const eb = b.bibliography?.all.map((e) => [e.ids.join(","), JSON.stringify(e.runs), e.omitted]) ?? [];
	if (JSON.stringify(ea) !== JSON.stringify(eb)) diffs.push("bibliography differs");
	return diffs;
}

describe("CslFormatter.formatDocument (kept engine) gives format()'s result", () => {
	// APA keeps its engine (author-date); Vancouver is numbered, so it is rebuilt on every call and must still match
	for (const [style, steps] of [
		["apa", 70],
		["vancouver", 120],
	] as const) {
		test(`${style}: ${steps} random edits`, async () => {
			const kept = await CslFormatter.create(src, style, "en-US");
			const fresh = await CslFormatter.create(src, style, "en-US");
			const r = rng(style.length * 97);
			const pickId = () => String(1 + Math.floor(r() * 40));
			let items = makeItems(40, rng(5));
			let next = 0;
			const newCitation = (): DocCitation => ({
				citationID: `c${next++}`,
				noteIndex: 0,
				items: Array.from({ length: 1 + Math.floor(r() * 3) }, () => ({
					id: pickId(),
					...(r() < 0.3 ? { locator: String(1 + Math.floor(r() * 99)), label: "page" } : {}),
				})).filter((v, i, all) => all.findIndex((w) => w.id === v.id) === i),
			});
			const doc: DocCitation[] = Array.from({ length: 30 }, newCitation);
			let uncited: string[] = [];
			const failures: string[] = [];
			for (let step = 0; step < steps; step++) {
				const op = r();
				const at = Math.floor(r() * (doc.length + 1));
				if (op < 0.3)
					doc.splice(at, 0, newCitation()); // insert
				else if (op < 0.55 && doc.length) {
					const i = at % doc.length;
					doc[i] = { ...newCitation(), citationID: doc[i]!.citationID };
				} // edit
				else if (op < 0.75 && doc.length > 1)
					doc.splice(at % doc.length, 1); // delete
				else if (op < 0.82)
					uncited = r() < 0.5 ? [] : [pickId(), pickId()]; // uncited items change
				else if (op < 0.88 && doc.length > 2) {
					const [c] = doc.splice(0, 1);
					doc.push(c!);
				} // move: rebuild
				else if (op < 0.92)
					items = makeItems(40, rng(5), step); // item data changed: rebuild
				else if (op < 0.96) {
					for (let k = 0; k < 3; k++) doc.splice(Math.floor(r() * doc.length), 0, newCitation());
				} // several inserts
				// else: unchanged refresh
				const a = kept.formatDocument(
					doc.map((c) => ({ ...c })),
					items,
					uncited,
					true,
				);
				const b = fresh.format(
					doc.map((c) => ({ ...c })),
					items,
					uncited,
					true,
				);
				for (const d of compare(a, b)) failures.push(`step ${step}: ${d}`);
			}
			expect(failures.slice(0, 10)).toEqual([]);
		}, 120_000);
	}
});
