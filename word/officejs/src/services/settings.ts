// Per-user add-in settings, matching word/addin/Settings.cs:
//   - same keys and patch semantics (null or "" deletes a key);
//   - same PageKeys whitelist enforced on settings.set (PatchFromPage);
//   - persisted with Office.context.roamingSettings when available, else localStorage, else in-memory.

export const SETTINGS_STORAGE_KEY = "zinc.settings";
export const DEFAULT_API_BASE = "http://127.0.0.1:23120";

/** Keys the sidebar page may change (Settings.cs PageKeys). Everything else (apiBase, launcher, ...) is protected. */
export const PAGE_KEYS: ReadonlySet<string> = new Set(["style", "locale", "noteType", "autoUpdate", "dbPath", "userId"]);

export interface RoamingSettingsLike {
	get(name: string): unknown;
	set(name: string, value: unknown): void;
	remove?(name: string): void;
	saveAsync?(callback?: (result: { status?: unknown; error?: { message?: string } }) => void): unknown;
}

export interface StorageBackend {
	read(): Record<string, unknown>;
	write(data: Record<string, unknown>): Promise<void>;
}

export interface SettingsStore {
	load(): Record<string, unknown>;
	patchFromPage(patch: Record<string, unknown>): Promise<Record<string, unknown>>;
	patchInternal(patch: Record<string, unknown>): Promise<Record<string, unknown>>;
	getString(key: string): string | null;
	apiBase(): string;
}

function getOffice(): any {
	return (globalThis as { Office?: any }).Office;
}

function getLocalStorage(): Storage | undefined {
	try {
		return (globalThis as { localStorage?: Storage }).localStorage;
	} catch {
		// sandboxed iframe with storage disabled
		return undefined;
	}
}

function normalizeLoaded(raw: unknown): Record<string, unknown> {
	if (typeof raw === "string") {
		if (!raw.trim()) return {};
		try {
			const parsed = JSON.parse(raw) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { ...(parsed as Record<string, unknown>) };
		} catch {
			// corrupt stored JSON: fall back to empty settings as Settings.cs does
		}
		return {};
	}
	if (raw && typeof raw === "object" && !Array.isArray(raw)) return { ...(raw as Record<string, unknown>) };
	return {};
}

async function saveRoamingAsync(rs: RoamingSettingsLike): Promise<void> {
	if (typeof rs.saveAsync !== "function") return;
	const office = getOffice();
	const failedStatus = office?.AsyncResultStatus?.Failed ?? "failed";
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const done = (err?: Error) => {
			if (settled) return;
			settled = true;
			if (err) reject(err);
			else resolve();
		};
		const expectsCallback = rs.saveAsync!.length > 0;
		const ret = rs.saveAsync!((res) => {
			if (res && (res.status === "failed" || res.status === failedStatus)) {
				done(new Error(res.error?.message ?? "Failed to save Office roamingSettings"));
			} else {
				done();
			}
		});
		if (ret && typeof (ret as PromiseLike<unknown>).then === "function") {
			(ret as PromiseLike<unknown>).then(
				() => done(),
				(e) => done(e instanceof Error ? e : new Error(String(e))),
			);
		} else if (!expectsCallback) {
			queueMicrotask(() => done());
		}
	});
}

/** Default persistence: Office.context.roamingSettings when available on each call, else localStorage, else memory. */
export function createDefaultStorageBackend(): StorageBackend {
	let mem: Record<string, unknown> = {};
	return {
		read(): Record<string, unknown> {
			const rs = getOffice()?.context?.roamingSettings as RoamingSettingsLike | undefined;
			if (rs && typeof rs.get === "function") {
				return normalizeLoaded(rs.get(SETTINGS_STORAGE_KEY));
			}
			const ls = getLocalStorage();
			if (ls && typeof ls.getItem === "function") {
				return normalizeLoaded(ls.getItem(SETTINGS_STORAGE_KEY));
			}
			return { ...mem };
		},
		async write(data: Record<string, unknown>): Promise<void> {
			const copy = { ...data };
			mem = copy;
			const rs = getOffice()?.context?.roamingSettings as RoamingSettingsLike | undefined;
			if (rs && typeof rs.set === "function") {
				rs.set(SETTINGS_STORAGE_KEY, copy);
				await saveRoamingAsync(rs);
				return;
			}
			const ls = getLocalStorage();
			if (ls && typeof ls.setItem === "function") {
				ls.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(copy));
			}
		},
	};
}

function isAllowedSettingValue(v: unknown): boolean {
	return (
		v === null || v === undefined || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))
	);
}

function applyPatch(cur: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
	const next: Record<string, unknown> = { ...cur };
	for (const [k, v] of Object.entries(patch)) {
		if (v === null || v === undefined || v === "") delete next[k];
		else next[k] = v;
	}
	return next;
}

export function createSettingsStore(opts: { storage?: StorageBackend; defaultApiBase?: string } = {}): SettingsStore {
	const backend = opts.storage ?? createDefaultStorageBackend();
	const fallbackBase = (opts.defaultApiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "");

	function load(): Record<string, unknown> {
		return backend.read();
	}

	async function patchInternal(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
		const next = applyPatch(load(), patch);
		await backend.write(next);
		return { ...next };
	}

	async function patchFromPage(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
		if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
			throw new Error("settings patch must be an object");
		}
		for (const [k, v] of Object.entries(patch)) {
			if (!PAGE_KEYS.has(k)) throw new Error("setting not changeable from the sidebar: " + k);
			if (!isAllowedSettingValue(v)) throw new Error("setting " + k + " must be a string, number or boolean");
		}
		return patchInternal(patch);
	}

	function getString(key: string): string | null {
		const v = load()[key];
		if (v === null || v === undefined) return null;
		const s = String(v);
		return s.length > 0 ? s : null;
	}

	function apiBase(): string {
		const configured = getString("apiBase");
		return (configured ?? fallbackBase).replace(/\/+$/, "");
	}

	return { load, patchFromPage, patchInternal, getString, apiBase };
}
