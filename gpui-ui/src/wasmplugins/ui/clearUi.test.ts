// When a plugin stops, is disabled or fails, its toasts and theme override go with its dialogs.
import { describe, expect, test } from "bun:test";
import { toastList } from "../../ui/core";
import { setThemeOverride, showToast, themeOverrideList, type HostCtx } from "./host";
import { clearUiOf } from "./index"; // the one the app hooks to "registrations reset"

const ctxOf = (pluginId: string): HostCtx => ({ pluginId, has: () => true, callExport: async () => undefined });
const toastSpec = { title: { tag: "plain", val: "hello" }, lines: [], tone: "info", durationMs: 0, actions: [] } as never;
const override = { label: { tag: "plain", val: "mine" }, light: [{ token: "primary", color: 0xff0000ff }], dark: [] } as never;

describe("clearUiOf", () => {
	test("removes the plugin's persistent toasts and theme override, and only its own", () => {
		const a = ctxOf("a@x");
		const b = ctxOf("b@x");
		showToast(a, toastSpec);
		showToast(b, toastSpec);
		setThemeOverride(a, override);
		setThemeOverride(b, override);
		expect(toastList().map((t) => t.id).filter((id) => id.startsWith("wp-")).length).toBe(2);
		expect(themeOverrideList().map((o) => o.pluginId).sort()).toEqual(["a@x", "b@x"]);

		clearUiOf("a@x");
		expect(toastList().map((t) => t.id)).toEqual([expect.stringContaining("wp-b@x-")]);
		expect(themeOverrideList().map((o) => o.pluginId)).toEqual(["b@x"]);

		clearUiOf(undefined); // the plugin host restarted
		expect(toastList()).toEqual([]);
		expect(themeOverrideList()).toEqual([]);
	});
});
