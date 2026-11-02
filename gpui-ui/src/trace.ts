// Startup trace: with ZN_TRACE=1 each mark prints "[zn-t] <name> <ms since process start>" on stdout (scripts/startup.ts parses it).
const on = typeof process !== "undefined" && !!process.env.ZN_TRACE;
const seen = new Set<string>();

/** Milliseconds since this process started. */
export const sinceStart = (): number => Math.round(process.uptime() * 1000);

/** Record a startup milestone (printed once per name, only when ZN_TRACE is set). */
export function mark(name: string): void {
	if (!on || seen.has(name)) return;
	seen.add(name);
	console.log(`[zn-t] ${name} ${sinceStart()}`);
}
