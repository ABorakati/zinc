// Sidebar UI (vanilla DOM). All logic lives in app.ts; this file renders and wires events.
import { App, type CitationView, type LibRow, type Pick } from "./app";
import { createWebViewHost, type Host } from "./host";
import { createMockHost } from "./mockhost";
import { styleUrlToId } from "./fields";

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

const LOCALES = ["", "en-US", "en-GB", "de-DE", "fr-FR", "es-ES", "it-IT", "pt-PT", "pt-BR", "nl-NL", "sv-SE", "da-DK", "nb-NO", "fi-FI", "pl-PL", "cs-CZ", "ru-RU", "ja-JP", "zh-CN", "ko-KR", "tr-TR"];

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

async function busy<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
	const btns = [...document.querySelectorAll<HTMLButtonElement>("button")];
	btns.forEach((b) => (b.disabled = true));
	$("status").textContent = label;
	try {
		return await fn();
	} catch (e) {
		toast(e instanceof Error ? e.message : String(e), true, 8000);
		return undefined;
	} finally {
		btns.forEach((b) => (b.disabled = false));
		$("status").textContent = "";
	}
}

function fmtReport(r: { citations: number; updated: number; missing: string[] }): string {
	const miss = r.missing.length ? `, ${r.missing.length} item(s) not found in the library or the document` : "";
	return `${r.citations} citation(s), ${r.updated} updated${miss}`;
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
		docStyle = st.prefs ? styleUrlToId(st.prefs.styleId) + (st.prefs.locale ? " (" + st.prefs.locale + ")" : "") : st.hasDoc ? `new document · default ${app.defaults.style}` : "";
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
				h("div", { class: "body" },
					h("div", { class: "t" }, r.title || "(untitled)"),
					h("div", { class: "m" }, [r.creators, r.year, r.publication].filter(Boolean).join(" · ")),
				),
			),
		),
	);
	if (!results.length) $("status").textContent = q.trim() ? "No matches" : "";
	else $("status").textContent = (q.trim() ? `${results.length} shown` : "Recently added") + " · click to cite, tick to cite several together";
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
					h("div", {}, h("div", { class: "t" }, p.title || "(untitled)"), h("div", { class: "muted small" }, [p.creators, p.year].filter(Boolean).join(" · "), p.inLibrary ? "" : "  (not in library, embedded copy)")),
					h("button", { class: "icon", title: "Remove", "aria-label": "Remove from citation", onclick: () => { picks.splice(i, 1); renderTray(); renderResults($<HTMLInputElement>("q").value); } }, "✕"),
				),
				h(
					"details",
					{ open: !!(p.locator || p.prefix || p.suffix || p.suppressAuthor) },
					h("summary", { class: "muted small" }, "Page, prefix, suffix…"),
					h(
					"div",
					{ class: "grid" },
					h("label", {}, "Locator", h("input", { type: "text", value: p.locator, placeholder: "e.g. 23-25", oninput: bind("locator") })),
					h(
						"label",
						{},
						"Type",
						(() => {
							const s = h("select", { onchange: (e: Event) => (p.label = (e.target as HTMLSelectElement).value) });
							for (const l of ["page", "chapter", "section", "paragraph", "figure", "table", "volume", "line", "note", "verse"]) s.append(h("option", { value: l, selected: l === p.label }, l));
							return s;
						})(),
					),
					h("label", {}, "Prefix", h("input", { type: "text", value: p.prefix, placeholder: "see", oninput: bind("prefix") })),
					h("label", {}, "Suffix", h("input", { type: "text", value: p.suffix, placeholder: "and others", oninput: bind("suffix") })),
					h("label", { class: "check full" }, h("input", { type: "checkbox", checked: p.suppressAuthor, onchange: (e: Event) => (p.suppressAuthor = (e.target as HTMLInputElement).checked) }), "Omit author"),
					),
				),
			);
		}),
	);
	$("tray-actions").hidden = picks.length === 0 && !editing;
	$("insert").textContent = editing ? "Update citation" : picks.length > 1 ? `Insert citation (${picks.length} items)` : "Insert citation";
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
	const r = await busy(editing ? "Updating citation…" : "Inserting citation…", () => (editing ? app.updateCitation(editing.ref, editing.citationID, picks) : app.insertCitation(picks)));
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
			if (it.key && it.inLibrary) acts.append(h("button", { onclick: () => void openInApp(it.key!) }, "Open in zotero-next"));
			if (it.doi) acts.append(h("button", { class: "ghost", onclick: () => void host.call("app.openUrl", { url: "https://doi.org/" + it.doi }).catch((e) => toast(String(e.message ?? e), true)) }, "DOI"));
			if (!it.abstract && it.doi && app.info?.zn.up) {
				acts.append(
					h("button", { class: "ghost", onclick: async (e: Event) => {
						(e.target as HTMLButtonElement).disabled = true;
						const a = await app.lookupAbstract(it.doi);
						if (a) { it.abstract = a; abs.textContent = a; abs.hidden = false; (e.target as HTMLElement).remove(); } else toast("No abstract found online.");
					} }, "Fetch abstract"),
				);
			}
			const more = h("button", { class: "link small", onclick: () => { abs.classList.toggle("open"); more.textContent = abs.classList.contains("open") ? "Show less" : "Show more"; } }, "Show more");
			queueMicrotask(() => {
				if (abs.scrollHeight > abs.clientHeight + 2) abs.classList.add("clamped");
				else more.hidden = true;
			});
			return h(
				"div",
				{ class: "cite-item" },
				h("div", { class: "t" }, it.title),
				h("div", { class: "muted small" }, [it.authors, it.year, it.journal].filter(Boolean).join(" · ")),
				h("div", { class: "row small" },
					it.trashed ? h("span", { class: "badge warn" }, "In trash") : it.inLibrary ? h("span", { class: "badge ok" }, "In library") : h("span", { class: "badge warn" }, "Not in library"),
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
			h("button", { class: "ghost", onclick: () => void deleteCited() }, "Delete"),
		),
	);
}

async function openInApp(key: string) {
	const r = await busy("Opening in zotero-next…", () => app.reveal(key));
	if (r && !r.ok) toast(r.error ?? "Could not open zotero-next.", true, 9000);
}

async function startEdit() {
	const v = cursorView;
	if (!v) return;
	const cur = await app.host.call<any>("doc.cursor");
	const code = cur.code as string | undefined;
	if (!code) return;
	const r = await busy("Loading citation…", () => app.picksFromCitation(code));
	if (!r) return;
	picks = r.picks;
	editing = { ref: v.ref, citationID: r.citationID };
	renderTray();
	renderCited();
	renderResults($<HTMLInputElement>("q").value);
	$<HTMLInputElement>("q").focus();
}

async function deleteCited() {
	const v = cursorView;
	if (!v) return;
	if (!confirm("Delete this citation from the document?")) return;
	const r = await busy("Deleting citation…", () => app.deleteCitation(v.ref, v.citationID));
	if (r) toast("Citation deleted. " + fmtReport(r));
	cursorView = null;
	renderCited();
}

async function onCursor(c: any) {
	if (!c?.hasDoc) {
		docName = "";
		cursorView = null;
		renderDocLine();
		renderCited();
		return;
	}
	const name = String(c.doc ?? "").split(/[\\/]/).pop() ?? "";
	if (name !== docName) void refreshDocState();
	try {
		cursorView = c.inField && c.kind === "item" ? await app.describeCitation(c) : null;
	} catch {
		cursorView = null;
	}
	renderCited();
}

// ---------------------------------------------------------------- settings

async function openSettings() {
	const box = $("settings");
	if (!box.hidden) {
		box.hidden = true;
		return;
	}
	const info = await app.init();
	const st = await app.docState();
	const styleNow = st.prefs ? styleUrlToId(st.prefs.styleId) : app.defaults.style;
	const localeNow = st.prefs ? st.prefs.locale : app.defaults.locale;
	let styleQ = "";
	const list = h("ul", { class: "styles" });
	const loc = h("select", {}, ...LOCALES.map((l) => h("option", { value: l, selected: l === localeNow }, l || "Style default")));
	async function loadStyles() {
		const rows = await host.call<any[]>("style.search", { q: styleQ, limit: 40 });
		list.replaceChildren(
			...rows.map((s) =>
				h("li", { class: s.id === styleNow ? "current" : "", title: s.id, onclick: async () => {
					const r = await busy("Applying style…", () => app.setStyle(s.id, (loc as HTMLSelectElement).value));
					if (r) {
						await app.saveDefaults(s.id, (loc as HTMLSelectElement).value);
						toast(`Style ${s.title}. ` + fmtReport(r));
						box.hidden = true;
						void refreshDocState();
					}
				} }, s.title, s.installed ? "" : "  (downloads on use)"),
			),
		);
	}
	const dbIn = h("input", { type: "text", value: info.settings.dbPath ?? "", placeholder: info.library.dbPath });
	const uidIn = h("input", { type: "text", value: info.settings.userId ?? "", placeholder: info.uri.userId ? `${info.uri.userId} (${info.uri.source})` : "zotero.org user id, or leave empty for a local library" });
	const noteSel = h("select", { onchange: (e: Event) => void app.setNoteType(Number((e.target as HTMLSelectElement).value) as 1 | 2).then(() => toast("Saved. Applies to new note-style citations.")) },
		h("option", { value: "1", selected: (st.prefs?.noteType ?? 1) !== 2 }, "Footnotes"), h("option", { value: "2", selected: st.prefs?.noteType === 2 }, "Endnotes"));
	box.replaceChildren(
		h("h3", {}, "Citation style"),
		h("div", { class: "settings-grid" },
			h("label", {}, "Search styles", h("input", { type: "search", placeholder: "e.g. vancouver, nature, apa", oninput: (e: Event) => { styleQ = (e.target as HTMLInputElement).value; void loadStyles(); } }), list),
			h("label", {}, "Language", loc),
			h("label", {}, "Note styles use", noteSel),
		),
		h("h3", { style: "margin-top:12px" }, "Library"),
		h("div", { class: "settings-grid" },
			h("div", { class: "small muted" }, info.library.dbExists ? `${info.library.items ?? "?"} items · read-only · ${info.library.dbPath}` : "Library database not found: " + info.library.dbPath),
			h("label", {}, "Database path (optional override)", dbIn),
			h("label", {}, "zotero.org user id (for citation links)", uidIn),
			h("div", { class: "small muted" }, `Citation links use ${info.uri.base} (${info.uri.source}).`),
			h("div", { class: "small muted" }, info.zn.up ? "zotero-next is running." : "zotero-next is not running (not needed; it is started on demand for Open)."),
			h("div", { class: "row" },
				h("button", { class: "primary", onclick: async () => {
					await host.call("settings.set", { dbPath: (dbIn as HTMLInputElement).value.trim(), userId: (uidIn as HTMLInputElement).value.trim() });
					await app.init();
					toast("Saved.");
					box.hidden = true;
					void runSearch();
				} }, "Save"),
				h("button", { class: "ghost", onclick: () => (box.hidden = true) }, "Close")),
		),
	);
	box.hidden = false;
	void loadStyles();
}

// ---------------------------------------------------------------- start

async function main() {
	try {
		host = new URLSearchParams(location.search).has("mock") ? createMockHost() : createWebViewHost();
	} catch {
		host = createMockHost();
		toast("Preview mode: not inside Word, using sample data.");
	}
	app = new App(host);
	try {
		await app.init();
	} catch (e) {
		toast(e instanceof Error ? e.message : String(e), true, 10000);
	}
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
	$("cancel").addEventListener("click", () => { resetTray(); renderCited(); });
	$("bib").addEventListener("click", async () => {
		const r = await busy("Updating bibliography…", () => app.insertBibliography());
		if (r) toast("Bibliography updated. " + fmtReport(r));
		void refreshDocState();
	});
	$("refresh").addEventListener("click", async () => {
		const r = await busy("Refreshing…", () => app.refreshAll());
		if (r) toast("Refreshed. " + fmtReport(r));
	});
	$("btn-settings").addEventListener("click", () => void openSettings());
	host.on("cursor", (c) => void onCursor(c));
	host.on("command", (d) => {
		if (d?.name === "insertCitation") q.focus();
		else if (d?.name === "insertBibliography") $("bib").click();
		else if (d?.name === "refresh") $("refresh").click();
	});
	renderTray();
	await refreshDocState();
	await runSearch();
	q.focus();
}

void main();
