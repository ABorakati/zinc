// macOS native menubar (macMenubar.ts): cross-platform shortcut conversion tests + real AppKit NSMenu tests on macOS.
import { describe, expect, test } from "bun:test";
import { installMacMenubar, inspectMacSubmenu, MAC_MOD, parseMacShortcut, readMacMainMenuTitles } from "./macMenubar";
import { nativeMenubarState, setNativeMenubarState, showInWindowMenubar } from "./menubarState";

describe("parseMacShortcut", () => {
	test("maps Ctrl/Cmd + punctuation or letter to Command key equivalent", () => {
		expect(parseMacShortcut("Ctrl+,")).toEqual({ key: ",", mask: MAC_MOD.command });
		expect(parseMacShortcut("Cmd+K")).toEqual({ key: "k", mask: MAC_MOD.command });
		expect(parseMacShortcut("Ctrl+Shift+K")).toEqual({ key: "k", mask: MAC_MOD.command | MAC_MOD.shift });
		expect(parseMacShortcut("Ctrl+Alt+S")).toEqual({ key: "s", mask: MAC_MOD.command | MAC_MOD.option });
	});

	test("skips plain editing chords so AppKit does not steal them from text inputs", () => {
		expect(parseMacShortcut("Ctrl+A")).toBeNull();
		expect(parseMacShortcut("Ctrl+C")).toBeNull();
		expect(parseMacShortcut("Ctrl+V")).toBeNull();
		expect(parseMacShortcut("Ctrl+Z")).toBeNull();
		// With Shift it no longer conflicts with basic text selection/copy
		expect(parseMacShortcut("Ctrl+Shift+A")).toEqual({ key: "a", mask: MAC_MOD.command | MAC_MOD.shift });
	});

	test("ignores multi-character / non-printable keys and empty strings", () => {
		expect(parseMacShortcut("")).toBeNull();
		expect(parseMacShortcut(undefined)).toBeNull();
		expect(parseMacShortcut("Ctrl+Tab")).toBeNull();
		expect(parseMacShortcut("Ctrl+PageDown")).toBeNull();
		expect(parseMacShortcut("Escape")).toBeNull();
	});
});

describe("menubarState", () => {
	test("showInWindowMenubar is true only in fallback state", () => {
		const prev = nativeMenubarState();
		try {
			setNativeMenubarState("pending");
			expect(showInWindowMenubar()).toBe(false);
			setNativeMenubarState("active");
			expect(showInWindowMenubar()).toBe(false);
			setNativeMenubarState("fallback");
			expect(showInWindowMenubar()).toBe(true);
		} finally {
			setNativeMenubarState(prev);
		}
	});
});

describe.skipIf(process.platform !== "darwin")("macOS native NSMenu integration", () => {
	test("installMacMenubar adds File/Edit/View/Go/Tools/Help and dispatches dynamic menu items", () => {
		let clicks = 0;
		let version = 1;
		const ok = installMacMenubar({
			getItems: (id) => {
				if (id === "go") {
					return [
						{ label: `Dynamic Item v${version}`, shortcut: "Ctrl+,", onSelect: () => clicks++ },
						{ separator: true },
						{ label: "Disabled Entry", disabled: true },
					];
				}
				return [{ label: `${id} item`, onSelect: () => {} }];
			},
		});
		expect(ok).toBe(true);

		const titles = readMacMainMenuTitles();
		expect(titles).toContain("File");
		expect(titles).toContain("Edit");
		expect(titles).toContain("View");
		expect(titles).toContain("Go");
		expect(titles).toContain("Tools");
		expect(titles).toContain("Help");

		// Rebuilding on menuNeedsUpdate: picks up fresh dynamic labels and dispatches znMenuAction:
		version = 2;
		const goItems = inspectMacSubmenu("Go", "Dynamic Item v2");
		expect(goItems).toEqual(["Dynamic Item v2", "---", "Disabled Entry"]);
		expect(clicks).toBe(1);

		// Reinstalling is idempotent (no duplicate menus)
		expect(installMacMenubar()).toBe(true);
		const after = readMacMainMenuTitles();
		expect(after.filter((t) => t === "File").length).toBe(1);
	});
});
