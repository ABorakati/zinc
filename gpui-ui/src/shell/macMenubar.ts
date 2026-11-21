// Native macOS system menubar (AppKit NSMenu via libobjc + bun:ffi).
//
// Preserves the application menu (item 0, installed by GPUIX for Hide/Quit) and appends File / Edit / View / Go / Tools / Help
// backed by Chrome.tsx's `menubarItems()`. Each top-level menu uses an NSMenuDelegate (`menuNeedsUpdate:`) so items, checkmarks,
// registered features and plugin menu entries are rebuilt fresh every time a menu opens.
//
// All ObjC pointers and selectors travel as u64 (BigInt): on arm64 macOS, short NSStrings ("Go", "File", ",") are tagged pointers
// with bit 63 set, which FFIType.ptr (JS number) would corrupt and crash Bun.
import { CString, dlopen, FFIType, JSCallback, linkSymbols } from "bun:ffi";
import type { MenuItem } from "../ui";
import { MENUS, menubarItems, type MenubarName } from "../wasmplugins/extend/Chrome";
import { buildContext } from "../wasmplugins/extend/context";
import { menuShowing } from "../wasmplugins/extend/menus";
import type { MenuTarget } from "../wasmplugins/extend/wit";
import { parseChord } from "./shortcuts";

const { ptr: P, i64: I64, u64: U64, bool: B, void: V } = FFIType;

/** AppKit NSEventModifierFlags bits used by NSMenuItem.keyEquivalentModifierMask. */
export const MAC_MOD = {
	shift: 1 << 17,
	control: 1 << 18,
	option: 1 << 19,
	command: 1 << 20,
} as const;

// Text-editing shortcuts handled by focused GPUI inputs: never bind them as AppKit key equivalents, because [NSApp mainMenu]
// runs performKeyEquivalent: before NSView.keyDown: and would steal Cmd+A / Cmd+C / Cmd+V / Cmd+X / Cmd+Z from text fields.
const EDITING_KEYS = new Set([
	"a",
	"c",
	"v",
	"x",
	"z",
	"backspace",
	"delete",
	"left",
	"right",
	"up",
	"down",
	"tab",
	"enter",
	"escape",
	" ",
]);

export interface MacShortcut {
	key: string;
	mask: number;
}

/**
 * Convert a Zinc shortcut string (e.g. "Ctrl+,", "Ctrl+Shift+K") into an AppKit NSMenuItem key equivalent + modifier mask,
 * or null when it cannot/should not be bound as a native menu key equivalent (e.g. plain Cmd+A which would steal text selection).
 */
export function parseMacShortcut(shortcut?: string): MacShortcut | null {
	if (!shortcut) return null;
	const chord = parseChord(shortcut);
	if (!chord || !chord.key) return null;
	// Only bind single printable characters as keyEquivalent (avoid function/nav keys and text-editing chords)
	if (chord.key.length !== 1) return null;
	if (chord.ctrl && !chord.shift && !chord.alt && EDITING_KEYS.has(chord.key)) return null;
	let mask = 0;
	if (chord.ctrl) mask |= MAC_MOD.command;
	if (chord.shift) mask |= MAC_MOD.shift;
	if (chord.alt) mask |= MAC_MOD.option;
	if (!mask) return null;
	return { key: chord.key, mask };
}

type Obj = bigint;
interface MacObjc {
	m0(o: Obj, s: Obj): Obj;
	m1(o: Obj, s: Obj, a: Obj): Obj;
	m1p(o: Obj, s: Obj, a: Buffer): Obj;
	m3(o: Obj, s: Obj, a: Obj, b: Obj, c: Obj): Obj;
	mi(o: Obj, s: Obj, n: number | bigint): void;
	mu(o: Obj, s: Obj, n: number | bigint): Obj;
	b0(o: Obj, s: Obj): boolean;
	s0(o: Obj, s: Obj): number | bigint | null;
	cls(name: string): Obj;
	sel(name: string): Obj;
	str(text: string): Obj;
	allocClassPair(sup: Obj, name: string): Obj;
	addMethod(cls: Obj, sel: Obj, imp: unknown, types: string): boolean;
	registerClassPair(cls: Obj): void;
}

const cs = (s: string) => Buffer.from(`${s}\0`, "utf8");
let rt: MacObjc | null | undefined;

function loadMacObjc(): MacObjc | null {
	if (rt !== undefined) return rt;
	if (process.platform !== "darwin") return (rt = null);
	try {
		const sys = dlopen("/usr/lib/libSystem.B.dylib", {
			dlsym: { args: [I64, P], returns: P },
			dlopen: { args: [P, FFIType.i32], returns: P },
		}).symbols;
		sys.dlopen(cs("/System/Library/Frameworks/AppKit.framework/AppKit"), 2);
		const lib = dlopen("/usr/lib/libobjc.A.dylib", {
			objc_getClass: { args: [P], returns: U64 },
			sel_registerName: { args: [P], returns: U64 },
			objc_allocateClassPair: { args: [U64, P, U64], returns: U64 },
			class_addMethod: { args: [U64, U64, P, P], returns: B },
			objc_registerClassPair: { args: [U64], returns: V },
		}).symbols;
		const ptr = sys.dlsym(-2n, cs("objc_msgSend"));
		if (!ptr) return (rt = null);
		const send = linkSymbols({
			m0: { ptr, args: [U64, U64], returns: U64 },
			m1: { ptr, args: [U64, U64, U64], returns: U64 },
			m1p: { ptr, args: [U64, U64, P], returns: U64 },
			m3: { ptr, args: [U64, U64, U64, U64, U64], returns: U64 },
			mi: { ptr, args: [U64, U64, I64], returns: V },
			mu: { ptr, args: [U64, U64, U64], returns: U64 },
			b0: { ptr, args: [U64, U64], returns: B },
			s0: { ptr, args: [U64, U64], returns: P },
		}).symbols as unknown as Pick<MacObjc, "m0" | "m1" | "m1p" | "m3" | "mi" | "mu" | "b0" | "s0">;

		const classes = new Map<string, Obj>();
		const sels = new Map<string, Obj>();
		const cls = (n: string): Obj => {
			let c = classes.get(n);
			if (c === undefined) classes.set(n, (c = lib.objc_getClass(cs(n)) as Obj));
			return c;
		};
		const sel = (n: string): Obj => {
			let s = sels.get(n);
			if (s === undefined) sels.set(n, (s = lib.sel_registerName(cs(n)) as Obj));
			return s;
		};
		const nsStringCls = cls("NSString");
		const strSel = sel("stringWithUTF8String:");
		rt = {
			...send,
			cls,
			sel,
			str: (text) => send.m1p(nsStringCls, strSel, cs(text)),
			allocClassPair: (sup, name) => lib.objc_allocateClassPair(sup, cs(name), 0n) as Obj,
			addMethod: (c, s, imp, types) => Boolean(lib.class_addMethod(c, s, imp as never, cs(types))),
			registerClassPair: (c) => lib.objc_registerClassPair(c),
		};
	} catch {
		rt = null;
	}
	return rt;
}

// Module-scoped state kept alive for the lifetime of the process so AppKit never calls freed JSCallbacks.
let bridgeInstance: Obj = 0n;
let onNeedsUpdateCb: JSCallback | undefined;
let onActionCb: JSCallback | undefined;
let installedTopItems: Obj[] = [];
const menuByPtr = new Map<Obj, MenubarName>();
const actionsByTag = new Map<number, () => void>();
const menuTags = new Map<MenubarName, number[]>();
let nextTag = 1000;

export interface MacMenuHooks {
	getItems?: (m: MenubarName) => MenuItem[];
	onShowing?: (m: MenubarName) => void;
}
let activeHooks: MacMenuHooks = {};

function ensureBridge(o: MacObjc): Obj {
	if (bridgeInstance) return bridgeInstance;
	let cls = o.cls("ZNMacMenuBridge");
	if (!cls) {
		cls = o.allocClassPair(o.cls("NSObject"), "ZNMacMenuBridge");
		if (!cls) return 0n;
		onNeedsUpdateCb = new JSCallback(
			(_self: Obj, _cmd: Obj, menu: Obj) => {
				try {
					const id = menuByPtr.get(menu);
					if (!id) return;
					if (activeHooks.onShowing) activeHooks.onShowing(id);
					else void menuShowing(`menubar-${id}` as MenuTarget, buildContext());
					populateMenu(o, menu, id);
				} catch (e) {
					console.error("[mac-menubar] menuNeedsUpdate failed:", e instanceof Error ? e.message : e);
				}
			},
			{ args: [U64, U64, U64], returns: V },
		);
		onActionCb = new JSCallback(
			(_self: Obj, _cmd: Obj, sender: Obj) => {
				try {
					const tag = Number(o.m0(sender, o.sel("tag")));
					const fn = actionsByTag.get(tag);
					if (fn) fn();
				} catch (e) {
					console.error("[mac-menubar] menu action failed:", e instanceof Error ? e.message : e);
				}
			},
			{ args: [U64, U64, U64], returns: V },
		);
		o.addMethod(cls, o.sel("menuNeedsUpdate:"), onNeedsUpdateCb.ptr, "v@:@");
		o.addMethod(cls, o.sel("znMenuAction:"), onActionCb.ptr, "v@:@");
		o.registerClassPair(cls);
	}
	bridgeInstance = o.m0(o.m0(cls, o.sel("alloc")), o.sel("init"));
	return bridgeInstance;
}

function clearTagsFor(id: MenubarName): void {
	const old = menuTags.get(id);
	if (!old) return;
	for (const tag of old) actionsByTag.delete(tag);
	menuTags.delete(id);
}

function appendItems(o: MacObjc, menu: Obj, items: MenuItem[], owner: MenubarName, tags: number[]): void {
	const nsMenuCls = o.cls("NSMenu");
	const nsItemCls = o.cls("NSMenuItem");
	const selAlloc = o.sel("alloc");
	const selInitTitle = o.sel("initWithTitle:");
	const selInitItem = o.sel("initWithTitle:action:keyEquivalent:");
	const selSep = o.sel("separatorItem");
	const selAdd = o.sel("addItem:");
	const selSetAuto = o.sel("setAutoenablesItems:");
	const selSetSub = o.sel("setSubmenu:");
	const selSetTarget = o.sel("setTarget:");
	const selSetTag = o.sel("setTag:");
	const selSetEnabled = o.sel("setEnabled:");
	const selSetState = o.sel("setState:");
	const selSetMod = o.sel("setKeyEquivalentModifierMask:");
	const selAction = o.sel("znMenuAction:");
	const selRelease = o.sel("release");

	for (const it of items) {
		if (it.separator) {
			o.m1(menu, selAdd, o.m0(nsItemCls, selSep));
			continue;
		}
		if (it.heading) {
			const mi = o.m3(o.m0(nsItemCls, selAlloc), selInitItem, o.str(it.heading), 0n, o.str(""));
			o.mi(mi, selSetEnabled, 0);
			o.m1(menu, selAdd, mi);
			o.m0(mi, selRelease);
			continue;
		}
		const label = it.label ?? "";
		if (it.submenu?.length) {
			const mi = o.m3(o.m0(nsItemCls, selAlloc), selInitItem, o.str(label), 0n, o.str(""));
			const sub = o.m1(o.m0(nsMenuCls, selAlloc), selInitTitle, o.str(label));
			o.mi(sub, selSetAuto, 0);
			appendItems(o, sub, it.submenu, owner, tags);
			o.m1(mi, selSetSub, sub);
			o.m0(sub, selRelease);
			if (it.disabled) o.mi(mi, selSetEnabled, 0);
			o.m1(menu, selAdd, mi);
			o.m0(mi, selRelease);
			continue;
		}
		const sc = !it.disabled && it.onSelect ? parseMacShortcut(it.shortcut) : null;
		const mi = o.m3(o.m0(nsItemCls, selAlloc), selInitItem, o.str(label), it.onSelect ? selAction : 0n, o.str(sc?.key ?? ""));
		if (sc) o.mu(mi, selSetMod, BigInt(sc.mask));
		if (it.onSelect) {
			const tag = nextTag++;
			tags.push(tag);
			actionsByTag.set(tag, it.onSelect);
			o.m1(mi, selSetTarget, bridgeInstance);
			o.mi(mi, selSetTag, tag);
		}
		if (it.disabled || !it.onSelect) o.mi(mi, selSetEnabled, 0);
		if (it.checked) o.mi(mi, selSetState, 1); // NSControlStateValueOn
		o.m1(menu, selAdd, mi);
		o.m0(mi, selRelease);
	}
}

function populateMenu(o: MacObjc, menu: Obj, id: MenubarName): void {
	clearTagsFor(id);
	o.m0(menu, o.sel("removeAllItems"));
	const items = (activeHooks.getItems ?? menubarItems)(id);
	const tags: number[] = [];
	appendItems(o, menu, items, id, tags);
	menuTags.set(id, tags);
}

/**
 * Install the native macOS File / Edit / View / Go / Tools / Help menus into `[NSApp mainMenu]`, preserving the existing
 * application menu at index 0. Returns true on success (macOS only), false elsewhere or if AppKit is unavailable.
 */
export function installMacMenubar(hooks: MacMenuHooks = {}): boolean {
	try {
		const o = loadMacObjc();
		if (!o) return false;
		const bridge = ensureBridge(o);
		if (!bridge) return false;
		activeHooks = hooks;

		const app = o.m0(o.cls("NSApplication"), o.sel("sharedApplication"));
		if (!app) return false;
		const nsMenuCls = o.cls("NSMenu");
		const nsItemCls = o.cls("NSMenuItem");
		const selAlloc = o.sel("alloc");
		const selInitTitle = o.sel("initWithTitle:");
		const selInitItem = o.sel("initWithTitle:action:keyEquivalent:");
		const selAdd = o.sel("addItem:");
		const selSetSub = o.sel("setSubmenu:");

		let mainMenu = o.m0(app, o.sel("mainMenu"));
		if (!mainMenu) {
			mainMenu = o.m1(o.m0(nsMenuCls, selAlloc), selInitTitle, o.str(""));
			const appItem = o.m3(o.m0(nsItemCls, selAlloc), selInitItem, o.str("Zinc"), 0n, o.str(""));
			const appSub = o.m1(o.m0(nsMenuCls, selAlloc), selInitTitle, o.str("Zinc"));
			const quitItem = o.m3(o.m0(nsItemCls, selAlloc), selInitItem, o.str("Quit Zinc"), o.sel("terminate:"), o.str("q"));
			o.m1(appSub, selAdd, quitItem);
			o.m1(appItem, selSetSub, appSub);
			o.m1(mainMenu, selAdd, appItem);
			o.m1(app, o.sel("setMainMenu:"), mainMenu);
		}

		// Idempotent reinstall: drop any previously installed Zinc menus first
		for (const item of installedTopItems) {
			o.m1(mainMenu, o.sel("removeItem:"), item);
		}
		installedTopItems = [];
		for (const id of menuByPtr.values()) clearTagsFor(id);
		menuByPtr.clear();

		for (const m of MENUS) {
			const topItem = o.m3(o.m0(nsItemCls, selAlloc), selInitItem, o.str(m.label), 0n, o.str(""));
			const sub = o.m1(o.m0(nsMenuCls, selAlloc), selInitTitle, o.str(m.label));
			o.mi(sub, o.sel("setAutoenablesItems:"), 0);
			o.m1(sub, o.sel("setDelegate:"), bridge);
			menuByPtr.set(sub, m.id);
			populateMenu(o, sub, m.id);
			o.m1(topItem, selSetSub, sub);
			o.m0(sub, o.sel("release"));
			o.m1(mainMenu, selAdd, topItem);
			o.m0(topItem, o.sel("release"));
			installedTopItems.push(topItem);
			if (m.id === "help") o.m1(app, o.sel("setHelpMenu:"), sub);
		}
		return true;
	} catch (e) {
		console.error("[mac-menubar] install failed:", e instanceof Error ? e.message : e);
		return false;
	}
}

/** Tests (macOS only): read the titles currently in `[NSApp mainMenu]`. */
export function readMacMainMenuTitles(): string[] {
	const o = loadMacObjc();
	if (!o) return [];
	const app = o.m0(o.cls("NSApplication"), o.sel("sharedApplication"));
	const mainMenu = app ? o.m0(app, o.sel("mainMenu")) : 0n;
	if (!mainMenu) return [];
	const count = Number(o.m0(mainMenu, o.sel("numberOfItems")));
	const out: string[] = [];
	for (let i = 0; i < count; i++) {
		const item = o.mu(mainMenu, o.sel("itemAtIndex:"), BigInt(i));
		const title = item ? o.m0(item, o.sel("title")) : 0n;
		const cstr = title ? o.s0(title, o.sel("UTF8String")) : null;
		if (cstr) out.push(new CString(cstr as never).toString());
	}
	return out;
}

/** Tests (macOS only): trigger `menuNeedsUpdate:` on a named top-level menu and return its item titles, optionally invoking one. */
export function inspectMacSubmenu(menuTitle: string, invokeTitle?: string): string[] {
	const o = loadMacObjc();
	if (!o) return [];
	const app = o.m0(o.cls("NSApplication"), o.sel("sharedApplication"));
	const mainMenu = app ? o.m0(app, o.sel("mainMenu")) : 0n;
	if (!mainMenu) return [];
	const topItem = o.m1(mainMenu, o.sel("itemWithTitle:"), o.str(menuTitle));
	const sub = topItem ? o.m0(topItem, o.sel("submenu")) : 0n;
	if (!sub) return [];
	const delegate = o.m0(sub, o.sel("delegate"));
	if (delegate) o.m1(delegate, o.sel("menuNeedsUpdate:"), sub);
	const count = Number(o.m0(sub, o.sel("numberOfItems")));
	const out: string[] = [];
	for (let i = 0; i < count; i++) {
		const item = o.mu(sub, o.sel("itemAtIndex:"), BigInt(i));
		if (!item) continue;
		if (o.b0(item, o.sel("isSeparatorItem"))) {
			out.push("---");
			continue;
		}
		const title = o.m0(item, o.sel("title"));
		const cstr = title ? o.s0(title, o.sel("UTF8String")) : null;
		const text = cstr ? new CString(cstr as never).toString() : "";
		out.push(text);
		if (invokeTitle && text === invokeTitle) {
			const target = o.m0(item, o.sel("target"));
			const action = o.m0(item, o.sel("action"));
			if (target && action) o.m1(target, action, item);
		}
	}
	return out;
}
