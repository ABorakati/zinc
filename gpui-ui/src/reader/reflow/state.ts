// The reading view's settings as signals, in a module of its own (no UI imports) so Settings > Reader can show and change them
// without loading the reader plugins. Persisted by settings.ts (reading-settings.json).
import { createSignal } from "solid-js";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type ReadingSettings } from "./settings";

const [settings, setSettingsSig] = createSignal<ReadingSettings>(loadSettings());

export const reflowSettings = settings;
export function setReflowSettings(patch: Partial<ReadingSettings>): void {
	const next = { ...settings(), ...patch };
	setSettingsSig(next);
	saveSettings(next);
}
/** Typography and theme back to the defaults; "open by default" is a separate choice and survives. */
export const resetReflowSettings = (): void => setReflowSettings({ ...DEFAULT_SETTINGS, openByDefault: settings().openByDefault });
