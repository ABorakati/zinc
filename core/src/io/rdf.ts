// Zotero RDF (Zotero's own .rdf export) and generic RDF/XML import, plus Zotero RDF export.
// Follows Zotero's RDF translator (zotero/translators RDF.js and Zotero RDF.js).
import type { Creator, ZoteroItemData } from "../api-types";
import { getSchema } from "../schema-data";
import {
	creatorTypeFor, getBase, isSingleField, parseName, setBase, setFirst, textToNoteHtml,
	type ParsedAttachment, type ParsedItem,
} from "./common";
import type { ExportItem } from "./bibtex";
import { parseXml, local, textOf, type XmlNode } from "./xml";

// ---------------------------------------------------------------- namespaces

const NS_BY_URI: [RegExp, string][] = [
	[/rdf-syntax-ns#$/, "rdf"],
	[/purl\.org\/net\/biblio#$/, "bib"],
	[/purl\.org\/ontology\/bibo\/$/, "bibo"],
	[/purl\.org\/dc\/elements\/1\.0\/$/, "dc10"],
	[/purl\.org\/dc\/elements\/1\.1\/$/, "dc"],
	[/purl\.org\/dc\/terms\/$/, "dcterms"],
	[/prismstandard\.org\/namespaces\/1\.2\/basic\/$/, "prism"],
	[/prismstandard\.org\/namespaces\/basic\/2\.[01]\/$/, "prism"],
	[/xmlns\.com\/foaf\/0\.1\/$/, "foaf"],
	[/nwalsh\.com\/rdf\/vCard#$/, "vcard"],
	[/w3\.org\/2006\/vcard\/ns#$/, "vcard2"],
	[/zotero\.org\/namespaces\/export#$/, "z"],
	[/purl\.org\/rss\/1\.0\/modules\/link\/$/, "link"],
	[/purl\.org\/eprint\/terms\/$/, "eprints"],
	[/ogp\.me\/ns#$/, "og"],
	[/schema\.org\/?$/, "so"],
];

function nsKeyFor(uri: string | undefined): string {
	if (!uri) return "";
	for (const [re, key] of NS_BY_URI) if (re.test(uri)) return key;
	return uri;
}

// ---------------------------------------------------------------- RDF graph

interface RdfProp {
	pred: string;
	lit?: string;
	resId?: string; // resolved through byId, so forward references work
}

interface RdfResource {
	id: string;
	node: XmlNode;
	type: string; // "bib:Article", "foaf:Person", …
	props: RdfProp[];
}

class RdfGraph {
	byNode = new Map<XmlNode, RdfResource>();
	byId = new Map<string, RdfResource>();
	prefix = new Map<string, string>();
	defaultNs = "";
	anonymous = 0;
	root: XmlNode;

	constructor(xml: string, root: XmlNode) {
		for (const m of xml.matchAll(/xmlns:([\w.-]+)\s*=\s*["']([^"']+)["']/g)) this.prefix.set(m[1]!, nsKeyFor(m[2]!));
		const d = /\sxmlns\s*=\s*["']([^"']+)["']/.exec(xml);
		this.defaultNs = nsKeyFor(d?.[1]);
		this.root = root;
		// pass 1: every subject defined anywhere, so forward references resolve
		const walk = (n: XmlNode) => {
			if (this.attr(n, "rdf", "about") !== undefined || this.attr(n, "rdf", "nodeID") !== undefined) this.ensure(n);
			for (const c of n.children) walk(c);
		};
		walk(root);
	}

	ns(prefix: string | undefined): string {
		if (!prefix) return this.defaultNs;
		return this.prefix.get(prefix) ?? prefix;
	}

	/** Predicate key ("dc:title") and element type key ("bib:Article") for an element. */
	key(n: XmlNode): string {
		const i = n.name.indexOf(":");
		const p = i < 0 ? "" : n.name.slice(0, i);
		return `${this.ns(p)}:${local(n.name)}`;
	}

	attr(n: XmlNode, wantNs: string, name: string): string | undefined {
		for (const [k, v] of Object.entries(n.attrs)) {
			const i = k.indexOf(":");
			const p = i < 0 ? "" : k.slice(0, i);
			const l = i < 0 ? k : k.slice(i + 1);
			if (l === name && this.ns(p) === wantNs) return v;
		}
		return undefined;
	}

	ensure(n: XmlNode): RdfResource {
		let r = this.byNode.get(n);
		if (r) return r;
		const about = this.attr(n, "rdf", "about") ?? this.attr(n, "rdf", "ID");
		const nodeId = this.attr(n, "rdf", "nodeID");
		const id = about ?? (nodeId !== undefined ? `_:${nodeId}` : `_:anon${++this.anonymous}`);
		r = { id, node: n, type: local(n.name) === "Description" ? "" : this.key(n), props: [] };
		this.byNode.set(n, r);
		if (!this.byId.has(id)) this.byId.set(id, r);
		this.fill(r);
		return r;
	}

	private fill(r: RdfResource): void {
		for (const c of r.node.children) {
			if (this.key(c) === "rdf:type") {
				const target = this.attr(c, "rdf", "resource");
				if (target) r.type = this.uriKey(target);
				continue;
			}
			const pred = this.key(c);
			const resourceAttr = this.attr(c, "rdf", "resource");
			if (resourceAttr !== undefined) {
				r.props.push({ pred, resId: resourceAttr });
			} else if (c.children.length) {
				r.props.push({ pred, resId: this.ensure(c.children[0]!).id });
			} else {
				const t = c.text.trim();
				if (t) r.props.push({ pred, lit: t });
			}
		}
	}

	/** "<uri>" -> "so:Book" style key for a typed URI, e.g. http://purl.org/net/biblio#Book. */
	uriKey(uri: string): string {
		const hash = uri.lastIndexOf("#");
		const slash = uri.lastIndexOf("/");
		const cut = Math.max(hash, slash);
		if (cut < 0) return uri;
		const ns = nsKeyFor(uri.slice(0, cut + 1));
		return `${ns}:${uri.slice(cut + 1)}`;
	}

	lit(r: RdfResource | undefined, ...preds: string[]): string {
		if (!r) return "";
		for (const p of preds) {
			const v = r.props.find((x) => x.pred === p && x.lit !== undefined);
			if (v?.lit) return v.lit;
		}
		return "";
	}

	ref(r: RdfResource | undefined, ...preds: string[]): RdfResource | undefined {
		if (!r) return undefined;
		for (const p of preds) {
			const v = r.props.find((x) => x.pred === p && x.resId);
			if (v?.resId) return this.byId.get(v.resId);
		}
		return undefined;
	}

	refs(r: RdfResource | undefined, ...preds: string[]): RdfResource[] {
		if (!r) return [];
		return r.props
			.filter((x) => preds.includes(x.pred) && x.resId)
			.map((x) => this.byId.get(x.resId!))
			.filter((x): x is RdfResource => !!x);
	}

	lits(r: RdfResource | undefined, ...preds: string[]): string[] {
		if (!r) return [];
		return r.props.filter((x) => preds.includes(x.pred) && x.lit).map((x) => x.lit!);
	}

	/** The ids of resources a property points at, including subjects defined elsewhere or not at all. */
	refIds(r: RdfResource | undefined, ...preds: string[]): string[] {
		if (!r) return [];
		return r.props.filter((x) => preds.includes(x.pred) && x.resId).map((x) => x.resId!);
	}

	/** Values of a container (rdf:Seq/Bag/Alt) property, flattened; plain values pass through. */
	container(r: RdfResource, ...preds: string[]): (RdfResource | string)[] {
		const out: (RdfResource | string)[] = [];
		for (const p of preds) {
			for (const v of r.props.filter((x) => x.pred === p)) {
				if (v.lit) {
					out.push(v.lit);
					continue;
				}
				const res = v.resId ? this.byId.get(v.resId) : undefined;
				if (!res) continue;
				if (["rdf:Seq", "rdf:Bag", "rdf:Alt"].includes(res.type)) {
					for (const item of res.props.filter((x) => x.pred === "rdf:li")) {
						if (item.lit) out.push(item.lit);
						else if (item.resId) {
							const target = this.byId.get(item.resId);
							if (target) out.push(target);
						}
					}
				} else out.push(res);
			}
		}
		return out;
	}
}

// ---------------------------------------------------------------- type maps

const BIB_TYPES: Record<string, string> = {
	book: "book", booksection: "bookSection", thesis: "thesis", letter: "letter", manuscript: "manuscript",
	interview: "interview", report: "report", patent: "patent", map: "map", motionpicture: "film",
	illustration: "artwork", image: "artwork", legislation: "statute", recording: "audioRecording",
	memo: "note", conferenceproceedings: "presentation", data: "computerProgram", part: "bookSection",
	courtReporter: "case",
};

const DC_TYPES: Record<string, string> = {
	book: "book", patent: "patent", report: "report", thesis: "thesis", bookitem: "bookSection",
	booksection: "bookSection", conferenceitem: "conferencePaper", conferencepaper: "conferencePaper",
	dataset: "dataset", article: "journalArticle", journalitem: "journalArticle", journalarticle: "journalArticle",
	newsitem: "newspaperArticle", scholarlytext: "journalArticle", workingpaper: "report", authoredbook: "book",
	bookchapter: "bookSection", bachelorthesis: "thesis", masterthesis: "thesis", doctoralthesis: "thesis",
	electronicbook: "book", homepage: "webpage", webpage: "webpage", illustration: "artwork", map: "map",
	software: "computerProgram", movingimage: "videoRecording", sound: "audioRecording", stillimage: "artwork",
	image: "artwork", text: "journalArticle",
};

const SCHEMA_TYPES: Record<string, string> = {
	scholarlyarticle: "journalArticle", medicalscholarlyarticle: "journalArticle", newsarticle: "newspaperArticle",
	chapter: "bookSection", book: "book", blogposting: "blogPost", blogpost: "blogPost", discussionforumposting: "forumPost",
	techarticle: "report", apireference: "report", dataset: "dataset", datacatalog: "dataset", movie: "film",
	musicrecording: "audioRecording", musicalbum: "audioRecording", audiobook: "audioRecording", audioobject: "audioRecording",
	softwareapplication: "computerProgram", mobileapplication: "computerProgram", videogame: "computerProgram",
	webapplication: "computerProgram", softwaresourcecode: "computerProgram", painting: "artwork", photograph: "artwork",
	visualartwork: "artwork", sculpture: "artwork", message: "email", emailmessage: "email", thesis: "thesis",
	report: "report", presentationdigitaldocument: "presentation", tvclip: "tvBroadcast", tvepisode: "tvBroadcast",
};

/** Containers whose title is a publication title. */
const CONTAINER_TYPES: Record<string, true> = {
	"bib:Journal": true, "bibo:Journal": true, "bib:Periodical": true, "bibo:Periodical": true,
	"bib:Newspaper": true, "bibo:Newspaper": true, "bib:Book": true, "bibo:Book": true,
	"bib:CourtReporter": true, "bibo:CourtReporter": true, "z:Website": true, "z:Blog": true, "z:Forum": true,
	"so:Periodical": true, "so:PublicationIssue": true, "so:PublicationVolume": true, "so:Book": true,
};

const KNOWN_ITEM_TYPES = new Set(getSchema().itemTypes.map((t) => t.itemType));

function typeFromKey(key: string): string | null {
	const name = key.slice(key.indexOf(":") + 1).toLowerCase();
	if (key.startsWith("bib:") || key.startsWith("bibo:")) return BIB_TYPES[name] ?? null;
	if (key.startsWith("dc")) return DC_TYPES[name] ?? null;
	if (key.startsWith("so:")) return SCHEMA_TYPES[name] ?? null;
	return null;
}

// ---------------------------------------------------------------- import

function creatorOf(v: RdfResource | string, graph: RdfGraph, type: string): Creator | null {
	if (typeof v === "string") return parseName(v, type);
	const last = graph.lit(v, "foaf:familyName", "foaf:lastName", "foaf:surname", "foaf:family_name", "so:familyName");
	const first = graph.lit(v, "foaf:givenName", "foaf:firstName", "foaf:givenname", "so:givenName");
	if (last || first) return first ? { creatorType: type, lastName: last, firstName: first } : { creatorType: type, name: last };
	const name = graph.lit(v, "so:name", "foaf:name") || textOf(v.node);
	return name ? parseName(name, type) : null;
}

/** Creator container predicates to try for a creator type, in Zotero's order. */
function creatorPreds(creatorType: string): string[] {
	const out = [`z:${creatorType}s`];
	if (creatorType === "author") out.push("bib:authors", "dc:creator", "dcterms:creator", "so:author", "so:creator", "eprints:creators_name", "dc:contributor");
	else if (creatorType === "editor" || creatorType === "contributor") out.push(`bib:${creatorType}s`, `eprints:${creatorType}s_name`, `so:${creatorType}`);
	return out;
}

function itemFromResource(res: RdfResource, graph: RdfGraph, container: RdfResource | undefined): ParsedItem | null {
	const zType = graph.lit(res, "z:itemType", "z:type");
	let itemType = zType && !/^\d+$/.test(zType) && KNOWN_ITEM_TYPES.has(zType) ? zType : "";
	if (!itemType) {
		const dcType = graph.lit(res, "dc:type", "dc10:type", "dcterms:type");
		if (dcType && KNOWN_ITEM_TYPES.has(dcType)) itemType = dcType;
		else if (dcType) itemType = DC_TYPES[dcType.toLowerCase().replace(/\s+/g, "")] ?? "";
		itemType ||= typeFromKey(res.type) ?? "";
		// "article" and "document" need the container to say which kind they are
		if (!itemType && res.type === "bib:Article") itemType = "journalArticle";
		if (!itemType && res.type === "bib:Document") itemType = "webpage";
		itemType = itemType || "journalArticle";
	}
	const data: Partial<ZoteroItemData> & { itemType: string } = { itemType };
	const notes: string[] = [];
	const attachments: ParsedAttachment[] = [];

	setBase(data, "title", graph.lit(res, "dc:title", "dc10:title", "dcterms:title", "eprints:title", "og:title", "so:headline", "so:name"));
	setBase(data, "shortTitle", graph.lit(res, "bibo:shortTitle", "z:shortTitle"));

	// creators
	const creators: Creator[] = [];
	for (const ct of ["author", "editor", "contributor", "translator", "seriesEditor", "presenter", "composer", "wordsBy",
		"performer", "programmer", "director", "interviewee", "interviewer", "recipient", "reviewedAuthor", "bookAuthor",
		"castMember", "scriptwriter", "producer", "counsel", "commenter", "guest", "host", "narrator", "podcaster"]) {
		for (const v of graph.container(res, ...creatorPreds(ct))) {
			const c = creatorOf(v, graph, creatorTypeFor(itemType, ct, "author", "contributor", "editor"));
			if (c) creators.push(c);
		}
	}
	const directCreator = graph.lit(res, "dc:creator", "dc10:creator", "dcterms:creator");
	if (directCreator && !creators.length) {
		for (const name of directCreator.split(/\s*;\s*/).filter(Boolean)) {
			const c = parseName(name, creatorTypeFor(itemType, "author", "contributor"));
			if (c) creators.push(c);
		}
	}
	if (creators.length) data.creators = creators;

	// publication information: the containing journal/book, else a property on the item
	const title = graph.lit(container, "dc:title", "dcterms:title", "so:name");
	if (!setBase(data, "publicationTitle", title)) {
		setBase(data, "publicationTitle", graph.lit(res, "prism:publicationName", "dc:source", "dcterms:source", "eprints:publication"));
	}
	setBase(data, "journalAbbreviation", graph.lit(container, "dcterms:alternative"));
	setFirst(data, ["volume", "seriesNumber"], graph.lit(container, "prism:volume", "bibo:volume") || graph.lit(res, "prism:volume", "bibo:volume"));
	setFirst(data, ["issue", "number"], graph.lit(container, "prism:number", "bibo:issue") || graph.lit(res, "prism:number", "bibo:issue"));

	// pages, extents
	const pageStart = graph.lit(res, "prism:startingPage", "bibo:pageStart");
	const pageEnd = graph.lit(res, "prism:endingPage", "bibo:pageEnd");
	const pages = graph.lit(res, "bib:pages", "bibo:pages", "prism:pageRange", "so:pagination") || (pageStart ? (pageEnd ? `${pageStart}–${pageEnd}` : pageStart) : "");
	if (!setBase(data, "pages", pages.replace(/\s*-\s*/g, "–"))) setBase(data, "numPages", pages);
	setBase(data, "numPages", graph.lit(res, "bibo:numPages", "so:numberOfPages"));
	setBase(data, "numberOfVolumes", graph.lit(res, "bibo:numVolumes"));
	setBase(data, "edition", graph.lit(res, "prism:edition", "bibo:edition", "so:bookEdition"));

	// dates
	setBase(data, "date", graph.lit(res, "dc:date", "dc10:date", "dcterms:date", "dcterms:issued", "prism:publicationDate", "eprints:date", "so:datePublished", "og:published_time"));
	setBase(data, "accessDate", graph.lit(res, "dcterms:dateSubmitted", "dcterms:dateCaptured").slice(0, 10));

	// abstract, extra, rights, coverage
	setBase(data, "abstractNote", graph.lit(res, "dcterms:abstract", "so:description"));
	const description = graph.lit(res, "dc:description", "dc10:description", "dcterms:description");
	if (description && !data.abstractNote) setBase(data, "abstractNote", description);
	else if (description) data.extra = description;
	setBase(data, "rights", graph.lit(res, "dc:rights", "dcterms:rights", "so:license"));
	setBase(data, "archiveLocation", graph.lit(res, "dc:coverage"));
	setBase(data, "language", graph.lit(res, "dc:language", "dcterms:language"));
	setBase(data, "medium", graph.lit(res, "dcterms:medium"));
	setBase(data, "programmingLanguage", graph.lit(res, "so:programmingLanguage"));
	setBase(data, "system", graph.lit(res, "so:operatingSystem"));
	const part = graph.refs(res, "dcterms:isPartOf", "so:isPartOf").find((r) => r.type === "bib:Part");
	setBase(data, "section", graph.lit(part, "dc:title") || graph.lit(res, "so:genre"));

	// publisher and place
	const publisherRes = graph.ref(res, "dc:publisher", "dc10:publisher", "dcterms:publisher", "so:publisher", "so:publishedBy");
	const publisher = (publisherRes && (graph.lit(publisherRes, "foaf:name", "so:name", "vcard2:organization-name") || textOf(publisherRes.node))) || graph.lit(res, "dc:publisher");
	setBase(data, "publisher", publisher);
	const org = publisherRes ? graph.ref(publisherRes, "vcard:adr", "vcard2:adr") : undefined;
	setBase(data, "place", graph.lit(org, "vcard:locality", "vcard2:label") || graph.lit(publisherRes, "so:location"));

	// identifiers
	for (const id of graph.lits(res, "dc:identifier", "dc10:identifier", "dcterms:identifier", "bibo:doi", "bibo:isbn", "bibo:issn")) {
		assignIdentifier(data, id);
	}
	for (const containerId of graph.lits(container, "dc:identifier", "dc10:identifier", "dcterms:identifier")) {
		const m = /^(ISSN|ISBN|DOI)\s+(.+)$/i.exec(containerId);
		if (m && !data[m[1]!.toUpperCase()]) data[m[1]!.toUpperCase()] = m[2]!.trim();
	}
	for (const idRes of graph.refs(res, "dc:identifier", "dcterms:identifier")) {
		if (idRes.type === "dcterms:URI") setBase(data, "url", graph.lit(idRes, "rdf:value") || textOf(idRes.node));
	}
	setBase(data, "url", graph.lit(res, "bibo:uri", "so:url"));
	// the exporter (like Zotero's) uses an item's URL as its rdf:about and then omits the dc:identifier: read it back from there
	if (/^https?:\/\//i.test(res.id)) setBase(data, "url", res.id);

	// call number: a dc:subject that is a call-number resource
	for (const subj of graph.refs(res, "dc:subject", "dcterms:subject")) {
		if (/dcterms:(LCC|DDC|UDC)$/.test(subj.type)) setBase(data, "callNumber", graph.lit(subj, "rdf:value"));
	}

	// conference
	const presentedAt = graph.ref(res, "bib:presentedAt");
	if (presentedAt) setBase(data, "conferenceName", graph.lit(presentedAt, "dc:title"));

	// series
	const series = graph.refs(container ?? res, "dcterms:isPartOf").find((r) => /:(Series)$/.test(r.type));
	if (series) {
		setFirst(data, ["series", "seriesTitle"], graph.lit(series, "dc:title"));
		setBase(data, "seriesNumber", graph.lit(series, "dc:identifier"));
	}

	// tags: plain subjects are tags; automatic ones are z:AutomaticTag resources
	const tags: { tag: string; type?: number }[] = [];
	for (const t of graph.lits(res, "dc:subject", "dc10:subject", "dcterms:subject")) {
		if (/\b(page|pages|p\.)\s*\d/i.test(t) && tags.some((x) => /^(LCC|DDC|UDC):/.test(x.tag))) continue;
		tags.push({ tag: t });
	}
	for (const subj of graph.refs(res, "dc:subject", "dcterms:subject")) {
		if (subj.type === "z:AutomaticTag") {
			const v = graph.lit(subj, "rdf:value", "dc:title");
			if (v) tags.push({ tag: v, type: 1 });
		}
	}
	if (tags.length) data.tags = tags;

	// notes: the item is referenced by a bib:Memo
	for (const noteRes of graph.refs(res, "dcterms:isReferencedBy", "dcterms:references")) {
		const html = graph.lit(noteRes, "rdf:value", "dc:description") || textOf(noteRes.node);
		if (html) notes.push(html);
	}

	// attachments: a link:link points at a z:Attachment node (z:path) or at a URL
	for (const id of [...graph.refIds(res, "link:link"), ...graph.refIds(res, "dcterms:hasPart")]) {
		const att = graph.byId.get(id);
		if (att && att.type !== "z:Attachment" && !graph.lit(att, "z:path")) continue;
		const path = (att && graph.lit(att, "z:path")) || id;
		if (!path) continue;
		const title = att ? graph.lit(att, "dc:title", "z:title") : "";
		const contentType = att ? graph.lit(att, "link:type") : "";
		if (/^(https?|file):/i.test(path)) attachments.push({ title: title || undefined, url: path, contentType: contentType || undefined });
		else attachments.push({ title: title || undefined, path, contentType: contentType || undefined });
	}

	// related items
	const related = graph.refIds(res, "dc:relation", "dc10:relation", "dcterms:relation")
		.filter((id) => /^#?item_\d+$/.test(id) || /^https?:/.test(id));
	if (related.length) data.relations = { "dc:relation": related };

	const zNote = graph.lit(res, "z:note");
	if (zNote) notes.push(textToNoteHtml(zNote));

	if (!data.title && !creators.length && !data.date) return null;
	return { data, notes, attachments: attachments.length ? attachments : undefined };
}

function assignIdentifier(data: Record<string, unknown>, raw: string): void {
	const s = raw.trim();
	const prefixed = /^(ISSN|ISBN|DOI)\s+(.+)$/i.exec(s);
	if (prefixed) {
		const field = prefixed[1]!.toUpperCase();
		data[field] = prefixed[2]!.trim();
		return;
	}
	if (/^10\.\d{4,9}\//.test(s)) data.DOI = s;
	else if (/^https?:\/\//i.test(s)) data.url = s;
	else if (/^\d{4}-?\d{3}[\dXx]$/.test(s)) data.ISSN = s;
	else if (/^(?:97[89])?\d{9}[\dXx]$/.test(s.replace(/[\s-]/g, ""))) data.ISBN = s;
}

interface CollectionNode {
	res: RdfResource;
	title: string;
	children: CollectionNode[];
	items: RdfResource[];
}

/** Parse a Zotero RDF (or other RDF/XML) document into items with collection paths and attachments. */
export function parseZoteroRdf(xml: string): { items: ParsedItem[]; errors: string[] } {
	const items: ParsedItem[] = [];
	const errors: string[] = [];
	let graph: RdfGraph;
	let resources: RdfResource[];
	try {
		const root = parseXml(xml.replace(/^\uFEFF/, ""));
		const rdf = root.children.find((c) => local(c.name) === "RDF");
		if (!rdf) return { items, errors: ["no rdf:RDF element"] };
		graph = new RdfGraph(xml, root);
		resources = rdf.children.filter((c) => local(c.name) !== "#text").map((n) => graph.ensure(n));
	} catch (e) {
		return { items, errors: [`invalid RDF: ${e instanceof Error ? e.message : e}`] };
	}

	// resources that are parts of, attachments to or creators of another resource
	const nested = new Set<string>();
	const nestedPreds = [
		"dcterms:isPartOf", "so:isPartOf", "bib:presentedAt", "link:link", "dcterms:creator", "dcterms:isReferencedBy",
		"dc:publisher", "dcterms:publisher", "bibo:authorList",
	];
	for (const r of graph.byId.values()) {
		for (const p of r.props) if (p.resId && nestedPreds.includes(p.pred)) nested.add(p.resId);
	}

	const isCollection = (r: RdfResource) => r.type === "z:Collection" || r.type === "bib:Collection" || r.type === "bibo:Collection";
	const collectionOf = (r: RdfResource): CollectionNode => {
		const node: CollectionNode = { res: r, title: graph.lit(r, "dc:title", "dcterms:title") || textOf(r.node), children: [], items: [] };
		for (const part of graph.refs(r, "dcterms:hasPart", "dc:hasPart", "bib:hasPart")) {
			if (isCollection(part)) node.children.push(collectionOf(part));
			else node.items.push(part);
		}
		return node;
	};

	const childCollectionIds = new Set<string>();
	for (const r of graph.byId.values()) {
		for (const part of graph.refs(r, "dcterms:hasPart", "bib:hasPart")) if (isCollection(part)) childCollectionIds.add(part.id);
	}
	const roots = [...graph.byId.values()]
		.filter((r) => isCollection(r) && !childCollectionIds.has(r.id))
		.map(collectionOf);

	// item id -> collection path (nested collections become "Parent/Child")
	const paths = new Map<string, string[][]>();
	const walkCollection = (node: CollectionNode, prefix: string[]) => {
		const path = [...prefix, node.title || "Collection"];
		for (const it of node.items) {
			const list = paths.get(it.id) ?? [];
			list.push(path);
			paths.set(it.id, list);
		}
		for (const c of node.children) walkCollection(c, path);
	};
	for (const r of roots) walkCollection(r, []);

	const containers = new Map<string, RdfResource>();
	for (const r of graph.byId.values()) {
		for (const part of graph.refs(r, "dcterms:isPartOf", "so:isPartOf")) {
			if (CONTAINER_TYPES[part.type] && !containers.has(r.id)) containers.set(r.id, part);
		}
	}

	for (const r of resources) {
		if (isCollection(r) || nested.has(r.id)) continue;
		if (r.type === "z:Attachment") continue;
		try {
			const item = itemFromResource(r, graph, containers.get(r.id));
			if (!item) {
				errors.push(`${r.id} has no title, author or date`);
				continue;
			}
			const collPaths = paths.get(r.id);
			if (collPaths?.length) item.collections = collPaths;
			items.push(item);
		} catch (e) {
			errors.push(`${r.id}: ${e instanceof Error ? e.message : e}`);
		}
	}
	return { items, errors };
}

// ---------------------------------------------------------------- export

export interface RdfAttachment {
	title?: string;
	path?: string; // relative to the exported .rdf file
	url?: string;
	contentType?: string;
}

export interface RdfExportItem extends ExportItem {
	noteHtml?: string[];
	autoTags?: string[];
	attachments?: RdfAttachment[];
}

export interface RdfCollection {
	key: string;
	name: string;
	parentKey: string | null;
	itemKeys: string[];
}

const RDF_TYPE: Record<string, string> = {
	book: "bib:Book", bookSection: "bib:BookSection", journalArticle: "bib:Article", magazineArticle: "bib:Article",
	newspaperArticle: "bib:Article", thesis: "bib:Thesis", letter: "bib:Letter", manuscript: "bib:Manuscript",
	interview: "bib:Interview", film: "bib:MotionPicture", artwork: "bib:Illustration", map: "bib:Image",
	report: "bib:Report", bill: "bib:Legislation", statute: "bib:Legislation", hearing: "bib:Report",
	patent: "bib:Patent", email: "bib:Letter", instantMessage: "bib:Letter", audioRecording: "bib:Recording",
	podcast: "bib:Recording", radioBroadcast: "bib:Recording", tvBroadcast: "bib:Recording",
	videoRecording: "bib:Recording", presentation: "bib:ConferenceProceedings", computerProgram: "bib:Data",
	dataset: "bib:Data", case: "bib:Document", webpage: "bib:Document", blogPost: "bib:Document", forumPost: "bib:Document",
};

/** Containers written for item types that live inside a larger work. */
const RDF_CONTAINER: Record<string, { type: string; field: string }> = {
	journalArticle: { type: "bib:Journal", field: "publicationTitle" },
	magazineArticle: { type: "bib:Periodical", field: "publicationTitle" },
	newspaperArticle: { type: "bib:Newspaper", field: "publicationTitle" },
	bookSection: { type: "bib:Book", field: "bookTitle" },
	encyclopediaArticle: { type: "bib:Book", field: "encyclopediaTitle" },
	dictionaryEntry: { type: "bib:Book", field: "dictionaryTitle" },
	conferencePaper: { type: "bib:Journal", field: "proceedingsTitle" },
	case: { type: "bib:CourtReporter", field: "reporter" },
	webpage: { type: "z:Website", field: "websiteTitle" },
	blogPost: { type: "z:Blog", field: "blogTitle" },
	forumPost: { type: "z:Forum", field: "forumTitle" },
};

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Zotero RDF for a set of items (the shape Zotero's own "Zotero RDF" exporter writes). */
export function exportZoteroRdf(items: RdfExportItem[], collections: RdfCollection[] = []): string {
	const lines: string[] = [
		'<?xml version="1.0" encoding="utf-8"?>',
		'<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"',
		'         xmlns:bib="http://purl.org/net/biblio#"',
		'         xmlns:bibo="http://purl.org/ontology/bibo/"',
		'         xmlns:dc="http://purl.org/dc/elements/1.1/"',
		'         xmlns:dcterms="http://purl.org/dc/terms/"',
		'         xmlns:prism="http://prismstandard.org/namespaces/1.2/basic/"',
		'         xmlns:foaf="http://xmlns.com/foaf/0.1/"',
		'         xmlns:vcard="http://nwalsh.com/rdf/vCard#"',
		'         xmlns:link="http://purl.org/rss/1.0/modules/link/"',
		'         xmlns:z="http://www.zotero.org/namespaces/export#">',
	];

	const used = new Set<string>();
	const uriOf = (item: RdfExportItem, index: number): string => {
		const isbn = String(item.data.ISBN ?? "").trim();
		if (isbn && !used.has(`urn:isbn:${isbn}`)) {
			used.add(`urn:isbn:${isbn}`);
			return `urn:isbn:${encodeURI(isbn)}`;
		}
		const url = String(item.data.url ?? "").trim();
		if (item.data.itemType !== "attachment" && url && !used.has(url)) {
			used.add(url);
			return url;
		}
		return `#item_${index + 1}`;
	};
	const itemUris = items.map(uriOf);
	const itemIndex = new Map(itemUris.map((uri, i) => [uri, i]));
	const containers = new Map<string, { uri: string; type: string; title: string; alternative: string; volume: string; issue: string }>();
	let containerCount = 0;

	items.forEach((item, index) => {
		const d = item.data;
		const uri = itemUris[index]!;
		const type = RDF_TYPE[d.itemType] ?? "rdf:Description";
		const containerSpec = RDF_CONTAINER[d.itemType];
		const containerTitle = containerSpec ? String(d[containerSpec.field] ?? "") : "";
		let containerUri = "";
		if (containerSpec && containerTitle) {
			const issn = String(d.ISSN ?? "").trim();
			const key = issn ? `urn:issn:${encodeURI(issn)}` : `#container_${++containerCount}`;
			containerUri = key;
			if (!containers.has(key)) {
				containers.set(key, {
					uri: key,
					type: containerSpec.type,
					title: containerTitle,
					alternative: String(d.journalAbbreviation ?? ""),
					volume: String(d.volume ?? ""),
					issue: String(d.issue ?? ""),
				});
			}
		}
		lines.push(`  <${type} rdf:about="${xmlEscape(uri)}">`);
		lines.push(`    <z:itemType>${xmlEscape(d.itemType)}</z:itemType>`);
		if (containerUri) lines.push(`    <dcterms:isPartOf rdf:resource="${xmlEscape(containerUri)}"/>`);

		const put = (pred: string, value: unknown) => {
			const v = String(value ?? "").trim();
			if (v) lines.push(`    <${pred}>${xmlEscape(v)}</${pred}>`);
		};

		put("dc:title", d.title);
		put("bibo:shortTitle", d.shortTitle);
		put("dcterms:abstract", d.abstractNote);
		put("dc:date", d.date);
		put("dc:language", d.language);
		put("dcterms:medium", d.medium ?? d.interviewMedium ?? d.artworkMedium);
		put("so:programmingLanguage", d.programmingLanguage);
		put("so:operatingSystem", d.system);
		put("dc:rights", d.rights);
		put("dc:coverage", d.archiveLocation);
		put("dc:description", d.extra);
		if (d.accessDate) put("dcterms:dateSubmitted", d.accessDate);
		put("bib:pages", d.pages);
		put("bibo:numPages", d.numPages);
		put("bibo:numVolumes", d.numberOfVolumes);
		put("prism:edition", d.edition ?? d.versionNumber);
		if (containerSpec && d.itemType === "conferencePaper") put("bib:conferenceName", d.conferenceName);
		for (const key of ["thesisType", "reportType", "websiteType", "artworkMedium", "letterType", "manuscriptType", "mapType", "videoRecordingType", "audioRecordingType", "presentationType", "postType"]) {
			if (d[key]) lines.push(`    <dc:type>${xmlEscape(String(d[key]))}</dc:type>`);
		}

		// creators in bib:* / z:* containers
		const creators = d.creators ?? [];
		const groups = new Map<string, Creator[]>();
		for (const c of creators) {
			const pred = ["author", "editor", "contributor"].includes(c.creatorType) ? `bib:${c.creatorType}s` : `z:${c.creatorType}s`;
			groups.set(pred, [...(groups.get(pred) ?? []), c]);
		}
		for (const [pred, list] of groups) {
			lines.push(`    <${pred}><rdf:Seq>`);
			for (const c of list) {
				lines.push("      <rdf:li><foaf:Person>");
				const family = isSingleField(c) ? (c.name ?? "") : (c.lastName ?? "");
				const given = isSingleField(c) ? "" : (c.firstName ?? "");
				lines.push(`        <foaf:surname>${xmlEscape(family)}</foaf:surname>`);
				if (given) lines.push(`        <foaf:givenName>${xmlEscape(given)}</foaf:givenName>`);
				lines.push("      </foaf:Person></rdf:li>");
			}
			lines.push("    </rdf:Seq></" + pred + ">");
		}

		// identifiers: DOI/ISBN/ISSN live on the container when there is one
		const idLines: string[] = [];
		if (d.DOI) idLines.push(`DOI ${String(d.DOI)}`);
		if (d.ISBN) idLines.push(`ISBN ${String(d.ISBN)}`);
		if (d.ISSN) idLines.push(`ISSN ${String(d.ISSN)}`);
		for (const line of idLines) lines.push(`    <dc:identifier>${xmlEscape(line)}</dc:identifier>`);
		// omitted only when this item's own rdf:about already is the URL (another item may have taken it first)
		if (d.url && uri !== String(d.url).trim()) {
			lines.push("    <dc:identifier><dcterms:URI><rdf:value>" + xmlEscape(String(d.url)) + "</rdf:value></dcterms:URI></dc:identifier>");
		}
		if (d.callNumber) {
			lines.push("    <dc:subject><dcterms:LCC><rdf:value>" + xmlEscape(String(d.callNumber)) + "</rdf:value></dcterms:LCC></dc:subject>");
		}
		if (!containerUri && containerSpec) put("dc:source", containerTitle);

		// publisher as a foaf organization
		const publisher = getBase(d, "publisher");
		const place = String(d.place ?? "");
		if (publisher || place) {
			lines.push("    <dc:publisher><foaf:Organization>");
			lines.push(`      <rdf:type rdf:resource="http://xmlns.com/foaf/0.1/Organization"/>`);
			if (publisher) lines.push(`      <foaf:name>${xmlEscape(publisher)}</foaf:name>`);
			if (place) lines.push(`      <vcard:adr><vcard:Address><vcard:locality>${xmlEscape(place)}</vcard:locality></vcard:Address></vcard:adr>`);
			lines.push("    </foaf:Organization></dc:publisher>");
		}

		// tags
		const auto = new Set(item.autoTags ?? []);
		for (const tag of item.tags) {
			if (auto.has(tag)) {
				lines.push(`    <dc:subject><z:AutomaticTag><rdf:value>${xmlEscape(tag)}</rdf:value></z:AutomaticTag></dc:subject>`);
			} else lines.push(`    <dc:subject>${xmlEscape(tag)}</dc:subject>`);
		}

		// notes
		const notes = item.noteHtml ?? item.notes;
		notes.forEach((note, n) => {
			const id = `#item_${index + 1}_note${n + 1}`;
			lines.push(`    <dcterms:isReferencedBy rdf:resource="${id}"/>`);
			lines.push(`    <bib:Memo rdf:about="${id}">`);
			lines.push(`      <rdf:value>${xmlEscape(note)}</rdf:value>`);
			lines.push("    </bib:Memo>");
		});

		// attachments
		for (const att of item.attachments ?? []) {
			if (att.url) {
				lines.push(`    <link:link rdf:resource="${xmlEscape(att.url)}"/>`);
				continue;
			}
			if (!att.path) continue;
			lines.push("    <link:link><z:Attachment>");
			lines.push(`      <z:path>${xmlEscape(att.path)}</z:path>`);
			if (att.title) lines.push(`      <dc:title>${xmlEscape(att.title)}</dc:title>`);
			if (att.contentType) lines.push(`      <link:type>${xmlEscape(att.contentType)}</link:type>`);
			lines.push("    </z:Attachment></link:link>");
		}

		// related items that are part of this export
		const related = d.relations?.["dc:relation"];
		for (const rel of Array.isArray(related) ? related : related ? [related] : []) {
			const idx = itemIndex.get(rel);
			if (idx !== undefined) lines.push(`    <dc:relation rdf:resource="${xmlEscape(itemUris[idx]!)}"/>`);
		}

		lines.push(`  </${type}>`);
	});

	for (const c of containers.values()) {
		lines.push(`  <${c.type} rdf:about="${xmlEscape(c.uri)}">`);
		if (c.title) lines.push(`    <dc:title>${xmlEscape(c.title)}</dc:title>`);
		if (c.alternative) lines.push(`    <dcterms:alternative>${xmlEscape(c.alternative)}</dcterms:alternative>`);
		if (c.volume) lines.push(`    <prism:volume>${xmlEscape(c.volume)}</prism:volume>`);
		if (c.issue) lines.push(`    <prism:number>${xmlEscape(c.issue)}</prism:number>`);
		lines.push(`  </${c.type}>`);
	}

	const collectionUri = (key: string) => `#collection_${key}`;
	const indexOfKey = new Map(items.map((item, i) => [item.data.key, i]));
	for (const c of collections) {
		lines.push(`  <z:Collection rdf:about="${collectionUri(c.key)}">`);
		lines.push(`    <dc:title>${xmlEscape(c.name)}</dc:title>`);
		lines.push(`    <dc:identifier>${xmlEscape(c.key)}</dc:identifier>`);
		if (c.parentKey) lines.push(`    <dcterms:isPartOf rdf:resource="${collectionUri(c.parentKey)}"/>`);
		for (const child of collections) {
			if (child.parentKey === c.key) lines.push(`    <dcterms:hasPart rdf:resource="${collectionUri(child.key)}"/>`);
		}
		for (const key of c.itemKeys) {
			const i = indexOfKey.get(key);
			if (i !== undefined) lines.push(`    <dcterms:hasPart rdf:resource="${xmlEscape(itemUris[i]!)}"/>`);
		}
		lines.push("  </z:Collection>");
	}

	lines.push("</rdf:RDF>");
	return lines.join("\n") + "\n";
}
