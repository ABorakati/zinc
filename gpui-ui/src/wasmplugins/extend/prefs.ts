// Plugin preferences as the settings panes read and write them (`setting-control` rows bound to a pref key). The store of the values is
// the `prefs` interface of the plugin host (a core route); this module talks to it through an adapter so tests can use memory and the
// owner of `prefs` can swap the transport. Default: core HTTP `GET/PUT /api/plugin-prefs/<plugin>/<key>` carrying a `pref-value`
// (`{ tag, val }`), as in plugin-host/src/imports/README.md.
import { createSignal, type Accessor } from "solid-js";
import type { PrefValue } from "./wit";

export interface PrefsAdapter {
	get(plugin: string, key: string): Promise<PrefValue | undefined>;
	set(plugin: string, key: string, value: PrefValue | undefined): Promise<void>;
}

const httpAdapter: PrefsAdapter = {
	async get(plugin, key) {
		const { apiFetch } = await import("../../api");
		const r = await apiFetch(`/plugin-prefs/${encodeURIComponent(plugin)}/${encodeURIComponent(key)}`);
		if (r.status === 404) return undefined;
		if (!r.ok) throw new Error(`prefs ${r.status}`);
		return (await r.json()) as PrefValue;
	},
	async set(plugin, key, value) {
		const { apiFetch } = await import("../../api");
		const path = `/plugin-prefs/${encodeURIComponent(plugin)}/${encodeURIComponent(key)}`;
		const r = await apiFetch(path, value === undefined ? { method: "DELETE" } : { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
		if (!r.ok && r.status !== 404) throw new Error(`prefs ${r.status}`);
	},
};

let adapter: PrefsAdapter = httpAdapter;
export function setPrefsAdapter(a: PrefsAdapter | undefined): void {
	adapter = a ?? httpAdapter;
	cells.clear();
}

/** Same in-memory adapter for tests. */
export function memoryPrefs(initial: Record<string, PrefValue> = {}): PrefsAdapter & { values: Map<string, PrefValue> } {
	const values = new Map(Object.entries(initial));
	return {
		values,
		async get(plugin, key) {
			return values.get(`${plugin}\u0000${key}`);
		},
		async set(plugin, key, v) {
			if (v === undefined) values.delete(`${plugin}\u0000${key}`);
			else values.set(`${plugin}\u0000${key}`, v);
		},
	};
}

const cells = new Map<string, { get: Accessor<PrefValue | undefined>; set: (v: PrefValue | undefined) => void; loaded: boolean }>();

/** A reactive pref value (loaded on first read) and a setter that writes through the adapter. */
export function prefCell(plugin: string, key: string) {
	const id = `${plugin}\u0000${key}`;
	let c = cells.get(id);
	if (!c) {
		const [get, set] = createSignal<PrefValue | undefined>(undefined);
		c = { get, set, loaded: false };
		cells.set(id, c);
	}
	const cell = c;
	if (!cell.loaded) {
		cell.loaded = true;
		void adapter.get(plugin, key).then(cell.set, () => {});
	}
	return {
		get: cell.get,
		async set(v: PrefValue | undefined) {
			cell.set(v);
			await adapter.set(plugin, key, v).catch(() => {});
		},
	};
}
