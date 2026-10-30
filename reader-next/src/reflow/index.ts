// reflow/ plugin entry (see ../contract.ts): the "Reading view" toolbar button toggles an alternate full-pane
// view of the document as a reflowed article (see ReflowView.tsx).
import { createComponent, createSignal } from "solid-js";
import { render } from "solid-js/web";
import type { DocStructure, ReaderPlugin } from "../contract";
import { loadStructure } from "../structure/load";
import { installFonts } from "./fonts";
import { ReflowView, type LoadState } from "./ReflowView";
import { DEFAULT_SETTINGS, loadSettings, palette, saveSettings, STORAGE_KEY, type ReadingSettings } from "./settings";

export const reflowPlugin: ReaderPlugin = (viewer) => {
	const [settings, setSettingsSig] = createSignal<ReadingSettings>(loadSettings());
	const [state, setState] = createSignal<LoadState>({ phase: "loading", pct: 0 });
	const [on, setOn] = createSignal(false);

	// --rn-reading-bg / --rn-reading-fg on <html>: also drive the page view's "reading" tint (viewer/appearance.ts)
	const publish = () => {
		const p = palette(settings());
		document.documentElement.style.setProperty("--rn-reading-bg", p.bg);
		document.documentElement.style.setProperty("--rn-reading-fg", p.fg);
	};
	publish();
	const setSettings = (patch: Partial<ReadingSettings>) => {
		const next = { ...settings(), ...patch };
		setSettingsSig(next);
		saveSettings(next);
		publish();
	};
	// the app's Settings page edits these from another document: follow it live
	const onStorage = (e: StorageEvent) => {
		if (e.key !== STORAGE_KEY && e.key !== null) return;
		setSettingsSig(loadSettings());
		publish();
	};
	window.addEventListener("storage", onStorage);
	// reset typography and theme; "open by default" is a separate choice and stays
	const resetSettings = () => setSettings({ ...DEFAULT_SETTINGS, openByDefault: settings().openByDefault });

	let started = false;
	const start = async () => {
		setState({ phase: "loading", pct: 0 });
		try {
			const res = await fetch(`/api/attachments/${encodeURIComponent(viewer.attachmentKey)}/file`);
			if (!res.ok) throw new Error(`Could not read the PDF (HTTP ${res.status}).`);
			const doc: DocStructure = await loadStructure(viewer.attachmentKey, await res.arrayBuffer(), (pct) => {
				if (state().phase === "loading") setState({ phase: "loading", pct });
			});
			setState({ phase: "ready", doc });
		}
		catch (e) {
			started = false;
			setState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
		}
	};
	const ensureLoaded = () => { if (!started) { started = true; void start(); } };

	const close = () => viewer.setAlternateView(null);
	const open = () => {
		ensureLoaded();
		setOn(true);
		viewer.setAlternateView((container) => {
			const dispose = render(() => createComponent(ReflowView, {
				viewer, state, settings, setSettings, resetSettings, close,
				retry: () => { started = false; ensureLoaded(); },
				onLeave: ({ page, top }) => {
					setOn(false);
					// the page view becomes visible right after this cleanup; go there once it has
					requestAnimationFrame(() => requestAnimationFrame(() => viewer.goToPage(page, top === undefined ? undefined : { top })));
				},
			}), container);
			return dispose;
		});
	};

	const removeBtn = viewer.addToolbarButton({
		id: "reading-view", title: "Reading view", icon: "book-open",
		onClick: () => (on() ? close() : open()), active: on,
	});

	installFonts();
	// "Open PDFs in the reading view" setting
	const auto = settings().openByDefault ? setTimeout(open, 0) : undefined;

	return () => {
		clearTimeout(auto);
		window.removeEventListener("storage", onStorage);
		removeBtn();
		if (on()) close();
		document.documentElement.style.removeProperty("--rn-reading-bg");
		document.documentElement.style.removeProperty("--rn-reading-fg");
	};
};
