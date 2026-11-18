// The app side of the plugin runtime: the hooks the plugin host's handlers call (file picker, clipboard, shell confirmations), the
// reader app binding, the preference store for plugin settings panes, and drops as file grants. Loaded by startWasmPlugins() only
// when plugins are on, so the default app never imports it.
import { statSync } from "node:fs";
import { addGrant } from "../../../plugin-host/src/imports/data/fs-roots";
import { setClipboardBackend, setShellBackend } from "../../../plugin-host/src/imports/data/os-hooks";
import { setFilePicker } from "../../../plugin-host/src/imports/data/pick-hook";
import { getServices } from "../../../plugin-host/src/package/services";
import { hostRenderer } from "../shell/native";
import { store } from "../store";
import { clipboard } from "../ui/clipboard";
import { confirm } from "../ui/dialogs";
import { setDropGrantFactory } from "./extend/drop";
import { setPrefsAdapter } from "./extend/prefs";
import type { PrefValue as ExtendPrefValue } from "./extend/wit";
import { bindReaderApp } from "./reader";

/** `fs.pick-open`, `pick-save`, `pick-directory`: the native dialog of the window. GPUIX has no "save as" dialog: a save pick is refused. */
function wireFilePicker(): void {
	setFilePicker(async (req) => {
		const r = hostRenderer();
		if (!r?.promptForPaths) return undefined; // no window (headless): refused, as the WIT says for "no focused window"
		if (req.kind === "save") return undefined;
		const dir = req.kind === "directory";
		const paths = await r.promptForPaths({
			directories: dir,
			files: !dir,
			multiple: req.kind === "open-multiple",
			prompt: req.options.title ?? (dir ? "Choose folder" : "Choose file"),
		});
		return paths?.length ? paths.map((path) => ({ path, isDirectory: dir })) : undefined;
	});
}

/** Text clipboard through the app's own clipboard; the first read of a session is confirmed with the user. */
function wireClipboardAndShell(): void {
	setClipboardBackend({
		async write(c) {
			if (c.text === undefined) throw new Error("this build can only put text on the clipboard");
			await clipboard.writeText(c.text);
		},
		async read() {
			return { text: await clipboard.readText() };
		},
		windowFocused: () => !!hostRenderer(), // GPUIX reports no focus state: "a window exists" is the best check available
		confirmRead: async (pluginId) =>
			!!(await confirm({ title: "Read the clipboard?", body: `The plugin ${pluginId} wants to read what you last copied.`, confirmLabel: "Allow" })),
	});
	setShellBackend({
		confirmScheme: async (pluginId, scheme, url) =>
			!!(await confirm({ title: `Open a ${scheme}: link?`, body: `The plugin ${pluginId} wants to open ${url.slice(0, 200)}`, confirmLabel: "Open" })),
	});
}

/** Plugin preferences shown in settings panes live in the package area's PrefStore, in this process (no core route). */
function wirePrefs(): void {
	setPrefsAdapter({
		async get(plugin, key) {
			const v = getServices().prefs.get(plugin, key);
			return v === undefined ? undefined : typeof v === "boolean" ? { tag: "flag", val: v } : typeof v === "number" ? { tag: "integer", val: v } : { tag: "text", val: String(v) };
		},
		async set(plugin, key, value: ExtendPrefValue | undefined) {
			const prefs = getServices().prefs;
			if (value === undefined) prefs.clear(plugin, key);
			else prefs.set(plugin, key, value.val as never);
		},
	});
}

/** A file dropped on a drop target becomes a read grant of the plugin (`fs` root `granted(id)`). */
function wireDrops(): void {
	setDropGrantFactory((plugin, path) => {
		let isDirectory = false;
		let size: number | undefined;
		try {
			const st = statSync(path);
			isDirectory = st.isDirectory();
			size = isDirectory ? undefined : st.size;
		} catch {
			/* a path that vanished: the grant is still recorded; the plugin's read fails */
		}
		return addGrant(plugin, { path, isDirectory, mode: "read", size });
	});
}

/** The reader's tab functions, from the store. `libraryId` is the library the list shows (the store has no per-attachment lookup). */
function wireReader(): void {
	bindReaderApp({
		libraryId: () => store.libraryId(),
		openAttachment: (key, title, itemKey) => store.openAttachment(key, title, itemKey),
		closeTab: (key) => store.closeTab(key),
		setActiveTab: (id) => store.setActiveTab(id),
		activeTab: () => store.activeTab(),
		selectItem: (key) => store.selectItem(key),
	});
}

export function wireApp(): void {
	wireFilePicker();
	wireClipboardAndShell();
	wirePrefs();
	wireDrops();
	wireReader();
}

/** Undo what `wireApp` set (plugins switched off again in the same process: tests). */
export function unwireApp(): void {
	setFilePicker(undefined);
	setClipboardBackend(undefined);
	setShellBackend(undefined);
	setPrefsAdapter(undefined);
	bindReaderApp(undefined);
}
