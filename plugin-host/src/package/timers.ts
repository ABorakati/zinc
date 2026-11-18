// The timers of `timers.set-timeout`, `set-interval` and `request-idle` (lifecycle.wit): per plugin, at most 64, an interval is never
// shorter than 10 ms, and while every Zinc window is hidden a timer shorter than 1 s runs at most once a second. A fired timer calls
// the plugin's `events.on-timer(timer, kind)` through `deliver`. Native Rust timers run inside `zhw` and
// report their active count via `setRemoteCount`; `clearAll`/`clearEverything` also emit `onClear` (`timers-clear`).
import { WitError } from "../imports/registry";

export type TimerKind = "timeout" | "interval" | "idle";

export interface TimerOptions {
	/** Calls an export of the plugin. Failures (the plugin is stopping, the host restarted) are ignored here. */
	deliver: (plugin: string, iface: string, fn: string, args: unknown[]) => Promise<unknown>;
	/** True while every Zinc window is hidden or minimised. Default: never. */
	hidden?: () => boolean;
	/** Called when `clearAll(plugin)` or `clearEverything()` (`plugin === undefined`) cancels timers, so `zhw` cancels native timers too. */
	onClear?: (plugin?: string) => void;
	maxTimers?: number;
	minIntervalMs?: number;
	/** `request-idle` has no idle signal yet: it fires after min(deadline, this). Default 50 ms. */
	idleDelayMs?: number;
}

interface Entry {
	kind: TimerKind;
	ms: number;
	handle: ReturnType<typeof setTimeout> | undefined;
	busy: boolean;
}

export class TimerService {
	private timers = new Map<string, Map<number, Entry>>();
	private next = new Map<string, number>();
	private remoteCounts = new Map<string, number>();
	private max: number;
	private minInterval: number;
	private idleDelay: number;

	constructor(private o: TimerOptions) {
		this.max = o.maxTimers ?? 64;
		this.minInterval = o.minIntervalMs ?? 10;
		this.idleDelay = o.idleDelayMs ?? 50;
	}

	private add(plugin: string, kind: TimerKind, ms: number): number {
		let m = this.timers.get(plugin);
		if (!m) this.timers.set(plugin, (m = new Map()));
		if (m.size + (this.remoteCounts.get(plugin) ?? 0) >= this.max) throw new WitError("limit-exceeded", `at most ${this.max} timers per plugin`);
		const id = (this.next.get(plugin) ?? 0) + 1;
		this.next.set(plugin, id);
		const e: Entry = { kind, ms, handle: undefined, busy: false };
		m.set(id, e);
		this.arm(plugin, id, e);
		return id;
	}

	private delay(e: Entry): number {
		let d = e.kind === "idle" ? Math.min(e.ms, this.idleDelay) : e.ms;
		if (e.kind === "interval") d = Math.max(d, this.minInterval);
		if (this.o.hidden?.() && d < 1000) d = 1000;
		return d;
	}

	private arm(plugin: string, id: number, e: Entry) {
		e.handle = setTimeout(() => {
			const m = this.timers.get(plugin);
			if (!m || m.get(id) !== e) return;
			if (e.kind !== "interval") m.delete(id);
			if (e.kind === "interval" && e.busy) {
				this.arm(plugin, id, e); // the last tick is still running in the plugin: skip this one
				return;
			}
			e.busy = true;
			void this.o
				.deliver(plugin, "events", "on-timer", [id, e.kind])
				.catch(() => {})
				.finally(() => {
					e.busy = false;
				});
			if (e.kind === "interval") this.arm(plugin, id, e);
		}, this.delay(e));
		(e.handle as { unref?: () => void })?.unref?.();
	}

	setTimeout(plugin: string, ms: number): number {
		return this.add(plugin, "timeout", ms);
	}

	setInterval(plugin: string, ms: number): number {
		return this.add(plugin, "interval", ms);
	}

	requestIdle(plugin: string, deadlineMs: number): number {
		return this.add(plugin, "idle", deadlineMs);
	}

	clear(plugin: string, id: number): void {
		const m = this.timers.get(plugin);
		const e = m?.get(id);
		if (!e) return;
		clearTimeout(e.handle);
		m!.delete(id);
	}

	/** Update active native Rust timer count reported by `zhw` (`timers-count`). */
	setRemoteCount(plugin: string, count: number): void {
		if (count <= 0) this.remoteCounts.delete(plugin);
		else this.remoteCounts.set(plugin, count);
	}

	/** The plugin stopped (or the host restarted): cancel every timer it has. */
	clearAll(plugin: string): void {
		for (const e of this.timers.get(plugin)?.values() ?? []) clearTimeout(e.handle);
		this.timers.delete(plugin);
		this.next.delete(plugin);
		this.remoteCounts.delete(plugin);
		this.o.onClear?.(plugin);
	}

	clearEverything(): void {
		for (const m of this.timers.values()) {
			for (const e of m.values()) clearTimeout(e.handle);
		}
		this.timers.clear();
		this.next.clear();
		this.remoteCounts.clear();
		this.o.onClear?.(undefined);
	}

	count(plugin: string): number {
		return (this.timers.get(plugin)?.size ?? 0) + (this.remoteCounts.get(plugin) ?? 0);
	}
}
