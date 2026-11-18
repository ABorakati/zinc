// The switch that turns WASM plugins on. Light on purpose (no plugin-host imports): the settings page reads it.
import { persisted } from "../shell/prefs";

const [enabledPref, setEnabledPref] = persisted<boolean>("shell.wasmPlugins", false, (v) => (typeof v === "boolean" ? v : undefined));
const envOn = () => /^(1|true|on|yes)$/i.test(process.env.ZN_WASM_PLUGINS ?? "");
/** Are plugins switched on (setting `shell.wasmPlugins` or ZN_WASM_PLUGINS=1)? Reactive. Takes effect at the next start. */
export const wasmPluginsEnabled = (): boolean => enabledPref() || envOn();
export const setWasmPluginsEnabled = (on: boolean): void => setEnabledPref(on);
