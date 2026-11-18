// QuickJS test plugin for the extend area (gpui-ui/test/wasm-extend*.ts, gpui-ui/scripts/shot-wasm-extend.tsx).
// Registers a section, an info row, a column, a row style, a menu item (item list + Tools menu of the menubar), a toolbar button, a
// shortcut and a preference pane; every callback logs what it got, so a test can see that a click reached the plugin.
import log from "zinc:plugin/log@0.1.0";
import extend from "zinc:plugin/extend@0.1.0";

const info = (m) => log.write("info", m);
const plain = (s) => ({ tag: "plain", val: s });
const icon = (name) => ({ light: { tag: "builtin", val: name } });

const reg = (name, arg) => {
	try {
		extend[name](arg);
	} catch (e) {
		info(`FAILED ${name}: ${e && e.payload ? JSON.stringify(e.payload) : e}`);
	}
};

export const lifecycle = {
	install() {},
	startup(data, why) {
		info(`startup ${data.id} why=${why}`);
		reg("registerSection", {
			paneId: "sec1",
			header: { label: plain("Fixture section"), icon: icon("star") },
			sidenav: { label: plain("Fixture"), icon: icon("star"), orderable: true },
			buttons: [{ id: "b1", icon: icon("zap"), hidden: false, disabled: false }],
			defaultOpen: true,
			decidesEnabled: false,
		});
		reg("registerInfoRow", { rowId: "row1", label: plain("Fixture row"), position: "end", multiline: false, nowrap: false, editable: false });
		reg("registerColumn", { dataKey: "len", label: plain("Fixture len"), trees: [], sort: "text", sortReverse: false, fixedWidth: false, staticWidth: false, noPadding: false, align: "end", showInPicker: true, pickerSubmenu: false, flex: 1 });
		reg("registerRowStyle", { styleId: "rs", trees: [], priority: 0 });
		reg("registerMenu", {
			menuId: "m1",
			target: "library-item",
			entries: [{ id: "hello", kind: "item", label: plain("Fixture: say hello"), hooks: {} }],
		});
		reg("registerMenu", {
			menuId: "m2",
			target: "menubar-tools",
			entries: [{ id: "tools-hello", kind: "item", label: plain("Fixture tools entry"), hooks: {} }],
		});
		reg("registerToolbarButton", {
			buttonId: "tb1",
			slot: "library-toolbar",
			icon: icon("zap"),
			tooltip: plain("Fixture button"),
			menu: [],
			order: 0,
		});
		reg("registerShortcut", { shortcutId: "sc1", label: plain("Fixture shortcut"), defaultAccelerator: "Ctrl+Alt+J", scope: "global", inCommandSearch: false });
		reg("registerPrefPane", {
			paneId: "pane1",
			label: plain("Fixture"),
			order: 0,
			content: { tag: "rows", val: [{ id: "r1", keywords: [], label: plain("Fixture switch"), control: { tag: "toggle", val: "fixture.on" } }] },
			openCloseHooks: false,
		});
		reg("subscribeEvents", { selectionChanged: true, tabChanged: true });
	},
	shutdown() {},
	uninstall() {},
	mainWindowLoad() {},
	mainWindowUnload() {},
};

export const extendHandlers = {
	onMenuShowing() {
		return [];
	},
	onMenuPhase() {},
	onMenuCommand(menuId, entryId, checked, ctx) {
		info(`menu-command ${menuId}/${entryId} items=${ctx.items.length} tab=${ctx.tab.kind}`);
	},
	onToolbarClick(buttonId, toggled, ctx) {
		info(`toolbar-click ${buttonId} tab=${ctx.tab.kind}`);
	},
	onShortcut(id, ctx) {
		info(`shortcut ${id}`);
	},
	onInfoRowGet(rowId, item) {
		return { value: `row ${rowId} of ${item}`, enabled: true, editable: false };
	},
	onInfoRowSet() {},
	onColumnValues(dataKey, keys) {
		info(`column-values ${dataKey} n=${keys.length}`);
		return keys.map((k) => ({ body: { tag: "text", val: `len ${k.length}` }, style: "normal" }));
	},
	onRowStyles(styleId, keys) {
		info(`row-styles ${styleId} n=${keys.length}`);
		return keys.map(() => undefined);
	},
	onCollectionDecorations(id, rows) {
		return rows.map(() => undefined);
	},
	onVirtualCollectionItems() {
		return { keys: [], total: 0 };
	},
	onPrefPaneOpen() {},
	onPrefPaneClose() {},
	onPrefAction() {},
	onTabClosing() {
		return true;
	},
	onTabRestore() {
		return true;
	},
	onBannerAction() {},
	onDrop() {
		return "ignored";
	},
	onDragFormat() {
		return "";
	},
	onEvent(ev) {
		info(`event ${ev.tag}`);
	},
};
