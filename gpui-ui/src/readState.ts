// Local, unsynced read/unread state for library items.
// Persisted in a sidecar JSON file (%APPDATA%\zotero-next-gpui\read-state.json).
// Fast in-memory Solid store so row scrolling does zero file reads and one reactive lookup.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir } from "../../core/src/platform-dirs";
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";

export interface ReadStateFile {
	_version: number;
	_installedAt: string;
	_enabled: boolean;
	items?: Record<string, boolean>;
	[key: string]: unknown;
}

export function readStatePath(): string | null {
	const env = process.env.ZN_READ_STATE;
	if (env === "off") return null;
	if (env) return env;
	return join(configDir(), "zotero-next-gpui", "read-state.json");
}

function parseDateMs(str: string | undefined | null): number {
	if (!str) return 0;
	const s = String(str).trim();
	if (!s) return 0;
	const iso = s.includes("T") ? s : s.replace(" ", "T") + "Z";
	const parsed = Date.parse(iso);
	if (!isNaN(parsed)) return parsed;
	const direct = Date.parse(s);
	return isNaN(direct) ? 0 : direct;
}

function loadInitial(): { installedAt: string; enabled: boolean; items: Record<string, boolean> } {
	const p = readStatePath();
	const now = new Date().toISOString();
	if (!p || !existsSync(p)) {
		return { installedAt: now, enabled: true, items: {} };
	}
	try {
		const raw = JSON.parse(readFileSync(p, "utf8")) as ReadStateFile;
		const installedAt =
			typeof raw._installedAt === "string" ? raw._installedAt : typeof raw.installedAt === "string" ? raw.installedAt : now;
		const enabled = typeof raw._enabled === "boolean" ? raw._enabled : typeof raw.enabled === "boolean" ? raw.enabled : true;
		const items: Record<string, boolean> = {};
		if (raw.items && typeof raw.items === "object") {
			for (const [k, v] of Object.entries(raw.items)) {
				if (typeof v === "boolean") items[k] = v;
			}
		}
		for (const [k, v] of Object.entries(raw)) {
			if (k.startsWith("_") || k === "items" || k === "installedAt" || k === "enabled" || k === "version") continue;
			if (typeof v === "boolean") items[k] = v;
		}
		return { installedAt, enabled, items };
	} catch {
		return { installedAt: now, enabled: true, items: {} };
	}
}

const initial = loadInitial();

const [enabled, setEnabledSig] = createSignal<boolean>(initial.enabled);
const [installedAt, setInstalledAtSig] = createSignal<string>(initial.installedAt);
let installedAtMs = parseDateMs(initial.installedAt);

// Reactive Solid store for individual item states: items[key] is true (read) or false (unread).
const [items, setItems] = createStore<Record<string, boolean>>(initial.items);

let saveTimer: Timer | number | undefined;

function persist(): void {
	const p = readStatePath();
	if (!p) return;
	try {
		mkdirSync(dirname(p), { recursive: true });
		const out: ReadStateFile = {
			_version: 1,
			_installedAt: installedAt(),
			_enabled: enabled(),
			items: { ...items },
		};
		const temp = `${p}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(temp, JSON.stringify(out, null, 2), "utf8");
		renameSync(temp, p);
	} catch {
		/* ignore write errors */
	}
}

function scheduleSave(): void {
	clearTimeout(saveTimer);
	saveTimer = setTimeout(() => {
		saveTimer = undefined;
		persist();
	}, 200);
}

// Initial flush if the file didn't exist yet so installedAt is persisted immediately
if (readStatePath() && !existsSync(readStatePath()!)) {
	persist();
}

export const readState = {
	enabled(): boolean {
		return enabled();
	},
	setEnabled(on: boolean): void {
		if (enabled() === on) return;
		setEnabledSig(on);
		scheduleSave();
	},
	installedAt(): string {
		return installedAt();
	},
	setInstalledAt(iso: string): void {
		setInstalledAtSig(iso);
		installedAtMs = parseDateMs(iso);
		scheduleSave();
	},
	/**
	 * Single reactive lookup.
	 * Returns true if the item should display an unread dot.
	 */
	isUnread(item: { key: string; dateAdded?: string }): boolean {
		if (!enabled()) return false;
		const v = items[item.key];
		if (v === true) return false;
		if (v === false) return true;
		// Item was never explicitly marked: compare dateAdded to feature installation time.
		if (!item.dateAdded) return false;
		const itemMs = parseDateMs(item.dateAdded);
		return itemMs > installedAtMs;
	},
	isKeyUnread(key: string, dateAdded?: string): boolean {
		return readState.isUnread({ key, dateAdded });
	},
	markRead(keys: string | string[]): void {
		const list = Array.isArray(keys) ? keys : [keys];
		let changed = false;
		for (const k of list) {
			if (!k) continue;
			if (items[k] !== true) {
				setItems(k, true);
				changed = true;
			}
		}
		if (changed) scheduleSave();
	},
	markUnread(keys: string | string[]): void {
		const list = Array.isArray(keys) ? keys : [keys];
		let changed = false;
		for (const k of list) {
			if (!k) continue;
			if (items[k] !== false) {
				setItems(k, false);
				changed = true;
			}
		}
		if (changed) scheduleSave();
	},
	flush(): void {
		if (saveTimer !== undefined) {
			clearTimeout(saveTimer);
			saveTimer = undefined;
		}
		persist();
	},
};
