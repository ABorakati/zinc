// Per-plugin preferences (lifecycle.wit, interface prefs). One JSON file per plugin (<root>/prefs/<id>.json) holds the user-set values;
// defaults come from the manifest's `default_prefs` and are never written. Values are JS primitives: boolean (flag), integer number
// (integer, 32-bit) and string (text). The store lives in the Zinc process, so the import handler and the UI bindings (a control bound
// to a pref) see one copy; observers are told through `onChange`, and `zhw` cache pushes are driven synchronously through `onSync`.
import { rmSync } from "node:fs";
import { readJson, writeJsonAtomic } from "./json-file";
import type { Layout } from "./layout";

export type PrefValue = boolean | number | string;

export const MAX_PREF_KEYS = 1000;
export const MAX_PREF_TEXT_BYTES = 64 * 1024;
const KEY = /^[A-Za-z0-9._-]{1,128}$/;

export class PrefError extends Error {
	constructor(
		readonly tag: "invalid-argument" | "limit-exceeded",
		message: string,
	) {
		super(message);
	}
}

export interface PrefEntry {
	key: string;
	value: PrefValue;
	userSet: boolean;
}

export interface PrefChange {
	plugin: string;
	key: string;
	/** undefined: the user value was cleared and the key has no default. */
	value: PrefValue | undefined;
}

export class PrefStore {
	private cache = new Map<string, Record<string, PrefValue>>();
	private listeners = new Set<(c: PrefChange) => void>();
	private syncListeners = new Set<(plugin: string) => void>();
	/** Keys that are secret settings: kept in `secrets` under "pref:<key>", never here. */
	private secretKeys = new Map<string, Set<string>>();

	/** `defaultsFor` gives a plugin's `default_prefs` (the manager reads them from the installed manifest). */
	constructor(
		private layout: Layout,
		private defaultsFor: (plugin: string) => Record<string, PrefValue> | undefined,
	) {}

	private load(plugin: string): Record<string, PrefValue> {
		let m = this.cache.get(plugin);
		if (!m) {
			const raw = readJson<Record<string, unknown>>(this.layout.prefsFile(plugin), {});
			m = {};
			for (const [k, v] of Object.entries(raw)) if (KEY.test(k) && (typeof v === "boolean" || typeof v === "string" || (typeof v === "number" && Number.isInteger(v)))) m[k] = v;
			this.cache.set(plugin, m);
		}
		return m;
	}

	private save(plugin: string, m: Record<string, PrefValue>) {
		writeJsonAtomic(this.layout.prefsFile(plugin), m);
	}

	private emit(c: PrefChange) {
		for (const l of this.listeners) {
			try {
				l(c);
			} catch {
				/* a listener must not break a write */
			}
		}
	}

	private emitSync(plugin: string) {
		for (const fn of this.syncListeners) {
			try {
				fn(plugin);
			} catch {
				/* a sync listener must not break a write */
			}
		}
	}

	onChange(fn: (c: PrefChange) => void): () => void {
		this.listeners.add(fn);
		return () => void this.listeners.delete(fn);
	}

	/** Fires synchronously on every mutation (`setMany`, `clear`, `reset`, `markSecret`, `deleteAll`), before `onChange` and before handlers return. */
	onSync(fn: (plugin: string) => void): () => void {
		this.syncListeners.add(fn);
		return () => void this.syncListeners.delete(fn);
	}

	/** Current `{ defaults, user, secrets }` snapshot for pushing to `zhw`. */
	snapshot(plugin: string, defaultsOverride?: Record<string, PrefValue>): { defaults: Record<string, PrefValue>; user: Record<string, PrefValue>; secrets: string[] } {
		const defs = defaultsOverride ?? this.defaults(plugin);
		return {
			defaults: { ...defs },
			user: { ...this.load(plugin) },
			secrets: [...(this.secretKeys.get(plugin) ?? [])],
		};
	}

	/** A key bound to a `secret` setting: reads give none, and writes go to `secrets` (the caller does that). */
	markSecret(plugin: string, key: string) {
		let s = this.secretKeys.get(plugin);
		if (!s) this.secretKeys.set(plugin, (s = new Set()));
		s.add(key);
		this.emitSync(plugin);
	}

	isSecret(plugin: string, key: string): boolean {
		return this.secretKeys.get(plugin)?.has(key) ?? false;
	}

	private defaults(plugin: string): Record<string, PrefValue> {
		return this.defaultsFor(plugin) ?? {};
	}

	get(plugin: string, key: string): PrefValue | undefined {
		if (this.isSecret(plugin, key)) return undefined;
		const u = this.load(plugin);
		if (key in u) return u[key];
		return this.defaults(plugin)[key];
	}

	hasUserValue(plugin: string, key: string): boolean {
		return key in this.load(plugin);
	}

	getAll(plugin: string, prefix?: string): PrefEntry[] {
		const u = this.load(plugin);
		const d = this.defaults(plugin);
		const keys = new Set([...Object.keys(d), ...Object.keys(u)]);
		return [...keys]
			.filter((k) => (!prefix || k.startsWith(prefix)) && !this.isSecret(plugin, k))
			.sort()
			.map((k) => ({ key: k, value: (k in u ? u[k] : d[k])!, userSet: k in u }));
	}

	/** Checks a write without doing it. Throws PrefError. */
	private check(plugin: string, key: string, value: PrefValue, userKeys: Record<string, PrefValue>) {
		if (!KEY.test(key)) throw new PrefError("invalid-argument", `bad pref key "${key}" (1 to 128 of A-Z a-z 0-9 . _ -)`);
		if (typeof value === "number") {
			if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) throw new PrefError("invalid-argument", `${key}: an integer pref is a 32-bit whole number`);
		} else if (typeof value === "string") {
			if (Buffer.byteLength(value, "utf8") > MAX_PREF_TEXT_BYTES) throw new PrefError("limit-exceeded", `${key}: a text pref is at most 64 KiB`);
		} else if (typeof value !== "boolean") throw new PrefError("invalid-argument", `${key}: not a pref value`);
		const def = this.defaults(plugin)[key];
		if (def !== undefined && typeof def !== typeof value) throw new PrefError("invalid-argument", `${key} has a default of type ${typeName(def)}; cannot set ${typeName(value)}`);
		if (!(key in userKeys) && Object.keys(userKeys).length >= MAX_PREF_KEYS) throw new PrefError("limit-exceeded", `at most ${MAX_PREF_KEYS} prefs per plugin`);
	}

	set(plugin: string, key: string, value: PrefValue): void {
		this.setMany(plugin, [[key, value]]);
	}

	/** All or none: every entry is checked before the first is written. One change notification per key whose effective value changed. */
	setMany(plugin: string, entries: Array<[string, PrefValue]>): void {
		const u = this.load(plugin);
		const next = { ...u };
		for (const [k, v] of entries) {
			this.check(plugin, k, v, next);
			next[k] = v;
		}
		const changes: PrefChange[] = [];
		for (const [k, v] of new Map(entries)) if (this.get(plugin, k) !== v) changes.push({ plugin, key: k, value: v });
		this.cache.set(plugin, next);
		this.save(plugin, next);
		this.emitSync(plugin);
		for (const c of changes) this.emit(c);
	}

	private clearKey(plugin: string, key: string): PrefChange | undefined {
		const u = this.load(plugin);
		if (!(key in u)) return undefined;
		const before = this.get(plugin, key);
		const next = { ...u };
		delete next[key];
		this.cache.set(plugin, next);
		this.save(plugin, next);
		const after = this.get(plugin, key);
		return before !== after ? { plugin, key, value: after } : undefined;
	}

	clear(plugin: string, key: string): void {
		const c = this.clearKey(plugin, key);
		this.emitSync(plugin);
		if (c) this.emit(c);
	}

	/** Clears every user value under `prefix` (all if none) except `except`. */
	reset(plugin: string, prefix: string | undefined, except: string[]): void {
		const u = this.load(plugin);
		const changes: PrefChange[] = [];
		for (const k of Object.keys(u)) {
			if ((!prefix || k.startsWith(prefix)) && !except.includes(k)) {
				const c = this.clearKey(plugin, k);
				if (c) changes.push(c);
			}
		}
		this.emitSync(plugin);
		for (const c of changes) this.emit(c);
	}

	/** Uninstall: drop the plugin's pref file (and the cached copy). */
	deleteAll(plugin: string): void {
		this.cache.delete(plugin);
		this.secretKeys.delete(plugin);
		rmSync(this.layout.prefsFile(plugin), { force: true });
		this.emitSync(plugin);
	}
}

const typeName = (v: PrefValue) => (typeof v === "boolean" ? "flag" : typeof v === "number" ? "integer" : "text");

/** jco's `pref-value` variant to a primitive and back. */
export function fromWire(v: { tag: string; val: unknown }): PrefValue {
	if (v?.tag === "flag" && typeof v.val === "boolean") return v.val;
	if (v?.tag === "integer" && typeof v.val === "number") return v.val;
	if (v?.tag === "text" && typeof v.val === "string") return v.val;
	throw new PrefError("invalid-argument", "not a pref-value");
}

export function toWire(v: PrefValue): { tag: "flag" | "integer" | "text"; val: PrefValue } {
	return typeof v === "boolean" ? { tag: "flag", val: v } : typeof v === "number" ? { tag: "integer", val: v } : { tag: "text", val: v };
}
