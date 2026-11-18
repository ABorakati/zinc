// A reactive cache that fills itself in batches. Used for item list columns, row styles, collection decorations and info rows: the
// UI asks for the value of one key while it draws (`get`), the cache collects the keys asked for within a short delay and sends ONE
// call to the plugin for them (never one call per row), then notifies readers. Values stay until the key is invalidated.
import { createSignal } from "solid-js";

export interface BatchCacheOptions<V> {
	/** The plugin call for these keys: one value per key, in order. */
	fetch: (keys: string[]) => Promise<(V | undefined)[]>;
	/** Most keys per call (extend.wit: 200 for the rows on screen). */
	batch?: number;
	/** How long to collect keys before calling. Default 30 ms. */
	delayMs?: number;
	/** After a failed call the keys are asked for again no sooner than this. Default 5 s. */
	retryMs?: number;
}

interface Slot<V> {
	value?: V;
	state: "queued" | "loading" | "done" | "failed";
	at: number;
}

export class BatchCache<V> {
	private slots = new Map<string, Slot<V>>();
	private queue = new Set<string>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private rev: () => number;
	private bump: () => void;
	/** Calls made so far (tests: "no per-row calls"). */
	calls = 0;
	/** Key counts of each call. */
	callSizes: number[] = [];

	constructor(private opts: BatchCacheOptions<V>) {
		const [rev, setRev] = createSignal(0);
		this.rev = rev;
		this.bump = () => setRev((n) => n + 1);
	}

	/** The cached value, or undefined (and the key is queued) while it is not there yet. Subscribes the reader to arrivals. */
	get(key: string): V | undefined {
		this.rev();
		const s = this.slots.get(key);
		if (s) {
			if (s.state === "failed" && Date.now() - s.at >= (this.opts.retryMs ?? 5000)) this.enqueue(key);
			return s.value;
		}
		this.enqueue(key);
		return undefined;
	}

	/** Non-reactive peek (tests, handlers). */
	peek(key: string): V | undefined {
		return this.slots.get(key)?.value;
	}

	/** Forget these keys (all when omitted); readers ask again. The old value stays visible until the new one arrives. */
	invalidate(keys?: Iterable<string>): void {
		if (!keys) {
			for (const [k, s] of this.slots) if (s.state === "done" || s.state === "failed") this.enqueue(k, true);
			this.bump();
			return;
		}
		for (const k of keys) if (this.slots.has(k)) this.enqueue(k, true);
		this.bump();
	}

	/** Drop everything (the plugin went). */
	clear(): void {
		this.slots.clear();
		this.queue.clear();
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.bump();
	}

	private enqueue(key: string, force = false): void {
		const s = this.slots.get(key);
		if (s && !force && (s.state === "queued" || s.state === "loading")) return;
		this.slots.set(key, { value: s?.value, state: "queued", at: Date.now() });
		this.queue.add(key);
		this.timer ??= setTimeout(() => void this.flush(), this.opts.delayMs ?? 30);
	}

	private async flush(): Promise<void> {
		this.timer = undefined;
		const all = [...this.queue];
		this.queue.clear();
		const size = this.opts.batch ?? 200;
		for (let i = 0; i < all.length; i += size) {
			const keys = all.slice(i, i + size);
			for (const k of keys) {
				const s = this.slots.get(k);
				if (s) s.state = "loading";
			}
			this.calls++;
			this.callSizes.push(keys.length);
			try {
				const values = await this.opts.fetch(keys);
				for (let j = 0; j < keys.length; j++) {
					const s = this.slots.get(keys[j]!);
					if (!s || s.state !== "loading") continue; // invalidated or cleared meanwhile
					s.value = values[j] ?? undefined;
					s.state = "done";
				}
			} catch {
				// a failed or too-slow call: keep the last good values (Zotero's fallbackReturn), ask again later
				for (const k of keys) {
					const s = this.slots.get(k);
					if (s && s.state === "loading") {
						s.state = "failed";
						s.at = Date.now();
					}
				}
			}
			this.bump();
		}
	}
}
