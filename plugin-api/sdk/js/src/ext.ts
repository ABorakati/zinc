// Registration helpers for the `extend` and `reader` imports. They fill in the fields a plugin rarely sets, in the typed
// (variant-tagged) form those imports use. Text here is `{ tag: "plain", val }`, built by `plain()` / `localized()`.
import type { Text } from "./ui";
import { plainText } from "./ui";
import { fill } from "./defaults";

export const plain = (s: string) => ({ tag: "plain" as const, val: s });
export const localized = (id: string, args?: Record<string, string | number>, fallback?: string) => plainText({ id, args, fallback });
const t = (x: Text | { tag: string }) => (typeof x === "object" && "tag" in x ? x : plainText(x as Text));

/** A built-in (Lucide) icon, the same in light and dark. */
export const icon = (name: string) => ({ light: { tag: "builtin", val: name }, dark: undefined });

export interface ConditionDef {
	tabKinds?: string[];
	minItems?: number;
	maxItems?: number;
	itemTypes?: string[];
	rowKinds?: string[];
	requireEditable?: boolean;
}
export const when = (c: ConditionDef = {}) =>
	fill("extend/Condition", {
		tabKinds: c.tabKinds ?? [],
		minItems: c.minItems,
		maxItems: c.maxItems,
		itemTypes: c.itemTypes ?? [],
		rowKinds: c.rowKinds ?? [],
		requireEditable: !!c.requireEditable,
	});

export interface EntryDef {
	parent?: string;
	icon?: string;
	check?: boolean;
	accelerator?: string;
	visibleWhen?: ConditionDef;
	enabledWhen?: ConditionDef;
	showing?: boolean;
	shown?: boolean;
	hiding?: boolean;
	hidden?: boolean;
}
/** A menu entry. `kind`: "item" | "separator" | "submenu". */
export function entry(id: string, label: Text | undefined, o: EntryDef = {}, kind: "item" | "separator" | "submenu" = "item") {
	return fill<{ id: string }>("extend/MenuEntry", {
		id,
		parent: o.parent,
		kind,
		label: label === undefined ? undefined : t(label),
		icon: o.icon ? icon(o.icon) : undefined,
		check: o.check,
		accelerator: o.accelerator,
		visibleWhen: o.visibleWhen ? when(o.visibleWhen) : undefined,
		enabledWhen: o.enabledWhen ? when(o.enabledWhen) : undefined,
		hooks: { showing: !!o.showing, shown: !!o.shown, hiding: !!o.hiding, hidden: !!o.hidden },
	});
}
export const separator = (id: string, o: EntryDef = {}) => entry(id, undefined, o, "separator");
export const submenu = (id: string, label: Text, o: EntryDef = {}) => entry(id, label, o, "submenu");

/** `extend.registerMenu` argument. `target` is a `menu-target` such as "library-item". */
export const menu = (menuId: string, target: string, entries: ReturnType<typeof entry>[]) => fill("extend/MenuRegistration", { menuId, target, entries });

/** An item list column; values come from `extendHandlers.onColumnValues(dataKey, keys)`. */
export function column(dataKey: string, label: Text, o: Partial<Record<string, unknown>> = {}) {
	return fill("extend/ColumnRegistration", {
		dataKey,
		label: t(label),
		trees: ["item-tree-main-default"],
		sort: "number",
		sortReverse: false,
		fixedWidth: false,
		staticWidth: false,
		noPadding: false,
		align: "end",
		showInPicker: true,
		pickerSubmenu: false,
		width: 90,
		...o,
	});
}

/** An item pane section; its body is a view, `uiEvents.mount(instance, ctx)` with `ctx.view === paneId`. */
export function section(paneId: string, label: Text, iconName: string, o: Partial<Record<string, unknown>> = {}) {
	return fill("extend/SectionRegistration", {
		paneId,
		header: { label: t(label), icon: icon(iconName) },
		sidenav: { label: t(label), icon: icon(iconName), orderable: true },
		buttons: [],
		defaultOpen: true,
		decidesEnabled: false,
		...o,
	});
}

export const settingToggle = (id: string, label: Text, pref: string) => setting(id, label, { tag: "toggle", val: pref });
export const settingText = (id: string, label: Text, pref: string, o: { secret?: boolean; multiline?: boolean } = {}) =>
	setting(id, label, { tag: "text", val: { pref, secret: !!o.secret, multiline: !!o.multiline } });
export const settingNumber = (id: string, label: Text, pref: string, o: { min?: number; max?: number; step?: number } = {}) =>
	setting(id, label, { tag: "number", val: { pref, ...o } });
export function setting(id: string, label: Text, control: { tag: string; val?: unknown }) {
	return fill("extend/SettingRow", { id, label: t(label), keywords: [], control });
}
export const prefPane = (paneId: string, label: Text, rows: ReturnType<typeof setting>[]) =>
	fill("extend/PrefPaneRegistration", {
		paneId,
		label: t(label),
		order: 0,
		content: { tag: "rows", val: rows },
		openCloseHooks: false,
	});

/** `reader.registerListener` argument: a toolbar slot, or a menu (`{ tag: "menu", val: "annotation" }`). */
export function readerListener(id: string, target: { tag: "slot"; val: "toolbar" | "text-selection-popup" | "sidebar-annotation-header" } | { tag: "menu"; val: string }, staticMenu: ReturnType<typeof entry>[] = []) {
	return fill("reader/ListenerRegistration", { id, target, readerKinds: ["pdf", "epub"], staticMenu });
}

/** A `library.apply` change: `change("add-tags", { items: [...], tags: [{ name, kind: "manual" }] })`. */
export const change = (tag: string, val: unknown) => ({ tag, val });
