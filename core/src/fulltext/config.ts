// Settings (JSON file next to the library DB) and the EngineConfig built from them.
// Defaults mirror plugin/content/config.js of zotero-fulltext, with King's College London as the institution.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
	/** Items processed at once. Default 4. */
	concurrency?: number;
	/** Deep-merged over the generated EngineConfig (oa / inst / run / institution), for anything else. */
	engine?: { oa?: Record<string, unknown>; inst?: Record<string, unknown>; run?: Record<string, unknown>; institution?: Record<string, unknown> };
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

/** KCL's EZproxy host list (zotero-fulltext research/04 section 2.4). */
const KCL_EZPROXY_HOSTS = [
	"doi.org",
	"dx.doi.org",
	"www.bmj.com",
	"www.webofscience.com",
	"www.liebertpub.com",
	"www.jneurosci.org",
	"www.psychiatryonline.org",
	"psychiatryonline.org",
	"www.atsjournals.org",
	"www.ajronline.org",
	"www.jospt.org",
	"www.jove.com",
	"www.elgaronline.com",
	"infoweb.newsbank.com",
	"global.factiva.com",
	"www.portal.euromonitor.com",
	"institutions.newscientist.com",
	"www.lrb.co.uk",
	"libguides.kcl.ac.uk",
];

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
	const n = typeof v === "number" ? v : Number(v);
	if (!Number.isFinite(n)) return dflt;
	return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

function merge(base: Record<string, unknown>, over: Record<string, unknown> | undefined): Record<string, unknown> {
	return over ? { ...base, ...over } : base;
}

export function buildEngineConfig(settings: FulltextSettings = {}): EngineConfig {
	const institutional = settings.institutional !== false;
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
		use_openathens: true,
		use_saml: true,
		use_ezproxy: true,
		check_alma: true,
		// No embedded sign-in browser in this host: the engine hands the user a link instead.
		login_mode: "handoff",
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
	const institution = {
		name: "King's College London",
		openathens_domain: "kcl.ac.uk",
		ezproxy: { login_host: "login.kcl.idm.oclc.org", suffix: "kcl.idm.oclc.org" },
		ezproxy_hosts: KCL_EZPROXY_HOSTS,
		alma: { base: "https://librarysearch.kcl.ac.uk", inst: "44KCL_INST" },
		libkey_library_id: 286,
		idp_hosts: ["login.microsoftonline.com", "login.live.com", "login.openathens.net", "kclidp.kcl.ac.uk"],
		entra_tenant: "8370cf14-16f3-4c16-b83c-724071654356",
		passthrough_hosts: ["journals.lww.com"],
		warmup_url: "",
		saml_entity_id: "https://kclidp.kcl.ac.uk/idp/shibboleth",
		ezproxy_all_hosts: false,
	};
	const e = settings.engine;
	return {
		oa: merge(oa, e?.oa),
		inst: merge(inst, e?.inst),
		run: merge(run, e?.run),
		institution: merge(institution, e?.institution),
		endpoint_map: [],
		trace: false,
	};
}
