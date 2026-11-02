// Shared harness of the shell screenshot scripts (shot-app.tsx, shot-settings.tsx): boots <App/> in the headless GPUIX renderer
// against the core at ZN_URL (a library COPY), with appearance applied exactly as main.tsx does, and offers settle/shot/click helpers.
import { SHOTS, STATE_FILE } from "./_shell-env";
import { createTestRoot } from "@gpuix/solid/testing";
import { registerFonts } from "../src/fonts";
import { applyAppearance, setThemePrefs, startAppearance, type ThemePrefs } from "../src/shell/appearance";
import { setNativeRenderer } from "../src/shell/native";
import { store } from "../src/store";
import type { JSX } from "solid-js";

export { SHOTS, STATE_FILE };
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `view`: what to mount (default the whole <App/>; settings shots mount just the top bar + Settings so they do not depend on the list). */
export async function boot(opts: { prefs?: Partial<ThemePrefs>; width?: number; height?: number; view?: () => JSX.Element } = {}) {
	const t = createTestRoot({ width: opts.width ?? 1400, height: opts.height ?? 900 });
	setNativeRenderer(t.renderer);
	if (opts.prefs) setThemePrefs(opts.prefs);
	applyAppearance();
	registerFonts(t.renderer);
	startAppearance(store);
	if (opts.view) t.render(opts.view);
	else {
		const { App } = await import("../src/App");
		t.render(() => <App />);
		for (let i = 0; i < 100 && store.total() === 0; i++) await sleep(100);
	}
	await sleep(600);

	const settle = async (ms = 300) => {
		for (let i = 0; i < 3; i++) {
			t.renderer.flush();
			t.renderer.dispatchNativeEvents();
			await sleep(ms / 3);
		}
		t.renderer.flush();
	};
	const shot = async (name: string) => {
		await settle(500);
		const file = `${SHOTS}/shell-${name}.png`;
		t.renderer.captureScreenshot(file);
		console.log("wrote", file);
	};
	/** Bounds of the first <text> with this exact content. */
	const at = (label: string) => {
		const el = t.renderer.findByText(label);
		const b = el ? t.renderer.getElementBounds(el.id) : null;
		if (!b) throw new Error(`no element with text "${label}"`);
		return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height, left: b.x };
	};
	const click = async (x: number, y: number, button = 0) => {
		t.renderer.nativeSimulateClick(x, y, button);
		await settle();
	};
	const clickText = (label: string) => click(at(label).x, at(label).y);
	return { t, store, settle, shot, at, click, clickText };
}
