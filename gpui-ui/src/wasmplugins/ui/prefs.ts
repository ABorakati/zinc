// `node-props.pref`: a control bound to one of the plugin's own preferences. The host reads and writes it without a call into the
// plugin. The store behind it belongs to the `prefs` area (host side); until it registers a backend the values live in memory.
import { createSignal, type Accessor } from "solid-js";

export type PrefValue = { tag: "flag"; val: boolean } | { tag: "integer"; val: number } | { tag: "text"; val: string };

export interface PrefsBackend {
	get(pluginId: string, key: string): Promise<PrefValue | undefined> | PrefValue | undefined;
	set(pluginId: string, key: string, value: PrefValue): Promise<void> | void;
}

/** The package area's PrefStore (plugin-host/src/package), looked up lazily; undefined when the runtime is not up. */
const packageBackend: PrefsBackend = {
	get(pluginId, key) {
		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const v = require("../../../../plugin-host/src/package/services").getServices().prefs.get(pluginId, key);
			return v === undefined ? undefined : typeof v === "boolean" ? { tag: "flag", val: v } : typeof v === "number" ? { tag: "integer", val: v } : { tag: "text", val: String(v) };
		} catch {
			return undefined;
		}
	},
	set(pluginId, key, value) {
		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			require("../../../../plugin-host/src/package/services").getServices().prefs.setMany(pluginId, [[key, value.val]]);
		} catch {
			/* no runtime: the value stays in memory */
		}
	},
};
let backend: PrefsBackend | undefined = packageBackend;
export function setPrefsBackend(b: PrefsBackend | undefined): void {
	backend = b;
}

const signals = new Map<string, [Accessor<PrefValue | undefined>, (v: PrefValue | undefined) => void]>();

/** A reactive handle on one pref: `[value, write]`. The first read asks the backend. */
export function usePref(pluginId: string, key: string): [Accessor<PrefValue | undefined>, (v: PrefValue) => void] {
	const id = `${pluginId}\u0000${key}`;
	let s = signals.get(id);
	if (!s) {
		const [get, set] = createSignal<PrefValue | undefined>(undefined);
		s = [get, set];
		signals.set(id, s);
		void Promise.resolve(backend?.get(pluginId, key)).then((v) => v !== undefined && set(v), () => {});
	}
	const [get, set] = s;
	return [
		get,
		(v) => {
			set(v);
			void Promise.resolve(backend?.set(pluginId, key, v)).catch(() => {});
		},
	];
}
