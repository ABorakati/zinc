// OS-facing helpers of the shell: the window (title), the native folder dialog (GPUIX promptForPaths), "show in folder".
// The renderer is the one render() mounted, found the way fonts.ts finds it (no hook context needed).
import type { NativeRenderer } from "@gpuix/native/host";

const RENDER_HOST = Symbol.for("@gpuix/solid/render-host");

/** The mounted window's renderer, or undefined before render() / in headless scripts that did not install one. */
export function hostRenderer(): NativeRenderer | undefined {
	return (globalThis as unknown as Record<symbol, { renderer?: NativeRenderer } | undefined>)[RENDER_HOST]?.renderer;
}

let override: NativeRenderer | undefined;
/** Scripts: use this renderer (t.renderer from createTestRoot) for the window calls below. */
export function setNativeRenderer(r: NativeRenderer | undefined): void {
	override = r;
}
const renderer = (): NativeRenderer | undefined => override ?? hostRenderer();

let lastTitle = "";
export function setWindowTitle(title: string): void {
	if (title === lastTitle) return;
	lastTitle = title;
	try {
		renderer()?.setWindowTitle?.(title);
	} catch {
		/* headless */
	}
}

/** True when a native folder dialog is available (a real window). */
export const canPickFolder = (): boolean => !!renderer()?.promptForPaths;

/** The native folder dialog; null when cancelled or unavailable. */
export async function pickFolder(prompt = "Choose folder"): Promise<string | null> {
	const r = renderer();
	if (!r?.promptForPaths) return null;
	const paths = await r.promptForPaths({ directories: true, files: false, multiple: false, prompt });
	return paths?.[0] ?? null;
}

/** True when a native file dialog is available (the same dialog serves folders and files). */
export const canPickFile = canPickFolder;

/** The native file dialog. */
export async function pickFile(prompt = "Choose file"): Promise<string | null> {
	const r = renderer();
	if (!r?.promptForPaths) return null;
	const paths = await r.promptForPaths({ directories: false, files: true, multiple: false, prompt });
	return paths?.[0] ?? null;
}

/** Show a file or folder in Explorer (a file is selected in its folder). */
export function revealInFolder(path: string): void {
	try {
		if (process.platform === "win32") {
			const p = path.replaceAll("/", "\\");
			// explorer.exe returns exit code 1 even on success
			Bun.spawn(["explorer.exe", /\.[a-z0-9]{1,6}$/i.test(p) ? `/select,${p}` : p], { stdio: ["ignore", "ignore", "ignore"] });
		} else {
			Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", path], { stdio: ["ignore", "ignore", "ignore"] });
		}
	} catch (e) {
		console.error("[shell] reveal failed:", e instanceof Error ? e.message : e);
	}
}
