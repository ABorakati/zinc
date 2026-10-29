// The Bun host of the zotero-fulltext WebAssembly core.
//
// The engine is sans-IO: step(StepIn{now, wall, commands, completions}) returns StepOut{effects, next_timer, more}.
// This Runner performs every Effect concurrently (one Promise per op, never awaited by the step loop), feeds the
// completions back, and schedules the next step. Port of plugin/content/effects.js; the host functions it provides:
//
//   http           Bun fetch + cookie jar (http.ts); PDFs stream to a temp file, pages stay in memory
//   save_pdf       move the PDF to <dataDir>/storage/<KEY>/ and insert the attachment rows (save.ts)
//   persist        ledger / halts / caches -> <dataDir>/fulltext-state.json
//   browser_load   unsupported (no embedded browser): the engine skips the browser tier
//   login_window   answered with LoginResult "handoff": the item ends with a link for the user's own browser
//   zotero_oa / run_translators   nothing found (Zotero-only services)
//   confirm        yes

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type BodyStore, stageBytes, stageFile } from "./bodies";
import { type HttpClient, OpError } from "./http";
import type { Command, CompletionMsg, Effect, ItemId, OpErr, OpId, Outcome, Persisted, ProgressRow, RunId, RunReport, StepOut } from "./proto";
import type { WasmHost } from "./wasm";
import { EngineError, EngineTrap } from "./wasm";

const MAX_STEPS_PER_PUMP = 64;
const STALL_MS = 15000;

// ---------------------------------------------------------------- persisted engine state

export class PersistStore {
	private data: Record<string, unknown> = {};
	constructor(private path: string | null) {
		if (path && existsSync(path)) {
			try {
				const v = JSON.parse(readFileSync(path, "utf8"));
				if (v && typeof v === "object") this.data = v.persisted ?? {};
			} catch {
				/* corrupt state: start fresh */
			}
		}
	}
	get(): Persisted {
		return this.data as Persisted;
	}
	set(key: string, value: unknown): void {
		this.data[key] = value;
		if (!this.path) return;
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			const tmp = `${this.path}.tmp`;
			writeFileSync(tmp, JSON.stringify({ v: 1, persisted: this.data }));
			renameSync(tmp, this.path);
		} catch (e) {
			console.warn("fulltext: could not persist state", e);
		}
	}
}

// ---------------------------------------------------------------- runner

export interface RunnerDeps {
	wasm: WasmHost;
	http: HttpClient;
	bodies: BodyStore;
	state: PersistStore;
	save: (req: Extract<Effect, { type: "save_pdf" }>["req"]) => { attachment_key: string; filename: string };
	onProgress: (run: RunId, item: ItemId, row: ProgressRow) => void;
	onRunFinished: (report: RunReport) => void;
	onEngineFailure?: (err: unknown) => void;
	onLog?: (level: string, msg: string) => void;
	/** test seam */
	clock?: { mono: () => number; wall: () => number };
}

interface OpRec {
	op: OpId;
	type: string;
	run: RunId;
	item: ItemId | null;
	ac: AbortController;
	engineCancelled: boolean;
	posted: boolean;
}

interface RunRec {
	run: RunId;
	items: { item: ItemId; key: string }[];
	saved: Map<ItemId, Outcome>;
	started: boolean;
	finished: boolean;
}

function opErrOf(e: unknown): OpErr {
	if (e instanceof OpError) return e.toOpErr();
	return { kind: "internal", message: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
}

export class Runner {
	failed = false;
	needsConfigure = true;
	private runs = new Map<RunId, RunRec>();
	private ops = new Map<OpId, OpRec>();
	private pendingCommands: Command[] = [];
	private pendingCompletions: CompletionMsg[] = [];
	private completionBodies = new Map<OpId, number[]>();
	private pumping = false;
	private dirty = false;
	private pumpPromise: Promise<void> = Promise.resolve();
	private pumpTimer: ReturnType<typeof setTimeout> | null = null;
	private engineTimer: ReturnType<typeof setTimeout> | null = null;
	private stallTimer: ReturnType<typeof setTimeout> | null = null;
	private stallStrikes = 0;
	private dumpSent = false;
	private lastOut: StepOut | null = null;
	private disposed = false;
	private quietWaiters: (() => void)[] = [];
	private tasks = new Set<Promise<unknown>>();
	steps = 0;

	constructor(
		private deps: RunnerDeps,
		private opts: { stallMs?: number } = {},
	) {}

	private mono(): number {
		return this.deps.clock ? this.deps.clock.mono() : Math.floor(performance.now());
	}
	private wall(): number {
		return this.deps.clock ? this.deps.clock.wall() : Date.now();
	}

	// ------------------------------------------------------------ public API

	send(commands: Command[]): void {
		if (this.disposed) return;
		let queued = false;
		for (const cmd of commands) {
			if (this.failed) {
				if (cmd.type !== "configure") continue;
				this.failed = false; // a new Configure is the resume signal
			}
			if (cmd.type === "configure") this.needsConfigure = false;
			else if (cmd.type === "start_run") {
				const r = this.run(cmd.run);
				r.started = true;
				r.finished = false;
				r.items = cmd.items.map((i) => ({ item: i.item, key: i.key }));
			} else if (cmd.type === "cancel_run") this.cancelOps((r) => r.run === cmd.run, "user");
			else if (cmd.type === "cancel_item") this.cancelOps((r) => r.run === cmd.run && r.item === cmd.item, "user");
			this.pendingCommands.push(cmd);
			queued = true;
		}
		if (queued) {
			this.updateStall();
			this.schedulePump();
		}
	}

	activeRuns(): number {
		let n = 0;
		for (const r of this.runs.values()) if (r.started && !r.finished) n++;
		return n;
	}

	whenQuiet(): Promise<void> {
		if (this.isQuiet()) return Promise.resolve();
		return new Promise((resolve) => this.quietWaiters.push(resolve));
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.clearTimers();
		this.pendingCommands = [];
		this.pendingCompletions = [];
		for (const rec of this.ops.values()) rec.ac.abort("dispose");
		await Promise.race([Promise.allSettled(Array.from(this.tasks)), new Promise((r) => setTimeout(r, 3000))]);
		this.notifyQuiet();
	}

	// ------------------------------------------------------------ plumbing

	private run(id: RunId): RunRec {
		let r = this.runs.get(id);
		if (!r) {
			r = { run: id, items: [], saved: new Map(), started: false, finished: false };
			this.runs.set(id, r);
		}
		return r;
	}

	private isQuiet(): boolean {
		return this.ops.size === 0 && this.pendingCompletions.length === 0 && this.pendingCommands.length === 0 && !this.pumping && this.pumpTimer === null;
	}

	private notifyQuiet(): void {
		if (!this.quietWaiters.length || !this.isQuiet()) return;
		const w = this.quietWaiters;
		this.quietWaiters = [];
		for (const f of w) f();
	}

	private spawn(label: string, fn: () => Promise<unknown>): void {
		const p = fn().catch((e) => this.log("error", `${label} failed: ${e instanceof Error ? e.message : e}`));
		this.tasks.add(p);
		void p.finally(() => this.tasks.delete(p));
	}

	private log(level: string, msg: string): void {
		if (this.deps.onLog) this.deps.onLog(level, msg);
		else if (level === "warn" || level === "error") console.warn(`fulltext: ${msg}`);
	}

	private clearTimers(): void {
		if (this.pumpTimer !== null) clearTimeout(this.pumpTimer);
		if (this.engineTimer !== null) clearTimeout(this.engineTimer);
		if (this.stallTimer !== null) clearTimeout(this.stallTimer);
		this.pumpTimer = this.engineTimer = this.stallTimer = null;
	}

	private schedulePump(): void {
		this.dirty = true;
		if (this.pumping || this.pumpTimer !== null || this.disposed || this.failed) return;
		this.pumpTimer = setTimeout(() => {
			this.pumpTimer = null;
			this.spawn("pump", () => this.pump());
		}, 0);
	}

	private armEngineTimer(): void {
		if (this.engineTimer !== null) {
			clearTimeout(this.engineTimer);
			this.engineTimer = null;
		}
		const at = this.lastOut?.next_timer;
		if (at === null || at === undefined) return;
		this.engineTimer = setTimeout(
			() => {
				this.engineTimer = null;
				this.spawn("engine-timer", () => this.pump());
			},
			Math.max(0, at - this.mono()),
		);
	}

	async pump(): Promise<void> {
		if (this.failed || this.disposed) return;
		if (this.pumping) {
			this.dirty = true;
			return this.pumpPromise;
		}
		if (this.pumpTimer !== null) {
			clearTimeout(this.pumpTimer);
			this.pumpTimer = null;
		}
		this.pumping = true;
		this.dirty = true;
		let resolveDone!: () => void;
		this.pumpPromise = new Promise<void>((r) => (resolveDone = r));
		let more = false;
		let capped = false;
		try {
			let steps = 0;
			while ((this.dirty || more) && !this.failed && !this.disposed) {
				if (steps >= MAX_STEPS_PER_PUMP) {
					capped = true;
					break;
				}
				steps++;
				this.dirty = false;
				more = this.stepOnce();
				if (more) await new Promise((r) => setTimeout(r, 0));
			}
		} catch (e) {
			this.log("error", `pump failed: ${e instanceof Error ? e.message : e}`);
		} finally {
			this.pumping = false;
			if (!this.failed && !this.disposed) {
				if (capped) this.schedulePump();
				else this.armEngineTimer();
			}
			resolveDone();
			this.updateStall();
			this.notifyQuiet();
		}
	}

	private stepOnce(): boolean {
		const commands = this.pendingCommands;
		this.pendingCommands = [];
		const completions = this.pendingCompletions;
		this.pendingCompletions = [];
		let out: StepOut;
		try {
			out = this.deps.wasm.step({ now: this.mono(), wall: this.wall(), commands, completions });
		} catch (e) {
			this.fail(e);
			return false;
		}
		if (!out || typeof out !== "object") {
			this.fail(new Error("engine returned no StepOut"));
			return false;
		}
		this.steps++;
		this.lastOut = out;
		const ignored = new Set(out.ignored ?? []);
		for (const c of completions) {
			const handles = this.completionBodies.get(c.op);
			if (!handles) continue;
			this.completionBodies.delete(c.op);
			if (ignored.has(c.op)) for (const h of handles) this.deps.bodies.release(h);
		}
		for (const eff of out.effects ?? []) {
			try {
				this.dispatch(eff);
			} catch (e) {
				this.log("error", `effect ${eff?.type} dispatch failed: ${e instanceof Error ? e.message : e}`);
			}
		}
		return !!out.more;
	}

	// ------------------------------------------------------------ effects

	private dispatch(eff: Effect): void {
		switch (eff.type) {
			case "http":
				this.startOp(eff, (rec) => this.doHttp(eff, rec));
				break;
			case "browser_load":
				this.startOp(eff, async () => {
					throw new OpError("unsupported", "no embedded browser in this host");
				});
				break;
			case "login_window":
				this.startOp(eff, async () => ({
					result: "handoff",
					final_url: eff.req.entry_url,
					inspect: { expect: "none" },
				}));
				break;
			case "login_update":
				this.pendingCompletions.push({ op: eff.op, ok: {} });
				this.schedulePump();
				break;
			case "run_translators":
				this.startOp(eff, async () => ({ found: null, ms: 0 }));
				break;
			case "zotero_oa":
				this.startOp(eff, async () => []);
				break;
			case "save_pdf":
				this.startOp(eff, async (rec) => {
					const ok = this.deps.save(eff.req);
					this.run(eff.run).saved.set(eff.item, {
						kind: "saved",
						route: eff.req.route,
						source: eff.req.source,
						version: eff.req.version,
						url: eff.req.url_to_store,
						attachment_key: ok.attachment_key,
					});
					void rec;
					return ok;
				});
				break;
			case "confirm":
				this.startOp(eff, async () => ({ choice: "yes" }));
				break;
			case "cancel": {
				const rec = this.ops.get(eff.op);
				if (rec) {
					rec.engineCancelled = true;
					rec.ac.abort("engine");
				}
				break;
			}
			case "release":
				this.deps.bodies.release(eff.handle);
				break;
			case "progress":
				try {
					this.deps.onProgress(eff.run, eff.item, eff.row);
				} catch (e) {
					this.log("error", `onProgress failed: ${e}`);
				}
				break;
			case "persist":
				this.deps.state.set(eff.key, eff.value);
				break;
			case "run_finished": {
				this.deps.bodies.releaseAll(eff.run);
				const r = this.runs.get(eff.run);
				if (r) {
					r.finished = true;
					this.cancelOps((o) => o.run === eff.run, "run_finished", false);
					this.runs.delete(eff.run);
				}
				try {
					this.deps.onRunFinished(eff.report);
				} catch (e) {
					this.log("error", `onRunFinished failed: ${e}`);
				}
				break;
			}
			case "log":
				if (eff.level !== "debug") this.log(eff.level === "error" || eff.level === "warn" ? eff.level : "info", `engine: ${eff.msg}`);
				break;
			case "trace":
				break;
			default: {
				const op = (eff as { op?: unknown }).op;
				this.log("warn", `unknown effect type ${(eff as { type: string }).type}`);
				if (typeof op === "number") {
					this.pendingCompletions.push({ op, err: { kind: "unsupported", message: "unknown effect" } });
					this.schedulePump();
				}
			}
		}
	}

	private startOp(eff: Effect & { op: OpId }, handler: (rec: OpRec) => Promise<unknown>): void {
		if (this.ops.has(eff.op)) return;
		const rec: OpRec = {
			op: eff.op,
			type: eff.type,
			run: "run" in eff ? (eff as { run: RunId }).run : -1,
			item: "item" in eff ? (eff as { item: ItemId }).item : null,
			ac: new AbortController(),
			engineCancelled: false,
			posted: false,
		};
		this.ops.set(eff.op, rec);
		this.spawn(`${eff.type}#${eff.op}`, async () => {
			let ok: unknown;
			let err: OpErr | null = null;
			try {
				if (rec.ac.signal.aborted) throw new OpError("cancelled", String(rec.ac.signal.reason));
				ok = await handler(rec);
			} catch (e) {
				err = opErrOf(e);
			}
			this.post(rec, ok, err);
		});
	}

	/** Answer an op exactly once; late results are dropped and their bodies released. */
	private post(rec: OpRec, ok: unknown, err: OpErr | null): void {
		const handles = err ? [] : bodyHandles(ok);
		if (rec.posted) {
			for (const h of handles) this.deps.bodies.release(h);
			return;
		}
		rec.posted = true;
		if (process.env.FULLTEXT_DEBUG) console.log("fulltext completion", rec.type, rec.op, JSON.stringify(err ?? ok).slice(0, 500));
		this.ops.delete(rec.op);
		if (rec.engineCancelled || this.failed || this.disposed) {
			for (const h of handles) this.deps.bodies.release(h);
			this.notifyQuiet();
			return;
		}
		this.pendingCompletions.push(err ? { op: rec.op, err } : { op: rec.op, ok: ok === undefined ? null : ok });
		if (handles.length) this.completionBodies.set(rec.op, handles);
		this.schedulePump();
	}

	/** JS-initiated cancel: abort the ops and answer them at once with err.kind "cancelled". */
	private cancelOps(match: (r: OpRec) => boolean, reason: string, answer = true): void {
		for (const rec of Array.from(this.ops.values())) {
			if (!match(rec)) continue;
			rec.ac.abort(reason);
			if (answer) this.post(rec, undefined, { kind: "cancelled", message: reason });
			else rec.engineCancelled = true;
		}
	}

	private inspect(spec: unknown, resp: Parameters<WasmHost["inspect"]>[0]["resp"], bytes: Uint8Array) {
		return this.deps.wasm.inspect({ spec, resp }, bytes);
	}

	private async doHttp(eff: Extract<Effect, { type: "http" }>, rec: OpRec): Promise<unknown> {
		const { http, bodies } = this.deps;
		const signal = rec.ac.signal;
		const spec = eff.inspect;
		const retain = eff.retain ?? "none";
		const wantFile = retain === "pdf" || spec?.expect === "pdf";
		let slot: { dir: string; path: string } | null = null;
		let raw;
		try {
			if (wantFile) {
				slot = bodies.allocSlot();
				raw = await http.request(eff.req, { signal, sink: "file", path: slot.path });
			} else {
				raw = await http.request(eff.req, { signal, sink: "memory" });
			}
		} catch (e) {
			bodies.discardSlot(slot);
			throw e;
		}
		let kept = false;
		try {
			const fileWritten = !!(slot && raw.path);
			const staged = fileWritten ? stageFile(raw.path!, raw.bytes) : stageBytes((slot ? raw.errorBody : raw.body) ?? new Uint8Array(0), "page");
			const resp: Parameters<WasmHost["inspect"]>[0]["resp"] = {
				status: raw.status,
				final_url: raw.final_url,
				headers: raw.headers,
				body_len: staged.body_len,
				truncated: staged.truncated,
			};
			if (staged.head_len != null) resp.head_len = staged.head_len;
			const inspection = this.inspect(spec, resp, staged.bytes);
			if (process.env.FULLTEXT_DEBUG) console.log("fulltext http", eff.req.url, raw.status, JSON.stringify(resp), JSON.stringify(inspection).slice(0, 300));
			if (signal.aborted) throw new OpError("cancelled", String(signal.reason));
			let body = null;
			if (retain !== "none") {
				if (fileWritten) {
					body = bodies.putFile({ path: raw.path!, dir: slot!.dir, len: staged.body_len, run: eff.run });
					kept = true;
				} else if (!slot && retain === "page") {
					body = bodies.putMemory(raw.body ?? new Uint8Array(0), eff.run);
				}
			}
			return {
				status: raw.status,
				final_url: raw.final_url,
				headers: raw.headers,
				bytes: Number.isFinite(raw.bytes) ? raw.bytes : staged.body_len,
				ms: Math.max(0, Math.round(raw.ms) || 0),
				body,
				inspect: inspection,
			};
		} finally {
			if (slot && !kept) bodies.discardSlot(slot);
		}
	}

	// ------------------------------------------------------------ failure policy

	private fail(err: unknown): void {
		if (this.failed) return;
		this.failed = true;
		this.log("error", `engine failure: ${err instanceof Error ? err.message : err}`);
		this.clearTimers();
		this.pendingCommands = [];
		this.pendingCompletions = [];
		this.completionBodies.clear();
		this.stallStrikes = 0;
		this.dumpSent = false;
		const unfinished = Array.from(this.runs.values()).filter((r) => r.started && !r.finished);
		for (const rec of this.ops.values()) {
			rec.posted = true;
			rec.ac.abort("engine_failure");
		}
		this.ops.clear();
		this.runs = new Map();
		this.deps.bodies.releaseAll();
		for (const r of unfinished) {
			try {
				this.deps.onRunFinished(syntheticReport(r));
			} catch (e) {
				this.log("error", `onRunFinished failed: ${e}`);
			}
		}
		try {
			this.deps.wasm.resetEngine();
		} catch (e) {
			this.log("error", `resetEngine failed: ${e}`);
		}
		this.lastOut = null;
		this.needsConfigure = true;
		try {
			this.deps.onEngineFailure?.(err);
		} catch {
			/* ignore */
		}
		this.notifyQuiet();
	}

	// ------------------------------------------------------------ stall watchdog

	private stallInterval(): number {
		return Math.max(1, Math.floor((this.opts.stallMs ?? STALL_MS) / 3));
	}

	private updateStall(): void {
		if (this.failed || this.disposed) return;
		const active = this.activeRuns() > 0;
		if (active && this.stallTimer === null) {
			this.stallTimer = setTimeout(() => this.stallCheck(), this.stallInterval());
		} else if (!active && this.stallTimer !== null) {
			clearTimeout(this.stallTimer);
			this.stallTimer = null;
			this.stallStrikes = 0;
			this.dumpSent = false;
		}
	}

	private isStalled(): boolean {
		const out = this.lastOut;
		if (!out) return false;
		return (
			this.ops.size === 0 &&
			!this.pumping &&
			this.pumpTimer === null &&
			this.pendingCommands.length === 0 &&
			this.pendingCompletions.length === 0 &&
			!out.more &&
			(out.next_timer === null || out.next_timer === undefined) &&
			!((out.stats?.waiting_user ?? 0) > 0)
		);
	}

	private stallCheck(): void {
		this.stallTimer = null;
		if (this.failed || this.disposed) return;
		if (this.activeRuns() === 0) {
			this.stallStrikes = 0;
			return;
		}
		if (this.isStalled()) {
			this.stallStrikes++;
			if (this.stallStrikes >= 3 && this.dumpSent) {
				this.fail(new Error("engine stalled"));
				return;
			}
			if (this.stallStrikes >= 2 && !this.dumpSent) {
				this.dumpSent = true;
				this.send([{ type: "dump_state" }]);
			}
		} else {
			this.stallStrikes = 0;
		}
		this.updateStall();
	}
}

function bodyHandles(ok: unknown): number[] {
	const out: number[] = [];
	if (!ok || typeof ok !== "object" || Array.isArray(ok)) return out;
	for (const key of ["body", "pdf", "page"]) {
		const ref = (ok as Record<string, any>)[key];
		if (ref && typeof ref.handle === "number") out.push(ref.handle);
	}
	return out;
}

/** The report used when the engine failed under a run: items seen saved stay saved, the rest need the user. */
export function syntheticReport(r: RunRec): RunReport {
	let saved = 0;
	const items = r.items.map((it) => {
		const done = r.saved.get(it.item);
		if (done) saved++;
		return { item: it.item, key: it.key, outcome: done ?? ({ kind: "needs_user", why: "engine_restarted", handoff: {} } as Outcome), trace: [] };
	});
	return {
		run: r.run,
		counts: { saved, skipped: 0, not_found: 0, needs_user: items.length - saved, blocked: 0, deferred: 0, cancelled: 0, failed: 0 },
		items,
		ledger: { hour: 0, hour_cap: 0, day: 0, day_cap: 0, mb_hour: 0, mb_hour_cap: 0 },
		halted: null,
		engine_restarts: 1,
	};
}

export { EngineError, EngineTrap };
