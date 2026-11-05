// An in-memory Host: a small library and a fake Word document. Used for the browser preview of the sidebar
// (index.html?mock) and by the unit tests; the real add-in implements the same methods (addin/Bridge.cs).
// The fake document keeps fields in document order with per-story indices and start/end positions (a `gap` of body text
// before each field decides adjacency), and simulates doc.insert (cursor, placement footnote/endnote, `after` another
// field), doc.convert (inline / footnote / endnote), doc.unlink and doc.delete the way WordDoc.cs does.
import type { ZoteroItemData } from "../../../core/src/api-types";
import type { Host } from "./host";

export interface MockOptions {
	items?: ZoteroItemData[];
	/** style id -> CSL xml (default: fetches /mock/styles/<id>.csl, served by dev.ts) */
	styleXml?: (id: string) => Promise<string>;
	localeXml?: (lang: string) => Promise<string | null>;
	userId?: string;
	prefsXml?: string | null;
}

export const SAMPLE_ITEMS: ZoteroItemData[] = [
	{
		key: "AAAA1111", itemType: "journalArticle", title: "Outcomes after liver transplantation in the United Kingdom",
		creators: [{ creatorType: "author", firstName: "Jane", lastName: "Smith" }, { creatorType: "author", firstName: "Omar", lastName: "Haddad" }],
		publicationTitle: "Transplantation", date: "2021-03-04", volume: "105", issue: "3", pages: "512-520", DOI: "10.1000/tx.2021.001",
		abstractNote: "BACKGROUND: Long-term outcomes after liver transplantation vary by centre. METHODS: We analysed registry data for 12,000 recipients. RESULTS: Five-year graft survival was 82%. CONCLUSIONS: Centre volume matters.",
	} as ZoteroItemData,
	{
		key: "BBBB2222", itemType: "journalArticle", title: "Machine perfusion for donor liver preservation: a systematic review",
		creators: [{ creatorType: "author", firstName: "Li", lastName: "Chen" }],
		publicationTitle: "Journal of Hepatology", date: "2019", volume: "71", pages: "1-12", DOI: "10.1000/jh.2019.044",
		abstractNote: "We reviewed 34 trials of normothermic and hypothermic machine perfusion.",
	} as ZoteroItemData,
	{
		key: "CCCC3333", itemType: "book", title: "Clinical Transplantation Handbook",
		creators: [{ creatorType: "author", firstName: "Anna", lastName: "Rossi" }, { creatorType: "author", firstName: "Peter", lastName: "Kovacs" }],
		publisher: "Oxford University Press", place: "Oxford", date: "2018",
	} as ZoteroItemData,
];

export interface MockField {
	story: string;
	idx: number;
	kind: string;
	code: string;
	text: string;
	start: number;
	end: number;
	note?: number;
	/** characters of body text between the previous field of the same story and this one (default 1 in the main text, 3 between notes; 0 = touching) */
	gap?: number;
}

export function createMockHost(opts: MockOptions = {}): Host & { emit(event: string, data: unknown): void; fields: any[]; unlinked: { story: string; text: string }[]; prefsXml: string | null; settings: Record<string, any>; calls: string[] } {
	const items = opts.items ?? SAMPLE_ITEMS;
	const handlers = new Map<string, ((d: any) => void)[]>();
	// fields are kept in document order (main text, notes interleaved as Word's reference marks would place them); `idx` counts per story like Word's Fields collection
	const fields: MockField[] = [];
	const unlinked: { story: string; text: string }[] = [];
	const state = { prefsXml: opts.prefsXml ?? (null as string | null), settings: { style: "vancouver" } as Record<string, any>, calls: [] as string[], cursor: -1 };
	const fetchText = async (url: string) => {
		const r = await fetch(url);
		if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
		return r.text();
	};
	/** Per-story field numbers and start/end positions (a field occupies text.length + 2 characters: its begin and end marks). */
	const layout = () => {
		const counter: Record<string, number> = {};
		const pos: Record<string, number> = {};
		const noteNo: Record<string, number> = {};
		let prev: MockField | undefined;
		for (const f of fields) {
			counter[f.story] = (counter[f.story] ?? 0) + 1;
			f.idx = counter[f.story]!;
			const main = f.story === "main";
			const gap = f.gap ?? (main ? 1 : 3);
			const prevSame = prev && prev.story === f.story;
			if (!main) {
				if (prevSame && gap === 0) f.note = prev!.note;
				else f.note = (noteNo[f.story] = (noteNo[f.story] ?? 0) + 1);
			} else delete f.note;
			f.start = (pos[f.story] ?? 0) + gap;
			f.end = f.start + f.text.length + 2;
			pos[f.story] = f.end;
			prev = f;
		}
	};
	const reindex = layout;
	const find = (ref: { story?: string; idx: number; kind?: string; cid?: string }): MockField => {
		const f = fields.find((x) => x.story === (ref.story ?? "main") && x.idx === ref.idx);
		if (!f) throw new Error("The document changed: field " + ref.idx + " no longer exists. Refresh and try again.");
		if ((ref.kind && f.kind !== ref.kind) || (ref.cid && !f.code.includes('"' + ref.cid + '"'))) throw new Error("The document changed under the sidebar. Refresh and try again.");
		return f;
	};
	const storyOf = (placement?: string) => (placement === "footnote" ? "fn" : placement === "endnote" ? "en" : "main");
	const row = (d: ZoteroItemData) => ({
		key: d.key, title: d.title ?? "", creators: (d.creators ?? []).map((c: any) => c.lastName ?? c.name).join(", "),
		year: Number(/\d{4}/.exec(String(d.date ?? ""))?.[0]) || null, publication: String((d as any).publicationTitle ?? ""), itemType: d.itemType, doi: String((d as any).DOI ?? ""),
	});
	const methods: Record<string, (p: any) => any> = {
		"host.info": () => ({
			version: "mock",
			library: { dbPath: "(mock library)", dbExists: true, items: items.length, dataDir: "" },
			uri: { base: `http://zotero.org/users/${opts.userId ?? "12345"}`, userId: opts.userId ?? "12345", source: "settings" },
			settings: state.settings,
			zn: { up: false, api: "", launcher: "", launcherExists: false },
		}),
		"settings.get": () => state.settings,
		"settings.set": (p) => Object.assign(state.settings, p),
		"lib.search": (p) => {
			let rows = items.filter((d) => !p.year || String(d.date ?? "").startsWith(String(p.year)));
			if (p.doi) rows = rows.filter((d) => String((d as any).DOI).toLowerCase() === String(p.doi).toLowerCase());
			if (p.match) {
				const words = [...String(p.match).matchAll(/"([^"]+)"/g)].map((m) => m[1]!.toLowerCase());
				rows = rows.filter((d) => {
					const hay = JSON.stringify([d.title, d.creators, d.abstractNote, (d as any).publicationTitle]).toLowerCase();
					return words.every((w) => hay.includes(w));
				});
			}
			return rows.map(row);
		},
		"lib.items": (p) => (p.keys as string[]).map((k) => {
			const d = items.find((x) => x.key === k);
			return d ? { key: k, found: true, itemKey: k, trashed: false, itemType: d.itemType, data: d } : { key: k, found: false };
		}),
		"lib.byUri": () => ({}),
		"style.search": () => [{ id: "vancouver", title: "Vancouver", installed: true, dependent: false }, { id: "apa", title: "American Psychological Association 7th edition", installed: true, dependent: false }, { id: "nature", title: "Nature", installed: true, dependent: false }],
		"style.xml": async (p) => ({ id: p.id, xml: await (opts.styleXml ?? ((id) => fetchText(`/mock/styles/${id}.csl`)))(p.id) }),
		"locale.xml": async (p) => ({ lang: p.lang, xml: await (opts.localeXml ?? ((l) => fetchText(`/mock/locales/locales-${l}.xml`).catch(() => null)))(p.lang) }),
		"zn.status": () => ({ up: false }),
		"zn.reveal": () => ({ ok: false, error: "preview mode" }),
		"zn.lookup": () => null,
		"app.openUrl": () => ({ ok: true }),
		"doc.state": () => ({ hasDoc: true, name: "Preview.docx", fullName: "Preview.docx", readOnly: false, prefsXml: state.prefsXml }),
		"doc.fields": () => {
			layout();
			return fields.map((f) => ({ story: f.story, idx: f.idx, kind: f.kind, code: f.code, text: f.text, start: f.start, end: f.end, note: f.note ?? 0 }));
		},
		"doc.cursor": () => {
			const f = fields[state.cursor];
			return f ? { hasDoc: true, doc: "Preview.docx", start: 1, end: 1, story: 1, inField: true, ref: { story: f.story, idx: f.idx }, kind: f.kind, code: f.code, text: f.text } : { hasDoc: true, doc: "Preview.docx", start: 0, end: 0, story: 1, inField: false };
		},
		"doc.insert": (p) => {
			const field: MockField = { story: storyOf(p.placement), idx: 0, kind: p.kind, code: String(p.code).trim(), text: p.text ?? (p.runs ?? []).map((r: any) => r.t).join(""), start: 0, end: 0 };
			if (p.after) {
				// directly after another field (same story, nothing in between)
				const prev = find(p.after);
				field.story = prev.story;
				field.gap = 0;
				fields.splice(fields.indexOf(prev) + 1, 0, field);
			} else fields.push(field);
			reindex();
			state.cursor = fields.indexOf(field);
			// like the add-in's cursor watcher: tell the page the caret is now in this citation
			setTimeout(() => {
				const c = methods["doc.cursor"]!({});
				for (const cb of handlers.get("cursor") ?? []) cb(c);
			}, 50);
			return { ok: true, story: field.story };
		},
		"doc.set": (p) => {
			const f = find(p.ref);
			if (p.code !== undefined) f.code = String(p.code).trim();
			if (p.runs?.length) f.text = p.runs.map((r: any) => r.t).join("");
			return { ok: true };
		},
		"doc.delete": (p) => { fields.splice(fields.indexOf(find(p.ref)), 1); reindex(); state.cursor = -1; return { ok: true }; },
		"doc.unlink": (p) => {
			const f = find(p.ref);
			unlinked.push({ story: f.story, text: f.text });
			fields.splice(fields.indexOf(f), 1);
			reindex();
			state.cursor = -1;
			return { ok: true };
		},
		// move a citation between inline / footnote / endnote, keeping its place in the document order, its text and its code
		"doc.convert": (p) => {
			const f = find(p.ref);
			if (f.kind !== "item") throw new Error("only citations can be converted");
			f.story = storyOf(p.target === "inline" ? undefined : p.target);
			if (p.code !== undefined) f.code = String(p.code).trim();
			f.gap = f.story === "main" ? 1 : 3;
			reindex();
			return { ok: true, story: f.story };
		},
		"doc.getPrefs": () => ({ xml: state.prefsXml }),
		"doc.setPrefs": (p) => { state.prefsXml = p.xml; return { ok: true }; },
		"popup.close": () => ({ ok: true }),
		"popup.resize": () => ({ ok: true }),
		"popup.edit": () => ({ ok: true }),
		"doc.begin": () => ({ ok: true }),
		"doc.end": () => ({ ok: true }),
	};
	const host = {
		fields,
		unlinked,
		/** deliver a host event to the page (preview and tests) */
		emit(event: string, data: unknown) {
			for (const cb of handlers.get(event) ?? []) cb(data);
		},
		get prefsXml() { return state.prefsXml; },
		settings: state.settings,
		calls: state.calls,
		async call(method: string, params: Record<string, unknown> = {}) {
			state.calls.push(method);
			const fn = methods[method];
			if (!fn) throw new Error("mock host: unknown method " + method);
			return structuredClone(await fn(params));
		},
		on(event: string, cb: (d: any) => void) {
			const l = handlers.get(event) ?? [];
			l.push(cb);
			handlers.set(event, l);
		},
	};
	return host as any;
}
