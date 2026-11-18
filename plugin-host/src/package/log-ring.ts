// The plugin log (lifecycle.wit, interface log): lines tagged with the plugin id, kept in a ring buffer for Help > Debug Output and
// Settings > Plugins. Limits: 200 lines a second and 8 KiB a line per plugin; extra lines are dropped and counted. `debug` lines are
// kept only while `debugEnabled` is true. The ring is fed by the supervisor's "log" events (`services.attach`), so output that does not
// come through `log.write` (a Rust guest's stderr, host diagnostics) lands in the same place.
export type LogLevel = "error" | "warn" | "info" | "debug";

export interface LogLine {
	ts: number;
	plugin?: string;
	level: LogLevel;
	message: string;
}

export const MAX_LINE_BYTES = 8 * 1024;
export const MAX_LINES_PER_SECOND = 200;

export class LogRing {
	private lines: LogLine[] = [];
	private rate = new Map<string, { windowStart: number; n: number }>();
	private dropped = new Map<string, number>();
	private lastErrors = new Map<string, { ts: number; message: string; stack?: string }>();
	debugEnabled = false;

	constructor(private capacity = 5000) {}

	/**
	 * Applies the plugin-facing limits to one `log.write` line. Returns the text to log, or undefined when the line is dropped
	 * (debug off, or over the rate limit).
	 */
	accept(plugin: string, level: LogLevel, message: string, now = Date.now()): string | undefined {
		if (level === "debug" && !this.debugEnabled) return undefined;
		let r = this.rate.get(plugin);
		if (!r || now - r.windowStart >= 1000) this.rate.set(plugin, (r = { windowStart: now, n: 0 }));
		if (++r.n > MAX_LINES_PER_SECOND) {
			this.dropped.set(plugin, (this.dropped.get(plugin) ?? 0) + 1);
			return undefined;
		}
		return truncate(message);
	}

	push(plugin: string | undefined, level: LogLevel, message: string, ts = Date.now()) {
		this.lines.push({ ts, plugin, level, message });
		if (this.lines.length > this.capacity) this.lines.splice(0, this.lines.length - this.capacity);
	}

	/** `log.write-error` and error-level `log.write`: remembered as the plugin's last error (Settings > Plugins). */
	recordError(plugin: string, message: string, stack?: string) {
		this.lastErrors.set(plugin, { ts: Date.now(), message, stack });
	}

	lastError(plugin: string) {
		return this.lastErrors.get(plugin);
	}

	droppedCount(plugin: string): number {
		return this.dropped.get(plugin) ?? 0;
	}

	recent(o: { plugin?: string; limit?: number } = {}): LogLine[] {
		const all = o.plugin ? this.lines.filter((l) => l.plugin === o.plugin) : this.lines;
		return all.slice(-(o.limit ?? 200));
	}

	clearPlugin(plugin: string) {
		this.lines = this.lines.filter((l) => l.plugin !== plugin);
		this.lastErrors.delete(plugin);
		this.dropped.delete(plugin);
		this.rate.delete(plugin);
	}
}

function truncate(s: string): string {
	if (Buffer.byteLength(s, "utf8") <= MAX_LINE_BYTES) return s;
	return Buffer.from(s, "utf8").subarray(0, MAX_LINE_BYTES).toString("utf8").replace(/�$/, "") + "... [truncated]";
}
