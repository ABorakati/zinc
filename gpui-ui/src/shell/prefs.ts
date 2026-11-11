// UI preferences of the shell ("shell." keys: layout, appearance, Settings page, reader defaults) in the one shared
// %APPDATA%\zotero-next-gpui\ui-state.json (the GPUI window has no localStorage). store.ts owns that file's writer (`uiState`):
// this module reads the file itself once (so the theme and layout are known before the store is imported, for the splash) and
// hands every write to `uiState.set` as soon as it is bound (shell/layout.ts and main.tsx call bindUiState), so there is a single
// writer and nothing clobbers anything. Writes made before the bind are queued and replayed.
//
//   const [leftOpen, setLeftOpen] = persisted("shell.panelLeft", true);
//
// ZN_UI_STATE=<file> redirects the file, ZN_UI_STATE=off keeps everything in memory (same switches as store.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../../../core/src/platform-dirs";
import { createSignal, type Accessor } from "solid-js";

/** Where the preferences live (null: persistence is off). */
export function prefsPath(): string | null {
	const env = process.env.ZN_UI_STATE;
	if (env === "off") return null;
	if (env) return env;
	return join(configDir(), "zotero-next-gpui", "ui-state.json");
}

let data: Record<string, unknown> | undefined;
function all(): Record<string, unknown> {
	if (data) return data;
	data = {};
	const p = prefsPath();
	if (p) {
		try {
			const v = JSON.parse(readFileSync(p, "utf8")) as unknown;
			if (v && typeof v === "object" && !Array.isArray(v)) data = v as Record<string, unknown>;
		} catch { /* first run / unreadable: defaults */ }
	}
	return data;
}

/** The writer: store.ts's `uiState` (structurally typed here so this module never imports the store). */
interface Sink { set(key: string, value: unknown): void }
let sink: Sink | undefined;
const queued = new Map<string, unknown>();

/** Route writes through store.ts's uiState (call once the store module is loaded); replays what was set before. */
export function bindUiState(s: Sink): void {
	sink = s;
	for (const [k, v] of queued) s.set(k, v);
	queued.clear();
}
const write = (key: string, value: unknown) => { if (sink) sink.set(key, value); else queued.set(key, value); };

/** A stored value, or `fallback` when missing / rejected by `validate` (which may also repair it). */
export function getPref<T>(key: string, fallback: T, validate?: (v: unknown) => T | undefined): T {
	const v = all()[key];
	if (v === undefined) return fallback;
	if (!validate) return v as T;
	try {
		return validate(v) ?? fallback;
	} catch {
		return fallback;
	}
}

/** Store a value (undefined removes the key). */
export function setPref(key: string, value: unknown): void {
	if (value === undefined) delete all()[key];
	else all()[key] = value;
	write(key, value);
}

/** Remove every stored key that starts with `prefix` (e.g. "shell."). */
export function clearPrefs(prefix: string): void {
	for (const k of Object.keys(all())) if (k.startsWith(prefix)) setPref(k, undefined);
}

/** A signal backed by a stored key. */
export function persisted<T>(key: string, fallback: T, validate?: (v: unknown) => T | undefined): readonly [Accessor<T>, (v: T) => void] {
	const [get, set] = createSignal<T>(getPref(key, fallback, validate), { equals: false });
	return [get, (v: T) => { set(() => v); setPref(key, v); }] as const;
}

export const isBool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
export const isStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
export const isNum = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
export const oneOf = <T extends string>(list: readonly T[]) => (v: unknown): T | undefined => (list.includes(v as T) ? (v as T) : undefined);
