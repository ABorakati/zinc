// Citation popup: shown by the add-in (borderless WebView2 under the citation) when the cursor enters a Zotero
// citation. Events from the host: popup.show (Word cursor object), popup.hide and popup.place {side, tailX, tail, radius}
// (the window is clipped to a speech bubble; the page draws it). RPC to the host: the usual Bridge methods plus
// popup.close, popup.resize {height: total window height incl. the tail} and popup.edit.
import { App, type PopupCitation, type PopupItemView } from "./app";
import { metaLine, noteChips, popupHeight, runsToHtml, targetFromCursor, type PopupTarget } from "./cited";
import { CITATION_SCHEMA, buildItemCode } from "./fields";
import { createWebViewHost, type Host } from "./host";
import { SAMPLE_ITEMS, createMockHost } from "./mockhost";

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (v == null || v === false) continue;
		if (k === "class") el.className = v;
		else if (k === "html") el.innerHTML = v;
		else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
		else if (k in el) (el as any)[k] = v;
		else el.setAttribute(k, String(v));
	}
	for (const c of kids) if (c) el.append(c);
	return el;
}

const root = document.getElementById("pop") as HTMLElement;
const MAX_HEIGHT = 560; // total window height cap; #pop (max-height 548 + border + tail) scrolls beyond it
const bubble = document.getElementById("bubble") as HTMLElement;
let place = { side: "none" as "below" | "above" | "none", tailX: 40, tail: 10 };
let host: Host;
let app: App;
let seq = 0; // bumped on every show/hide/delete: late results of an older request are dropped
let current: { target: PopupTarget; view: PopupCitation; labels: Map<string, string> | null } | null = null;

function applyPlace(p: any) {
	const side = p?.side === "below" || p?.side === "above" ? p.side : "none";
	place = { side, tailX: typeof p?.tailX === "number" ? p.tailX : place.tailX, tail: typeof p?.tail === "number" ? p.tail : 10 };
	document.body.classList.toggle("below", side === "below");
	document.body.classList.toggle("above", side === "above");
	document.body.style.setProperty("--tail", place.tail + "px");
	bubble.style.setProperty("--tail-x", place.tailX + "px");
	reportSize();
}

function reportSize() {
	requestAnimationFrame(() => {
		// #pop is not stretched to the window, so its scrollHeight is the content height (capped; it scrolls inside beyond that);
		// the window is the bubble (content + its 1px borders) plus the tail
		const tail = place.side === "none" ? 0 : place.tail;
		void host.call("popup.resize", { height: popupHeight(root.scrollHeight + 2 + tail, MAX_HEIGHT) }).catch(() => {});
	});
}

function close() {
	void host.call("popup.close").catch(() => {});
}

function message(text: string, opts: { err?: boolean; busy?: boolean } = {}) {
	root.replaceChildren(h("div", { class: "msg muted" + (opts.err ? " err" : "") }, opts.busy ? h("span", { class: "spin" }) : null, text));
	reportSize();
}

function hide() {
	seq++;
	current = null;
	root.replaceChildren();
}

async function show(cursor: any) {
	const my = ++seq;
	const target = targetFromCursor(cursor);
	if (!target) return message("This is not a Zotero citation.", { err: true });
	// first paint straight from the field code (no host call); library status, reference, abstract and label fill in after
	const quick = app.quickView(target.code);
	if (quick) {
		current = { target, view: quick, labels: null };
		render();
	} else {
		message("Loading citation…", { busy: true });
	}
	void app.docLabels().then(
		(labels) => {
			if (my !== seq || !current) return;
			current.labels = labels;
			paintLabels();
		},
		() => {},
	);
	let view: PopupCitation | null;
	try {
		if (!app.info) await app.init().catch(() => {});
		view = await app.describeForPopup(target.code);
	} catch (e) {
		if (my === seq && !quick) message(e instanceof Error ? e.message : String(e), { err: true });
		return;
	}
	if (my !== seq) return;
	if (!view) {
		current = null;
		return message("Could not read this citation.", { err: true });
	}
	current = { target, view, labels: current?.labels ?? null };
	render();
}

/** Set the label badges of the items on screen (in place: keeps an expanded abstract open). */
function paintLabels() {
	if (!current) return;
	const { view, labels } = current;
	root.querySelectorAll<HTMLElement>(".item .lab").forEach((el, i) => {
		const l = labels && view.items[i]?.cslId ? labels.get(view.items[i]!.cslId!) : undefined;
		el.textContent = l ?? "";
		el.title = l ?? "";
		el.hidden = !l;
	});
	reportSize();
}

// ---------------------------------------------------------------- rendering

function renderItem(it: PopupItemView): HTMLElement {
	const status = it.pending ? null : h("div", { class: "row small chips" },
		it.trashed ? h("span", { class: "badge warn" }, "In trash") : it.inLibrary ? h("span", { class: "badge ok" }, "In library") : h("span", { class: "badge warn" }, "Not in library: showing the copy stored in the document"),
		...noteChips(it).map((c) => h("span", { class: "badge" }, c)),
	);
	const err = h("div", { class: "small msg err", hidden: true });
	const acts = h("div", { class: "acts row" });
	if (!it.pending && it.key && it.inLibrary) {
		const open = h("button", { class: "primary", onclick: async () => {
			open.disabled = true;
			open.textContent = "Opening Zinc…";
			err.hidden = true;
			try {
				const r = await app.reveal(it.key!);
				if (r && !r.ok) {
					err.textContent = r.error ?? "Could not open Zinc.";
					err.hidden = false;
				}
			} catch (e) {
				err.textContent = e instanceof Error ? e.message : String(e);
				err.hidden = false;
			}
			open.disabled = false;
			open.textContent = "Open in Zinc";
			reportSize();
		} }, "Open in Zinc");
		acts.append(open);
	}
	if (!it.pending && it.doi) acts.append(h("button", { class: "ghost", onclick: () => void host.call("app.openUrl", { url: "https://doi.org/" + it.doi }).catch(() => {}) }, "DOI"));

	const abs = h("div", { class: "abs" }, it.abstract);
	const more = h("button", { class: "link small", hidden: true, onclick: () => {
		abs.classList.toggle("open");
		more.textContent = abs.classList.contains("open") ? "Show less" : "Show more";
		reportSize();
	} }, "Show more");
	const absBlock = h("div", {});
	if (it.abstract) absBlock.append(h("div", { class: "abs-label" }, "Abstract"), abs, more);
	else if (!it.pending) absBlock.append(h("div", { class: "muted small", style: "margin-top:8px" }, "No abstract on record."));
	if (!it.abstract && it.doi && app.info?.zn.up) {
		const fetchBtn = h("button", { class: "ghost", onclick: async () => {
			fetchBtn.disabled = true;
			fetchBtn.textContent = "Fetching…";
			const a = await app.lookupAbstract(it.doi);
			if (a) {
				it.abstract = a;
				render();
			} else {
				fetchBtn.textContent = "No abstract found online";
			}
		} }, "Fetch abstract");
		acts.append(fetchBtn);
	}
	// reveal "Show more" only when the 6-line clamp actually cuts the text
	requestAnimationFrame(() => {
		if (it.abstract && abs.scrollHeight > abs.clientHeight + 2) more.hidden = false;
		reportSize();
	});

	return h("div", { class: "item" },
		h("div", { class: "head" }, h("div", { class: "t" }, h("span", { class: "lab", hidden: true }), it.title), h("div", { class: "m" }, metaLine(it))),
		status,
		it.reference.length && !it.pending ? h("div", { class: "ref", html: runsToHtml(it.reference) }) : null,
		absBlock,
		err,
		acts.childElementCount ? acts : null,
	);
}

function render() {
	if (!current) return;
	const { view } = current;
	root.replaceChildren(
		...view.items.map(renderItem),
		h("div", { class: "actions row" },
			h("button", { onclick: () => void host.call("popup.edit").catch(() => {}) }, "Edit citation"),
			h("span", { class: "spacer" }),
			h("button", { class: "ghost danger", onclick: () => void del() }, "Delete citation"),
		),
	);
	paintLabels();
}

async function del() {
	if (!current) return;
	const { target, view } = current;
	if (!target.ref) return message("Cannot delete: the host did not say which field this citation is.", { err: true });
	const my = ++seq;
	// no confirmation: the delete is one Word undo step (Ctrl+Z brings it back)
	message("Deleting citation…", { busy: true });
	try {
		await app.deleteCitation(target.ref, view.citationID);
	} catch (e) {
		if (my === seq) message(e instanceof Error ? e.message : String(e), { err: true });
		return;
	}
	close();
}

// ---------------------------------------------------------------- start

async function main() {
	const wantMock = new URLSearchParams(location.search).has("mock");
	let mock = wantMock;
	try {
		host = wantMock ? createMockHost() : createWebViewHost();
	} catch {
		host = createMockHost();
		mock = true;
	}
	app = new App(host);
	host.on("popup.show", (c) => void show(c));
	host.on("popup.hide", hide);
	host.on("popup.place", applyPlace);
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape") {
			e.preventDefault();
			close();
		}
	});
	new ResizeObserver(() => reportSize()).observe(root);
	try {
		await app.init();
		// compile the document's citation style now so the first popup does not wait for it
		void app.warmUp();
	} catch {
		/* surfaced when the first citation loads */
	}
	const mockHost = host as ReturnType<typeof createMockHost>;
	if (mock) {
		document.body.classList.add("mock");
		mockHost.emit("popup.place", { side: "below", tailX: 40, tail: 10, radius: 10 });
		startMock(mockHost);
	}
}

/** Browser preview: put a two-item citation in the fake document and "show" the popup for it. */
function startMock(mh: ReturnType<typeof createMockHost>) {
	const mk = (k: string, id: number) => ({ id, uris: [`http://zotero.org/users/12345/items/${k}`], itemData: { id, type: "article-journal", title: SAMPLE_ITEMS.find((i) => i.key === k)!.title } });
	const data = {
		citationID: "mock1",
		properties: { formattedCitation: "(1,2)", plainCitation: "(1,2)", noteIndex: 0 },
		citationItems: [{ ...mk("AAAA1111", 1), locator: "23-25", label: "page" }, mk("BBBB2222", 2)],
		schema: CITATION_SCHEMA,
	};
	const code = buildItemCode(data as any);
	mh.fields.push({ story: "main", idx: 1, kind: "item", code, text: "(1,2)", start: 10, end: 15 });
	mh.emit("popup.show", { hasDoc: true, doc: "Preview.docx", start: 12, end: 12, story: 1, inField: true, ref: { story: "main", idx: 1 }, kind: "item", code, text: "(1,2)" });
}

void main();
