// The zotero.org sync service for one library database: serialises pull, push and file work, keeps the settings
// in sync_state, and reports WebSyncStatus. Pull is always on while the service runs; push and files are opt-in.

import type { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { HttpError } from "../db";
import { logError } from "../log";
import { dbFileOf } from "../files/config";
import { listLibraries, markGroupsRemoved, upsertGroupLibrary, USER_LIBRARY, type Library } from "../libraries";
import { pendingCount } from "../sync/build";
import { failure, PreconditionFailed, WebApiError, ZoteroWebClient } from "./client";
import { checkFiles, downloadMissing, uploadMissing, type FileJob, type FilesCheck } from "./files";
import { bunKeyStore, type KeyStore } from "./keystore";
import { pullOnce } from "./pull";
import { pushOnce, type PushResult } from "./push";
import { groupRef, userRef, webVersions, type LibraryRef } from "./library";
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
	/** The account's group libraries (My Library is described by the fields above). */
	groups: GroupStatus[];
}

export interface GroupStatus {
	libraryId: number;
	groupId: number;
	name: string;
	/** False: read-only for this user, so nothing is pushed. */
	editable: boolean;
	filesEditable: boolean;
	libraryVersion?: number;
	pending: number;
	lastPullAt?: string;
	lastError?: string;
}

interface KeyAccess {
	all?: { library?: boolean; write?: boolean };
	[groupId: string]: { library?: boolean; write?: boolean } | undefined;
}

/** A group record from GET /users/<id>/groups (the `data` object). */
export interface GroupRecord {
	id: number;
	name?: string;
	owner?: number;
	admins?: number[];
	members?: number[];
	libraryEditing?: string; // admins | members
	fileEditing?: string; // none | admins | members
}

/**
 * What this user may do in a group: the API key must allow writing to it, and the group's own rules must let this user edit
 * (owner and admins always; members when libraryEditing is "members"). Files follow fileEditing the same way.
 */
export function groupPermissions(rec: GroupRecord, userId: number, access: KeyAccess | undefined, keyFiles: boolean): { editable: boolean; filesEditable: boolean } {
	const keyWrite = !!(access?.[String(rec.id)]?.write ?? access?.all?.write);
	const owner = rec.owner === userId;
	const admin = owner || !!rec.admins?.includes(userId);
	// a record without member lists (a trimmed response) is read as "this user is a member"
	const member = admin || rec.members === undefined || rec.members.includes(userId);
	const editable = keyWrite && (admin || (rec.libraryEditing === "members" && member));
	const fileRule = rec.fileEditing === "members" ? member : rec.fileEditing === "admins" ? admin : false;
	return { editable, filesEditable: editable && fileRule && keyFiles };
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
		let info: { userID?: number; username?: string; access?: { user?: { library?: boolean; write?: boolean; files?: boolean }; groups?: KeyAccess } };
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
		setState(this.db, "web_groups_access", JSON.stringify((info.access as { groups?: KeyAccess } | undefined)?.groups ?? {}));
		// the key's access decides what is editable: re-read every group's permissions on the next pull
		this.db.run("UPDATE libraries SET group_version = 0 WHERE type = 'group'");
		setState(this.db, "web_error", null);
		return this.status();
	}

	async clearKey(): Promise<WebSyncStatus> {
		await this.keyStore.delete();
		for (const n of ["web_user_id", "web_username", "web_can_write", "web_files_access", "web_groups_access", "web_error"]) setState(this.db, n, null);
		return this.status();
	}

	async setOptions(o: { push?: boolean; files?: FilesMode }): Promise<WebSyncStatus> {
		if (o.push !== undefined) setState(this.db, "web_push", o.push ? "1" : "0");
		if (o.files !== undefined) setState(this.db, "files", o.files);
		return this.status();
	}

	// ------------------------------------------------------------ libraries

	private get accessGroups(): KeyAccess | undefined {
		try {
			return JSON.parse(getState(this.db, "web_groups_access") ?? "{}") as KeyAccess;
		} catch {
			return undefined;
		}
	}

	/** sync_state name for a library: My Library keeps the plain names it always had. */
	private stateName(name: string, libraryId: number): string {
		return libraryId === USER_LIBRARY ? name : `${name}_lib${libraryId}`;
	}

	/** The account's group libraries that are still synced (not removed). */
	private groupLibraries(): Library[] {
		return listLibraries(this.db).filter((l) => l.type === "group");
	}

	private refFor(l: Library): LibraryRef {
		return groupRef(l.id, l.groupId!);
	}

	/** Read the account's group list: new groups become libraries, names and permissions are refreshed, groups that are gone are hidden. */
	private async discoverGroups(): Promise<void> {
		const uid = this.userId;
		const vres = await this.client.request("GET", `/users/${uid}/groups`, { query: { format: "versions" } });
		if (!vres.ok) throw await failure(vres);
		const versions = (await vres.json()) as Record<string, number>;
		const present = Object.keys(versions).map(Number).filter((n) => Number.isInteger(n) && n > 0);
		const known = new Map(
			(this.db.query("SELECT group_id AS id, group_version AS version, removed FROM libraries WHERE type = 'group'").all() as { id: number; version: number; removed: number }[]).map((r) => [r.id, r]),
		);
		const stale = present.filter((id) => {
			const k = known.get(id);
			return !k || k.removed === 1 || k.version < (versions[String(id)] ?? 0);
		});
		if (stale.length) {
			const filesAccess = getState(this.db, "web_files_access") === "1";
			for (let start = 0; ; start += 100) {
				const res = await this.client.request("GET", `/users/${uid}/groups`, { query: { limit: 100, start } });
				if (!res.ok) throw await failure(res);
				const page = (await res.json()) as { id?: number; version?: number; data?: GroupRecord & { version?: number } }[];
				for (const g of page) {
					const rec = g.data;
					const id = Number(rec?.id ?? g.id);
					if (!rec || !present.includes(id)) continue;
					const perm = groupPermissions({ ...rec, id }, uid, this.accessGroups, filesAccess);
					upsertGroupLibrary(this.db, { groupId: id, name: rec.name || `Group ${id}`, ...perm, version: Number(g.version ?? rec.version ?? versions[String(id)]) || 0 });
				}
				if (page.length < 100) break;
			}
		}
		markGroupsRemoved(this.db, present);
	}

	// ------------------------------------------------------------ operations (never throw: failures land in web_error)

	private pullLibrary(ref: LibraryRef): Promise<unknown> {
		return pullOnce({ db: this.db, client: this.client, userId: this.userId, ref, dataDir: this.dataDir });
	}

	/** Push one library's queue; on a 412 pull that library and retry once. */
	private async pushLibrary(ref: LibraryRef): Promise<PushResult> {
		const ctx = { db: this.db, client: this.client, userId: this.userId, ref, dataDir: this.dataDir, ownStorageDir: this.storageDir };
		let r: PushResult;
		try {
			r = await pushOnce(ctx);
		} catch (e) {
			if (!(e instanceof PreconditionFailed)) throw e;
			// someone else wrote first: bring their changes in, then retry once
			await this.pullLibrary(ref);
			r = await pushOnce(ctx);
		}
		if (r.conflicted) await this.pullLibrary(ref);
		return r;
	}

	pull(): Promise<void> {
		return this.exclusive(async () => {
			let discoverError: string | null = null;
			try {
				await this.discoverGroups();
			} catch (e) {
				discoverError = failMsg(e);
			}
			try {
				await this.pullLibrary(userRef(this.userId));
				setState(this.db, "web_last_pull_at", new Date().toISOString());
				setState(this.db, "web_error", discoverError);
			} catch (e) {
				setState(this.db, "web_error", failMsg(e));
			}
			// a failing group never stops the others: its error is shown against it
			for (const g of this.groupLibraries()) {
				try {
					await this.pullLibrary(this.refFor(g));
					setState(this.db, this.stateName("web_last_pull_at", g.id), new Date().toISOString());
					setState(this.db, this.stateName("web_error", g.id), null);
				} catch (e) {
					setState(this.db, this.stateName("web_error", g.id), failMsg(e));
				}
			}
		});
	}

	push(): Promise<void> {
		return this.exclusive(async () => {
			if (!this.pushEnabled) return;
			if (pendingCount(this.db, USER_LIBRARY) > 0) {
				if (!this.canWrite) {
					setState(this.db, "web_error", "the API key is read-only: allow write access to push");
				} else {
					try {
						const r = await this.pushLibrary(userRef(this.userId));
						setState(this.db, "web_last_push_at", new Date().toISOString());
						setState(this.db, "web_error", r.error ?? null);
					} catch (e) {
						setState(this.db, "web_error", failMsg(e));
					}
				}
			}
			// groups: only the ones this user may edit ever push; a read-only group's queue is left alone
			for (const g of this.groupLibraries()) {
				if (!g.editable || pendingCount(this.db, g.id) === 0) continue;
				try {
					const r = await this.pushLibrary(this.refFor(g));
					setState(this.db, this.stateName("web_last_push_at", g.id), new Date().toISOString());
					setState(this.db, this.stateName("web_error", g.id), r.error ?? null);
				} catch (e) {
					setState(this.db, this.stateName("web_error", g.id), failMsg(e));
				}
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
				if (mode === "sync" && getState(this.db, "web_files_access") === "1") {
					for (const g of this.groupLibraries()) {
						if (!g.filesEditable) continue;
						try {
							await uploadMissing({ db: this.db, client: this.client, userId: this.userId, ref: this.refFor(g), storageDir: this.storageDir });
						} catch (e) {
							setState(this.db, this.stateName("web_error", g.id), failMsg(e));
						}
					}
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

	checkFiles(libraryId: number = USER_LIBRARY): Promise<FilesCheck> {
		const lib = libraryId === USER_LIBRARY ? undefined : this.groupLibraries().find((g) => g.id === libraryId);
		if (libraryId !== USER_LIBRARY && !lib) throw new HttpError(404, "library not found");
		return checkFiles({ db: this.db, client: this.client, userId: this.userId, ref: lib ? this.refFor(lib) : undefined, storageDir: this.storageDir });
	}

	/** Download every library's missing files, My Library first. The job's counters add up across libraries. */
	private startJob(): void {
		if (this.job?.running) return;
		const job: FileJob = { done: 0, total: 0, failed: 0, bytes: 0, running: true };
		this.job = job;
		const base = { db: this.db, client: this.client, userId: this.userId, storageDir: this.storageDir };
		this.fileJobDone = (async () => {
			await downloadMissing(base, job);
			for (const g of this.groupLibraries()) {
				const sub: FileJob = { done: 0, total: 0, failed: 0, bytes: 0, running: true };
				job.running = true;
				try {
					await downloadMissing({ ...base, ref: this.refFor(g) }, sub);
				} catch (e) {
					setState(this.db, this.stateName("web_error", g.id), failMsg(e));
				}
				job.total += sub.total;
				job.done += sub.done;
				job.failed += sub.failed;
				job.bytes += sub.bytes;
			}
		})()
			.catch((e) => {
				setState(this.db, "web_error", failMsg(e));
			})
			.finally(() => {
				job.running = false;
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
			groups: [],
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
		if (keySet) {
			for (const g of this.groupLibraries()) {
				const gs: GroupStatus = { libraryId: g.id, groupId: g.groupId!, name: g.name, editable: g.editable, filesEditable: g.filesEditable, pending: pendingCount(this.db, g.id) };
				const gv = webVersions(this.db, g.id).pull;
				if (gv) gs.libraryVersion = gv;
				const lp = getState(this.db, this.stateName("web_last_pull_at", g.id));
				if (lp) gs.lastPullAt = lp;
				const le = getState(this.db, this.stateName("web_error", g.id));
				if (le) gs.lastError = le;
				st.groups.push(gs);
			}
		}
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
