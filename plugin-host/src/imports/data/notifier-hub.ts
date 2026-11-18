// The notifier engine: reads core's change log and delivers batches of events to subscriptions (library.md design note 4).
//
//  - One feed per host process: a long poll on GET /api/changes?since=<cursor>&wait=. It runs while a subscription exists.
//  - Per subscription the events of one flush are merged per (object, kind, library, origin) with their ids, and flushed after
//    `max-delay-ms` (default 50 ms, at most 1000 ms), so a 5,000-item import is a few calls, not 5,000.
//  - One batch is in flight per subscription; the queue holds 256 batches. Past that the oldest are dropped and a `refresh` event
//    per affected object type follows, so a plugin re-reads instead of trusting a stream with holes.
//  - `silent` log rows (library.apply with skip-notify) are not delivered. A reset of the log (a different library file, or a
//    cursor older than what core keeps) turns into one `refresh` per subscribed type.
export const QUEUE_LIMIT = 256;
export const DEFAULT_DELAY_MS = 50;
export const MAX_DELAY_MS = 1000;

export interface ChangeRow {
	seq: number;
	object: string;
	kind: string;
	key: string;
	library: number | null;
	origin: string;
	silent: boolean;
}
export interface ChangePage {
	head: number;
	cursor: number;
	reset: boolean;
	changes: ChangeRow[];
}

export interface WitEvent {
	object: string;
	kind: string;
	ids: string[];
	library: number | undefined;
	extra: { id: string; data: string }[];
	options: string | undefined;
	origin: { tag: string; val?: string };
}
export interface WitBatch {
	seq: bigint;
	at: bigint;
	events: WitEvent[];
}
export interface WitSubscription {
	types: string[];
	kinds: string[];
	priority: number;
	skipOwn: boolean;
	maxDelayMs: number;
	label: string;
}

const ALL_TYPES = ["collection", "search", "item", "file", "collection-item", "item-tag", "tag", "setting", "group", "trash", "relation", "feed", "feed-item", "sync", "api-key", "share", "share-items", "bucket"];

interface Sub {
	id: number;
	plugin: string;
	sub: WitSubscription;
	deliver: (subId: number, batch: WitBatch) => Promise<void>;
	pending: Map<string, WitEvent>;
	timer: ReturnType<typeof setTimeout> | undefined;
	queue: WitBatch[];
	dropped: Set<string>;
	inflight: boolean;
	seq: bigint;
	failures: number;
}

export interface HubOptions {
	baseUrl: string;
	/** Long-poll wait, ms. Tests use a short one. */
	waitMs?: number;
	log?: (level: "warn" | "debug", msg: string) => void;
}

function originOf(raw: string, plugin: string): WitEvent["origin"] {
	if (raw.startsWith("plugin:")) {
		const id = raw.slice("plugin:".length);
		return id === plugin ? { tag: "this-plugin" } : { tag: "plugin", val: id };
	}
	if (raw === "user" || raw === "sync" || raw === "connector" || raw === "external") return { tag: raw };
	return { tag: "unknown" };
}

export class NotifierHub {
	private subs = new Map<number, Sub>();
	private nextId = 1;
	private abort: AbortController | undefined;
	private running = false;
	private cursor = 0;

	constructor(private opts: HubOptions) {}

	get size(): number {
		return this.subs.size;
	}

	subscribe(plugin: string, sub: WitSubscription, deliver: Sub["deliver"]): number {
		const id = this.nextId++;
		this.subs.set(id, { id, plugin, sub, deliver, pending: new Map(), timer: undefined, queue: [], dropped: new Set(), inflight: false, seq: 0n, failures: 0 });
		this.ensureFeed();
		return id;
	}

	unsubscribe(plugin: string, id: number): boolean {
		const s = this.subs.get(id);
		if (!s || s.plugin !== plugin) return false;
		this.remove(s);
		return true;
	}

	/** The plugin stopped: end all its subscriptions. */
	dropPlugin(plugin: string): void {
		for (const s of [...this.subs.values()]) if (s.plugin === plugin) this.remove(s);
	}

	countFor(plugin: string): number {
		return [...this.subs.values()].filter((s) => s.plugin === plugin).length;
	}

	private remove(s: Sub) {
		clearTimeout(s.timer);
		this.subs.delete(s.id);
		if (this.subs.size === 0) this.stopFeed();
	}

	stop(): void {
		for (const s of this.subs.values()) clearTimeout(s.timer);
		this.subs.clear();
		this.stopFeed();
	}

	/** A plugin-defined event (`notifier.trigger`): reaches the subscriptions of this process, never a forged library event. */
	trigger(from: string, ev: { object: string; ids: string[]; options: string | undefined }): void {
		const row = { object: ev.object, kind: "other", ids: ev.ids, options: ev.options, origin: `plugin:${from}` };
		for (const s of [...this.subs.values()].sort((a, b) => a.sub.priority - b.sub.priority)) this.offer(s, { ...row, library: null });
	}

	private stopFeed() {
		this.running = false;
		this.abort?.abort();
		this.abort = undefined;
	}

	private ensureFeed() {
		if (this.running) return;
		this.running = true;
		this.abort = new AbortController();
		void this.feed(this.abort.signal);
	}

	private async feed(signal: AbortSignal) {
		let backoff = 200;
		try {
			const head = await (await fetch(`${this.opts.baseUrl}/api/changes/head`, { signal })).json();
			this.cursor = (head as { head: number }).head;
		} catch {
			this.cursor = 0;
		}
		while (this.running && !signal.aborted) {
			try {
				const res = await fetch(`${this.opts.baseUrl}/api/changes?since=${this.cursor}&limit=1000&wait=${this.opts.waitMs ?? 20_000}`, { signal });
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const page = (await res.json()) as ChangePage;
				this.cursor = page.cursor;
				this.handle(page);
				backoff = 200;
			} catch (e) {
				if (signal.aborted) return;
				this.opts.log?.("warn", `change feed: ${(e as Error).message}`);
				await new Promise((r) => setTimeout(r, backoff));
				backoff = Math.min(backoff * 2, 5000);
			}
		}
	}

	/** Public for tests: feed a page as if the long poll had returned it. */
	handle(page: ChangePage): void {
		const subs = [...this.subs.values()].sort((a, b) => a.sub.priority - b.sub.priority);
		if (page.reset) {
			for (const s of subs) for (const t of s.sub.types.length ? s.sub.types : ["item", "collection"]) this.offer(s, { object: t, kind: "refresh", ids: [], library: null, origin: "unknown" });
		}
		for (const row of page.changes) {
			if (row.silent) continue;
			const ev =
				row.object === "annotation"
					? { object: "item", kind: "other", ids: [row.key], library: row.library, origin: row.origin, options: JSON.stringify({ name: "annotation", change: row.kind }) }
					: row.object === "item" && row.kind === "index"
						? { object: "item", kind: "index", ids: [row.key], library: row.library, origin: row.origin, options: undefined }
						: { object: row.object, kind: row.kind, ids: [row.key], library: row.library, origin: row.origin, options: undefined };
			for (const s of subs) this.offer(s, ev);
		}
	}

	private offer(s: Sub, ev: { object: string; kind: string; ids: string[]; library: number | null; origin: string; options?: string }) {
		const { sub } = s;
		if (sub.types.length && !sub.types.includes(ev.object)) return;
		if (sub.kinds.length && !sub.kinds.includes(ev.kind)) return;
		const origin = originOf(ev.origin, s.plugin);
		if (sub.skipOwn && origin.tag === "this-plugin") return;
		const k = [ev.object, ev.kind, ev.library ?? "", origin.tag, origin.val ?? "", ev.options ?? ""].join("\u0000");
		const cur = s.pending.get(k);
		if (cur) {
			for (const id of ev.ids) if (!cur.ids.includes(id)) cur.ids.push(id);
		} else s.pending.set(k, { object: ev.object, kind: ev.kind, ids: [...ev.ids], library: ev.library ?? undefined, extra: [], options: ev.options, origin });
		if (!s.timer) {
			const delay = Math.min(Math.max(sub.maxDelayMs > 0 ? sub.maxDelayMs : DEFAULT_DELAY_MS, 1), MAX_DELAY_MS);
			s.timer = setTimeout(() => this.flush(s), delay);
		}
	}

	private flush(s: Sub) {
		s.timer = undefined;
		if (s.pending.size === 0 || !this.subs.has(s.id)) return;
		const events = [...s.pending.values()];
		s.pending.clear();
		s.queue.push({ seq: ++s.seq, at: BigInt(Date.now()), events });
		while (s.queue.length > QUEUE_LIMIT) {
			const gone = s.queue.shift()!;
			for (const e of gone.events) s.dropped.add(e.object);
		}
		void this.pump(s);
	}

	private async pump(s: Sub) {
		if (s.inflight) return;
		s.inflight = true;
		try {
			while (s.queue.length && this.subs.has(s.id)) {
				// batches were dropped before these: the plugin first gets a `refresh` for each affected type (what it holds is stale)
				let batch: WitBatch;
				if (s.dropped.size) {
					batch = { seq: ++s.seq, at: BigInt(Date.now()), events: [...s.dropped].map((object) => ({ object, kind: "refresh", ids: [], library: undefined, extra: [], options: undefined, origin: { tag: "unknown" } })) };
					s.dropped.clear();
				} else batch = s.queue.shift()!;
				try {
					await s.deliver(s.id, batch);
					s.failures = 0;
				} catch (e) {
					this.opts.log?.("warn", `notifier: delivery to ${s.plugin} failed: ${(e as Error).message}`);
					if (++s.failures >= 5) {
						this.remove(s);
						return;
					}
				}
			}
		} finally {
			s.inflight = false;
		}
	}
}

export const OBJECT_TYPES = ALL_TYPES;
