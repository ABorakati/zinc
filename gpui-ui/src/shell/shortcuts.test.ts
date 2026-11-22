// bun test src/shell/shortcuts.test.ts -- chords, the user's rebinding (bindings.ts) and the window key handler that honours it.
process.env.ZN_UI_STATE = "off"; // never touch the user's ui-state.json
import { beforeEach, describe, expect, test } from "bun:test";
import { registerAppAction } from "../registry";
import { effectiveShortcut, isCustomised, resetAllShortcuts, resetShortcut, setShortcut, shortcutOverrides } from "./bindings";
import {
	actionShortcut,
	canonicalChord,
	chordFromEvent,
	displayShortcut,
	handleWindowKeyDown,
	isBindable,
	matchesChord,
	shortcutUsers,
} from "./shortcuts";

const ran: string[] = [];
registerAppAction({ id: "t.quick", label: "Quick", menu: "none", shortcut: "Ctrl+Shift+K", run: () => ran.push("quick") });
registerAppAction({ id: "t.other", label: "Other", menu: "none", shortcut: "Ctrl+Shift+J", run: () => ran.push("other") });
registerAppAction({ id: "t.none", label: "Unbound", menu: "none", run: () => ran.push("none") });

const press = (key: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) =>
	handleWindowKeyDown({ key, modifiers: mods, defaultPrevented: false, preventDefault() {} } as never);

beforeEach(() => {
	resetAllShortcuts();
	ran.length = 0;
});

describe("chords", () => {
	test("canonical form: Ctrl, Alt, Shift, then the key", () => {
		expect(canonicalChord("shift+ctrl+k")).toBe("Ctrl+Shift+K");
		expect(canonicalChord("Alt+Shift+Ctrl+I")).toBe("Ctrl+Alt+Shift+I");
		expect(canonicalChord("ctrl+pagedown")).toBe("Ctrl+PageDown");
		expect(canonicalChord("Ctrl+ArrowLeft")).toBe("Ctrl+Left");
		expect(canonicalChord("f2")).toBe("F2");
		expect(canonicalChord("Ctrl+")).toBe("Ctrl++");
	});
	test("a key stroke as a chord; a modifier alone is none", () => {
		expect(chordFromEvent({ key: "k", modifiers: { ctrl: true, shift: true } } as never)).toBe("Ctrl+Shift+K");
		expect(chordFromEvent({ key: "tab", modifiers: { cmd: true } } as never)).toBe("Ctrl+Tab");
		expect(chordFromEvent({ key: "shift", modifiers: { shift: true } } as never)).toBeUndefined();
		expect(chordFromEvent({ key: "Control", modifiers: { ctrl: true } } as never)).toBeUndefined();
	});
	test("only chords with Ctrl / Alt, or function keys, can be bound", () => {
		expect(isBindable("Ctrl+Shift+K")).toBe(true);
		expect(isBindable("Alt+1")).toBe(true);
		expect(isBindable("F5")).toBe(true);
		expect(isBindable("K")).toBe(false);
		expect(isBindable("Shift+Delete")).toBe(false);
		expect(isBindable("Down")).toBe(false);
	});
	test("Ctrl+Tab / Ctrl+Shift+Tab are told apart", () => {
		expect(matchesChord("Ctrl+Tab", { key: "tab", modifiers: { ctrl: true } } as never)).toBe(true);
		expect(matchesChord("Ctrl+Tab", { key: "tab", modifiers: { ctrl: true, shift: true } } as never)).toBe(false);
		expect(matchesChord("Ctrl+Shift+Tab", { key: "tab", modifiers: { ctrl: true, shift: true } } as never)).toBe(true);
	});
});

describe("rebinding", () => {
	test("defaults run until changed", () => {
		press("k", { ctrl: true, shift: true });
		expect(ran).toEqual(["quick"]);
	});
	test("a new chord replaces the default; the old one stops working", () => {
		setShortcut("t.quick", "Ctrl+Alt+Q", "Ctrl+Shift+K");
		expect(actionShortcut({ id: "t.quick", shortcut: "Ctrl+Shift+K" })).toBe("Ctrl+Alt+Q");
		press("k", { ctrl: true, shift: true });
		press("q", { ctrl: true, alt: true });
		expect(ran).toEqual(["quick"]);
		expect(isCustomised("t.quick")).toBe(true);
	});
	test("removing a shortcut, then resetting it", () => {
		setShortcut("t.quick", "", "Ctrl+Shift+K");
		expect(effectiveShortcut("t.quick", "Ctrl+Shift+K")).toBeUndefined();
		press("k", { ctrl: true, shift: true });
		expect(ran).toEqual([]);
		resetShortcut("t.quick");
		press("k", { ctrl: true, shift: true });
		expect(ran).toEqual(["quick"]);
	});
	test("an action without a default can be given one", () => {
		setShortcut("t.none", "F7");
		press("f7");
		expect(ran).toEqual(["none"]);
	});
	test("setting the default back stores nothing", () => {
		setShortcut("t.quick", "Ctrl+Shift+K", "Ctrl+Shift+K");
		expect(shortcutOverrides()).toEqual({});
	});
	test("who else uses a chord, whatever its spelling", () => {
		expect(shortcutUsers("shift+ctrl+j").map((a) => a.id)).toEqual(["t.other"]);
		expect(shortcutUsers("Ctrl+Shift+J", "t.other")).toEqual([]);
	});
	test("menus show the current key of the command behind a default", () => {
		expect(displayShortcut("Ctrl+Shift+J")).toBe("Ctrl+Shift+J");
		setShortcut("t.other", "Ctrl+Alt+J", "Ctrl+Shift+J");
		expect(displayShortcut("Ctrl+Shift+J")).toBe("Ctrl+Alt+J");
		setShortcut("t.other", "", "Ctrl+Shift+J");
		expect(displayShortcut("Ctrl+Shift+J")).toBeUndefined();
		expect(displayShortcut("Ctrl+Shift+Z")).toBe("Ctrl+Shift+Z"); // no command behind it: shown as written
	});
});

describe("two actions on one chord", () => {
	let applicable = false;
	registerAppAction({ id: "t.dupA", label: "A", menu: "none", shortcut: "Ctrl+Shift+Q", when: () => applicable, run: () => ran.push("A") });
	registerAppAction({ id: "t.dupB", label: "B", menu: "none", shortcut: "Ctrl+Shift+Q", run: () => ran.push("B") });
	const pressQ = () => {
		let prevented = false;
		handleWindowKeyDown({ key: "q", modifiers: { ctrl: true, shift: true }, defaultPrevented: false, preventDefault: () => (prevented = true) } as never);
		return prevented;
	};
	test("an action that does not apply here does not shadow the next one on the chord", () => {
		applicable = false;
		expect(pressQ()).toBe(true);
		expect(ran).toEqual(["B"]);
	});
	test("the first one that applies runs, and only that one", () => {
		applicable = true;
		expect(pressQ()).toBe(true);
		expect(ran).toEqual(["A"]);
	});
});
