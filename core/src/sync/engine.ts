// Two-way sync service between a zotero-next library and the local Zotero library.
// Contract: core/src/sync/protocol.ts. Pull is always on; pushing into Zotero is opt-in.

import type { Database } from "bun:sqlite";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { logError } from "../log";
import { applyChanges } from "./apply";
import { buildPush, completePush, pendingCount } from "./build";
import { type SyncStatus, type ZoteroReader, ZoteroLockedError, type ZoteroWriter } from "./protocol";

export interface SyncOptions {
	/** Zotero data directory (zotero.sqlite and storage/). */
	dataDir: string;
	reader: ZoteroReader;
	writer: ZoteroWriter;
	/** True while the Zotero application is running. Default: process list check for zotero.exe. */
	isZoteroRunning?: () => Promise<boolean>;
	/** zotero-next's own attachment storage (files here are removed after Zotero took them over). Default: <db dir>/storage. */
	ownStorageDir?: string | null;
	/** Poll interval in ms (default 30000). 0 disables the poll timer. */
	pollMs?: number;
	/** Debounce for zotero.sqlite file events in ms (default 2000). */
	debounceMs?: number;
	/** Minimum gap between automatic push attempts for lingering outbox entries (default 5 minutes). */
	pushMinIntervalMs?: number;
	/** Watch zotero.sqlite / -wal for changes (default true). */
	watch?: boolean;
}

export interface SyncStatusEx extends SyncStatus {
	/** Incremented every time a pull applied changes (UI: refresh lists when it changes). */
	changeCount: number;
	/** True while a pull or push is running. */
	busy: boolean;
}

export interface SyncConflict {
	id: number;
	type: string;
	key: string;
	title: string;
	local: unknown;
	remote: unknown;
	resolved: string;
	at: string;
}

async function tasklistHasZotero(): Promise<boolean> {
	if (process.platform !== "win32") return false;
	try {
		const p = Bun.spawn(["tasklist", "/FI", "IMAGENAME eq zotero.exe", "/NH", "/FO", "CSV"], { stdout: "pipe", stderr: "ignore", stdin: "ignore", windowsHide: true });
		const out = await new Response(p.stdout).text();
		await p.exited;
		return /"zotero\.exe"/i.test(out);
	} catch {
		return false;
	}
}

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

export class SyncService {
	private chain: Promise<unknown> = Promise.resolve();
	private timer: ReturnType<typeof setInterval> | null = null;
	private debounce: ReturnType<typeof setTimeout> | null = null;
	private watchers: FSWatcher[] = [];
	private running: boolean | null = null; // last observed "Zotero app is running"
	private probe = false;
	private probeAt = 0;
	private lastPushAttempt = 0;
	private changeCount = 0;
	private active = 0;
	private stopped = false;
	private readonly ownStorage: string | null;

	constructor(
		readonly db: Database,
		readonly opts: SyncOptions,
	) {
		const f = db.query("PRAGMA database_list").all() as { name: string; file: string }[];
		const file = f.find((r) => r.name === "main")?.file;
		this.ownStorage = opts.ownStorageDir !== undefined ? opts.ownStorageDir : file ? join(dirname(file), "storage") : null;
	}

	// ------------------------------------------------------------ state

	private getState(name: string): string | undefined {
		const r = this.db.query("SELECT value FROM sync_state WHERE name = ?").get(name) as { value: string } | null;
		return r?.value;
	}

	private setState(name: string, value: string | null): void {
		if (value === null) this.db.query("DELETE FROM sync_state WHERE name = ?").run(name);
		else this.db.query("INSERT INTO sync_state(name, value) VALUES(?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").run(name, value);
	}

	get enabled(): boolean {
		return this.getState("enabled") === "1";
	}

	private async zoteroRunning(): Promise<boolean> {
		return (this.opts.isZoteroRunning ?? tasklistHasZotero)();
	}

	// ------------------------------------------------------------ serialisation

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

	// ------------------------------------------------------------ pull

	/** Read Zotero's changes into zotero-next. Never throws: failures land in last_error. */
	pull(): Promise<void> {
		return this.exclusive(async () => {
			try {
				const since = this.getState("last_pull_at") ?? null;
				const ch = await this.opts.reader.changesSince(since);
				const report = applyChanges(this.db, ch, this.opts.dataDir);
				this.setState("last_pull_at", ch.at);
				this.setState("last_pull_ok_at", new Date().toISOString());
				this.setState("pull_error", null);
				if (report.applied + report.deleted > 0) this.changeCount++;
			} catch (e) {
				logError("sync", e, "pull");
				this.setState("pull_error", errMsg(e));
			}
		});
	}

	// ------------------------------------------------------------ push

	/** Write queued changes into Zotero (needs writing enabled and Zotero closed). Never throws. */
	push(): Promise<void> {
		return this.exclusive(async () => {
			this.lastPushAttempt = Date.now();
			if (!this.enabled || this.getState("paused") === "1") return;
			if (pendingCount(this.db) === 0) return;
			let plan;
			try {
				if (!(await this.opts.writer.canWrite())) return;
				plan = buildPush(this.db, this.opts.dataDir);
				if (plan.writes.length === 0) {
					completePush(this.db, plan, [], this.ownStorage);
					return;
				}
				const { backupPath, results } = await this.opts.writer.apply(plan.writes);
				const done = completePush(this.db, plan, results, this.ownStorage);
				this.setState("last_backup", backupPath);
				this.setState("last_push_at", new Date().toISOString());
				if (done.failed.length > 0) {
					const f = done.failed[0];
					this.setState("push_error", `${done.failed.length} change(s) not written; ${f.key}: ${f.error}`);
					logError("sync", f.error, `push: ${done.failed.length} change(s) not written`, { key: f.key });
				} else this.setState("push_error", null);
			} catch (e) {
				if (e instanceof ZoteroLockedError) return; // Zotero started meanwhile: entries stay queued
				logError("sync", e, "push (sync paused)");
				this.setState("push_error", errMsg(e));
				this.setState("paused", "1");
			}
		});
	}

	// ------------------------------------------------------------ public operations

	/** Pull, then push if writing is enabled and Zotero is closed. Clears a pause (manual retry). */
	async syncNow(): Promise<SyncStatusEx> {
		this.setState("paused", null);
		this.running = await this.zoteroRunning();
		await this.pull();
		if (this.enabled && !this.running) await this.push();
		return this.status();
	}

	async setEnabled(enabled: boolean): Promise<SyncStatusEx> {
		this.setState("enabled", enabled ? "1" : "0");
		if (enabled) {
			this.setState("paused", null);
			this.running = await this.zoteroRunning();
			if (!this.running) {
				await this.pull();
				await this.push();
			}
		}
		return this.status();
	}

	async status(): Promise<SyncStatusEx> {
		let zotero: SyncStatus["zotero"];
		if (!existsSync(join(this.opts.dataDir, "zotero.sqlite"))) zotero = "missing";
		else if (this.getState("pull_error")) zotero = "error";
		else {
			// cached for a few seconds: the UI polls this and each check spawns a process
			if (Date.now() - this.probeAt > 5000) {
				this.probe = await this.zoteroRunning();
				this.probeAt = Date.now();
			}
			zotero = this.probe ? "running" : "closed";
		}
		const conflicts = (this.db.query("SELECT count(*) AS n FROM sync_conflicts").get() as { n: number }).n;
		const st: SyncStatusEx = {
			enabled: this.enabled,
			zotero,
			dataDir: this.opts.dataDir,
			pending: pendingCount(this.db),
			conflicts,
			changeCount: this.changeCount,
			busy: this.active > 0,
		};
		const set = <K extends "lastPullAt" | "lastPushAt" | "lastBackup" | "lastError">(k: K, v: string | undefined) => {
			if (v) st[k] = v;
		};
		set("lastPullAt", this.getState("last_pull_ok_at"));
		set("lastPushAt", this.getState("last_push_at"));
		set("lastBackup", this.getState("last_backup"));
		set("lastError", this.getState("push_error") ?? this.getState("pull_error"));
		return st;
	}

	conflicts(): SyncConflict[] {
		const rows = this.db.query("SELECT id, type, key, local, remote, resolved, at FROM sync_conflicts ORDER BY id DESC LIMIT 500").all() as {
			id: number;
			type: string;
			key: string;
			local: string | null;
			remote: string | null;
			resolved: string;
			at: string;
		}[];
		return rows.map((r) => {
			const local = r.local ? JSON.parse(r.local) : null;
			const remote = r.remote ? JSON.parse(r.remote) : null;
			const o = (local ?? remote ?? {}) as Record<string, unknown>;
			const title = String(o.title ?? o.name ?? o.text ?? o.comment ?? (typeof o.note === "string" ? o.note.replace(/<[^>]*>/g, " ").trim().slice(0, 80) : "") ?? "") || r.key;
			return { id: r.id, type: r.type, key: r.key, title, local, remote, resolved: r.resolved, at: r.at };
		});
	}

	/** Remove conflict records the user has looked at (all when id is omitted). */
	dismissConflicts(id?: number): void {
		if (id === undefined) this.db.run("DELETE FROM sync_conflicts");
		else this.db.query("DELETE FROM sync_conflicts WHERE id = ?").run(id);
	}

	// ------------------------------------------------------------ background loop

	private async tick(): Promise<void> {
		if (this.stopped) return;
		const was = this.running;
		let now: boolean;
		try {
			now = await this.zoteroRunning();
		} catch {
			now = true;
		}
		this.running = now;
		this.probe = now;
		this.probeAt = Date.now();
		await this.pull();
		if (this.stopped || now || !this.enabled || pendingCount(this.db) === 0) return;
		const transitioned = was === true;
		if (transitioned || Date.now() - this.lastPushAttempt >= (this.opts.pushMinIntervalMs ?? 300_000)) await this.push();
	}

	private schedule(): void {
		if (this.debounce) clearTimeout(this.debounce);
		this.debounce = setTimeout(() => void this.tick(), this.opts.debounceMs ?? 2000);
	}

	start(): void {
		this.stopped = false;
		if (this.timer || this.watchers.length) return;
		void this.tick();
		const poll = this.opts.pollMs ?? 30_000;
		if (poll > 0) this.timer = setInterval(() => void this.tick(), poll);
		if (this.opts.watch !== false) {
			try {
				// Watch the directory (works for files that are replaced or locked) and filter on the names.
				const w = watch(this.opts.dataDir, (_ev, name) => {
					if (name && /^zotero\.sqlite(-wal)?$/.test(String(name))) this.schedule();
				});
				w.on("error", () => {});
				this.watchers.push(w);
			} catch {
				// directory missing: the poll still covers it
			}
		}
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		if (this.debounce) clearTimeout(this.debounce);
		this.timer = null;
		this.debounce = null;
		for (const w of this.watchers) w.close();
		this.watchers = [];
		await this.chain;
	}
}
