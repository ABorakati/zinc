// The plugin manager: install, update, uninstall, enable and disable of .zplugin packages, the lifecycle hook calls with their reasons
// (lifecycle.md 2.2), and the startup of every installed plugin. It drives a PluginSupervisor (src/supervisor.ts) and writes the
// loadable layout under <root>/installed/<id>/ (see layout.ts):
//
//   package -> checks -> staging -> zhw precompile into cache/ -> installed/<id>/ -> load, install, startup
//
// What is checked, in order: zip safety (names, sizes, CRC), the manifest against manifest.schema.json plus the permission ids, the
// platform and the version ranges (api_version, min_version, strict max), main.sha256 against plugin.wasm (pinned when absent), then the
// permission approval. A `transpiled/` folder inside a package (an older build layout) is always ignored.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { PluginManifest } from "../manifest";
import type { PluginSupervisor } from "../supervisor";
import { PluginError } from "../protocol";
import { describePermissions, declaredPermissions, optionalIds, requiredIds, permissionTier, type PromptGroup } from "../permissions/risk";
import { GrantStore } from "../permissions/store";
import { assertSafeId, createLayout, pluginsRoot, type Layout } from "./layout";
import { CwasmCache } from "./cwasm-cache";
import { readJson, writeJsonAtomic } from "./json-file";
import { apiCompatible, semverCompare } from "./semver";
import { sha256Hex } from "./hash";
import { validateManifest } from "./validate";
import { readZip, ZipError, type ZipFile } from "./zip";
import { extractPackage, isWasm } from "./wasm-package";

export type InstallAction = "install" | "upgrade" | "downgrade" | "reinstall";
export type InstallErrorCode = "invalid-package" | "invalid-manifest" | "incompatible" | "hash-mismatch" | "cancelled" | "prepare-failed" | "io";

export class InstallError extends Error {
	constructor(
		readonly code: InstallErrorCode,
		message: string,
		readonly details: string[] = [],
	) {
		super(details.length ? `${message}: ${details.join("; ")}` : message);
		this.name = "InstallError";
	}
}

/** What the install prompt needs (the UI draws it with `groups`). */
export interface ApprovalRequest {
	action: InstallAction;
	manifest: PluginManifest;
	previousVersion?: string;
	/** What needs a decision: everything on a first install, only what the new version adds on an update. Optional permissions are listed with `optional: true` and are never granted here. */
	groups: PromptGroup[];
	/** Permission ids in `groups` that are required (the ones `grant` may contain). */
	required: string[];
}

/** `grant`: the ids the user approved (only required ids count). `false` or undefined: the user cancelled. */
export type Approval = { grant: string[] } | false | undefined;
export type ApproveFn = (req: ApprovalRequest) => Promise<Approval> | Approval;

export type PluginState = "enabled" | "disabled" | "blocked" | "incompatible" | "failed" | "uninstalling";

export interface InstalledPlugin {
	id: string;
	name: string;
	version: string;
	description?: string;
	author?: string;
	homepage?: string;
	state: PluginState;
	stateDetail?: string;
	granted: string[];
	dir: string;
	manifest: PluginManifest;
	/** An update added permissions the user has not approved yet: the plugin stays disabled until `approvePending`. */
	pendingApproval?: string[];
}

export interface InstallResult {
	id: string;
	version: string;
	action: InstallAction;
	previousVersion?: string;
	/** The plugin is running after the install. */
	started: boolean;
	/** A hook failed or the plugin did not start; the plugin is installed and marked failed. */
	error?: string;
	warnings: string[];
	/** Permission ids granted. */
	granted: string[];
	pendingApproval?: string[];
}

export interface ManagerOptions {
	/** Plugins folder. Default: pluginsRoot() (ZN_PLUGINS_DIR, else %APPDATA%\zotero-next-gpui\plugins). Tests pass a temp folder. */
	root?: string;
	/** Zinc's own version, for `zinc.min_version`. Default ZN_VERSION or "0.1.0". */
	zincVersion?: string;
	/** `zinc:plugin` API version of this build. Default "0.1.0". */
	apiVersion?: string;
	platform?: "windows" | "macos" | "linux";
	/** Precompile `plugin.wasm` into the `.cwasm` cache on install. Default `true`. */
	precompile?: boolean;
	/** Rebuild `.cwasm` on `loadInto` when `zhw` version bumped (or always when `true`, never when `false`). */
	autoRebuildCache?: boolean;
	/** Explicit path to the `zhw` binary. */
	zhwPath?: string;
	/** Test hook: overrides the `cacheKey` reported by `zhw version` to simulate a `zhw` upgrade. */
	zhwVersionOverride?: string;
	/** The install prompt. Without one, tiers none and low are granted and the rest is not. */
	approve?: ApproveFn;
	/** A reason string for a blocked plugin version (`plugin-state::blocked`), or undefined. */
	blocklist?: (id: string, version: string) => string | undefined;
	log?: (level: "error" | "warn" | "info" | "debug", message: string) => void;
}

export interface ManagerEvents {
	installed: { id: string; action: InstallAction; version: string };
	uninstalled: { id: string };
	/** Something about a plugin changed (state, enabled, permissions). */
	changed: { id: string };
	/** A lifecycle hook finished OK (`hook` is a lifecycle.hook name, `why` a lifecycle.reason). */
	hook: { plugin: string; hook: string; why: string };
	/** A library window opened or closed (emitted before running the window lifecycle hooks). */
	window: { hook: "main-window-load" | "main-window-unload"; window: number };
}

interface StateEntry {
	version: string;
	enabled: boolean;
	installedAt: number;
	updatedAt?: number;
	disabledReason?: string;
	pendingApproval?: string[];
	/** `zhw` cacheKey under which `.cwasm` was precompiled. */
	cwasmCacheKey?: string;
}

interface StateFile {
	version: 1;
	plugins: Record<string, StateEntry>;
}

interface Rec {
	manifest: PluginManifest;
	entry: StateEntry;
}

const HOOK_REASON = { install: "addon-install", upgrade: "addon-upgrade", downgrade: "addon-downgrade", reinstall: "addon-upgrade" } as const;

const MAX_MANIFEST_BYTES = 256 * 1024;

export class PluginManager {
	readonly layout: Layout;
	readonly grants: GrantStore;
	readonly cwasmCache: CwasmCache;
	readonly zincVersion: string;
	readonly apiVersion: string;
	private sup: PluginSupervisor | undefined;
	private records = new Map<string, Rec>();
	private resolvedCwasm = new Map<string, string | undefined>();
	private problems = new Map<string, { state: PluginState; detail: string }>();
	private uninstalling = new Set<string>();
	private listeners = new Map<string, Set<(e: any) => void>>();
	private approveFn: ApproveFn | undefined;
	private platform: "windows" | "macos" | "linux";
	private loaded = false;
	private dataRemovers: Array<(id: string) => void> = [];
	/** Serialises install, uninstall and enable/disable per plugin id. */
	private locks = new Map<string, Promise<unknown>>();

	constructor(private opts: ManagerOptions = {}) {
		this.layout = createLayout(opts.root ?? pluginsRoot());
		this.grants = new GrantStore(this.layout.grantsFile);
		this.cwasmCache = new CwasmCache({
			cacheRoot: this.layout.cacheRoot,
			zhwPath: opts.zhwPath,
			zhwVersionOverride: opts.zhwVersionOverride,
		});
		this.zincVersion = opts.zincVersion ?? process.env.ZN_VERSION ?? "0.1.0";
		this.apiVersion = opts.apiVersion ?? "0.1.0";
		this.approveFn = opts.approve;
		this.platform = opts.platform ?? (process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux");
	}

	/** `.cwasm` path resolved for `id` (used by `supervisor`'s `cwasmOf` hook). */
	cwasmFor(id: string, manifest?: PluginManifest): string | undefined {
		if (this.resolvedCwasm.has(id)) return this.resolvedCwasm.get(id);
		if (this.opts.precompile === false) return undefined;
		const sha = (manifest ?? this.records.get(id)?.manifest)?.main.sha256;
		return sha ? this.cwasmCache.getIfFresh(sha) : undefined;
	}

	private pruneCache() {
		const valid = new Set<string>();
		for (const r of this.records.values()) {
			if (r.manifest.main.sha256) valid.add(r.manifest.main.sha256);
		}
		this.cwasmCache.prune(valid);
	}

	/** The supervisor the manager drives. Set once, before the first install or `startAll`. */
	attach(sup: PluginSupervisor) {
		this.sup = sup;
	}

	setApprove(fn: ApproveFn | undefined) {
		this.approveFn = fn;
	}

	on<K extends keyof ManagerEvents>(event: K, handler: (e: ManagerEvents[K]) => void): () => void {
		let set = this.listeners.get(event);
		if (!set) this.listeners.set(event, (set = new Set()));
		set.add(handler);
		return () => void set!.delete(handler);
	}

	private emit<K extends keyof ManagerEvents>(event: K, e: ManagerEvents[K]) {
		for (const h of this.listeners.get(event) ?? []) {
			try {
				h(e);
			} catch (err) {
				this.log("error", `listener for ${event} threw: ${(err as Error).message}`);
			}
		}
	}

	private log(level: "error" | "warn" | "info" | "debug", message: string) {
		this.opts.log?.(level, message);
	}

	private supervisor(): PluginSupervisor {
		if (!this.sup) throw new Error("PluginManager: no supervisor attached");
		return this.sup;
	}

	private lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.locks.get(id) ?? Promise.resolve();
		const next = prev.then(fn, fn);
		this.locks.set(id, next.catch(() => {}));
		return next;
	}

	/** An export call of one plugin. The supervisor runs one call at a time per plugin (see PluginSupervisor), so no queue is needed here. */
	callPlugin(id: string, iface: string, fn: string, args: unknown[], opts?: { timeoutMs?: number }): Promise<unknown> {
		return this.supervisor().call(id, iface, fn, args, opts);
	}

	private startPlugin(id: string, why: string, previousVersion?: string): Promise<void> {
		return this.supervisor().start(id, { why, previousVersion });
	}

	private stopPlugin(id: string, why: string): Promise<void> {
		return this.supervisor().stop(id, { why });
	}

	// ---- reading what is installed ------------------------------------------------------------------------------------------

	/** Reads state.json and every installed manifest, empties temp/ and the work folders, and prunes stale `.cwasm` caches. Idempotent. */
	init(): void {
		if (this.loaded) return;
		this.loaded = true;
		const state = readJson<StateFile>(this.layout.stateFile, { version: 1, plugins: {} });
		for (const [id, entry] of Object.entries(state.plugins ?? {})) {
			try {
				const manifest = JSON.parse(readFileSync(join(this.layout.installed(id), "manifest.json"), "utf8")) as PluginManifest;
				this.records.set(id, { manifest, entry });
			} catch (e) {
				this.log("warn", `plugin ${id} is in state.json but its folder cannot be read: ${(e as Error).message}`);
			}
		}
		// the temp root is emptied when Zinc starts (fs root `temp`)
		rmSync(this.layout.tempRoot, { recursive: true, force: true });
		mkdirSync(this.layout.tempRoot, { recursive: true });
		rmSync(this.layout.staging, { recursive: true, force: true });
		rmSync(this.layout.trash, { recursive: true, force: true });
		this.pruneCache();
	}

	private saveState() {
		const plugins: Record<string, StateEntry> = {};
		for (const [id, r] of this.records) plugins[id] = r.entry;
		writeJsonAtomic(this.layout.stateFile, { version: 1, plugins } satisfies StateFile);
	}

	manifestOf(id: string): PluginManifest | undefined {
		return this.records.get(id)?.manifest;
	}

	stateOf(id: string): { state: PluginState; detail?: string } | undefined {
		const r = this.records.get(id);
		if (!r) return undefined;
		if (this.uninstalling.has(id)) return { state: "uninstalling" };
		const p = this.problems.get(id);
		if (p) return p;
		if (!r.entry.enabled) return { state: "disabled", detail: r.entry.pendingApproval ? "new permissions need your approval" : r.entry.disabledReason };
		const s = this.sup?.get(id);
		if (s && (s.status === "failed" || s.status === "disabled")) return { state: "failed", detail: s.reason };
		return { state: "enabled" };
	}

	get(id: string): InstalledPlugin | undefined {
		const r = this.records.get(id);
		if (!r) return undefined;
		const m = r.manifest;
		const st = this.stateOf(id)!;
		return {
			id,
			name: m.name,
			version: m.version,
			description: typeof m.description === "string" ? m.description : undefined,
			author: typeof m.author === "string" ? m.author : undefined,
			homepage: typeof m.homepage_url === "string" ? m.homepage_url : undefined,
			state: st.state,
			stateDetail: st.detail,
			granted: this.grants.get(id)?.granted ?? [],
			dir: this.layout.installed(id),
			manifest: m,
			pendingApproval: r.entry.pendingApproval,
		};
	}

	list(): InstalledPlugin[] {
		return [...this.records.keys()].sort().map((id) => this.get(id)!);
	}

	// ---- compatibility --------------------------------------------------------------------------------------------------------

	/** Why this manifest cannot run on this Zinc, or undefined. */
	incompatibility(m: PluginManifest): string | undefined {
		const zinc = (m as unknown as { zinc: { api_version: string; min_version?: string; max_version?: string; strict_max?: boolean; platforms?: string[] } }).zinc;
		if (!apiCompatible(zinc.api_version, this.apiVersion)) return `built for plugin API ${zinc.api_version}, this Zinc offers ${this.apiVersion}`;
		if (zinc.min_version && semverCompare(this.zincVersion, zinc.min_version) < 0) return `needs Zinc ${zinc.min_version} or later (this is ${this.zincVersion})`;
		if (zinc.strict_max && zinc.max_version) {
			const max = zinc.max_version.replace(/\*/g, "999999");
			if (semverCompare(this.zincVersion, max) > 0) return `works with Zinc up to ${zinc.max_version} (this is ${this.zincVersion})`;
		}
		if (zinc.platforms && !zinc.platforms.includes(this.platform)) return `not available on ${this.platform}`;
		return undefined;
	}

	// ---- install ---------------------------------------------------------------------------------------------------------------

	/**
	 * Install or update from the bytes of a package, or from its path: a .zplugin (a zip), or a single-file plugin (a .wasm with the
	 * package embedded in its `zinc:package` custom section, see wasm-package.ts). Both go through the same checks.
	 */
	async installPackage(source: Uint8Array | string, o: { approve?: ApproveFn } = {}): Promise<InstallResult> {
		const bytes = typeof source === "string" ? new Uint8Array(await Bun.file(source).arrayBuffer()) : source;
		let files: ZipFile[];
		try {
			if (isWasm(bytes)) {
				const inner = extractPackage(bytes);
				if (!inner)
					throw new InstallError("invalid-package", "this .wasm file is not a Zinc plugin package", [
						"it has no embedded manifest (no zinc:package section); pack it with pack.ts --wasm, or install the .zplugin",
					]);
				files = inner;
			} else files = readZip(bytes);
		} catch (e) {
			if (e instanceof ZipError) throw new InstallError("invalid-package", "not a valid plugin package", [e.message]);
			throw e;
		}
		return this.installFiles(files, o);
	}

	/** Install from a folder that holds manifest.json and plugin.wasm (a plugin source folder, or build-plugin's output). */
	async installDir(dir: string, o: { approve?: ApproveFn } = {}): Promise<InstallResult> {
		const files: ZipFile[] = [];
		const walk = async (d: string, prefix: string) => {
			for (const e of await readdir(d, { withFileTypes: true })) {
				const rel = prefix ? `${prefix}/${e.name}` : e.name;
				if (e.isDirectory()) {
					if (!prefix && ["transpiled", "node_modules", ".git"].includes(e.name)) continue;
					await walk(join(d, e.name), rel);
				} else if (e.isFile()) files.push({ name: rel, data: new Uint8Array(await Bun.file(join(d, e.name)).arrayBuffer()) });
			}
		};
		await walk(dir, "");
		return this.installFiles(files, o);
	}

	private async installFiles(files: ZipFile[], o: { approve?: ApproveFn }): Promise<InstallResult> {
		this.init();
		const warnings: string[] = [];
		const byName = new Map(files.map((f) => [f.name, f]));
		const mf = byName.get("manifest.json");
		if (!mf) throw new InstallError("invalid-package", "the package has no manifest.json at its root");
		if (mf.data.length > MAX_MANIFEST_BYTES) throw new InstallError("invalid-manifest", "manifest.json is too large");
		let raw: unknown;
		try {
			raw = JSON.parse(new TextDecoder().decode(mf.data));
		} catch (e) {
			throw new InstallError("invalid-manifest", "manifest.json is not valid JSON", [(e as Error).message]);
		}
		const problems = validateManifest(raw);
		if (problems.length) throw new InstallError("invalid-manifest", "manifest.json is not valid", problems.slice(0, 12));
		const manifest = raw as PluginManifest;
		assertSafeId(manifest.id);

		const why = this.incompatibility(manifest);
		if (why) throw new InstallError("incompatible", `${manifest.name} ${manifest.version} cannot be installed`, [why]);
		const blocked = this.opts.blocklist?.(manifest.id, manifest.version);
		if (blocked) throw new InstallError("incompatible", `${manifest.name} ${manifest.version} is blocked`, [blocked]);

		const wasm = byName.get(manifest.main.wasm);
		if (!wasm) throw new InstallError("invalid-package", `main.wasm "${manifest.main.wasm}" is not in the package`);
		if (wasm.data.length < 8 || wasm.data[0] !== 0 || wasm.data[1] !== 0x61 || wasm.data[2] !== 0x73 || wasm.data[3] !== 0x6d) {
			throw new InstallError("invalid-package", `"${manifest.main.wasm}" is not a WebAssembly binary`);
		}
		const digest = sha256Hex(wasm.data);
		if (manifest.main.sha256 && manifest.main.sha256 !== digest) {
			throw new InstallError("hash-mismatch", "plugin.wasm does not match main.sha256", [`expected ${manifest.main.sha256}`, `got ${digest}`]);
		}
		for (const icon of Object.values((manifest as { icons?: Record<string, string> }).icons ?? {})) if (!byName.has(icon)) warnings.push(`icon "${icon}" is not in the package`);
		const loc = (manifest as { locales?: { default: string; dir?: string } }).locales;
		if (loc) {
			const prefix = `${loc.dir ?? "locale"}/${loc.default}/`;
			if (![...byName.keys()].some((n) => n.startsWith(prefix))) warnings.push(`no strings for the default locale under ${prefix}`);
		}
		if ([...byName.keys()].some((n) => n.startsWith("transpiled/"))) warnings.push("the package's transpiled/ folder was ignored; Zinc builds its own from plugin.wasm");

		return this.lock(manifest.id, () => this.installLocked(manifest, files, digest, warnings, o));
	}

	private async installLocked(manifest: PluginManifest, files: ZipFile[], digest: string, warnings: string[], o: { approve?: ApproveFn }): Promise<InstallResult> {
		const id = manifest.id;
		const old = this.records.get(id);
		const cmp = old ? semverCompare(manifest.version, old.manifest.version) : 0;
		const action: InstallAction = !old ? "install" : cmp > 0 ? "upgrade" : cmp < 0 ? "downgrade" : "reinstall";
		const prevVersion = old?.manifest.version;

		// 1. permissions: what is new needs approval
		const d = declaredPermissions(manifest);
		const required = requiredIds(d);
		const seen = new Set(this.grants.get(id)?.seen ?? []);
		const added = old ? required.filter((p) => !seen.has(p)) : required;
		const declaredAll = new Set([...required, ...optionalIds(d)]);
		const granted = new Set((this.grants.get(id)?.granted ?? []).filter((p) => declaredAll.has(p)));
		let pending: string[] | undefined;
		if (added.length) {
			const req: ApprovalRequest = { action, manifest, previousVersion: prevVersion, groups: describePermissions(manifest, old ? added : undefined), required: added };
			const approve = o.approve ?? this.approveFn;
			if (approve) {
				const a = await approve(req);
				if (!a) throw new InstallError("cancelled", `installing ${manifest.name} was cancelled`);
				for (const p of a.grant) if (added.includes(p)) granted.add(p);
			} else if (old) {
				pending = added; // an update that adds permissions stops at disabled until the user approves
			} else {
				for (const p of added) if (["none", "low"].includes(permissionTier(p) ?? "high")) granted.add(p);
			}
		}

		// 2. stage: the files, then precompile plugin.wasm into the `.cwasm` cache
		const stage = join(this.layout.staging, `${id}-${crypto.randomUUID().slice(0, 8)}`);
		await rm(stage, { recursive: true, force: true });
		await mkdir(stage, { recursive: true });
		try {
			for (const f of files) {
				if (f.name.startsWith("transpiled/") || f.name === "manifest.json") continue;
				const target = join(stage, ...f.name.split("/"));
				await mkdir(join(target, ".."), { recursive: true });
				await Bun.write(target, f.data);
			}
			const pinned = { ...manifest, main: { ...manifest.main, sha256: digest } } as PluginManifest;
			await Bun.write(join(stage, "manifest.json"), JSON.stringify(pinned, null, "\t") + "\n");

			const wasmBytes = files.find((f) => f.name === manifest.main.wasm)!.data;
			let cwasmCacheKey: string | undefined;
			if (this.opts.precompile !== false) {
				try {
					const cwasmPath = await this.cwasmCache.precompile(join(stage, ...manifest.main.wasm.split("/")), digest);
					cwasmCacheKey = this.cwasmCache.cacheKey();
					this.resolvedCwasm.set(id, cwasmPath);
				} catch (e) {
					throw new InstallError("prepare-failed", "plugin.wasm could not be prepared (is it a component built for the zinc:plugin world?)", [(e as Error).message.split("\n")[0]]);
				}
			} else {
				if (wasmBytes.length <= 8 || wasmBytes[4] !== 0x0d) {
					throw new InstallError("prepare-failed", "plugin.wasm could not be prepared (is it a component built for the zinc:plugin world?)", ["not a WebAssembly component"]);
				}
				this.resolvedCwasm.set(id, undefined);
			}

			// 3. stop and remove the old version (data and prefs stay)
			if (old) await this.retire(id, action === "downgrade" ? "addon-downgrade" : "addon-upgrade", { removeFiles: false });

			// 4. swap folders
			const dest = this.layout.installed(id);
			await mkdir(this.layout.installedRoot, { recursive: true });
			let trash: string | undefined;
			if (existsSync(dest)) {
				trash = join(this.layout.trash, `${id}-${crypto.randomUUID().slice(0, 8)}`);
				await mkdir(this.layout.trash, { recursive: true });
				renameSync(dest, trash);
			}
			try {
				renameSync(stage, dest);
			} catch (e) {
				if (trash) renameSync(trash, dest);
				throw new InstallError("io", "could not move the plugin into place", [(e as Error).message]);
			}
			if (trash) await rm(trash, { recursive: true, force: true });

			// 5. record it
			const now = Date.now();
			const enabled = pending ? false : old ? old.entry.enabled : true;
			const entry: StateEntry = {
				version: manifest.version,
				enabled,
				installedAt: old?.entry.installedAt ?? now,
				updatedAt: old ? now : undefined,
				disabledReason: enabled ? undefined : pending ? undefined : old?.entry.disabledReason,
				pendingApproval: pending,
				...(cwasmCacheKey ? { cwasmCacheKey } : {}),
			};
			const stored = JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8")) as PluginManifest;
			this.records.set(id, { manifest: stored, entry });
			this.problems.delete(id);
			this.grants.set(id, { granted: [...granted], seen: [...declaredAll] });
			this.saveState();
			this.pruneCache();
		} catch (e) {
			await rm(stage, { recursive: true, force: true }).catch(() => {});
			throw e;
		}

		// 6. run it
		const result: InstallResult = { id, version: manifest.version, action, previousVersion: prevVersion, started: false, warnings, granted: [...granted], pendingApproval: pending };
		const rec = this.records.get(id)!;
		this.emit("installed", { id, action, version: manifest.version });
		if (rec.entry.enabled) {
			const why = HOOK_REASON[action];
			try {
				if (!(await this.loadInto(id))) {
					result.error = this.problems.get(id)?.detail;
				} else {
					await this.runHook(id, "install", why, { previousVersion: prevVersion });
					await this.startPlugin(id, why, prevVersion);
					this.emit("hook", { plugin: id, hook: "startup", why });
					result.started = true;
				}
			} catch (e) {
				result.error = describe(e);
				this.problems.set(id, { state: "failed", detail: result.error });
				this.log("error", `${id}: ${result.error}`);
			}
		}
		this.emit("changed", { id });
		return result;
	}

	// ---- loading and the lifecycle hooks -----------------------------------------------------------------------------------

	/** Checks hashes, compatibility and the blocklist, then loads the component into the supervisor. False (with a problem recorded) when it must not run. */
	private async loadInto(id: string): Promise<boolean> {
		const r = this.records.get(id);
		if (!r) return false;
		const dir = this.layout.installed(id);
		const m = r.manifest;
		const bad = (state: PluginState, detail: string) => {
			this.problems.set(id, { state, detail });
			this.emit("changed", { id });
			return false;
		};
		const why = this.incompatibility(m);
		if (why) return bad("incompatible", why);
		const blocked = this.opts.blocklist?.(id, m.version);
		if (blocked) return bad("blocked", blocked);
		let wasmSha = m.main.sha256;
		try {
			const wasm = new Uint8Array(await Bun.file(join(dir, m.main.wasm)).arrayBuffer());
			const actualSha = sha256Hex(wasm);
			if (m.main.sha256 && actualSha !== m.main.sha256) return bad("failed", "plugin.wasm does not match its pinned hash; reinstall the plugin");
			wasmSha = actualSha;
		} catch (e) {
			return bad("failed", `plugin files cannot be read: ${(e as Error).message}`);
		}
		if (wasmSha) {
			let cwasm = this.opts.precompile === false ? undefined : this.cwasmCache.getIfFresh(wasmSha);
			const currentKey = this.cwasmCache.cacheKey();
			const shouldRebuild =
				!cwasm &&
				this.opts.precompile !== false &&
				this.opts.autoRebuildCache !== false &&
				(this.opts.autoRebuildCache === true || (currentKey !== undefined && r.entry.cwasmCacheKey !== currentKey));
			if (shouldRebuild) {
				try {
					cwasm = await this.cwasmCache.precompile(join(dir, m.main.wasm), wasmSha);
					r.entry.cwasmCacheKey = currentKey;
					this.saveState();
				} catch (e) {
					this.log("warn", `${id}: .cwasm cache rebuild failed, falling back to JIT: ${(e as Error).message.split("\n")[0]}`);
				}
			}
			this.resolvedCwasm.set(id, cwasm);
		}
		const sup = this.supervisor();
		if (sup.get(id)) await sup.unload(id);
		await sup.load(dir);
		sup.setGrants(id, this.grants.grantsFor(m)); // what the user granted, whatever `grantsFor` the supervisor was built with
		this.problems.delete(id);
		return true;
	}

	private budget(id: string): number {
		return this.records.get(id)?.manifest.main.startup_timeout_ms ?? 10_000;
	}

	/** Calls one lifecycle export with the reason. A WIT error or a trap rejects with PluginError. */
	async runHook(id: string, hook: "install" | "startup" | "shutdown" | "uninstall", why: string, o: { previousVersion?: string } = {}): Promise<void> {
		const r = this.records.get(id);
		if (!r) throw new Error(`plugin ${id} is not installed`);
		const data = { id, version: r.manifest.version, previousVersion: o.previousVersion };
		await this.callPlugin(id, "lifecycle", hook, [data, why], { timeoutMs: this.budget(id) });
		this.emit("hook", { plugin: id, hook, why });
	}

	/** Stops (shutdown hook), runs `uninstall`, unloads. With `removeFiles` also deletes the installed folder. Never throws. */
	private async retire(id: string, why: string, o: { removeFiles: boolean }): Promise<void> {
		const sup = this.supervisor();
		if (sup.get(id)?.status === "running") {
			try {
				await this.stopPlugin(id, why);
				this.emit("hook", { plugin: id, hook: "shutdown", why });
			} catch (e) {
				this.log("warn", `${id}: shutdown(${why}) failed: ${describe(e)}`);
			}
		}
		const status = sup.get(id)?.status;
		if (status && status !== "failed" && status !== "disabled") {
			try {
				await this.runHook(id, "uninstall", why);
			} catch (e) {
				this.log("warn", `${id}: uninstall(${why}) failed: ${describe(e)}`);
			}
		}
		await sup.unload(id).catch(() => {});
		if (o.removeFiles) rmSync(this.layout.installed(id), { recursive: true, force: true });
	}

	// ---- uninstall, enable, disable --------------------------------------------------------------------------------------------

	/**
	 * shutdown(addon-uninstall), uninstall(addon-uninstall), then the folder and grants, and unless `keepData` the plugin's data folder
	 * and (through `onRemoveData`) its prefs and secrets: the design deletes them by default (lifecycle.md, open question 6).
	 */
	uninstall(id: string, o: { keepData?: boolean } = {}): Promise<void> {
		return this.lock(id, async () => {
			this.init();
			if (!this.records.has(id)) throw new Error(`plugin ${id} is not installed`);
			this.uninstalling.add(id);
			this.emit("changed", { id });
			try {
				if (!this.supervisor().get(id)) {
					// not loaded (disabled, or never started): load it just to run its `uninstall` hook
					try {
						if (await this.loadInto(id)) await this.runHook(id, "uninstall", "addon-uninstall");
					} catch (e) {
						this.log("warn", `${id}: uninstall hook of a plugin that was not running failed: ${describe(e)}`);
					}
				}
				await this.retire(id, "addon-uninstall", { removeFiles: true });
				this.records.delete(id);
				this.resolvedCwasm.delete(id);
				this.problems.delete(id);
				this.grants.remove(id);
				this.saveState();
				this.pruneCache();
				if (!o.keepData) {
					rmSync(this.layout.data(id), { recursive: true, force: true });
					for (const fn of this.dataRemovers) fn(id);
				}
				this.emit("uninstalled", { id });
			} finally {
				this.uninstalling.delete(id);
				this.emit("changed", { id });
			}
		});
	}

	/** Called with the id when a plugin is uninstalled without `keepData`: delete the plugin's prefs and secrets. The services register this. */
	onRemoveData(fn: (id: string) => void) {
		this.dataRemovers.push(fn);
	}

	setEnabled(id: string, enabled: boolean): Promise<void> {
		return this.lock(id, async () => {
			this.init();
			const r = this.records.get(id);
			if (!r) throw new Error(`plugin ${id} is not installed`);
			if (r.entry.pendingApproval && enabled) throw new Error(`${id} needs its new permissions approved first`);
			if (enabled === r.entry.enabled && !this.problems.has(id)) return;
			if (!enabled) {
				const sup = this.supervisor();
				if (sup.get(id)?.status === "running") {
					try {
						await this.stopPlugin(id, "addon-disable");
						this.emit("hook", { plugin: id, hook: "shutdown", why: "addon-disable" });
					} catch (e) {
						this.log("warn", `${id}: shutdown(addon-disable) failed: ${describe(e)}`);
					}
				}
				await sup.unload(id).catch(() => {});
				r.entry.enabled = false;
				r.entry.disabledReason = "disabled by the user";
				this.saveState();
			} else {
				r.entry.enabled = true;
				r.entry.disabledReason = undefined;
				this.problems.delete(id);
				this.saveState();
				try {
					if (await this.loadInto(id)) {
						await this.startPlugin(id, "addon-enable");
						this.emit("hook", { plugin: id, hook: "startup", why: "addon-enable" });
					}
				} catch (e) {
					this.problems.set(id, { state: "failed", detail: describe(e) });
				}
			}
			this.emit("changed", { id });
		});
	}

	/** The user approved the permissions an update added: grant them (a subset is fine), then enable. */
	async approvePending(id: string, grant: string[]): Promise<void> {
		this.init();
		const r = this.records.get(id);
		if (!r?.entry.pendingApproval) return;
		const rec = this.grants.get(id) ?? { granted: [], seen: [] };
		const ok = grant.filter((p) => r.entry.pendingApproval!.includes(p));
		this.grants.set(id, { granted: [...rec.granted, ...ok], seen: [...rec.seen, ...r.entry.pendingApproval] });
		r.entry.pendingApproval = undefined;
		this.saveState();
		await this.setEnabled(id, true);
	}

	/** Grant or revoke one permission (Settings > Plugins, or the answer to `permissions.request`). Tells the plugin through `events.on-permission-changed`. */
	async setPermission(id: string, permission: string, granted: boolean): Promise<void> {
		this.init();
		const r = this.records.get(id);
		if (!r) throw new Error(`plugin ${id} is not installed`);
		if (granted) this.grants.grant(id, permission);
		else this.grants.revoke(id, permission);
		const sup = this.sup;
		if (sup?.get(id)) {
			sup.setGrants(id, this.grants.grantsFor(r.manifest));
			// not awaited: `permissions.request` lands here from inside the plugin's own call, and the notification waits for that call to end
			if (sup.get(id)!.status === "running") void this.callPlugin(id, "events", "on-permission-changed", [permission, granted]).catch((e) => this.log("debug", `${id}: on-permission-changed: ${describe(e)}`));
		}
		this.emit("changed", { id });
	}

	// ---- app start and quit ---------------------------------------------------------------------------------------------------

	/** Load and start every enabled plugin (`startup(app-startup)`). Call after the library is open and the UI is ready. Failures are recorded per plugin. */
	async startAll(o: { concurrency?: number } = {}): Promise<void> {
		this.init();
		this.pruneCache();
		const queue = [...this.records.keys()].filter((id) => this.records.get(id)!.entry.enabled);
		const total = queue.length;
		const worker = async () => {
			for (let id = queue.shift(); id; id = queue.shift()) {
				const cur = id;
				await this.lock(cur, async () => {
					try {
						if (!(await this.loadInto(cur))) return;
						await this.startPlugin(cur, "app-startup");
						this.emit("hook", { plugin: cur, hook: "startup", why: "app-startup" });
					} catch (e) {
						this.problems.set(cur, { state: "failed", detail: describe(e) });
						this.log("error", `${cur}: ${describe(e)}`);
					}
				});
				this.emit("changed", { id: cur });
			}
		};
		await Promise.all(Array.from({ length: Math.min(o.concurrency ?? 4, total) }, worker));
	}

	/** `shutdown(app-shutdown)` for every running plugin. The supervisor's own `shutdown()` then stops the host process. */
	async stopAll(): Promise<void> {
		const sup = this.supervisor();
		await Promise.all(
			[...this.records.keys()].map(async (id) => {
				if (sup.get(id)?.status !== "running") return;
				try {
					await this.stopPlugin(id, "app-shutdown");
					this.emit("hook", { plugin: id, hook: "shutdown", why: "app-shutdown" });
				} catch (e) {
					this.log("warn", `${id}: shutdown(app-shutdown) failed: ${describe(e)}`);
				}
			}),
		);
	}

	/** A library window opened: `main-window-load` for every running plugin. */
	async windowLoaded(window: number): Promise<void> {
		await this.windowHook("main-window-load", window);
	}

	/** A library window is closing: `main-window-unload`. */
	async windowUnloaded(window: number): Promise<void> {
		await this.windowHook("main-window-unload", window);
	}

	private async windowHook(hook: "main-window-load" | "main-window-unload", window: number) {
		this.emit("window", { hook, window });
		const sup = this.supervisor();
		await Promise.all(
			[...this.records.keys()].map(async (id) => {
				if (sup.get(id)?.status !== "running") return;
				const r = this.records.get(id)!;
				try {
					await this.callPlugin(id, "lifecycle", hook, [{ id, version: r.manifest.version, previousVersion: undefined }, window], { timeoutMs: this.budget(id) });
					this.emit("hook", { plugin: id, hook, why: hook });
				} catch (e) {
					this.log("warn", `${id}: ${hook}(${window}) failed: ${describe(e)}`);
				}
			}),
		);
	}

	/** Folders under installed/ that state.json does not know (a crash between the folder swap and the state write). */
	orphans(): string[] {
		try {
			return readdirSync(this.layout.installedRoot).filter((n) => !this.records.has(n) && statSync(join(this.layout.installedRoot, n)).isDirectory());
		} catch {
			return [];
		}
	}
}

function describe(e: unknown): string {
	return e instanceof PluginError ? e.message : ((e as Error)?.message ?? String(e));
}
