// Headless check of the PROTOTYPE native note view (src/notes/native): Zotero note HTML parsed with Zotero's own schema, drawn with
// GPUIX (no web view). Fixture notes are built here (Zotero's annotation-note shape, every formatting, a long note); with ZN_DB set to
// a COPY of a library, its notes are added too (read only).
//   ZN_SHOTS=<dir> [ZN_DB=<copy of library.sqlite>] bun scripts/shot-native-note.tsx
// For each note: parse time, render time, and a text check (every character of the note's text reaches the document, except what
// the prototype drops on purpose); writes <ZN_SHOTS>/native-note-<name>.png. Exits 1 on a failure.
import "./_shell-env";
import { Database } from "bun:sqlite";
import { createSignal, Show } from "solid-js";
import { boot, SHOTS } from "./shell-shot-lib";
import { store } from "../src/store";
import { tw } from "../src/theme";
import { loadNoteParser, type NoteNode } from "../src/notes/native/parse";
import { NoteDocView } from "../src/notes/native/NoteDocView";
import { createRequire } from "node:module";

// core's jsdom (the same one the parser uses), for the text check
const { JSDOM } = createRequire(new URL("../../core/package.json", import.meta.url))("jsdom") as {
	JSDOM: new (html: string) => { window: { document: Document } };
};

const enc = (o: unknown) => encodeURIComponent(JSON.stringify(o));
const PARENT = "http://zotero.org/users/local/abCD1234/items/PARENT01";
const itemData = {
	id: 1,
	type: "article-journal",
	title: "Five safes task execution service",
	author: [{ family: "Beck", given: "Tim" }, { family: "Lockhart-Jones" }, { family: "Panagi" }],
	issued: { "date-parts": [["2026"]] },
};
const ann = (key: string, color: string, page: string) =>
	enc({
		attachmentURI: "http://zotero.org/users/local/abCD1234/items/ATTACH01",
		annotationKey: key,
		color,
		pageLabel: page,
		position: { pageIndex: Number(page) - 1, rects: [[100, 200, 300, 212]] },
		citationItem: { uris: [PARENT], locator: page },
	});
const cite = (page: string) =>
	`<span class="citation" data-citation="${enc({ citationItems: [{ uris: [PARENT], locator: page }], properties: {} })}">(<span class="citation-item">Beck et al., 2026, p. ${page}</span>)</span>`;

const annotations = `<div data-citation-items="${enc([{ uris: [PARENT], itemData }])}" data-schema-version="9"><h1>Annotations<br>(21/11/2026, 10:12:03)</h1>
<p>“<span class="highlight" data-annotation="${ann("AAAA1111", "#ffd400", "3")}">Trusted research environments hold sensitive data that cannot leave them, so analyses must travel to the data instead.</span>” ${cite("3")} This is the core idea of federated analytics.</p>
<p>“<span class="highlight" data-annotation="${ann("BBBB2222", "#5fb236", "4")}">The Five Safes framework: safe projects, people, settings, data and outputs.</span>” ${cite("4")}</p>
<p>“<span class="underline" data-annotation="${ann("CCCC3333", "#2ea8e5", "6")}">Task execution is standardised through GA4GH TES.</span>” ${cite("6")} <strong>Check</strong> whether Zinc's own export could follow this.</p>
<p>“<span class="highlight" data-annotation="${ann("DDDD4444", "#ff6666", "7")}">Outputs are checked manually before release, which remains a bottleneck.</span>” ${cite("7")}</p>
</div>`;

const rich = `<div data-schema-version="10"><h1>Every formatting</h1>
<p>Plain, <strong>bold</strong>, <em>italic</em>, <strong><em>both</em></strong>, <u>underlined</u>, <span style="text-decoration: line-through">struck</span>, <code>code()</code>, a <a href="https://www.zotero.org">link</a>, x<sup>2</sup> and H<sub>2</sub>O, <span style="color: #ff2020">red text</span> and <span style="background-color: #ffd40080">a yellow background</span>. Inline maths <span class="math">$e^{i\\pi}+1=0$</span>.</p>
<h2>Lists</h2>
<ul><li><p>First point</p><ul><li><p>Nested point with <strong>bold</strong></p><ul><li><p>Third level</p></li></ul></li></ul></li><li><p>Second point</p></li></ul>
<ol start="3"><li><p>Numbered from three</p></li><li><p>Four</p></li></ol>
<h3>Quote and code</h3>
<blockquote><p>A quoted paragraph, which runs long enough to wrap onto a second line in a pane of ordinary width.</p></blockquote>
<pre>def hello():\n    return "world"</pre>
<pre class="math">$$\\int_0^1 x^2\\,dx = \\tfrac{1}{3}$$</pre>
<hr>
<table><tbody><tr><th><p>Measure</p></th><th><p>Value</p></th></tr><tr><td><p>Sensitivity</p></td><td><p><strong>0.92</strong></p></td></tr><tr><td><p>Specificity</p></td><td><p>0.87</p></td></tr></tbody></table>
<p style="padding-left: 40px">An indented paragraph.</p>
</div>`;

const long = `<div data-citation-items="${enc([{ uris: [PARENT], itemData }])}" data-schema-version="9"><h1>A long note</h1>${Array.from(
	{ length: 300 },
	(_, i) =>
		`<p>Paragraph ${i + 1}: <strong>lorem</strong> ipsum dolor sit amet, <em>consectetur</em> adipiscing elit, sed do eiusmod tempor incididunt ut labore ${cite(String((i % 9) + 1))}.</p>`,
).join("")}</div>`;

const notes: { name: string; html: string }[] = [
	{ name: "annotations", html: annotations },
	{ name: "rich", html: rich },
	{ name: "long", html: long },
];
if (process.env.ZN_DB) {
	const ro = new Database(process.env.ZN_DB, { readonly: true });
	const rows = ro.query(`SELECT key, data FROM items WHERE item_type = 'note' AND deleted = 0 LIMIT 20`).all() as {
		key: string;
		data: string;
	}[];
	ro.close();
	for (const r of rows) {
		const html = (JSON.parse(r.data) as { note?: string }).note;
		if (html) notes.push({ name: `db-${r.key}`, html });
	}
}

let fails = 0;
const check = (ok: unknown, what: string) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
	if (!ok) fails++;
};

const tl0 = performance.now();
const parser = await loadNoteParser();
const loadWall = performance.now() - tl0;
if (!parser) throw new Error("the note parser did not load (vendor/note-editor or core/node_modules/jsdom missing?)");
console.log(`parser loaded in ${loadWall.toFixed(0)} ms (jsdom + schema ${parser.loadMs.toFixed(0)} ms)`);

const [doc, setDoc] = createSignal<NoteNode | null>(null);
const h = await boot({
	prefs: { mode: "light" },
	width: 460,
	height: 900,
	view: () => (
		<div style={{ ...tw("flex bg-background", store.mode()), width: "100%", height: "100%", padding: 16, overflow: "hidden" }}>
			<Show when={doc()} keyed>
				{(d) => <NoteDocView doc={d} />}
			</Show>
		</div>
	),
});
store.setMode("light");

const textOf = (n: NoteNode): string => (n.type === "citation" ? "" : (n.text ?? (n.content ?? []).map(textOf).join("")));
const squash = (s: string) => s.replace(/[\s\u00a0“”"]+/g, "");

for (const note of notes) {
	const t0 = performance.now();
	const d = parser.parse(note.html);
	const parseMs = performance.now() - t0;
	// the note's text as a browser sees it, without citations (drawn from their data, not their inner text) and maths delimiters
	const box = new JSDOM(`<body>${note.html}</body>`).window.document.body;
	box.querySelectorAll(".citation").forEach((e: Element) => e.remove());
	const want = squash((box.textContent ?? "").replace(/\$\$?/g, ""));
	const got = squash(textOf(d).replace(/\$\$?/g, ""));
	check(got === want, `${note.name}: all ${want.length} text characters are in the document`);
	if (got !== want) {
		let i = 0;
		while (i < got.length && got[i] === want[i]) i++;
		console.log(`     first difference at ${i}: html "${want.slice(i, i + 40)}" vs doc "${got.slice(i, i + 40)}"`);
	}
	const r0 = performance.now();
	setDoc(d);
	h.t.renderer.flush();
	const renderMs = performance.now() - r0;
	await h.settle(500);
	const mds = h.t.renderer.findByType("markdown").length;
	console.log(`     ${note.name}: parse ${parseMs.toFixed(1)} ms, first render ${renderMs.toFixed(1)} ms, ${mds} <markdown> elements`);
	h.t.renderer.captureScreenshot(`${SHOTS}/native-note-${note.name}.png`);
	setDoc(null);
	await h.settle(100);
}

console.log(fails ? `${fails} check(s) failed` : "all checks passed");
process.exit(fails ? 1 : 0);
