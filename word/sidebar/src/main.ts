// Sidebar UI (vanilla DOM). All logic lives in app.ts; this file renders and wires events.
// Panels: search + citation tray, "Cited here" card (edit / split / delete), bibliography editor (exclude, edit text,
// add uncited), settings (style, note type, automatic updates, library, unlink citations).
import { App, type BibEditorEntry, type CitationView, type LibRow, type ModifiedCitation, type Pick, changesFromEntries } from "./app";
import { createWebViewHost, type Host } from "./host";
import { createMockHost } from "./mockhost";
import { htmlToRuns, isHandEdited, parseFieldCode, runsToHtml, styleUrlToId, type Run } from "./fields";

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (v == null || v === false) continue;
		if (k === "class") el.className = v;
		else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
		else if (k in el) (el as any)[k] = v;
		else el.setAttribute(k, String(v));
	}
	for (const c of kids) if (c) el.append(c);
	return el;
}
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const LOCALES = [
	"",
	"en-US",
	"en-GB",
	"de-DE",
	"fr-FR",
	"es-ES",
	"it-IT",
	"pt-PT",
	"pt-BR",
	"nl-NL",
	"sv-SE",
	"da-DK",
	"nb-NO",
	"fi-FI",
	"pl-PL",
	"cs-CZ",
	"ru-RU",
	"ja-JP",
	"zh-CN",
	"ko-KR",
	"tr-TR",
];

let app: App;
let host: Host;
let picks: Pick[] = [];
let editing: { ref: { story: string; idx: number }; citationID: string } | null = null;
let results: LibRow[] = [];
let active = 0;
let searchSeq = 0;
let cursorView: CitationView | null = null;
let docName = "";
let docStyle = "";

// ---------------------------------------------------------------- small UI helpers

function toast(msg: string, err = false, ms = 4500) {
	const t = h("div", { class: "t" + (err ? " err" : "") }, msg);
	$("toast").append(t);
	setTimeout(() => t.remove(), ms);
}

/** True while a busy() action runs: a second click, Enter or list click while it runs is ignored (it would insert twice). */
let isBusy = false;

function lockButtons(root: ParentNode = document) {
	root.querySelectorAll<HTMLButtonElement>("button:not([data-busy])").forEach((b) => {
		if (b.disabled) return;
		b.disabled = true;
		b.dataset.busy = "1";
	});
}

async function busy<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
	if (isBusy) {
		toast("Still working on the previous action.");
		return undefined;
	}
	isBusy = true;
	lockButtons();
	$("status").textContent = label;
	try {
		return await fn();
	} catch (e) {
		toast(e instanceof Error ? e.message : String(e), true, 8000);
		return undefined;
	} finally {
		isBusy = false;
		// includes buttons the sidebar drew while the action ran (the cursor moves, so the "Cited here" card is rebuilt)
		document.querySelectorAll<HTMLButtonElement>("button[data-busy]").forEach((b) => {
			b.disabled = false;
			delete b.dataset.busy;
		});
		$("status").textContent = "";
	}
}

function fmtReport(r: { citations: number; updated: number; missing: string[]; merged?: number; kept?: number }): string {
	const miss = r.missing.length ? `, ${r.missing.length} item(s) not found in the library or the document` : "";
	const merged = r.merged ? `, ${r.merged} adjacent citation(s) merged` : "";
	const kept = r.kept ? `, ${r.kept} hand-edited citation(s) left as they are` : "";
	return `${r.citations} citation(s), ${r.updated} updated${miss}${merged}${kept}`;
}

/** Refresh asks once when citations were typed into: keep the edits (they are flagged so Refresh leaves them alone) or overwrite them. */
async function askAboutEdits(items: ModifiedCitation[]): Promise<"keep" | "overwrite"> {
	const n = items.length;
	const which = items
		.slice(0, 3)
		.map((i) => `"${i.now}"`)
		.join(", ");
	const keep = window.confirm(
		`${n} citation${n === 1 ? " was" : "s were"} edited by hand (${which}${n > 3 ? ", ..." : ""}).\n\nKeep your edits? OK keeps them, Cancel replaces them with the formatted citation.`,
	);
	return keep ? "keep" : "overwrite";
}

// ---------------------------------------------------------------- doc line

function renderDocLine() {
	const el = $("docline");
	el.textContent = docName ? `${docName}${docStyle ? "  ·  " + docStyle : ""}` : "No document open";
	el.title = el.textContent;
}

async function refreshDocState() {
	try {
		const st = await app.docState();
		docName = st.hasDoc ? (st.name ?? "") : "";
		docStyle = st.prefs
			? styleUrlToId(st.prefs.styleId) + (st.prefs.locale ? " (" + st.prefs.locale + ")" : "")
			: st.hasDoc
				? `new document · default ${app.defaults.style}`
				: "";
	} catch {
		docName = "";
	}
	renderDocLine();
}

// ---------------------------------------------------------------- search

async function runSearch() {
	const seq = ++searchSeq;
	const q = $<HTMLInputElement>("q").value;
	try {
		const rows = await app.search(q);
		if (seq !== searchSeq) return;
		results = rows;
		active = 0;
		renderResults(q);
	} catch (e) {
		if (seq !== searchSeq) return;
		results = [];
		renderResults(q);
		$("status").textContent = e instanceof Error ? e.message : String(e);
	}
}

const picked = (key: string) => picks.some((p) => p.key === key);

function renderResults(q: string) {
	const ul = $("results");
	ul.replaceChildren(
		...results.map((r, i) =>
			h(
				"li",
				{
					role: "option",
					"aria-selected": String(i === active),
					class: picked(r.key) ? "added" : "",
					title: picks.length || editing ? "Add to this citation" : "Cite this at the cursor",
					onclick: () => void choose(r.key),
				},
				h("input", {
					type: "checkbox",
					checked: picked(r.key),
					title: "Select to cite several items together",
					"aria-label": "Select " + (r.title || "item"),
					onclick: (e: Event) => e.stopPropagation(),
					onchange: () => void togglePick(r.key),
				}),
				h(
					"div",
					{ class: "body" },
					h("div", { class: "t" }, r.title || "(untitled)"),
					h("div", { class: "m" }, [r.creators, r.year, r.publication].filter(Boolean).join(" · ")),
				),
			),
		),
	);
	if (!results.length) $("status").textContent = q.trim() ? "No matches" : "";
	else
		$("status").textContent =
			(q.trim() ? `${results.length} shown` : "Recently added") + " · click to cite, tick to cite several together";
}

/** A click on a result: cite it straight away, unless a multi-item citation is being built or edited (then add it). */
async function choose(key: string) {
	if (picks.length || editing) return addPick(key);
	const p = await app.pickFromKey(key);
	if (!p) return toast("That item is no longer in the library.", true);
	const r = await busy("Inserting citation…", () => app.insertCitation([p]));
	if (r) {
		toast("Citation inserted. " + fmtReport(r));
		void refreshDocState();
	}
}

async function togglePick(key: string) {
	if (picked(key)) {
		picks = picks.filter((p) => p.key !== key);
		renderTray();
		renderResults($<HTMLInputElement>("q").value);
	} else await addPick(key);
}

async function addPick(key: string) {
	if (picked(key)) return;
	const p = await app.pickFromKey(key);
	if (!p) return toast("That item is no longer in the library.", true);
	picks.push(p);
	renderTray();
	renderResults($<HTMLInputElement>("q").value);
}

// ---------------------------------------------------------------- tray

function renderTray() {
	const tray = $("tray");
	tray.replaceChildren(
		...picks.map((p, i) => {
			const bind = (field: "locator" | "prefix" | "suffix") => (e: Event) => void (p[field] = (e.target as HTMLInputElement).value);
			return h(
				"div",
				{ class: "pick" },
				h(
					"div",
					{ class: "head" },
					h(
						"div",
						{},
						h("div", { class: "t" }, p.title || "(untitled)"),
						h(
							"div",
							{ class: "muted small" },
							[p.creators, p.year].filter(Boolean).join(" · "),
							p.inLibrary ? "" : "  (not in library, embedded copy)",
						),
					),
					h(
						"button",
						{
							class: "icon",
							title: "Remove",
							"aria-label": "Remove from citation",
							onclick: () => {
								picks.splice(i, 1);
								renderTray();
								renderResults($<HTMLInputElement>("q").value);
							},
						},
						"✕",
					),
				),
				h(
					"details",
					{ open: !!(p.locator || p.prefix || p.suffix || p.suppressAuthor) },
					h("summary", { class: "muted small" }, "Page, prefix, suffix…"),
					h(
						"div",
						{ class: "grid" },
						h(
							"label",
							{},
							"Locator",
							h("input", { type: "text", value: p.locator, placeholder: "e.g. 23-25", oninput: bind("locator") }),
						),
						h(
							"label",
							{},
							"Type",
							(() => {
								const s = h("select", { onchange: (e: Event) => (p.label = (e.target as HTMLSelectElement).value) });
								for (const l of [
									"page",
									"chapter",
									"section",
									"paragraph",
									"figure",
									"table",
									"volume",
									"line",
									"note",
									"verse",
								])
									s.append(h("option", { value: l, selected: l === p.label }, l));
								return s;
							})(),
						),
						h(
							"label",
							{},
							"Prefix",
							h("input", { type: "text", value: p.prefix, placeholder: "see", oninput: bind("prefix") }),
						),
						h(
							"label",
							{},
							"Suffix",
							h("input", { type: "text", value: p.suffix, placeholder: "and others", oninput: bind("suffix") }),
						),
						h(
							"label",
							{ class: "check full" },
							h("input", {
								type: "checkbox",
								checked: p.suppressAuthor,
								onchange: (e: Event) => (p.suppressAuthor = (e.target as HTMLInputElement).checked),
							}),
							"Omit author",
						),
					),
				),
			);
		}),
	);
	$("tray-actions").hidden = picks.length === 0 && !editing;
	$("insert").textContent = editing
		? "Update citation"
		: picks.length > 1
			? `Insert citation (${picks.length} items)`
			: "Insert citation";
	$("cancel").hidden = !editing;
}

function resetTray() {
	picks = [];
	editing = null;
	renderTray();
	renderResults($<HTMLInputElement>("q").value);
}

async function doInsert() {
	if (!picks.length) return;
	const r = await busy(editing ? "Updating citation…" : "Inserting citation…", () =>
		editing ? app.updateCitation(editing.ref, editing.citationID, picks) : app.insertCitation(picks),
	);
	if (r) {
		toast(editing ? "Citation updated. " + fmtReport(r) : "Citation inserted. " + fmtReport(r));
		resetTray();
		void refreshDocState();
	}
}

// ---------------------------------------------------------------- cited items (cursor inside a citation)

function renderCited() {
	const box = $("cited");
	const v = cursorView;
	if (!v || editing) {
		box.hidden = true;
		return;
	}
	box.hidden = false;
	box.replaceChildren(
		h("h3", {}, v.items.length > 1 ? `Cited here (${v.items.length})` : "Cited here"),
		...v.items.map((it) => {
			const abs = h("div", { class: "abs" }, it.abstract || "");
			const acts = h("div", { class: "acts row" });
			if (it.key && it.inLibrary) acts.append(h("button", { onclick: () => void openInApp(it.key!) }, "Open in Zinc"));
			if (it.doi)
				acts.append(
					h(
						"button",
						{
							class: "ghost",
							onclick: () =>
								void host
									.call("app.openUrl", { url: "https://doi.org/" + it.doi })
									.catch((e) => toast(String(e.message ?? e), true)),
						},
						"DOI",
					),
				);
			if (!it.abstract && it.doi && app.info?.zn.up) {
				acts.append(
					h(
						"button",
						{
							class: "ghost",
							onclick: async (e: Event) => {
								(e.target as HTMLButtonElement).disabled = true;
								const a = await app.lookupAbstract(it.doi);
								if (a) {
									it.abstract = a;
									abs.textContent = a;
									abs.hidden = false;
									(e.target as HTMLElement).remove();
								} else toast("No abstract found online.");
							},
						},
						"Fetch abstract",
					),
				);
			}
			const more = h(
				"button",
				{
					class: "link small",
					onclick: () => {
						abs.classList.toggle("open");
						more.textContent = abs.classList.contains("open") ? "Show less" : "Show more";
					},
				},
				"Show more",
			);
			queueMicrotask(() => {
				if (abs.scrollHeight > abs.clientHeight + 2) abs.classList.add("clamped");
				else more.hidden = true;
			});
			return h(
				"div",
				{ class: "cite-item" },
				h("div", { class: "t" }, it.title),
				h("div", { class: "muted small" }, [it.authors, it.year, it.journal].filter(Boolean).join(" · ")),
				h(
					"div",
					{ class: "row small" },
					it.trashed
						? h("span", { class: "badge warn" }, "In trash")
						: it.inLibrary
							? h("span", { class: "badge ok" }, "In library")
							: h("span", { class: "badge warn" }, "Not in library"),
					it.locator ? h("span", { class: "badge" }, "loc. " + it.locator) : null,
					it.prefix || it.suffix ? h("span", { class: "badge" }, [it.prefix, "…", it.suffix].join(" ")) : null,
				),
				it.abstract ? abs : h("div", { class: "muted small" }, "No abstract on record."),
				it.abstract ? more : null,
				acts,
			);
		}),
		h(
			"div",
			{ class: "row", style: "margin-top:8px" },
			h("button", { class: "primary", onclick: () => void startEdit() }, "Edit citation"),
			v.items.length > 1 ? h("button", { title: "Make one citation per item", onclick: () => void splitCited() }, "Split") : null,
			h("button", { class: "ghost", onclick: () => void deleteCited() }, "Delete"),
		),
	);
	if (isBusy) lockButtons(box);
}

async function openInApp(key: string) {
	const r = await busy("Opening in Zinc…", () => app.reveal(key));
	if (r && !r.ok) toast(r.error ?? "Could not open Zinc.", true, 9000);
}

async function startEdit() {
	const v = cursorView;
	if (!v) return;
	const cur = await app.host.call<any>("doc.cursor");
	const code = cur.code as string | undefined;
	if (!code) return;
	// like Zotero: editing replaces text the user typed into the citation, so say so first
	const parsed = parseFieldCode(code);
	if (
		parsed?.kind === "item" &&
		(parsed.data.properties.dontUpdate || isHandEdited(parsed.data.properties, String(cur.text ?? ""))) &&
		!window.confirm("This citation was edited by hand. Editing it will replace your changes with the formatted citation. Continue?")
	)
		return;
	const r = await busy("Loading citation…", () => app.picksFromCitation(code));
	if (!r) return;
	picks = r.picks;
	editing = { ref: v.ref, citationID: r.citationID };
	renderTray();
	renderCited();
	renderResults($<HTMLInputElement>("q").value);
	$<HTMLInputElement>("q").focus();
}

/** "editCitation" command (from the citation popup): the cursor view may not have arrived yet, so read the cursor first. */
async function editCitationAtCursor() {
	if (!cursorView) {
		try {
			const c = await app.host.call<any>("doc.cursor");
			if (c?.inField && c.kind === "item") cursorView = await app.describeCitation(c);
		} catch {
			cursorView = null;
		}
	}
	if (!cursorView) return toast("The cursor is not inside a citation.", true);
	await startEdit();
}

async function splitCited() {
	const v = cursorView;
	if (!v) return;
	// custom or hand-edited text cannot survive a split: say so first, and show what would be replaced
	const cur = (await app.readFields().catch(() => [])).find((f) => f.story === v.ref.story && f.idx === v.ref.idx);
	const props = cur?.parsed?.kind === "item" ? cur.parsed.data.properties : null;
	if (props && (props.custom || props.dontUpdate || isHandEdited(props, String(cur?.text ?? "")))) {
		const was = String(cur?.text ?? props.plainCitation ?? "");
		const ok = window.confirm(`This citation has custom or hand-edited text:

${was}

Splitting replaces it with one formatted citation per item. Ctrl+Z in Word brings the original back. Split anyway?`);
		if (!ok) return;
	}
	const r = await busy("Splitting citation…", () => app.splitCitation(v.ref, v.citationID, { allowProtected: true }));
	if (r) toast("Split into " + v.items.length + " citations (Refresh joins touching citations again). " + fmtReport(r));
	cursorView = null;
	renderCited();
}

async function deleteCited() {
	const v = cursorView;
	if (!v) return;
	// no confirmation: the delete is one Word undo step (Ctrl+Z brings it back)
	const r = await busy("Deleting citation…", () => app.deleteCitation(v.ref, v.citationID));
	if (r) toast("Citation deleted (Ctrl+Z in the document to undo). " + fmtReport(r));
	cursorView = null;
	renderCited();
}

let cursorSeq = 0;
/** Full name of the document the last cursor event came from: the doc line is re-read only when it changes. (Comparing a
 * file name cut from the path with Word's Name could fail to match, e.g. for a OneDrive document whose full name is a URL,
 * and then every cursor move re-read the document state from Word.) */
let cursorDoc: string | null = null;
async function onCursor(c: any) {
	const seq = ++cursorSeq;
	if (!c?.hasDoc) {
		docName = "";
		cursorDoc = null;
		cursorView = null;
		renderDocLine();
		renderCited();
		return;
	}
	const doc = String(c.doc ?? "");
	if (doc !== cursorDoc) {
		cursorDoc = doc;
		void refreshDocState();
	}
	let view: CitationView | null = null;
	try {
		view = c.inField && c.kind === "item" ? await app.describeCitation(c) : null;
	} catch {
		view = null;
	}
	if (seq !== cursorSeq) return; // a later cursor event arrived first
	cursorView = view;
	renderCited();
}

// ---------------------------------------------------------------- bibliography editor

/** The entry text as the editor's text box shows it: plain, or with <i> <b> <sup> <sub> tags when the entry has formatting. */
function runsToEditText(runs: Run[]): string {
	return runs.some((r) => r.i || r.b || r.sup || r.sub || r.sc) ? runsToHtml(runs) : runs.map((r) => r.t).join("");
}
function editTextToRuns(text: string): Run[] {
	return /<\/?(?:i|b|sup|sub)>/i.test(text) ? htmlToRuns(text) : text ? [{ t: text }] : [];
}

let bibState: BibEditorEntry[] = [];

function renderBibEntries() {
	const list = $("bibed-list");
	const changed = bibState.some((e) => e.omitted || e.custom || (e.uncited && !e.cited));
	$("bibed-revert").hidden = !bibState.some((e) => e.omitted || e.custom);
	list.replaceChildren(
		...bibState.map((e, i) => {
			const body = h("div", { class: "ent" + (e.omitted ? " off" : "") });
			if (e.runs.length) for (const r of e.runs) body.append(h(r.i ? "i" : "span", { class: r.b ? "b" : "" }, r.t));
			else body.append(e.title);
			const acts = h(
				"div",
				{ class: "row" },
				h(
					"button",
					{
						onclick: () => {
							e.omitted = !e.omitted;
							renderBibEntries();
						},
					},
					e.omitted ? "Include" : "Exclude",
				),
				h("button", { class: "ghost", onclick: () => editBibEntry(i) }, "Edit text"),
				e.custom
					? h(
							"button",
							{
								class: "ghost",
								onclick: () => {
									e.custom = false;
									e.runs = e.defaultRuns;
									renderBibEntries();
								},
							},
							"Revert",
						)
					: null,
				e.uncited && !e.cited
					? h(
							"button",
							{
								class: "ghost",
								onclick: () => {
									bibState.splice(i, 1);
									renderBibEntries();
								},
							},
							"Remove",
						)
					: null,
			);
			return h(
				"li",
				{},
				body,
				h(
					"div",
					{ class: "row small" },
					e.omitted ? h("span", { class: "badge warn" }, "Excluded") : null,
					e.custom ? h("span", { class: "badge" }, "Edited text") : null,
					e.uncited && !e.cited ? h("span", { class: "badge" }, "Not cited in the text") : null,
				),
				acts,
			);
		}),
	);
	if (!bibState.length) list.append(h("li", { class: "muted" }, "The bibliography is empty."));
	$("bibed-save").textContent = changed ? "Save changes" : "Save";
}

function editBibEntry(i: number) {
	const e = bibState[i]!;
	const ta = h("textarea", { rows: 4, value: runsToEditText(e.runs.length ? e.runs : e.defaultRuns), "aria-label": "Entry text" });
	const li = $("bibed-list").children[i] as HTMLElement;
	const box = h(
		"div",
		{ class: "edit" },
		ta,
		h("div", { class: "muted small" }, "Use <i>…</i> for italics, <b>…</b> for bold. Only this entry changes."),
		h(
			"div",
			{ class: "row" },
			h(
				"button",
				{
					class: "primary",
					onclick: () => {
						const runs = editTextToRuns((ta as HTMLTextAreaElement).value);
						if (!runs.length) return toast("The entry text is empty. Use Exclude to leave the entry out.", true);
						e.runs = runs;
						e.custom = JSON.stringify(runs) !== JSON.stringify(e.defaultRuns);
						renderBibEntries();
					},
				},
				"Done",
			),
			h("button", { class: "ghost", onclick: () => renderBibEntries() }, "Cancel"),
		),
	);
	li.replaceChildren(box);
	(ta as HTMLTextAreaElement).focus();
}

async function openBibEditor() {
	const box = $("bibed");
	if (!box.hidden) {
		box.hidden = true;
		return;
	}
	$("settings").hidden = true;
	const entries = await busy("Reading the bibliography…", () => app.bibliographyEditor());
	if (entries === undefined) return;
	if (entries === null) return toast("Insert a bibliography first (Insert bibliography), then edit it here.", true);
	bibState = entries;
	let seq = 0;
	const search = h("input", {
		type: "search",
		placeholder: "Add an uncited item: search your library",
		autocomplete: "off",
		oninput: async (e: Event) => {
			const mine = ++seq;
			const q = (e.target as HTMLInputElement).value.trim();
			const found = q ? await app.search(q, 8).catch(() => []) : [];
			if (mine !== seq) return;
			found_.replaceChildren(
				...found.map((r) =>
					h(
						"li",
						{
							onclick: async () => {
								const p = await app.pickFromKey(r.key);
								if (!p) return toast("That item is no longer in the library.", true);
								if (bibState.some((x) => x.uris.some((u) => p.uris.includes(u))))
									return toast("It is already in the bibliography.");
								bibState.push({
									cslId: p.cslId,
									uris: p.uris,
									title: p.title,
									runs: [],
									defaultRuns: [],
									cited: false,
									uncited: true,
									omitted: false,
									custom: false,
								});
								(search as HTMLInputElement).value = "";
								found_.replaceChildren();
								renderBibEntries();
							},
						},
						h("div", { class: "t" }, r.title || "(untitled)"),
						h("div", { class: "m muted small" }, [r.creators, r.year].filter(Boolean).join(" · ")),
					),
				),
			);
		},
	});
	const found_ = h("ul", { class: "found" });
	box.replaceChildren(
		h("h3", {}, "Edit bibliography"),
		h(
			"div",
			{ class: "muted small" },
			"Exclude an entry, change its text, or list an item the text does not cite. Changes are stored in the bibliography field, as Zotero does.",
		),
		h("ul", { id: "bibed-list", class: "bibed" }),
		search,
		found_,
		h(
			"div",
			{ class: "row", style: "margin-top:8px" },
			h(
				"button",
				{
					id: "bibed-save",
					class: "primary",
					onclick: async () => {
						const r = await busy("Saving bibliography…", () => app.saveBibliography(changesFromEntries(bibState)));
						if (r) {
							toast("Bibliography updated. " + fmtReport(r));
							box.hidden = true;
						}
					},
				},
				"Save",
			),
			h(
				"button",
				{
					id: "bibed-revert",
					class: "ghost",
					onclick: () => {
						for (const e of bibState) {
							e.omitted = false;
							e.custom = false;
							e.runs = e.defaultRuns;
						}
						renderBibEntries();
					},
				},
				"Revert all",
			),
			h("button", { class: "ghost", onclick: () => (box.hidden = true) }, "Close"),
		),
	);
	renderBibEntries();
	box.hidden = false;
}

// ---------------------------------------------------------------- settings

async function openSettings() {
	const box = $("settings");
	if (!box.hidden) {
		box.hidden = true;
		return;
	}
	$("bibed").hidden = true;
	const info = await app.init();
	const st = await app.docState();
	const styleNow = st.prefs ? styleUrlToId(st.prefs.styleId) : app.defaults.style;
	const localeNow = st.prefs ? st.prefs.locale : app.defaults.locale;
	let styleQ = "";
	const list = h("ul", { class: "styles" });
	const loc = h("select", {}, ...LOCALES.map((l) => h("option", { value: l, selected: l === localeNow }, l || "Style default")));
	let styleSeq = 0;
	async function loadStyles() {
		const seq = ++styleSeq;
		const rows = await host.call<any[]>("style.search", { q: styleQ, limit: 40 });
		if (seq !== styleSeq) return; // a newer search is in flight
		list.replaceChildren(
			...rows.map((s) =>
				h(
					"li",
					{
						class: s.id === styleNow ? "current" : "",
						title: s.id,
						onclick: async () => {
							const r = await busy("Applying style…", () => app.setStyle(s.id, (loc as HTMLSelectElement).value));
							if (r) {
								await app.saveDefaults(s.id, (loc as HTMLSelectElement).value);
								toast(`Style ${s.title}. ` + fmtReport(r));
								box.hidden = true;
								void refreshDocState();
							}
						},
					},
					s.title,
					s.installed ? "" : "  (downloads on use)",
				),
			),
		);
	}
	const dbIn = h("input", { type: "text", value: info.settings.dbPath ?? "", placeholder: info.library.dbPath });
	const uidIn = h("input", {
		type: "text",
		value: info.settings.userId ?? "",
		placeholder: info.uri.userId ? `${info.uri.userId} (${info.uri.source})` : "zotero.org user id, or leave empty for a local library",
	});
	const noteSel = h(
		"select",
		{
			onchange: async (e: Event) => {
				const r = await busy("Moving citations…", () => app.setNoteType(Number((e.target as HTMLSelectElement).value) as 1 | 2));
				if (r) toast("Note type changed. " + fmtReport(r));
				else if (r === null) toast("The note type only applies to note styles (the current style puts citations in the text).");
			},
		},
		h("option", { value: "1", selected: (st.prefs?.noteType ?? 1) !== 2 }, "Footnotes"),
		h("option", { value: "2", selected: st.prefs?.noteType === 2 }, "Endnotes"),
	);
	const autoChk = h("input", {
		type: "checkbox",
		checked: !st.prefs?.delayCitationUpdates,
		onchange: (e: Event) => {
			const on = (e.target as HTMLInputElement).checked;
			void app
				.setAutoUpdate(on)
				.then(() =>
					toast(
						on
							? "Citations update automatically."
							: "Automatic updates are off: a new citation is formatted on its own, use Refresh to update the rest.",
					),
				);
		},
	});
	box.replaceChildren(
		h("h3", {}, "Citation style"),
		h(
			"div",
			{ class: "settings-grid" },
			h(
				"label",
				{},
				"Search styles",
				h("input", {
					type: "search",
					placeholder: "e.g. vancouver, nature, apa",
					oninput: (e: Event) => {
						styleQ = (e.target as HTMLInputElement).value;
						void loadStyles();
					},
				}),
				list,
			),
			h("label", {}, "Language", loc),
			h("label", {}, "Note styles use (existing citations move to match)", noteSel),
			h("label", { class: "check" }, autoChk, "Automatically update citations"),
		),
		h("h3", { style: "margin-top:12px" }, "Library"),
		h(
			"div",
			{ class: "settings-grid" },
			h(
				"div",
				{ class: "small muted" },
				info.library.dbExists
					? `${info.library.items ?? "?"} items · read-only · ${info.library.dbPath}`
					: "Library database not found: " + info.library.dbPath,
			),
			h("label", {}, "Database path (optional override)", dbIn),
			h("label", {}, "zotero.org user id (for citation links)", uidIn),
			h("div", { class: "small muted" }, `Citation links use ${info.uri.base} (${info.uri.source}).`),
			h(
				"div",
				{ class: "small muted" },
				info.zn.up ? "Zinc is running." : "Zinc is not running (not needed; it is started on demand for Open).",
			),
			h(
				"div",
				{ class: "row" },
				h(
					"button",
					{
						class: "primary",
						onclick: async () => {
							await host.call("settings.set", {
								dbPath: (dbIn as HTMLInputElement).value.trim(),
								userId: (uidIn as HTMLInputElement).value.trim(),
							});
							await app.init();
							toast("Saved.");
							box.hidden = true;
							void runSearch();
						},
					},
					"Save",
				),
				h("button", { class: "ghost", onclick: () => (box.hidden = true) }, "Close"),
			),
		),
		h("h3", { style: "margin-top:12px" }, "Document"),
		h(
			"div",
			{ class: "settings-grid" },
			h(
				"div",
				{ class: "small muted" },
				"Unlink citations turns every citation and the bibliography into plain text. The text stays, but it can no longer be refreshed or edited here.",
			),
			h("div", { class: "row" }, h("button", { class: "danger", onclick: () => void unlinkAll(box) }, "Unlink citations…")),
		),
	);
	box.hidden = false;
	void loadStyles();
}

async function unlinkAll(box: HTMLElement) {
	if (
		!window.confirm(
			"Unlink all citations and the bibliography?\n\nThey become plain text and cannot be refreshed or edited afterwards. (Ctrl+Z in Word undoes it.)",
		)
	)
		return;
	const r = await busy("Unlinking…", () => app.unlinkCitations());
	if (r) {
		toast(`${r.unlinked} field(s) unlinked.`);
		box.hidden = true;
		cursorView = null;
		renderCited();
	}
}

// ---------------------------------------------------------------- start

async function main() {
	try {
		// a host handed in before this module runs (the website's live demo, src/demo-host.ts), else Word's WebView2 or ?mock
		const given = (globalThis as { __znHost?: Host }).__znHost;
		host = given ?? (new URLSearchParams(location.search).has("mock") ? createMockHost() : createWebViewHost());
	} catch {
		host = createMockHost();
		toast("Preview mode: not inside Word, using sample data.");
	}
	app = new App(host);
	// the search box and buttons work at once; the first calls answer in parallel (calls that do not need Word run on a
	// worker thread in the add-in). Light init: no item count and no Zinc probe, which is asked afterwards.
	const ready = app.init(true).catch((e) => toast(e instanceof Error ? e.message : String(e), true, 10000));
	const q = $<HTMLInputElement>("q");
	let timer: ReturnType<typeof setTimeout> | undefined;
	q.addEventListener("input", () => {
		clearTimeout(timer);
		timer = setTimeout(() => void runSearch(), 120);
	});
	q.addEventListener("keydown", (e) => {
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			active = Math.max(0, Math.min(results.length - 1, active + (e.key === "ArrowDown" ? 1 : -1)));
			renderResults(q.value);
			$("results").children[active]?.scrollIntoView({ block: "nearest" });
		} else if (e.key === "Enter") {
			e.preventDefault();
			if (e.ctrlKey) void doInsert();
			else if (e.shiftKey && results[active]) void togglePick(results[active]!.key);
			else if (results[active]) void choose(results[active]!.key);
		} else if (e.key === "Escape") {
			q.value = "";
			void runSearch();
		}
	});
	$("insert").addEventListener("click", () => void doInsert());
	$("clear").addEventListener("click", resetTray);
	$("cancel").addEventListener("click", () => {
		resetTray();
		renderCited();
	});
	$("bib").addEventListener("click", async () => {
		const r = await busy("Updating bibliography…", () => app.insertBibliography());
		if (r) toast("Bibliography updated. " + fmtReport(r));
		void refreshDocState();
	});
	$("bib-edit").addEventListener("click", () => void openBibEditor());
	$("refresh").addEventListener("click", async () => {
		const r = await busy("Refreshing…", () => app.refreshAll({ merge: true, onModified: askAboutEdits }));
		if (r) toast("Refreshed. " + fmtReport(r));
	});
	$("btn-settings").addEventListener("click", () => void openSettings());
	host.on("cursor", (c) => void onCursor(c));
	host.on("command", (d) => {
		if (d?.name === "insertCitation") q.focus();
		else if (d?.name === "insertBibliography") $("bib").click();
		else if (d?.name === "refresh") $("refresh").click();
		else if (d?.name === "editCitation") void editCitationAtCursor();
	});
	renderTray();
	q.focus();
	// the doc line names the default style for a new document, which comes with the host info
	await Promise.all([ready.then(refreshDocState), runSearch()]);
	void app.checkZinc().catch(() => {});
}

void main();
