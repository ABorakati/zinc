// The Settings feature: importing this registers the built-in sections with the shell's registry (registerSettingsSection) so the
// Settings tab lists them beside any section a feature registered itself, and registers the Ctrl+, shortcut.
//
// For features contributing a section: either registerSettingsSection({ id, label, icon, order, render }) from ../registry
// (render() draws the rows; use SettingRow from ./controls for the same look), or call registerSection + registerSetting from
// ./registry and let this module bridge it (data-driven rows with search).
import { registerAppAction, registerSettingsSection, settingsSections } from "../registry";
import { openSettings } from "../shell/layout";
import "./defs/appearance";
import "./defs/general";
import "../locate/settings"; // Locate engines rows (under general's "Locate" group; must follow defs/general)
import "./defs/reader";
import "./defs/sync";
import "./defs/files";
import "./defs/files-storage"; // the ZotMoov rows of Files and folders (must follow defs/files)
import "./defs/integrations";
import "./defs/system";
import { SectionBody } from "./SettingsPage";
import { sections } from "./registry";

export { SettingsPage, gotoSection } from "./SettingsPage";
export { SettingRow, Btn, Choice, Kbd, Segmented, TextField, Toggle, Value } from "./controls";
export { registerSection, registerSetting, registerSettings, registerSettingsProvider, onSettingsShown } from "./registry";
export { readerPrefs } from "./readerPrefs";

/** Bridge: every data-driven section becomes a shell SettingsSection (once; safe to call again for sections added later). */
export function bridgeSections(): void {
	const have = new Set(settingsSections().map((s) => s.id));
	for (const s of sections()) {
		if (have.has(s.id)) continue;
		registerSettingsSection({ id: s.id, label: s.label, icon: s.icon, order: s.order, render: () => SectionBody({ id: s.id }) });
	}
}
bridgeSections();

registerAppAction({ id: "settings-open", label: "Settings…", icon: "settings", menu: "tools", shortcut: "Ctrl+,", run: openSettings });
