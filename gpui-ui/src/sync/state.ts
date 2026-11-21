// Zotero sync state (core /api/sync/*): polled status, conflicts, Sync now, write opt-in. One instance for the whole window,
// shared by the top-bar indicator (SyncStatus.tsx) and the Settings > Sync section.
import { createRoot, createSignal } from "solid-js";
import { call, errMsg } from "../shell/net";
import type { ListStore } from "../contracts";

export interface SyncState {
	enabled: boolean;
	zotero: "closed" | "running" | "missing" | "error";
	dataDir: string;
	pending: number;
	lastPullAt?: string;
	lastPushAt?: string;
	lastBackup?: string;
	lastError?: string;
	conflicts: number;
	changeCount?: number;
	busy?: boolean;
}
export interface SyncConflict {
	id: number;
	type: string;
	key: string;
	title: string;
	local: unknown;
	remote: unknown;
	resolved: "local" | "remote";
	at: string;
}

export const ZOTERO_LABEL: Record<SyncState["zotero"], string> = {
	closed: "Zotero closed",
	running: "Zotero running",
	missing: "Zotero not found",
	error: "Zotero unreadable",
};

/** Compact view of a conflicting record: the fields worth comparing. */
export function showRecord(v: unknown): string {
	if (v === null || v === undefined) return "(none)";
	if (typeof v !== "object") return String(v);
	const o = v as Record<string, unknown>;
	const out: string[] = [];
	for (const k of [
		"title",
		"name",
		"itemType",
		"date",
		"abstractNote",
		"note",
		"text",
		"comment",
		"url",
		"publicationTitle",
		"dateModified",
	]) {
		const x = o[k];
		if (x === undefined || x === "") continue;
		const s = typeof x === "string" ? (x.length > 160 ? `${x.slice(0, 160)}…` : x) : String(x);
		out.push(`${k}: ${s}`);
	}
	if (Array.isArray(o.tags)) out.push(`tags: ${(o.tags as { tag?: string }[]).map((t) => t.tag).join(", ")}`);
	return out.join("\n") || "(no comparable fields)";
}

const POLL_MS = 5000;

function create() {
	const [status, setStatus] = createSignal<SyncState | null>(null);
	const [conflicts, setConflicts] = createSignal<SyncConflict[]>([]);
	const [working, setWorking] = createSignal(false);
	const [error, setError] = createSignal("");
	/** false once the sync service has been unreachable (the indicator shows "Zotero" only) */
	const [reachable, setReachable] = createSignal(true);
	let lastChange: number | undefined;
	let onChanged: (() => void) | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let wantConflicts = false;

	const apply = (s: SyncState) => {
		if (lastChange !== undefined && s.changeCount !== undefined && s.changeCount !== lastChange) onChanged?.();
		lastChange = s.changeCount;
		setStatus(s);
		setReachable(true);
	};
	const loadConflicts = async () => setConflicts((await call<{ conflicts: SyncConflict[] }>("GET", "/api/sync/conflicts")).conflicts);

	async function refresh(): Promise<void> {
		try {
			apply(await call<SyncState>("GET", "/api/sync/status"));
			if (wantConflicts) await loadConflicts();
		} catch {
			setReachable(false); // keep the last known state
		}
	}
	async function run(fn: () => Promise<SyncState>): Promise<boolean> {
		setWorking(true);
		setError("");
		try {
			apply(await fn());
			await loadConflicts().catch(() => {});
			return true;
		} catch (e) {
			setError(errMsg(e));
			return false;
		} finally {
			setWorking(false);
		}
	}

	return {
		status,
		conflicts,
		working,
		error,
		reachable,
		/** Start polling (idempotent). Returns true when polling just started (and triggered an initial refresh). */
		start(changed?: () => void): boolean {
			if (changed) onChanged = changed;
			if (timer) return false;
			void refresh();
			timer = setInterval(() => void refresh(), POLL_MS);
			(timer as unknown as { unref?: () => void }).unref?.();
			return true;
		},
		refresh,
		/** The popover / Settings page is showing conflicts: load and keep them fresh. */
		watchConflicts(on: boolean) {
			wantConflicts = on;
			if (on) void refresh();
		},
		syncNow: () => run(() => call<SyncState>("POST", "/api/sync/now")),
		setEnabled: (enabled: boolean) => run(() => call<SyncState>("POST", "/api/sync/enable", { enabled })),
		async dismiss(id?: number) {
			try {
				await call("DELETE", id === undefined ? "/api/sync/conflicts" : `/api/sync/conflicts?id=${id}`);
				await refresh();
				await loadConflicts();
			} catch (e) {
				setError(errMsg(e));
			}
		},
		clearError: () => setError(""),
		busy: () => working() || !!status()?.busy,
	};
}

export const sync = createRoot(create);

/** Lists to reload after a pull brought changes in (ListStore.refresh when the store has it). */
export function refreshLibraryLists(store: unknown): void {
	(store as Partial<ListStore>).refresh?.();
}
