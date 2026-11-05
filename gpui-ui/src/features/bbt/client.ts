// Client for /api/bbt/* (contract: core/src/bbt/types.ts).
import { createSignal } from "solid-js";
import type { AutoExport, AutoExportOptions, AutoExportScope, BbtExportFormat, BbtSettings, KeyInfo } from "../../../../core/src/bbt/types";
import { get, post } from "../http";

export type { AutoExport, AutoExportOptions, AutoExportScope, BbtExportFormat, BbtSettings, KeyInfo };

export interface FormulaCheck { ok: boolean; error?: string; preview?: string; position?: number }
export interface SettingsResult { settings: BbtSettings; staleKeys: number; formulaError: string | null }

/** Bumped when keys may have changed (pin, unpin, refresh, formula change) so the item pane re-reads its key. */
export const [bbtRev, setBbtRev] = createSignal(0);
export const bumpBbt = () => setBbtRev((n) => n + 1);

export const bbtApi = {
	settings: () => get<BbtSettings>("/api/bbt/settings"),
	putSettings: (patch: Partial<BbtSettings>) => post<SettingsResult>("/api/bbt/settings", { patch }),
	formula: (formula: string, itemKey?: string) => post<FormulaCheck>("/api/bbt/formula", itemKey ? { formula, itemKey } : { formula }),
	keys: (items: string[]) => get<{ keys: Record<string, KeyInfo | null> }>(`/api/bbt/keys?items=${encodeURIComponent(items.join(","))}`).then((r) => r.keys),
	pin: (itemKey: string, key?: string) => post<KeyInfo>("/api/bbt/pin", key === undefined ? { itemKey } : { itemKey, key }),
	unpin: (itemKey: string) => post<KeyInfo>("/api/bbt/unpin", { itemKey }),
	refresh: (items?: string[]) => post<{ updated: number }>("/api/bbt/refresh", items ? { items } : {}),
	cite: (b: { items: string[]; format?: string; command?: string }) => post<{ text: string }>("/api/bbt/cite", b),
	autoExports: () => get<{ exports: AutoExport[] }>("/api/bbt/autoexports").then((r) => r.exports),
	addAutoExport: (b: { path: string; format: BbtExportFormat; scope: AutoExportScope; trigger?: "change" | "idle"; options?: AutoExportOptions }) =>
		post<AutoExport>("/api/bbt/autoexports", b),
	removeAutoExport: (id: number) => post<{ removed: boolean }>("/api/bbt/autoexports/remove", { id }),
	runAutoExport: (id: number) => post<AutoExport>("/api/bbt/autoexports/run", { id }),
};
