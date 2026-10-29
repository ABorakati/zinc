// Find Full Text service: owns the wasm engine for one library DB, runs jobs and maps engine progress/outcomes onto
// the FullTextJob contract of core/src/api-types.ts.

import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
	FullTextInstitutionHit,
	FullTextItemState,
	FullTextJob,
	FullTextSettingsPatch,
	FullTextSettingsView,
	FullTextSignInResult,
	FullTextSignInStatus,
} from "../api-types";
import { HttpError } from "../db";
import { extractFulltext } from "../extract";
import { BodyStore } from "./bodies";
import { getBrowserBridge } from "./browser-bridge";
import { buildEngineConfig, type FulltextSettings, loadSettings, PROTOCOL, saveSettings } from "./config";
import {
	type EngineInstitution,
	normalizeInstitution,
	parseFederationSearch,
	resolveInstitution,
	searchPresets,
	sessionHosts,
	warmupTarget,
} from "./institutions";
import { SIGNED_IN_MS } from "./login";
import { PersistStore, Runner, type RunnerDeps } from "./host";
import { type FetchFn, HttpClient } from "./http";
import { snapshotItems } from "./items";
import type { Handoff, ItemId, Outcome, ProgressRow, RunId, RunReport } from "./proto";
import { savePdf } from "./save";
import { WasmHost } from "./wasm";

export interface ServiceOptions {
	/** Where storage/ and the settings/state files live. Default: the directory of the library DB. */
	dataDir?: string;
	/** fetch implementation (tests inject a mock). */
	fetch?: FetchFn;
	/** Settings instead of <dataDir>/fulltext-settings.json. */
	settings?: FulltextSettings;
	/** Text extraction after a PDF was attached. Default: core/src/extract extractFulltext. */
	extract?: (db: Database, attachmentKey: string) => Promise<unknown>;
	/** Loaded wasm host (tests share one). */
	wasm?: WasmHost;
}

type JobItem = FullTextJob["items"][number];

interface Job {
	id: string;
	run: RunId | null;
	items: JobItem[];
	byItemId: Map<ItemId, number>;
	done: boolean;
	cancelled: boolean;
	listeners: Set<(j: FullTextJob) => void>;
	finished: Promise<void>;
	finish: () => void;
}

const SOURCE_LABELS: Record<string, string> = {
	openalex: "OpenAlex",
	europepmc: "Europe PMC",
	biorxiv: "bioRxiv / medRxiv",
	pmc_s3: "PubMed Central",
	arxiv: "arXiv",
	unpaywall: "Unpaywall",
	zotero_oa: "Zotero OA",
	semantic_scholar: "Semantic Scholar",
	core: "CORE",
	alma: "Library catalogue",
	item_url: "Item URL",
	doi: "DOI",
	translator: "Publisher page",
	extractor: "Publisher page",
	redirector: "OpenAthens",
	ezproxy: "EZproxy",
};

const STATUS_TEXT: Record<string, string> = {
	queued: "Waiting",
	"waiting-confirm": "Waiting",
	checking: "Checking the item",
	"searching-oa": "Searching open access sources",
	downloading: "Downloading",
	"waiting-host": "Waiting for a publisher rate limit",
	"waiting-login": "Waiting for sign-in",
	"signing-in": "Signing in",
	institutional: "Trying institutional access",
	challenge: "The site shows a bot check",
	saving: "Saving the PDF",
	"network-down": "Network is down",
	"saved-oa": "Open access PDF attached",
	"saved-inst": "PDF attached through institutional access",
	"skipped-has-pdf": "Already has a PDF",
	"skipped-not-downloaded": "The existing PDF is not downloaded",
	"not-editable": "The library is read only",
	"skipped-not-regular": "Not a regular item",
	"skipped-in-progress": "Already being fetched",
	"no-identifier": "No DOI or other identifier",
	"not-found": "No full text found",
	"not-found-oa-only": "No open access full text found",
	"not-entitled": "Not available through your institution",
	"needs-login": "Sign-in needed",
	"login-declined": "Sign-in declined",
	"login-timeout": "Sign-in timed out",
	"login-refused": "Sign-in was refused",
	"login-ineffective": "Sign-in did not give access",
	misconfigured: "Institutional access is not set up",
	"needs-user": "Needs you: open the link in your browser",
	"no-pdf-link": "No PDF link found on the page",
	"group-library": "Group library skipped",
	"engine-restarted": "The finder restarted; try again",
	blocked: "The publisher blocked automatic access",
	"cap-reached": "Download limit reached; try later",
	halted: "Institutional access is paused",
	cancelled: "Cancelled",
	"timed-out": "Timed out",
	failed: "Failed",
};

const PREFIX = "zotero-fulltext-status-";

function sourceLabel(route: string | undefined, source: string): string {
	const base = SOURCE_LABELS[source] ?? source;
	return route === "inst" ? `Institutional access (${base})` : base;
}

function handoffUrl(h: Handoff | undefined): string | undefined {
	if (!h) return undefined;
	return h.redirector_url ?? h.libkey_url ?? h.ezproxy_url ?? h.doi_url ?? undefined;
}

function randomSeed(): number {
	const w = crypto.getRandomValues(new Uint32Array(2));
	return (w[0] & 0x1fffff) * 4294967296 + w[1];
}

export class FulltextService {
	readonly dataDir: string;
	private opts: ServiceOptions;
	private jobs = new Map<string, Job>();
	private runToJob = new Map<RunId, Job>();
	private runner: Runner | null = null;
	private ready: Promise<void> | null = null;
	private configHash = "";
	private nextRun = 1;
	private nextItem = 1; // engine item ids are unique across runs
	private pending = new Set<Promise<unknown>>();
	private bodies: BodyStore;
	private state: PersistStore;
	private http: HttpClient;
	private wasm: WasmHost | null = null;
	/** engine item id -> library key, per run */
	private keyOf = new Map<RunId, Map<ItemId, string>>();
	private ezproxySuffix = "";
	private signInAbort = new AbortController();

	constructor(
		private db: Database,
		opts: ServiceOptions = {},
	) {
		this.opts = opts;
		const file = (db as unknown as { filename?: string }).filename;
		this.dataDir = opts.dataDir ?? (file && file !== ":memory:" ? dirname(file) : join(process.env.TEMP ?? ".", "zotero-next-fulltext"));
		mkdirSync(this.dataDir, { recursive: true });
		this.bodies = new BodyStore(join(this.dataDir, "storage", ".fulltext-tmp"));
		this.bodies.sweep();
		this.state = new PersistStore(join(this.dataDir, "fulltext-state.json"));
		this.http = new HttpClient({ fetch: opts.fetch });
	}

	// ------------------------------------------------------------ setup

	private settings(): FulltextSettings {
		return this.opts.settings ?? loadSettings(this.dataDir);
	}

	private async init(): Promise<void> {
		this.wasm = this.opts.wasm ?? (await WasmHost.load());
		const deps: RunnerDeps = {
			wasm: this.wasm,
			http: this.http,
			bodies: this.bodies,
			state: this.state,
			save: (req) =>
				savePdf(
					{
						db: this.db,
						dataDir: this.dataDir,
						bodies: this.bodies,
						keyOfItem: (item) => this.keyForItem(item),
						ezproxySuffix: this.ezproxySuffix,
						afterSave: (key) => this.afterSave(key),
					},
					req,
				),
			institutionName: () => resolveInstitution(this.settings().institution).name,
			// Imported lazily: api.ts imports this module (via fulltext/api.ts).
			openExternal: (url) => {
				import("../api").then((m) => m.openUrlExternally(url)).catch((e) => console.warn("open in browser failed", e));
			},
			onProgress: (run, item, row) => this.onProgress(run, item, row),
			onRunFinished: (report) => this.onRunFinished(report),
		};
		this.runner = new Runner(deps);
		this.configure();
	}

	private configure(): void {
		const cfg = buildEngineConfig(this.settings(), { embeddedBrowser: getBrowserBridge() !== null });
		const hash = JSON.stringify(cfg);
		const ez = (cfg.institution as { ezproxy?: { suffix?: string } | null }).ezproxy;
		this.ezproxySuffix = ez?.suffix ?? "";
		if (hash === this.configHash && !this.runner!.needsConfigure) return;
		this.runner!.send([{ type: "configure", protocol: PROTOCOL, config: cfg, persisted: this.state.get(), seed: randomSeed() }]);
		this.configHash = hash;
	}

	private keyForItem(item: ItemId): string | undefined {
		for (const m of this.keyOf.values()) {
			const k = m.get(item);
			if (k) return k;
		}
		return undefined;
	}

	private afterSave(attachmentKey: string): void {
		const extract = this.opts.extract ?? ((db, key) => extractFulltext(db, key));
		const p = Promise.resolve()
			.then(() => extract(this.db, attachmentKey))
			.catch((e) => console.warn("fulltext: text extraction failed", e));
		this.pending.add(p);
		void p.finally(() => this.pending.delete(p));
	}

	/** Resolves when background text extraction of attached PDFs has finished (tests). */
	async idle(): Promise<void> {
		while (this.pending.size) await Promise.allSettled(Array.from(this.pending));
	}

	// ------------------------------------------------------------ jobs

	private async boot(): Promise<void> {
		if (!this.ready) {
			this.ready = this.init();
			this.ready.catch(() => {
				this.ready = null;
			});
		}
		try {
			await this.ready;
		} catch (e) {
			throw new HttpError(500, `Find Full Text could not start: ${e instanceof Error ? e.message : e}`);
		}
	}

	async start(keys: string[], openAccessOnly = false): Promise<string> {
		await this.boot();
		const runner = this.runner!;
		if (runner.activeRuns() === 0) this.configure();
		else if (runner.needsConfigure) this.configure();

		const { items, missing } = snapshotItems(this.db, keys, this.nextItem);
		this.nextItem += items.length;
		let doneResolve!: () => void;
		const job: Job = {
			id: crypto.randomUUID(),
			run: null,
			items: [],
			byItemId: new Map(),
			done: false,
			cancelled: false,
			listeners: new Set(),
			finished: new Promise<void>((r) => (doneResolve = r)),
			finish: () => doneResolve(),
		};
		for (const m of missing) job.items.push({ key: m, title: "", state: "failed", message: "Item not found" });
		for (const it of items) {
			job.byItemId.set(it.snapshot.item, job.items.length);
			job.items.push({ key: it.key, title: it.title, state: "queued" });
		}
		this.jobs.set(job.id, job);
		while (this.jobs.size > 50) {
			const oldest = this.jobs.keys().next().value!;
			if (this.jobs.get(oldest)?.done) this.jobs.delete(oldest);
			else break;
		}
		if (items.length === 0) {
			job.done = true;
			job.finish();
			return job.id;
		}
		const run = this.nextRun++;
		job.run = run;
		this.runToJob.set(run, job);
		this.keyOf.set(run, new Map(items.map((i) => [i.snapshot.item, i.key])));
		runner.send([
			{ type: "start_run", run, mode: openAccessOnly ? "oa_only" : "full", interactive: false, items: items.map((i) => i.snapshot), resume: [] },
		]);
		return job.id;
	}

	// ------------------------------------------------------------ settings, institutions, sign-in

	settingsView(): FullTextSettingsView {
		const st = this.settings();
		const r = resolveInstitution(st.institution);
		return {
			institution: {
				id: r.id,
				name: r.name,
				realm: r.realm,
				openathensDomain: r.openathensDomain,
				shibbolethEntityId: r.shibbolethEntityId,
				proxyPrefix: r.proxyPrefix,
				...(r.loginMode ? { loginMode: r.loginMode } : {}),
			},
			methods: r.methods,
			institutional: st.institutional !== false && r.enabled,
			unpaywallEmail: st.unpaywallEmail ?? "",
			concurrency: typeof st.concurrency === "number" ? st.concurrency : 4,
			embeddedBrowser: getBrowserBridge() !== null,
			isDefaultInstitution: !st.institution,
		};
	}

	/** Validate, merge and save the patch. Throws HttpError(400) for bad input. Applies to the next run. */
	updateSettings(patch: FullTextSettingsPatch): FullTextSettingsView {
		if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new HttpError(400, "settings must be an object");
		const next: FulltextSettings = { ...this.settings() };
		if (patch.institution !== undefined) {
			if (patch.institution === null) delete next.institution;
			else {
				try {
					next.institution = normalizeInstitution(patch.institution);
				} catch (e) {
					throw new HttpError(400, e instanceof Error ? e.message : "invalid institution");
				}
			}
		}
		if (patch.institutional !== undefined) {
			if (typeof patch.institutional !== "boolean") throw new HttpError(400, "institutional must be a boolean");
			next.institutional = patch.institutional;
		}
		if (patch.unpaywallEmail !== undefined) {
			const e = typeof patch.unpaywallEmail === "string" ? patch.unpaywallEmail.trim() : null;
			if (e === null || (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) || e.length > 254) throw new HttpError(400, "unpaywallEmail is not a valid email address");
			next.unpaywallEmail = e;
		}
		if (patch.concurrency !== undefined) {
			const n = Number(patch.concurrency);
			if (!Number.isInteger(n) || n < 1 || n > 8) throw new HttpError(400, "concurrency must be a whole number from 1 to 8");
			next.concurrency = n;
		}
		try {
			saveSettings(this.dataDir, next);
		} catch (e) {
			throw new HttpError(500, `could not save the settings: ${e instanceof Error ? e.message : e}`);
		}
		if (this.opts.settings) this.opts.settings = next;
		if (this.runner && this.runner.activeRuns() === 0) this.configure();
		return this.settingsView();
	}

	/** Built-in institutions filtered by q, then (q of 3+ characters) identity providers of the federation metadata. */
	async searchInstitutions(q: string): Promise<FullTextInstitutionHit[]> {
		const query = (q ?? "").trim();
		const hits: FullTextInstitutionHit[] = searchPresets(query).map((p) => ({
			id: p.id,
			name: p.name,
			openathensDomain: p.openathensDomain,
			shibbolethEntityId: p.shibbolethEntityId,
			proxyPrefix: p.proxyPrefix,
			methods: p.methods,
			source: "preset",
		}));
		if (query.length < 3) return hits;
		const known = new Set(hits.map((h) => h.shibbolethEntityId).filter(Boolean));
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), 3000);
		try {
			const f = this.opts.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));
			const res = await f(`https://md.seamlessaccess.org/entities/?q=${encodeURIComponent(query)}`, { signal: ac.signal, headers: { Accept: "application/json" } });
			if (res.ok) {
				for (const h of parseFederationSearch(await res.json())) {
					if (known.has(h.shibbolethEntityId)) continue;
					hits.push({ name: h.name, shibbolethEntityId: h.shibbolethEntityId, methods: ["saml"], source: "federation" });
				}
			}
		} catch {
			/* offline or blocked: the built-in list is enough */
		} finally {
			clearTimeout(timer);
		}
		return hits;
	}

	private institutionNow() {
		const cfg = buildEngineConfig(this.settings(), { embeddedBrowser: true });
		const r = resolveInstitution(this.settings().institution);
		return { cfg, r, engine: cfg.institution as unknown as EngineInstitution };
	}

	/** Warm-up: the sign-in window of the configured institution. */
	async signIn(): Promise<FullTextSignInResult> {
		const { cfg, r, engine } = this.institutionNow();
		const name = engine.name || r.name;
		if (!getBrowserBridge()) return { result: "unavailable", institution: name };
		const target = r.enabled ? warmupTarget(engine) : null;
		if (!target) return { result: "no_method", institution: name };
		await this.boot();
		const seconds = Number((cfg.inst as { login_timeout_sec?: number }).login_timeout_sec);
		const res = await this.runner!.login.warmUp(target.url, target.realm, seconds > 0 ? seconds * 1000 : 0, this.signInAbort.signal);
		return { result: res.result, institution: name, ...(res.caError ? { caError: res.caError } : {}) };
	}

	async signInStatus(): Promise<FullTextSignInStatus> {
		const bridge = getBrowserBridge();
		const { r, engine } = this.institutionNow();
		const out: FullTextSignInStatus = { available: !!bridge, signedIn: false, realm: r.realm, institution: r.name, methods: r.methods };
		if (!bridge || !r.enabled) return out;
		const at = this.runner?.login.signedInAt ?? 0;
		if (at && Date.now() - at < SIGNED_IN_MS) {
			out.signedIn = true;
			return out;
		}
		const now = Date.now() / 1000;
		for (const host of sessionHosts(engine)) {
			try {
				const cookies = await Promise.race([
					bridge.cookiesFor(`https://${host}/`),
					new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 2000)),
				]);
				if (cookies.some((c) => c.expires === undefined || c.expires > now)) {
					out.signedIn = true;
					break;
				}
			} catch {
				/* unreachable bridge: not signed in as far as we can tell */
			}
		}
		return out;
	}

	getJob(id: string): FullTextJob | null {
		const j = this.jobs.get(id);
		return j ? this.snapshot(j) : null;
	}

	/** Resolves when the job is done (tests). */
	async waitJob(id: string): Promise<FullTextJob> {
		const j = this.jobs.get(id);
		if (!j) throw new HttpError(404, "job not found");
		await j.finished;
		return this.snapshot(j);
	}

	subscribe(id: string, fn: (j: FullTextJob) => void): (() => void) | null {
		const j = this.jobs.get(id);
		if (!j) return null;
		j.listeners.add(fn);
		return () => j.listeners.delete(fn);
	}

	cancel(id: string): boolean {
		const j = this.jobs.get(id);
		if (!j) return false;
		if (j.done || j.run === null) return true;
		j.cancelled = true;
		this.runner!.send([{ type: "cancel_run", run: j.run }]);
		return true;
	}

	async dispose(): Promise<void> {
		this.signInAbort.abort("dispose");
		await this.runner?.dispose();
		this.bodies.releaseAll();
	}

	private snapshot(j: Job): FullTextJob {
		return { id: j.id, done: j.done, items: j.items.map((i) => ({ ...i })) };
	}

	private emit(j: Job): void {
		if (!j.listeners.size) return;
		const snap = this.snapshot(j);
		for (const fn of Array.from(j.listeners)) {
			try {
				fn(snap);
			} catch {
				j.listeners.delete(fn);
			}
		}
	}

	// ------------------------------------------------------------ engine callbacks

	private onProgress(run: RunId, itemId: ItemId, row: ProgressRow): void {
		const job = this.runToJob.get(run);
		if (!job) return;
		const idx = job.byItemId.get(itemId);
		if (idx === undefined) return;
		const cur = job.items[idx];
		const id = row.l10n.startsWith(PREFIX) ? row.l10n.slice(PREFIX.length) : row.l10n;
		const text = STATUS_TEXT[id] ?? id;
		const next: JobItem = { ...cur, message: row.args?.host ? `${text} (${row.args.host})` : text };
		next.state = rowState(id, row.state);
		if (row.route && (next.state === "searching" || next.state === "downloading")) next.source = row.route === "inst" ? "Institutional access" : "Open access";
		const open = row.actions?.find((a) => a.kind === "open_browser" && a.url);
		if (open?.url) next.handoffUrl = open.url;
		if (cur.state === "attached" || cur.state === "cancelled") return; // never walk back from a final state
		job.items[idx] = next;
		this.emit(job);
	}

	private onRunFinished(report: RunReport): void {
		if (process.env.FULLTEXT_DEBUG) console.log("fulltext report", JSON.stringify(report));
		const job = this.runToJob.get(report.run);
		if (!job) return;
		for (const rep of report.items) {
			const idx = job.byItemId.get(rep.item);
			if (idx === undefined) continue;
			job.items[idx] = this.finalItem(job.items[idx], rep.outcome);
		}
		// anything the engine never reported on (should not happen) must not stay "queued" forever
		for (let i = 0; i < job.items.length; i++) {
			const it = job.items[i];
			if (it.state === "queued" || it.state === "searching" || it.state === "downloading") {
				job.items[i] = { ...it, state: job.cancelled ? "cancelled" : "failed", message: job.cancelled ? "Cancelled" : "No result from the engine" };
			}
		}
		job.done = true;
		this.runToJob.delete(report.run);
		this.keyOf.delete(report.run);
		this.emit(job);
		job.finish();
	}

	private finalItem(cur: JobItem, o: Outcome): JobItem {
		const base: JobItem = { key: cur.key, title: cur.title, state: "failed" };
		switch (o.kind) {
			case "saved": {
				const label = sourceLabel(o.route, o.source);
				return { ...base, state: "attached", source: label, message: `PDF attached from ${label}`, attachmentKey: o.attachment_key.split("/").pop() };
			}
			case "skipped": {
				const map: Record<string, [FullTextItemState, string]> = {
					has_pdf: ["already-has-pdf", "Already has a PDF"],
					pdf_added_meanwhile: ["already-has-pdf", "A PDF was added meanwhile"],
					pdf_not_downloaded: ["already-has-pdf", "A PDF record exists but its file is missing"],
					read_only: ["failed", "The library is read only"],
					not_regular: ["failed", "Not a regular item"],
					feed: ["failed", "Feed items are skipped"],
					in_progress_elsewhere: ["failed", "Already being fetched"],
				};
				const [state, message] = map[o.reason] ?? ["failed", `Skipped: ${o.reason}`];
				return { ...base, state, message };
			}
			case "no_identifier":
				return { ...base, state: "not-found", message: "No DOI or other identifier to search with" };
			case "not_found":
				return { ...base, state: "not-found", message: o.reason === "oa_only" ? "No open access full text found" : "No full text found" };
			case "not_entitled": {
				// No open copy was found and the automatic institutional routes did not get in: the hand-off link
				// (OpenAthens / LibKey) is the way forward, so this is a sign-in case like the engine's own counts say.
				const url = handoffUrl(o.handoff);
				return url
					? { ...base, state: "needs-sign-in", source: "Institutional access", message: "No open access copy. Open the link in your browser and sign in with your institution", handoffUrl: url }
					: { ...base, state: "not-found", message: "Not available through your institution" };
			}
			case "needs_user": {
				if (o.why === "network_down" || o.why === "engine_restarted") {
					return { ...base, state: "failed", message: o.why === "network_down" ? "Network is down" : "The finder restarted; try again" };
				}
				const why: Record<string, string> = {
					login_declined: "Sign-in needed: open the link and sign in with your institution",
					login_timeout: "Sign-in needed: open the link and sign in with your institution",
					login_refused: "Sign-in was refused",
					login_ineffective: "Sign-in did not give access",
					misconfigured: "Institutional access is not set up",
					challenge: "The publisher shows a bot check: open the link in your browser",
					no_pdf_link: "No PDF link found: open the page in your browser",
					handoff_requested: "Open the link in your browser to get the PDF",
					group_library: "Group library skipped",
				};
				return { ...base, state: "needs-sign-in", source: "Institutional access", message: why[o.why] ?? `Needs you (${o.why})`, handoffUrl: handoffUrl(o.handoff) };
			}
			case "blocked":
				return { ...base, state: "needs-sign-in", message: `${o.host} blocked automatic access: open the link in your browser`, handoffUrl: handoffUrl(o.handoff) };
			case "deferred":
				return { ...base, state: "failed", message: `Download limit reached (${o.cap}); try again later` };
			case "halted":
				return { ...base, state: "failed", message: "Institutional access is paused", handoffUrl: handoffUrl(o.handoff) };
			case "cancelled":
				return { ...base, state: "cancelled", message: "Cancelled" };
			case "failed":
				return { ...base, state: "failed", message: `Failed (${o.code})` };
		}
	}
}

function rowState(id: string, state: ProgressRow["state"]): FullTextItemState {
	if (id.startsWith("saved")) return "attached";
	if (id === "skipped-has-pdf" || id === "skipped-not-downloaded") return "already-has-pdf";
	if (id === "no-identifier" || id.startsWith("not-found") || id === "not-entitled") return "not-found";
	if (id === "needs-login" || id === "needs-user" || id === "blocked" || id.startsWith("login-") || id === "challenge") return "needs-sign-in";
	if (state === "cancelled" || id === "cancelled") return "cancelled";
	if (state === "failed" || state === "skipped") return "failed";
	if (id === "downloading" || id === "saving") return "downloading";
	if (state === "queued" || id === "queued" || id === "waiting-confirm") return "queued";
	return "searching";
}

// ---------------------------------------------------------------- per-DB singleton

const services = new WeakMap<Database, FulltextService>();

export function fulltextService(db: Database, opts?: ServiceOptions): FulltextService {
	let s = services.get(db);
	if (!s) {
		s = new FulltextService(db, opts);
		services.set(db, s);
	}
	return s;
}

export async function disposeFulltextService(db: Database): Promise<void> {
	const s = services.get(db);
	services.delete(db);
	await s?.dispose();
}
