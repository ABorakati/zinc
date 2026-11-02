// reflow plugin (reader-next/src/reflow): the reflowed reading view as an alternate full-pane view (the reader core adds the
// toolbar toggle for it). The structure comes from the document worker through the academic session, which is shared with the
// academic plugins, so the document is analysed once.
import { createSignal } from "solid-js";
import { academicFor } from "../academic/session";
import type { ReaderPlugin } from "../plugins";
import { ReflowView, type LoadState } from "./ReflowView";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type ReadingSettings } from "./settings";

const [settings, setSettingsSig] = createSignal<ReadingSettings>(loadSettings());
const setSettings = (patch: Partial<ReadingSettings>) => {
	const next = { ...settings(), ...patch };
	setSettingsSig(next);
	saveSettings(next);
};
// "open by default" is a separate choice that survives a reset of typography and theme
const resetSettings = () => setSettings({ ...DEFAULT_SETTINGS, openByDefault: settings().openByDefault });

export const reflowSettings = settings;
export const setReflowSettings = setSettings;

export const reflowPlugin: ReaderPlugin = {
	id: "reflow",
	altView: {
		id: "reflow", label: "Reading view", icon: "book-open",
		render: (ctx) => {
			const s = academicFor(ctx);
			void s.start();
			const state = (): LoadState => {
				const x = s.struct();
				return x.phase === "ready" ? { phase: "ready", doc: x.doc } : x;
			};
			return <ReflowView ctx={ctx} state={state} retry={() => void s.retry()} settings={settings} setSettings={setSettings} resetSettings={resetSettings} />;
		},
	},
	onOpen(ctx) {
		// open straight into the reading view when the user asked for it
		if (settings().openByDefault) ctx.setAltView("reflow");
	},
};
