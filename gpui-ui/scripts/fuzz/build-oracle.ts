// Build the differential-fuzz oracle: Zotero's own note-editor code (the schema, Metadata, buildToHTML via `toHTML`, `preprocessHTML`
// and `schemaTransform` from src/core/schema/transformer.js, prosemirror-tables' `fixTables`: what EditorCore's constructor runs when
// a note is opened) bundled with Bun into one scratch module, on a jsdom document (spec HTML parser and serializer, like Gecko's).
//   bun scripts/fuzz/build-oracle.ts [--ed /home/user/ref/note-editor] [--out <file>]
// Setup, once:  git clone --depth 1 https://github.com/zotero/note-editor /home/user/ref/note-editor
//   cd /home/user/ref/note-editor && (drop the github-only `@benrbray/prosemirror-math` dependency from package.json, the schema never
//   imports it) && bun install && bun add jsdom
//   and fetch locales/en-US/{zotero,note-editor}.ftl from zotero/zotero at the commit in webpack.config.js (ZoteroLocalePlugin), the
//   citation text ("et al.") comes from them.
// The output (default <ed>/.oracle/oracle.js, outside the repos) keeps `jsdom` external: it resolves from the note-editor checkout.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (name: string, d: string) => {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1]! : d;
};
const ED = arg("--ed", process.env.NOTE_EDITOR ?? "/home/user/ref/note-editor");
const OUT = arg("--out", join(ED, ".oracle/oracle.js"));
for (const f of ["src/core/schema/index.js", "node_modules/prosemirror-model", "node_modules/jsdom", "locales/en-US/zotero.ftl"])
	if (!existsSync(join(ED, f))) throw new Error(`${ED}/${f} missing: see the setup notes at the top of build-oracle.ts`);

const commit = execFileSync("git", ["-C", ED, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const dir = mkdtempSync(join(tmpdir(), "zn-oracle-"));
const p = (f: string) => JSON.stringify(join(ED, f).replace(/\\/g, "/"));
writeFileSync(
	join(dir, "shim.js"),
	`import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: false });
const w = dom.window;
for (const k of ["window", "document", "DOMParser", "Node", "Element", "HTMLElement", "Text", "DocumentFragment", "NodeFilter", "XMLSerializer"]) {
	globalThis[k] = k === "window" ? w : w[k];
}
w.dir = undefined; // nodes.js backCompIndent reads window.dir (the page direction)
`,
);
writeFileSync(
	join(dir, "entry.js"),
	`import "./shim.js";
import { Node as PmNode, DOMParser as PmDOMParser } from ${p("node_modules/prosemirror-model")};
import { EditorState } from ${p("node_modules/prosemirror-state")};
import { fixTables } from ${p("node_modules/prosemirror-tables")};
import { schema, toHTML } from ${p("src/core/schema/index.js")};
import Metadata from ${p("src/core/schema/metadata.js")};
import { schemaTransform, preprocessHTML } from ${p("src/core/schema/transformer.js")};

export const commit = ${JSON.stringify(commit)};
export const schemaVersion = schema.version;

/**
 * EditorCore's constructor, minus the view: preprocessHTML, Metadata.parseAttributes, DOMParser.parse on a DOMParser body,
 * schemaTransform, fixTables, deleteUnusedCitationItems (writable notes). A note whose data-schema-version is newer than the
 * schema opens read-only. Returns the doc as JSON, the metadata as JSON, and which of the load transforms changed the doc.
 */
export function load(htmlIn) {
	const metadata = new Metadata();
	schema.cached.metadata = metadata;
	const { html, metadataAttributes } = preprocessHTML(htmlIn);
	metadata.parseAttributes(metadataAttributes);
	const readOnly = metadata.schemaVersion > schema.version;
	let doc = PmDOMParser.fromSchema(schema).parse(new DOMParser().parseFromString(html, "text/html").body);
	let state = EditorState.create({ doc });
	const ran = [];
	const tr = schemaTransform(state);
	if (tr) { state = state.apply(tr); ran.push("schemaTransform"); }
	const fix = fixTables(state);
	if (fix) { state = state.apply(fix.setMeta("addToHistory", false)); ran.push("fixTables"); }
	if (!readOnly) metadata.deleteUnusedCitationItems(state);
	return { doc: state.doc.toJSON(), metadata: metadata.toJSON(), readOnly, ran };
}

/** EditorCore.getHTML: buildToHTML's output for the doc and the metadata. Throws if the schema rejects the doc. */
export function save(docJson, metadataJson) {
	const metadata = new Metadata();
	metadata.fromJSON(metadataJson);
	schema.cached.metadata = metadata;
	return toHTML(PmNode.fromJSON(schema, docJson).content, metadata);
}

/** An HTML string as a list of tokens read with the spec parser: attributes sorted, \`style\` as the CSSOM prints it, entities decoded. */
export function canonHtml(html) {
	const body = new DOMParser().parseFromString(html, "text/html").body;
	const out = [];
	const walk = (n) => {
		if (n.nodeType === 3) return void out.push("#text " + JSON.stringify(n.data));
		if (n.nodeType === 8) return void out.push("#comment");
		if (n.nodeType !== 1) return;
		const attrs = [...n.attributes].map((a) => [a.name, a.name === "style" ? n.style.cssText : a.value]).sort((x, y) => (x[0] < y[0] ? -1 : 1));
		out.push("<" + n.localName + attrs.map(([k, v]) => " " + k + "=" + JSON.stringify(v)).join("") + ">");
		for (const c of n.childNodes) walk(c);
		out.push("</" + n.localName + ">");
	};
	for (const c of body.childNodes) walk(c);
	// adjacent text tokens (a parser may split a text run) are one
	return out.reduce((acc, t) => (t.startsWith("#text ") && acc.length && acc[acc.length - 1].startsWith("#text ") ? (acc[acc.length - 1] = "#text " + JSON.stringify(JSON.parse(acc[acc.length - 1].slice(6)) + JSON.parse(t.slice(6)))) && acc : (acc.push(t), acc)), []);
}

/** A CSS colour as the CSSOM prints it (\`#ff2020\` -> \`rgb(255, 32, 32)\`), as Gecko does for the style a note is saved with. */
export function cssColor(c) {
	const el = document.createElement("span");
	el.style.color = c;
	return el.style.color || c;
}

/** Throws unless the schema accepts the doc (Node.fromJSON + check: content expressions, marks, required attrs). */
export function check(docJson) {
	PmNode.fromJSON(schema, docJson).check();
	return true;
}
`,
);
try {
	const r = await Bun.build({
		entrypoints: [join(dir, "entry.js")],
		target: "bun",
		format: "esm",
		external: ["jsdom"],
		define: { __BUILD__: JSON.stringify("web") },
		loader: { ".ftl": "text" },
		minify: false,
	});
	if (!r.success) throw new AggregateError(r.logs, "bundling the oracle failed");
	mkdirSync(join(OUT, ".."), { recursive: true });
	writeFileSync(OUT, await r.outputs[0]!.text());
	console.log(`wrote ${OUT} (note-editor ${commit.slice(0, 7)})`);
} finally {
	rmSync(dir, { recursive: true, force: true });
}
