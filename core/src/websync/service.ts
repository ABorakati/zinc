// The zotero.org sync service for one library database: serialises pull, push and file work, keeps the settings
// in sync_state, and reports WebSyncStatus. Pull is always on while the service runs; push and files are opt-in.

import type { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { HttpError } from "../db";
import { logError } from "../log";
import { dbFileOf } from "../files/config";
import { pendingCount } from "../sync/build";
import { PreconditionFailed, WebApiError, ZoteroWebClient } from "./client";
import { checkFiles, downloadMissing, uploadMissing, type FileJob, type FilesCheck } from "./files";
import { bunKeyStore, type KeyStore } from "./keystore";
import { pullOnce } from "./pull";
import { pushOnce } from "./push";
import { filesMode, getState, setState, syncMode, type FilesMode, type SyncModeName } from "./state";

export interface WebSyncOptions {
	keyStore?: KeyStore;
	/** Base URL; default: ZN_ZOTERO_API, else https://api.zotero.org. */
	apiBase?: () => string;
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	/** Poll interval in ms (default 60000). 0 disables the timer. */
	pollMs?: number;
	/** Run a sync as soon as the service starts (default true). */
	initialSync?: boolean;
}

export interface WebSyncStatus {
	mode: SyncModeName;
	account: { keySet: boolean; userId?: number; username?: string; canWrite?: boolean; filesAccess?: boolean };
	push: boolean;
	files: FilesMode;
	libraryVersion?: number;
	pending: number;
	conflicts: number;
	lastPullAt?: string;
	lastPushAt?: string;
	lastError?: string;
	busy: boolean;
	backoffUntil?: string;
	fileJob?: FileJob;
}

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** errMsg for web_error, which also writes the error (with its stack) to the local log (core/src/log.ts). */
function failMsg(e: unknown): string {
	logError("websync", e);
	return errMsg(e);
}

export class WebSyncService {
	readonly client: ZoteroWebClient;
	private readonly keyStore: KeyStore;
	private chain: Promise<unknown> = Promise.resolve();
	private timer: ReturnType<typeof setInterval> | null = null;
	private active = 0;
	private stopped = true;
	private job: FileJob | undefined;
	/** Resolves when the running download job ends (tests and callers that want to wait). */
	fileJobDone: Promise<void> = Promise.resolve();
	private readonly dataDir: string;
	private readonly storageDir: string;

	constructor(
		readonly db: Database,
		readonly opts: WebSyncOptions = {},
	) {
		this.keyStore = opts.keyStore ?? bunKeyStore;
		this.client = new ZoteroWebClient({ base: opts.apiBase, getKey: () => this.keyStore.get(), fetch: opts.fetch, sleep: opts.sleep, now: opts.now });
		const file = dbFileOf(db);
		this.dataDir = file ? dirname(file) : process.cwd();
		this.storageDir = join(this.dataDir, "storage");
	}

	// ------------------------------------------------------------ settings

	get pushEnabled(): boolean {
		return getState(this.db, "web_push") === "1";
	}

	private num(name: string): number | undefined {
		const v = getState(this.db, name);
		return v === undefined || v === "" ? undefined : Number(v);
	}

	private get userId(): number {
		const id = this.num("web_user_id");
		if (!id) throw new WebApiError(401, "no zotero.org account is connected");
		return id;
	}

	private get canWrite(): boolean {
		return getState(this.db, "web_can_write") === "1";
	}

	private exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const run = async () => {
			this.active++;
			try {
				return await fn();
			} finally {
				this.active--;
			}
		};
		const p = this.chain.then(run, run);
		this.chain = p.catch(() => {});
		return p;
	}

	// ------------------------------------------------------------ account

	/** Validate an API key with /keys/current and keep it in the key store. Throws HttpError(400) when rejected. */
	async setKey(apiKey: string): Promise<WebSyncStatus> {
		const key = apiKey.trim();
		if (!key) throw new HttpError(400, "the API key is empty");
		let info: { userID?: number; username?: string; access?: { user?: { library?: boolean; write?: boolean; files?: boolean } } };
		try {
			const res = await this.client.request("GET", "/keys/current", { key });
			if (!res.ok) throw new HttpError(400, res.status === 403 || res.status === 404 || res.status === 401 ? "zotero.org rejected that API key" : `zotero.org answered ${res.status}`);
			info = (await res.json()) as typeof info;
		} catch (e) {
			if (e instanceof HttpError) throw e;
			throw new HttpError(400, `could not reach zotero.org: ${errMsg(e)}`);
		}
		if (!info.userID) throw new HttpError(400, "that API key has no user library");
		await this.keyStore.set(key);
		const a = info.access?.user;
		setState(this.db, "web_user_id", String(info.userID));
		setState(this.db, "web_username", info.username ?? null);
		setState(this.db, "web_can_write", a?.write ? "1" : "0");
		setState(this.db, "web_files_access", a?.files ? "1" : "0");
		setState(this.db, "web_error", null);
		return this.status();
	}

	async clearKey(): Promise<WebSyncStatus> {
		await this.keyStore.delete();
		for (const n of ["web_user_id", "web_username", "web_can_write", "web_files_access", "web_error"]) setState(this.db, n, null);
		return this.status();
	}

	async setOptions(o: { push?: boolean; files?: FilesMode }): Promise<WebSyncStatus> {
		if (o.push !== undefined) setState(this.db, "web_push", o.push ? "1" : "0");
		if (o.files !== undefined) setState(this.db, "files", o.files);
		return this.status();
	}

	// ------------------------------------------------------------ operations (never throw: failures land in web_error)

	pull(): Promise<void> {
		return this.exclusive(async () => {
			try {
				await pullOnce({ db: this.db, client: this.client, userId: this.userId, dataDir: this.dataDir });
				setState(this.db, "web_last_pull_at", new Date().toISOString());
				setState(this.db, "web_error", null);
			} catch (e) {
				setState(this.db, "web_error", failMsg(e));
			}
		});
	}

	push(): Promise<void> {
		return this.exclusive(async () => {
			if (!this.pushEnabled || pendingCount(this.db) === 0) return;
			if (!this.canWrite) {
				setState(this.db, "web_error", "the API key is read-only: allow write access to push");
				return;
			}
			try {
				const ctx = { db: this.db, client: this.client, userId: this.userId, dataDir: this.dataDir, ownStorageDir: this.storageDir };
				let r;
				try {
					r = await pushOnce(ctx);
				} catch (e) {
					if (!(e instanceof PreconditionFailed)) throw e;
					// someone else wrote first: bring their changes in, then retry once
					await pullOnce({ db: this.db, client: this.client, userId: this.userId, dataDir: this.dataDir });
					r = await pushOnce(ctx);
				}
				if (r.conflicted) await pullOnce({ db: this.db, client: this.client, userId: this.userId, dataDir: this.dataDir });
				setState(this.db, "web_last_push_at", new Date().toISOString());
				setState(this.db, "web_error", r.error ?? null);
			} catch (e) {
				setState(this.db, "web_error", failMsg(e));
			}
		});
	}

	private files(): Promise<void> {
		return this.exclusive(async () => {
			const mode = filesMode(this.db);
			if (mode === "off") return;
			try {
				if (mode === "sync" && this.canWrite && getState(this.db, "web_files_access") === "1") {
					await uploadMissing({ db: this.db, client: this.client, userId: this.userId, storageDir: this.storageDir });
				}
				this.startJob();
			} catch (e) {
				setState(this.db, "web_error", failMsg(e));
			}
		});
	}

	/** Pull, then push (when enabled) and sync files (when enabled). Returns the new status. */
	async syncNow(): Promise<WebSyncStatus> {
		await this.pull();
		await this.push();
		await this.files();
		return this.status();
	}

	checkFiles(): Promise<FilesCheck> {
		return checkFiles({ db: this.db, client: this.client, userId: this.userId, storageDir: this.storageDir });
	}

	private startJob(): void {
		if (this.job?.running) return;
		const job: FileJob = { done: 0, total: 0, failed: 0, bytes: 0, running: true };
		this.job = job;
		this.fileJobDone = downloadMissing({ db: this.db, client: this.client, userId: this.userId, storageDir: this.storageDir }, job).catch((e) => {
			job.running = false;
			setState(this.db, "web_error", failMsg(e));
		});
	}

	/** Start the download job (progress in status().fileJob). */
	downloadMissing(): Promise<WebSyncStatus> {
		this.startJob();
		return this.status();
	}

	// ------------------------------------------------------------ status

	async status(): Promise<WebSyncStatus> {
		const keySet = !!(await this.keyStore.get());
		const st: WebSyncStatus = {
			mode: syncMode(this.db),
			account: { keySet },
			push: this.pushEnabled,
			files: filesMode(this.db),
			pending: pendingCount(this.db),
			conflicts: (this.db.query("SELECT count(*) AS n FROM sync_conflicts").get() as { n: number }).n,
			busy: this.active > 0,
		};
		if (keySet && this.num("web_user_id")) {
			st.account.userId = this.num("web_user_id");
			const name = getState(this.db, "web_username");
			if (name) st.account.username = name;
			st.account.canWrite = this.canWrite;
			st.account.filesAccess = getState(this.db, "web_files_access") === "1";
		}
		const v = this.num("web_library_version");
		if (v !== undefined) st.libraryVersion = v;
		const set = <K extends "lastPullAt" | "lastPushAt" | "lastError">(k: K, val: string | undefined) => {
			if (val) st[k] = val as WebSyncStatus[K];
		};
		set("lastPullAt", getState(this.db, "web_last_pull_at"));
		set("lastPushAt", getState(this.db, "web_last_push_at"));
		set("lastError", getState(this.db, "web_error"));
		if (this.client.pausedUntil > this.client.now()) st.backoffUntil = new Date(this.client.pausedUntil).toISOString();
		if (this.job) st.fileJob = { ...this.job };
		return st;
	}

	// ------------------------------------------------------------ background loop

	private async tick(): Promise<void> {
		if (this.stopped || !(await this.keyStore.get()) || !this.num("web_user_id")) return;
		await this.pull();
		if (this.stopped) return;
		await this.push();
		await this.files();
	}

	start(): void {
		this.stopped = false;
		if (this.timer) return;
		if (this.opts.initialSync !== false) void this.tick();
		const poll = this.opts.pollMs ?? 60_000;
		if (poll > 0) this.timer = setInterval(() => void this.tick(), poll);
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		await this.chain;
	}

	get running(): boolean {
		return !this.stopped;
	}
}
