// QuickJS test plugin for the plugin UI: returns one tree with (nearly) every node kind in the nested JSON form, answers events,
// pulls virtual rows, opens dialogs and toasts from handlers. State lives in `s`; every event re-renders the whole tree.
import ui from "zinc:plugin/ui@0.1.0";
import log from "zinc:plugin/log@0.1.0";

const info = (m) => log.write("info", m);
const plain = (v) => ({ tag: "plain", val: v });

const s = { clicks: 0, typed: "", committed: "", checked: false, on: true, radio: "b", pick: "gamma", num: 7, slider: 40, color: "#2b5fa8", date: "2026-11-18", tokens: ["alpha", "beta"], tab: "one", selected: [], sort: undefined, open: false, outcome: "", pressed: false, notes: "line one", submitted: "" };

const sparkline = [];
for (let i = 0; i < 12; i++) sparkline.push(20 + 18 * Math.sin(i / 1.7) + i * 2);

function tree() {
	const T = (text, kind = "body", extra = {}) => ({ type: "text", kind, text, ...extra });
	const row = (children, extra = {}) => ({ type: "box", style: { direction: "row", gap: 2, alignItems: "center", wrap: true }, children, ...extra });
	const col = (children, extra = {}) => ({ type: "box", style: { direction: "column", gap: 2 }, children, ...extra });
	return {
		rev: s.clicks + s.typed.length + 1,
		styles: [{ name: "chip", style: { background: "primary-tint", radius: "full", padding: { x: 2, y: 1 } } }],
		root: col(
			[
				T("Plugin UI fixture", "heading1", { key: "h1" }),
				T("Every node kind, drawn by Zinc from a tree the plugin returned.", "caption"),
				// ---- text
				{ type: "group", caption: "Text", children: [
					T("Body text, label and mono follow.", "body"),
					T("Label text", "label"),
					T("let answer = 42;", "mono"),
					{ type: "text", runs: ["Mixed runs: ", { text: "bold", bold: true }, ", ", { text: "italic", italic: true }, ", ", { text: "code", mono: true }, " and a ", { text: "link", link: { url: "https://example.org" } }, "."] },
					{ type: "text", runs: [{ text: "Colored ", color: "palette-rust" }, { text: "sized ", size: "lg", color: "palette-violet" }, { text: "words", color: { light: "#1f7a62", dark: "#4fbf9e" } }] },
					{ type: "link", label: "A link node", target: { url: "https://example.org" }, icon: "external-link" },
				] },
				// ---- feedback
				{ type: "group", caption: "Feedback", children: [
					row([
						{ type: "badge", label: "neutral" }, { type: "badge", label: "info", tone: "info" }, { type: "badge", label: "success", tone: "success", icon: "check" },
						{ type: "badge", label: "warning", tone: "warning" }, { type: "badge", label: "error", tone: "error" }, { type: "badge", label: "removable", removable: true, color: "palette-violet" },
					]),
					{ type: "callout", tone: "info", title: "Heads up", message: "A callout with a title and a message.", dismissible: true },
					{ type: "callout", tone: "error", message: "Something failed." },
					row([
						{ type: "progress", value: 0.6, label: "60%", style: { width: "160px" } }, { type: "progress", look: "ring", value: 0.75 }, { type: "progress", look: "spinner" },
						{ type: "icon", icon: "loader-circle", spin: true, color: "palette-blue" }, { type: "icon", icon: "heart", size: 20, color: "palette-rose" },
					]),
					{ type: "skeleton", width: "200px", height: "12px" },
					{ type: "separator" },
				] },
				// ---- buttons
				{ type: "group", caption: "Buttons", children: [
					row([
						{ type: "button", key: "btn", label: "Click me", look: "primary", on: { press: "clicked" }, testId: "btn" },
						{ type: "button", label: "Standard" }, { type: "button", label: "Outline", look: "outline" }, { type: "button", label: "Ghost", look: "ghost", icon: "star" },
						{ type: "button", label: "Delete", look: "destructive" }, { type: "button", label: "Link look", look: "link" },
						{ type: "button", icon: "plus", a11y: { label: "Add" }, on: { press: "added" } },
						{ type: "button", label: "Toggle", pressed: s.pressed, on: { press: "toggle-pressed" } },
						{ type: "button", label: "Busy", loading: true },
						{ type: "button", label: "Menu", look: "outline", menu: { items: [{ id: "m1", label: "First" }, { kind: "separator" }, { id: "m2", label: "Second", icon: "star", shortcut: "Ctrl+2" }, { label: "More", children: [{ id: "m3", label: "Deep" }] }] } },
						{ type: "button", key: "dlg", label: "Open dialog", on: { press: "dialog" }, testId: "dlg" },
						{ type: "button", key: "toast", label: "Show toast", on: { press: "toast" } },
					]),
					T("Clicks: " + s.clicks, "label", { key: "count", testId: "count" }),
					T("Dialog outcome: " + (s.outcome || "none"), "caption", { key: "outcome" }),
				] },
				// ---- form
				{ type: "group", caption: "Inputs", children: [
					{ type: "form", key: "form", on: { submit: "submitted" }, children: [
						{ type: "text-input", key: "name", name: "name", value: s.typed, placeholder: "Type here", clearButton: true, prefixIcon: "pencil", on: { input: "typed", change: "committed" }, testId: "name",
							suggest: { items: [{ value: "alice", label: "Alice" }, { value: "alina", label: "Alina" }] } },
						T("Echo: " + s.typed, "body", { key: "echo" }),
						{ type: "text-input", name: "notes", multiline: true, minRows: 2, value: s.notes, placeholder: "Notes" },
						{ type: "checkbox", name: "agree", label: "I agree", checked: s.checked, on: { change: "checked" } },
						{ type: "switch", name: "on", label: "Switch", on: s.on },
						{ type: "radio-group", name: "radio", value: s.radio, options: [{ value: "a", label: "Option A", description: "first" }, { value: "b", label: "Option B" }], on: { change: "radio" } },
						{ type: "select", name: "pick", value: s.pick, options: [{ value: "alpha", label: "Alpha", group: "Greek" }, { value: "beta", label: "Beta", group: "Greek" }, { value: "gamma", label: "Gamma", group: "Greek" }, { value: "one", label: "One", group: "Numbers" }], on: { change: "pick" } },
						{ type: "number-input", name: "num", value: s.num, min: 0, max: 100, step: 1, unit: "pt" },
						{ type: "slider", name: "slider", value: s.slider, min: 0, max: 100, step: 5, showValue: true, on: { change: "slider" } },
						{ type: "color-input", name: "color", value: s.color, swatches: ["#2b5fa8", "#c0532e", "#1f7a62", "#6a4fc8"] },
						{ type: "date-input", name: "date", value: s.date },
						{ type: "token-input", name: "tokens", tokens: s.tokens.map((t) => ({ id: t, label: t })), allowNew: true, placeholder: "Add a tag", on: { change: "tokens" } },
						{ type: "button", label: "Submit form", submit: true, look: "primary" },
					] },
					T("Submitted: " + (s.submitted || "none"), "caption", { key: "submitted" }),
				] },
				// ---- layout
				{ type: "group", caption: "Layout", children: [
					{ type: "tabs", key: "tabs", look: "underline", selected: s.tab, on: { change: "tab" }, tabs: [{ key: "one", label: "One", icon: "folder" }, { key: "two", label: "Two", badge: 3 }, { key: "three", label: "Three" }], children: [
						T("Panel one"), T("Panel two"), T("Panel three"),
					] },
					{ type: "section", key: "sec", title: "A section", icon: "book", count: 4, open: true, summary: "closed summary", buttons: [{ id: "sec-btn", icon: "refresh-cw", label: "Refresh" }], on: { toggle: "toggled" }, children: [T("Inside the section")] },
					{ type: "grid", columns: ["fill", 120, "fill"], columnGap: 2, rowGap: 1, children: [
						{ type: "card", children: [T("Card 1")] }, { type: "card", children: [T("Card 2")] }, { type: "card", children: [T("Card 3")] },
						{ type: "card", style: { gridColumn: { span: 2 } }, children: [T("Spans two columns")] }, { type: "card", children: [T("Card 5")] },
					] },
					{ type: "toolbar", children: [{ type: "button", icon: "bold", look: "ghost", a11y: { label: "Bold" } }, { type: "button", icon: "italic", look: "ghost", a11y: { label: "Italic" } }, { type: "spacer" }, { type: "badge", label: "toolbar" }] },
					{ type: "split", key: "split", orientation: "row", sizes: [0.3, 0.7], style: { height: "60px" }, children: [{ type: "card", children: [T("Left")] }, { type: "card", children: [T("Right")] }] },
					{ type: "deck", selected: 1, children: [T("hidden deck card"), T("Deck card 2 (selected)")] },
					{ type: "scroll", axis: "vertical", style: { height: "50px" }, children: [T("Scroll line 1"), T("Scroll line 2"), T("Scroll line 3"), T("Scroll line 4"), T("Scroll line 5")] },
					{ type: "box", class: ["chip"], children: [T("A box using a named style", "caption")] },
					{ type: "box", tooltip: "A tooltip", style: { padding: 2, border: { width: 1, color: "border" }, radius: "md", background: { token: "primary", alpha: 20 } }, children: [T("Box with border, token alpha background and tooltip")] },
				] },
				// ---- collections
				{ type: "group", caption: "Lists and tables", children: [
					{ type: "list-view", key: "list", selection: "single", selected: s.selected, rows: [
						{ id: "l1", content: row([{ type: "icon", icon: "file-text" }, T("List row one")]) }, { id: "l2", content: row([{ type: "icon", icon: "file-text" }, T("List row two")]) }, { id: "l3", cells: [{ text: "Cell-only row three" }] },
					], on: { select: "list-select", activate: "list-activate" } },
					{ type: "table", key: "table", selection: "multiple", striped: true, sort: s.sort, on: { sort: "table-sort", select: "table-select" },
						columns: [{ key: "title", label: "Title", flex: 2, sortable: true }, { key: "year", label: "Year", width: 70, sortable: true, align: "end" }, { key: "tag", label: "Tag", width: 90 }],
						rows: [
							{ id: "r1", cells: [{ text: "Zeta paper" }, { text: "2019", sortValue: 2019 }, { content: { type: "badge", label: "new", tone: "success" } }] },
							{ id: "r2", cells: [{ text: "Alpha paper", bold: true }, { text: "2024", sortValue: 2024 }, { text: "old", color: "muted-foreground" }] },
							{ id: "r3", cells: [{ text: "Mid paper", icon: "file" }, { text: "2021", sortValue: 2021 }, { text: "" }] },
						] },
					{ type: "table", key: "vt", selection: "single", style: { height: "150px" }, rows: { count: 5000, rowHeight: 26, overscan: 10 }, columns: [{ key: "n", label: "#", width: 70 }, { key: "name", label: "Virtual row (pulled on demand)", flex: 1 }] },
					{ type: "table", key: "tree", tree: true, columns: [{ key: "name", label: "Tree", flex: 1 }], rows: [
						{ id: "t1", depth: 0, expandable: true, expanded: true, cells: [{ text: "Parent" }] }, { id: "t2", depth: 1, cells: [{ text: "Child A" }] }, { id: "t3", depth: 1, cells: [{ text: "Child B" }] },
						{ id: "t4", depth: 0, expandable: true, expanded: false, cells: [{ text: "Collapsed parent" }] }, { id: "t5", depth: 1, cells: [{ text: "Hidden child" }] },
					] },
				] },
				// ---- rich content
				{ type: "group", caption: "Rich content", children: [
					{ type: "rich-text", format: "markdown", source: "## Markdown\n\nSome **bold**, *italic* and `code`, a [link](https://example.org).\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |" },
					{ type: "rich-text", format: "html-subset", source: "<h3>HTML subset</h3><p>A <b>bold</b> word and a <a href=\"https://example.org\">link</a>.</p><script>alert(1)</script><ul><li>first</li><li>second</li></ul>" },
					{ type: "code", language: "ts", lineNumbers: true, copyButton: true, source: "export function add(a: number, b: number) {\n\treturn a + b;\n}" },
					{ type: "image", alt: "A picture", style: { width: "160px", height: "70px" }, source: { svg: "<svg xmlns='http://www.w3.org/2000/svg' width='160' height='70'><rect width='160' height='70' fill='#2b5fa8'/><circle cx='50' cy='35' r='22' fill='#f2b705'/><path d='M80 60 L110 15 L140 60 Z' fill='#c0532e'/></svg>" } },
					{ type: "canvas", key: "cv", width: 320, height: 120, panZoom: true, background: "muted", style: { width: "320px" }, on: { press: "canvas-press" }, ops: [
						{ op: "rect", x: 10, y: 10, width: 90, height: 50, cornerRadius: 6, style: { fill: "palette-blue", hit: "box-a", hoverTip: "Box A" } },
						{ op: "ellipse", cx: 160, cy: 40, rx: 38, ry: 28, style: { fill: { token: "palette-green", alpha: 200 }, stroke: { color: "foreground", width: 2 }, hit: "ellipse" } },
						{ op: "polyline", points: sparkline.flatMap((y, i) => [20 + i * 25, 110 - y]), style: { stroke: { color: "palette-rust", width: 2, roundCaps: true } } },
						{ op: "line", x1: 10, y1: 112, x2: 310, y2: 112, style: { stroke: { color: "border", width: 1, dashed: true } } },
						{ op: "path", d: "M 230 20 C 250 0, 290 0, 300 30 S 260 60, 230 50 Z", style: { fill: "palette-violet", hit: "blob" } },
						{ op: "text", x: 10, y: 80, text: "canvas text", size: "sm", color: "foreground" }, { op: "text", x: 310, y: 100, text: "end anchored", size: "xs", anchor: "end", color: "muted-foreground" },
					] },
				] },
				// ---- permission-gated
				{ type: "group", caption: "Gated by permissions", children: [
					{ type: "web-view", source: { html: "<h1>hi</h1>" }, sandbox: { scripts: false }, style: { height: "60px" } },
					{ type: "embed", component: "item-box", params: { item: "ABCD2345" } },
					{ type: "popover", open: false, children: [T("closed popover")] },
				] },
			],
			{ style: { direction: "column", gap: 3, padding: 3 } },
		),
	};
}

const render = () => ({ content: { tag: "json", val: JSON.stringify(tree()) } });
const handlers = {
	clicked: () => void (s.clicks++, info(`press btn clicks=${s.clicks}`)),
	typed: (e) => void ((s.typed = e.payload.val.val), info(`typed: ${s.typed}`)),
	committed: (e) => void ((s.committed = e.payload.val.val), info(`committed: ${s.committed}`)),
	checked: (e) => void ((s.checked = e.payload.val), info(`checked: ${s.checked}`)),
	radio: (e) => void ((s.radio = e.payload.val.val), info(`radio: ${s.radio}`)),
	pick: (e) => void ((s.pick = e.payload.val.val), info(`pick: ${s.pick}`)),
	slider: (e) => void ((s.slider = e.payload.val.val), info(`slider: ${s.slider}`)),
	tokens: (e) => void ((s.tokens = e.payload.val.val), info(`tokens: ${s.tokens.join(",")}`)),
	tab: (e) => void ((s.tab = e.payload.val), info(`tab: ${s.tab}`)),
	"toggle-pressed": () => void (s.pressed = !s.pressed),
	"table-sort": (e) => void ((s.sort = e.payload.val), info(`sort: ${s.sort.column} ${s.sort.direction}`)),
	"table-select": (e) => void info(`table-select: ${e.payload.val.join(",")}`),
	"list-select": (e) => void ((s.selected = e.payload.val), info(`list-select: ${s.selected.join(",")}`)),
	"canvas-press": (e) => void info(`canvas-press hit=${e.payload.val.hit ?? "none"}`),
	submitted: (e) => void ((s.submitted = e.payload.val.map((f) => `${f.name}=${f.value.val}`).join(";")), info(`submitted: ${s.submitted}`)),
	m1: () => void info("menu m1"),
	m2: () => void info("menu m2"),
	m3: () => void info("menu m3"),
	"sec-btn": () => void info("section button"),
	toast: () => {
		const id = ui.showToast({ title: plain("Fixture toast"), lines: [{ text: plain("Working on it"), progress: 0.5, tone: "info" }], tone: "success", durationMs: undefined, actions: [{ id: "toast-ok", label: plain("Got it") }] });
		info(`toast shown ${id}`);
	},
	"toast-ok": () => void info("toast action"),
	dialog: () => {
		// a dialog opened from inside an event handler: the plugin is suspended here while the dialog is open, and the dialog's own
		// events (button presses, input) are delivered to this same instance meanwhile
		const r = ui.runDialog({
			title: plain("Fixture dialog"), buttons: [{ id: "cancel", label: plain("Cancel"), role: "cancel", disabled: false, closes: true, isDefault: false }, { id: "ok", label: plain("OK"), role: "accept", disabled: false, closes: true, isDefault: true }],
			resizable: false, modal: true, dismissOnEscape: true, width: 420,
			content: { rev: 1n, root: 0, styles: [], nodes: [
				{ children: [1, 2], kind: { tag: "box" }, props: props({ style: { direction: "column", gap: step(2) } }) },
				{ children: [], kind: { tag: "text", val: { kind: "body", runs: [run("Type a value, then press OK.")], selectable: true } }, props: props({}) },
				{ children: [], kind: { tag: "text-input", val: textInput("dlgtext") }, props: props({ name: "dlgtext", key: "dlgtext", events: [binding("input", "dlg-typed")] }) },
			] },
		});
		const v = r.values.map((f) => `${f.name}=${f.value.val}`).join(";");
		s.outcome = `${r.button ?? "dismissed"} ${v}`;
		info(`dialog outcome: ${s.outcome}`);
	},
	"dlg-typed": (e) => void info(`dialog typed: ${e.payload.val.val}`),
};

// ---- helpers to build typed (flat) WIT values for the dialog
const step = (n) => ({ tag: "step", val: n });
const run = (t) => ({ text: plain(t), bold: false, italic: false, underline: false, strike: false, mono: false });
const binding = (event, handler) => ({ event, handler, keys: [], preventDefault: false, stopPropagation: false });
const props = (o) => ({ class: [], style: {}, events: [], a11y: { hidden: false }, disabled: false, hidden: false, autoFocus: false, ...o });
const textInput = (value) => ({ value: "", placeholder: plain("Value"), kind: "text", look: "field", multiline: false, readOnly: false, selectOnFocus: false, clearButton: false, spellcheck: false });

export const lifecycle = {
	install() {},
	startup(data, why) { info(`ui-fixture startup ${data.id} why=${why}`); },
	shutdown() {},
	uninstall() {},
	mainWindowLoad() {},
	mainWindowUnload() {},
};

const dialogInstances = new Set();
export const uiEvents = {
	mount(instance, ctx) { info(`mount ${instance} surface=${ctx.surface} theme=${ctx.theme}`); if (ctx.surface === "dialog") { dialogInstances.add(String(instance)); return { content: { tag: "unchanged" } }; } return render(); },
	updateContext(instance, ctx) { info(`update-context ${instance} theme=${ctx.theme}`); return render(); },
	unmount(instance) { info(`unmount ${instance}`); },
	visibility(instance, visible) { info(`visibility ${instance} ${visible}`); },
	onEvent(instance, event) {
		const h = handlers[event.handler];
		info(`on-event ${event.kind} ${event.handler} node=${event.nodeKey ?? "-"} inst=${instance}`);
		if (h) h(event);
		return dialogInstances.has(String(instance)) ? { content: { tag: "unchanged" } } : render();
	},
	resync() { return render(); },
	renderRange(instance, req) {
		info(`render-range ${req.nodeKey} ${req.start}+${req.count}${req.sort ? " sort=" + req.sort.column : ""}`);
		const rows = [];
		for (let i = req.start; i < req.start + req.count; i++) {
			rows.push({ id: "v" + i, depth: 0, expandable: false, expanded: false, disabled: false, cells: [{ text: plain(String(i)), bold: false }, { text: plain("Virtual row " + i), bold: false }] });
		}
		return { start: req.start, rows, nodes: [], styles: [] };
	},
	suggest() { return []; },
};
