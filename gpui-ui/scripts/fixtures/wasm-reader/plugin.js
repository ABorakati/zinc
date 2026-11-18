// QuickJS test plugin for gpui-ui/scripts/shot-wasm-reader.tsx. It registers every reader extension point, logs ("ZEV ...") every
// callback it gets, and runs the `annotations` / `reader` / `note-editor` calls the script asks for through `on-overlay-click`
// (the script sends command names such as "ann-create"; the results are logged).
import log from "zinc:plugin/log@0.1.0";
import reader from "zinc:plugin/reader@0.1.0";
import annotations from "zinc:plugin/annotations@0.1.0";
import noteEditor from "zinc:plugin/note-editor@0.1.0";

const say = (m) => log.write("info", "ZEV " + m);
const plain = (v) => ({ tag: "plain", val: v });
const flags = { showing: false, shown: false, hiding: false, hidden: false };
const entry = (id, label, extra) =>
	Object.assign(
		{ id, parent: undefined, kind: "item", label: plain(label), icon: undefined, swatch: undefined, check: undefined, accelerator: undefined, visibleWhen: undefined, enabledWhen: undefined, hooks: flags },
		extra || {},
	);
const listener = (id, target, staticMenu) => reader.registerListener({ id, target, readerKinds: [], staticMenu: staticMenu || [] });
const slot = (id, kind) => listener(id, { tag: "slot", val: kind });
const menu = (id, kind, staticMenu) => listener(id, { tag: "menu", val: kind }, staticMenu);

let lastKey = "";
const ref = (rdr) => ({ library: 1, key: rdr.attachment.key });
const loc = (o) => Object.assign({}, o);

export const lifecycle = {
	install() {},
	startup() {
		say("startup");
		slot("tb", "toolbar");
		slot("popup", "text-selection-popup");
		slot("hdr", "sidebar-annotation-header");
		menu("m-ann", "annotation"); // dynamic: build-menu
		menu("m-thumb", "thumbnail"); // dynamic
		menu("m-view", "view", [entry("view-item", "ZEV view item")]); // static
		menu("m-color", "color", [entry("color-item", "ZEV color item", { swatch: { tag: "rgba", val: 0x2ea8e5ff } })]);
		menu("m-sel", "selector", [entry("sel-item", "ZEV selector item")]);
		menu("m-theme", "theme", [entry("theme-item", "ZEV theme item")]);
		reader.registerPanel({ id: "zev-panel", placement: "sidebar-tab", label: plain("ZEV panel"), icon: { tag: "builtin", val: "puzzle" }, readerKinds: [] });
		reader.registerOverlay({ id: "ov", readerKinds: [] });
		reader.registerLinkInterceptor({ id: "lk", internal: true, external: true });
		reader.subscribe(["opened", "closed", "page-changed", "selection-changed", "annotations-selected", "annotations-changed", "tool-changed", "view-state-changed"]);
		noteEditor.subscribeNoteEvents(["editor-opened", "editor-closed", "note-saved"]);
		noteEditor.registerHead("note-head");
	},
	shutdown() {
		say("shutdown");
	},
	uninstall() {},
	mainWindowLoad() {},
	mainWindowUnload() {},
};

export const readerEvents = {
	buildMenu(listenerId, ctx) {
		const p = ctx.params;
		let d = "";
		if (p.tag === "annotation") d = " " + p.val.annotations[0].key + " " + p.val.annotations[0].kind;
		if (p.tag === "thumbnail") d = " pages=" + p.val.join(",");
		say("build-menu " + listenerId + " " + p.tag + d + " reader=" + ctx.reader.id);
		return [entry(listenerId === "m-ann" ? "ann-item" : "thumb-item", listenerId === "m-ann" ? "ZEV annotation item" : "ZEV thumbnail item")];
	},
	onMenuCommand(listenerId, command, ctx) {
		const p = ctx.params;
		let d = "";
		if (p.tag === "annotation") d = " " + p.val.current;
		if (p.tag === "thumbnail") d = " pages=" + p.val.join(",");
		say("menu-command " + listenerId + " " + command + d);
	},
	renderOverlay(listenerId, rdr, pageIndex) {
		say("render-overlay " + listenerId + " page=" + pageIndex);
		return [{ kind: "fill", rects: [[72, 640, 300, 660]], color: "#ff0000", opacity: 0.3, tooltip: "ZEV box", command: "overlay-hit" }];
	},
	onLink(listenerId, ctx) {
		say("link " + listenerId + " " + ctx.target.tag + " page=" + ctx.pageIndex + (ctx.target.tag === "uri" ? " " + ctx.target.val : ""));
	},
	onReaderEvent(ev) {
		const v = ev.val;
		let d = "";
		switch (ev.tag) {
			case "opened":
			case "closed":
			case "tab-selected":
				d = v.id + " " + v.kind;
				break;
			case "page-changed":
				d = "page=" + v.pageIndex + " label=" + v.pageLabel;
				break;
			case "selection-changed":
				d = v.selection ? "text=" + v.selection.text.slice(0, 24) : "cleared";
				break;
			case "annotations-selected":
				d = "keys=" + v.keys.join(",");
				break;
			case "annotations-changed":
				d = "added=" + v.added.length + " modified=" + v.modified.length + " removed=" + v.removed.length + " by=" + v.byThisPlugin;
				break;
			case "tool-changed":
				d = v.tool.kind;
				break;
			case "view-state-changed":
				d = v;
				break;
		}
		say("event " + ev.tag + " " + d);
	},
	onOverlayClick(listenerId, rdr, page, command) {
		if (listenerId !== "ov" || command === "overlay-hit") return void say("overlay-click " + command + " page=" + page);
		try {
			run(rdr, command);
		} catch (e) {
			say("ERR " + command + " " + (e && e.payload ? e.payload.tag + ":" + e.payload.val : e));
		}
	},
};

function run(rdr, command) {
	const [name, arg] = command.split(":");
	switch (name) {
		case "state": {
			const s = reader.getState(rdr.id);
			say("state page=" + s.primary.pageIndex + " pages=" + s.primary.pagesCount + " zoom=" + s.primary.zoom.toFixed(2) + " tool=" + s.tool.kind + " sidebar=" + s.sidebar.open + ":" + s.sidebar.view + " find=" + s.find.query);
			break;
		}
		case "readers": {
			const l = reader.listReaders();
			say("readers n=" + l.length + " first=" + (l[0] ? l[0].id : "none") + " selected=" + (reader.selectedReader(undefined) || {}).id);
			break;
		}
		case "selection": {
			const sel = reader.getSelection(rdr.id);
			say("selection " + (sel ? "text=" + sel.text.slice(0, 30) + " rects=" + sel.draft.position.rects.length + " kind=" + sel.draft.kind : "none"));
			break;
		}
		case "navigate":
			reader.navigate(rdr.id, loc({ pageIndex: Number(arg) }), { skipHistory: false });
			say("navigate " + arg);
			break;
		case "step":
			reader.navigateStep(rdr.id, arg);
			say("step " + arg);
			break;
		case "zoom-in":
			reader.runCommand(rdr.id, "zoom-in");
			say("zoom-in");
			break;
		case "tool":
			reader.setTool(rdr.id, { kind: arg, color: "#5fb236" });
			say("tool " + arg);
			break;
		case "sidebar":
			reader.setSidebar(rdr.id, true, arg, undefined);
			say("sidebar " + arg);
			break;
		case "find": {
			const f = reader.find(rdr.id, { action: "start", query: arg, caseSensitive: false, entireWord: false, highlightAll: true });
			say("find " + f.query + " active=" + f.active);
			break;
		}
		case "ann-create": {
			const r = annotations.createAnnotations(ref(rdr), [
				{ kind: "highlight", color: "#2ea8e5", text: "ZEV created", comment: "made by plugin", position: { pageIndex: 0, rects: [[72, 700, 200, 712]], nextPageRects: [], paths: [] }, tags: ["zev"], isExternal: false },
			]);
			lastKey = r[0].key;
			say("created n=" + r.length + " key=" + lastKey + " color=" + r[0].color + " sort=" + r[0].sortIndex + " label=" + r[0].pageLabel);
			break;
		}
		case "ann-list": {
			const l = annotations.listAnnotations(ref(rdr));
			say("list n=" + l.length + " kinds=" + l.map((a) => a.kind).join(","));
			break;
		}
		case "ann-get": {
			const a = annotations.getAnnotations([{ library: 1, key: lastKey }]);
			say("get " + (a[0] ? "comment=" + a[0].comment + " tags=" + a[0].tags.map((t) => t.name).join(",") : "none"));
			break;
		}
		case "ann-update": {
			const r = annotations.updateAnnotations(1, [{ key: lastKey, comment: "updated by plugin", color: "#ff6666" }]);
			say("updated comment=" + r[0].comment + " color=" + r[0].color);
			break;
		}
		case "ann-delete":
			annotations.removeAnnotations(1, [lastKey]);
			say("deleted " + lastKey);
			break;
		case "ann-colors":
			say("colors n=" + annotations.annotationColors().length + " first=" + annotations.annotationColors()[0].hex);
			break;
		case "ann-image": {
			const b = annotations.getAnnotationImage({ library: 1, key: lastKey });
			say("image " + (b ? b.length : "none"));
			break;
		}
		case "page-text": {
			const t = reader.getPageText(rdr.id, [Number(arg)], true);
			say("page-text len=" + t[0].text.length + " words=" + t[0].words.length + " first=" + (t[0].words[0] ? t[0].words[0].text : "-") + " w=" + Math.round(t[0].width));
			break;
		}
		case "render": {
			const r = reader.renderPage(rdr.id, Number(arg), 0.5, undefined);
			say("render " + r.width + "x" + r.height + " bytes=" + r.bytes.length + " png=" + (r.bytes[1] === 0x50 && r.bytes[2] === 0x4e));
			break;
		}
		case "outline":
			say("outline n=" + reader.getOutline(rdr.id).length);
			break;
		case "labels":
			say("labels " + reader.getPageLabels(rdr.id).slice(0, 3).join(","));
			break;
		case "themes":
			say("themes " + reader.listThemes().map((t) => t.id).join(","));
			reader.setThemeChoice({ light: "sepia", dark: "dark" });
			break;
		case "serialize": {
			const s = noteEditor.serializeAnnotations([{ library: 1, key: lastKey }], { skipEmbeddingItemData: false });
			say("serialized len=" + s.html.length + " has=" + s.html.includes("ZEV created"));
			break;
		}
		case "editors":
			say("editors n=" + noteEditor.listEditors().length + " active=" + (noteEditor.activeEditor(undefined) ? "yes" : "none"));
			break;
		case "open-note":
			noteEditor.openNote({ note: { library: 1, key: "AAAAAAAA" }, background: false, inWindow: false, allowDuplicate: false });
			break;
		case "invalidate":
			reader.invalidate("ov", undefined);
			say("invalidated");
			break;
		case "unregister":
			reader.unregister(arg);
			say("unregistered " + arg);
			break;
		case "close":
			reader.close(rdr.id);
			break;
		default:
			say("unknown command " + command);
	}
}

export const noteEvents = {
	onNoteEvent(ev) {
		say("note-event " + ev.tag);
	},
};

const label = (ctx) => {
	const p = JSON.parse(ctx.params);
	if (p.slot === "toolbar") return "toolbar";
	if (p.slot === "sidebar-annotation-header") return "hdr " + p.annotation.kind;
	if (p.slot === "text-selection-popup") return "sel: " + String((p.selection && p.selection.text) || "").slice(0, 24);
	if (p.slot === "panel") return "panel";
	return p.slot;
};
const render = (ctx) => ({ content: { tag: "json", val: JSON.stringify({ root: { type: "text", text: "ZEV " + label(ctx) } }) }, meta: undefined, focus: undefined });
export const uiEvents = {
	mount(instance, ctx) {
		say("mount " + ctx.view + " surface=" + ctx.surface + " slot=" + JSON.parse(ctx.params).slot + " reader=" + (JSON.parse(ctx.params).reader || {}).id);
		return render(ctx);
	},
	updateContext(instance, ctx) {
		say("update " + ctx.view);
		return render(ctx);
	},
	unmount(instance) {
		say("unmount");
	},
	visibility() {},
	onEvent() {
		return { content: { tag: "unchanged" }, meta: undefined, focus: undefined };
	},
	resync(instance) {
		return { content: { tag: "unchanged" }, meta: undefined, focus: undefined };
	},
	renderRange() {
		return { start: 0, rows: [], styles: undefined, total: undefined };
	},
	suggest() {
		return [];
	},
};
