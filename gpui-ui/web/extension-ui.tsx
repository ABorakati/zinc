// What the extension's library page (src/platform.web.ts, in the Zinc Connector's library.html) shows besides the app: the browser
// library's first-run welcome screen, the offer to move the browser library into the desktop app, and the Export library setting.
// Loaded only by that page, and only for the data path each belongs to.
import type { Store, StartContext } from "../src/start";

declare const chrome: {
	runtime: {
		sendMessage(msg: unknown, cb: (reply?: unknown) => void): void;
		lastError?: { message?: string };
		onMessage: { addListener(f: (msg: unknown) => void): void };
	};
};

interface MoveReply { ok?: boolean; error?: string; offer?: boolean; items?: number; result?: MoveResult }
export interface MoveResult { topLevelItems: number; items: number; skippedItems: number; emptied?: boolean; emptyError?: string }
/** The app's library tab: the "Move your browser library into Zinc" offer (offerMove below), for the headless check. */
export interface MoveProbe { phase: string; offered?: boolean; items?: number; run?: () => Promise<MoveResult | null>; result?: MoveResult; error?: string }

function askExtension(msg: object): Promise<MoveReply> {
	return new Promise<MoveReply>((resolve, reject) => {
		chrome.runtime.sendMessage(msg, (r) => (r ? resolve(r as MoveReply) : reject(new Error(chrome.runtime.lastError?.message ?? "the extension did not answer"))));
	});
}
function movedText(r: MoveResult): string {
	return `Moved ${r.topLevelItems} ${r.topLevelItems === 1 ? "item" : "items"} into Zinc`;
}

/** The probe entries (window.znLibrary) that only the extension's page has, for the headless checks (web/browser-welcome-check.ts, browser-library-check.ts). */
export function addExtensionProbe(probe: { importProgress: string[] }, ctx: StartContext, store: Store): void {
	Object.assign(probe, {
		/** "Import a Zotero or Zinc data folder" without the folder dialog: `dir` is a FileSystemDirectoryHandle (or anything shaped like one) */
		async importFolder(dir: unknown): Promise<unknown> {
			const wi = await import("./browser-db/welcome-import");
			const r = await wi.importFolder(dir as never, (p) => { probe.importProgress.push(p.phase); });
			// what "Open the library" does after the import
			await wi.setFirstRunDone();
			ctx.setOverlay(null);
			store.refresh();
			return r;
		},
		/** the Export library command of Settings > Files and folders: starts the download; resolves to its size */
		async exportLibrary(): Promise<unknown> { return (await import("./browser-db/welcome-import")).exportLibrary(); },
		/** the first-run flag as stored */
		readFirstRunDone: async () => (await import("./browser-db/welcome-import")).readFirstRunDone(),
	});
}

/**
 * One library per computer (docs/design/browser-edition.md, section 6): this tab is the app's library. When the browser still holds a
 * library of its own, offer to move it into the app. The extension's service worker does the move (connector nativeHost.js
 * moveBrowserLibrary): export the browser library, the host merges it into this one, then the browser library is emptied.
 * No background to ask (an extension without the connector's service worker, e.g. a test one): nothing to offer, quietly.
 */
export async function offerMove(probe: { move: MoveProbe }, store: Store): Promise<void> {
	const state = await askExtension({ zincMoveState: true });
	if (!state.ok || !state.offer) return;
	const { toast } = await import("../src/ui");
	let running = false;
	const run = async (): Promise<MoveResult | null> => {
		if (running) return null;
		running = true;
		probe.move.phase = "running";
		toast("Moving your browser library", { id: "zinc-move", description: "Starting", durationMs: 0 });
		try {
			const r = await askExtension({ zincMoveLibrary: true });
			if (!r.ok || !r.result) throw new Error(r.error ?? "the move failed");
			probe.move = { ...probe.move, phase: "done", result: r.result };
			const skipped = r.result.skippedItems ? (r.result.skippedItems === 1 ? " One item was already in Zinc and was left as it is." : ` ${r.result.skippedItems} items were already in Zinc and were left as they are.`) : "";
			toast.success(movedText(r.result), { id: "zinc-move", description: `${r.result.emptied === false ? `The browser library could not be emptied (${r.result.emptyError ?? "unknown error"}).` : "Your browser library is now empty."}${skipped}`, durationMs: 10_000 });
			store.refresh();
			return r.result;
		} catch (e) {
			probe.move = { ...probe.move, phase: "failed", error: e instanceof Error ? e.message : String(e) };
			toast.error("Could not move your browser library", { id: "zinc-move", description: `${probe.move.error} Your browser library is unchanged.`, action: { label: "Try again", run: () => void run() } });
			return null;
		} finally {
			running = false;
		}
	};
	probe.move = { ...probe.move, offered: true, items: state.items ?? 0, run };
	chrome.runtime.onMessage.addListener((m) => {
		const p = (m as { zincMoveProgress?: { text?: string } } | null)?.zincMoveProgress;
		if (p && running) toast("Moving your browser library", { id: "zinc-move", description: p.text ? `${p.text}…` : "", durationMs: 0 });
	});
	const label = `Move your browser library into Zinc`;
	toast(label, {
		id: "zinc-move",
		description: `${state.items === 1 ? "One item" : `${state.items} items`} in this browser can go into your Zinc library. They are copied first; then the browser library is emptied.`,
		actions: [{ label: "Not now", run: () => toast.dismiss("zinc-move") }, { label: "Move library", run: () => void run() }],
		durationMs: 0,
	});
	// also in Settings > Files and folders, where it stays while the offer stands
	const { registerSetting } = await import("../src/settings/registry");
	const { Btn } = await import("../src/settings/controls");
	registerSetting({
		id: "browser.moveToApp", section: "files", label,
		description: "This browser holds a library of its own from before the Zinc app was installed. Move it into the app's library: items, collections, notes, annotations, tags and files. Items the app already has are left as they are. Your browser library is emptied when the move succeeds.",
		keywords: ["move", "browser library", "import", "merge", "copy", "browser"],
		control: () => <Btn icon="download" onClick={() => void run()}>Move library</Btn>,
	});
}

/** Settings > Files and folders > Export library: only for the browser library (the desktop library is a file the user already has). */
export async function registerExportSetting(): Promise<void> {
	const { registerSetting } = await import("../src/settings/registry");
	const { Btn } = await import("../src/settings/controls");
	const { toast } = await import("../src/ui");
	registerSetting({
		id: "browser.export", section: "files", label: "Export library",
		description: "Download the whole library as one zip file: library.sqlite and the attachment files (storage folder). Your library is stored in this browser, so keep a copy.",
		keywords: ["export", "backup", "download", "zip", "browser library", "copy"],
		control: () => <Btn icon="download" onClick={() => {
			void import("./browser-db/welcome-import").then((m) => m.exportLibrary()).then(
				(r) => toast("Library exported", { description: `${r.name} (${(r.bytes / 1048576).toFixed(1)} MB) is in your downloads.` }),
				(e) => toast("Could not export the library", { description: e instanceof Error ? e.message : String(e) }),
			);
		}}>Export library</Btn>,
	});
}

/**
 * First run of the browser library: the library is empty and chrome.storage.local `zincBrowserLibrary.firstRunDone` is not true. The
 * welcome screen then takes the place of the app until the user chooses: start empty, sign in to zotero.org (Settings > Sync), or import
 * a Zotero or Zinc data folder. Any choice sets the flag; a library that is not empty skips the screen (and sets the flag).
 */
export async function welcomeScreenHook(ctx: StartContext, store: Store): Promise<void> {
	const wi = await import("./browser-db/welcome-import");
	if (await wi.readFirstRunDone()) return;
	if (!(await wi.libraryIsEmpty())) { await wi.setFirstRunDone(); return; }
	const { BrowserWelcome } = await import("./browser-db/welcome");
	const finish = async () => { await wi.setFirstRunDone(); ctx.setOverlay(null); store.refresh(); };
	const api = {
		startEmpty: () => void finish(),
		signIn: () => {
			void finish().then(async () => {
				const { openSettings } = await import("../src/shell/layout");
				const { gotoSection } = await import("../src/settings");
				openSettings();
				gotoSection("sync");
			});
		},
		async pickFolder() {
			const picker = (globalThis as { showDirectoryPicker?: (o?: object) => Promise<unknown> }).showDirectoryPicker;
			if (!picker) throw new Error("This browser cannot choose a folder (it has no showDirectoryPicker).");
			try { return await picker({ mode: "read" }); } catch (e) { if ((e as { name?: string }).name === "AbortError") return null; throw e; }
		},
		importFolder: (dir: unknown, onProgress: (p: import("./browser-db/welcome-import").Progress) => void) => wi.importFolder(dir as never, onProgress),
		done: () => void finish(),
	};
	ctx.setOverlay(() => <BrowserWelcome api={api} mode={store.mode()} />);
}
