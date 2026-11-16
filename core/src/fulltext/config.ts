// Settings (JSON file next to the library DB) and the EngineConfig built from them.
// Defaults mirror plugin/content/config.js of zotero-fulltext. Its default institution (King's College London) is only
// the default: settings.institution replaces it (see ./institutions.ts for the presets and the derivation).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type InstitutionSettings, resolveInstitution } from "./institutions";
import type { EngineConfig } from "./proto";

export const PROTOCOL = 1;

export interface FulltextSettings {
	/** Unpaywall needs an email; empty = Unpaywall stays off. */
	unpaywallEmail?: string;
	openalexKey?: string;
	semanticScholarKey?: string;
	coreKey?: string;
	/** false = never use institutional routes (open access only). Default true. */
	institutional?: boolean;
	/** The user's institution (name, OpenAthens domain, Shibboleth entityID, library proxy). Absent = the engine default. */
	institution?: InstitutionSettings;
	/** Items processed at once. Default 4. */
	concurrency?: number;
	/** Deep-merged over the generated EngineConfig (oa / inst / run / institution), for anything else. */
	engine?: {
		oa?: Record<string, unknown>;
		inst?: Record<string, unknown>;
		run?: Record<string, unknown>;
		institution?: Record<string, unknown>;
	};
}

export function settingsPath(dataDir: string): string {
	return join(dataDir, "fulltext-settings.json");
}

export function loadSettings(dataDir: string): FulltextSettings {
	const p = settingsPath(dataDir);
	if (!existsSync(p)) return {};
	try {
		const v = JSON.parse(readFileSync(p, "utf8"));
		return v && typeof v === "object" && !Array.isArray(v) ? (v as FulltextSettings) : {};
	} catch {
		return {};
	}
}

/** Atomic write (temp file + rename). Throws on I/O errors. */
export function saveSettings(dataDir: string, settings: FulltextSettings): void {
	const p = settingsPath(dataDir);
	mkdirSync(dirname(p), { recursive: true });
	const tmp = `${p}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
	renameSync(tmp, p);
}

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
	const n = typeof v === "number" ? v : Number(v);
	if (!Number.isFinite(n)) return dflt;
	return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

function merge(base: Record<string, unknown>, over: Record<string, unknown> | undefined): Record<string, unknown> {
	return over ? { ...base, ...over } : base;
}

export interface BuildOptions {
	/** The desktop app registered an embedded browser: sign-in uses a window (unless the settings force a hand-off). */
	embeddedBrowser?: boolean;
}

export function buildEngineConfig(settings: FulltextSettings = {}, opts: BuildOptions = {}): EngineConfig {
	const resolved = resolveInstitution(settings.institution);
	const institutional = settings.institutional !== false && resolved.enabled;
	const oa = {
		openalex: true,
		openalex_key: settings.openalexKey ?? "",
		europepmc: true,
		biorxiv: true,
		pmc_s3: true,
		europepmc_get_pdf: true,
		medrxiv_early: true,
		arxiv: true,
		// Zotero's private Unpaywall mirror only exists inside Zotero.
		zotero_oa: false,
		unpaywall_email: settings.unpaywallEmail ?? "",
		semantic_scholar_key: settings.semanticScholarKey ?? "",
		core_key: settings.coreKey ?? "",
		version_order: ["published", "accepted", "submitted"],
	};
	const inst = {
		enabled: institutional,
		try_direct: true,
		use_openathens: resolved.methods.includes("openathens"),
		use_saml: resolved.methods.includes("saml"),
		use_ezproxy: resolved.methods.includes("ezproxy"),
		check_alma: !!resolved.engine.alma,
		// With an embedded browser (the desktop app) sign-in happens in a window; otherwise the engine hands the user a link.
		login_mode: opts.embeddedBrowser && resolved.loginMode !== "handoff" ? "window" : "handoff",
		auto_open_login: false,
		login_timeout_sec: 300,
		group_libraries: "never",
		confirm_above: 100000,
		batch_max: 20,
		hourly_cap: 30,
		daily_cap: 80,
		mb_per_hour: 300,
		min_gap_sec: 5,
		challenge_windows: false,
	};
	const run = {
		item_concurrency: clampInt(settings.concurrency, 1, 8, 4),
		hedge: true,
		pdf_max_mb: 100,
	};
	const e = settings.engine;
	return {
		oa: merge(oa, e?.oa),
		inst: merge(inst, e?.inst),
		run: merge(run, e?.run),
		institution: merge({ ...resolved.engine } as unknown as Record<string, unknown>, e?.institution),
		endpoint_map: [],
		trace: false,
	};
}
