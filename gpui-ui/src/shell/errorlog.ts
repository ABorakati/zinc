// The app's error / crash log: the glue around core/src/log.ts (the writer, rotation, redaction, crash marker; read its header for the
// file format). Local files only, nothing is sent anywhere.
//
//   initErrorLog()   call once, first thing in main.tsx: crash marker, console.error/warn mirror, process error handlers.
//   logBoundary()    for Solid <ErrorBoundary> fallbacks.
//   previousCrash()  what the crash marker found at start (main.tsx shows a toast for it).
//
// Exit behaviour is unchanged: an uncaught exception and an unhandled rejection are logged first (synchronously) and then end the process
// exactly as Bun does without handlers (message on stderr, exit code 1) - unless another handler is installed, which then decides.
import { installConsoleMirror, log, logError, markCleanExit, markRunning, type LogArea, type PreviousCrash } from "../../../core/src/log";

export {
	appVersion,
	buildVariant,
	flushLog,
	flushLogSync,
	formatReport,
	listLogFiles,
	log,
	logDir,
	logError,
	logInfo,
	logWarn,
	makeZip,
	osVersion,
	readRecentLogs,
	redact,
	summarizeErrors,
	type LogArea,
	type LogLevel,
	type PreviousCrash,
} from "../../../core/src/log";

let started = false;
let crashed: PreviousCrash | null = null;

/** What the crash marker found at start: the previous session ended without a clean exit. Null otherwise. */
export const previousCrash = (): PreviousCrash | null => crashed;

function fatal(origin: string, e: unknown): void {
	log("fatal", "ui", `${origin}: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`, e, { origin });
}

/**
 * Check aid: ZN_LOG_SELFTEST=error writes a console.error, a console.warn and a caught error, then exits cleanly after 6 s;
 * ZN_LOG_SELFTEST=throw / reject ends the process with an uncaught exception / unhandled rejection after 3 s (to see the fatal line
 * and the crash marker). Unset in normal use.
 */
function selfTest(): void {
	const mode = process.env.ZN_LOG_SELFTEST;
	if (!mode) return;
	console.error("[ui] selftest console.error", new Error("selftest error"));
	console.warn("[sync] selftest console.warn");
	logError("reader", new Error("selftest logError"), "selftest");
	if (mode === "error") setTimeout(() => process.exit(0), 6000);
	if (mode === "throw")
		setTimeout(() => {
			throw new Error("selftest uncaught");
		}, 3000);
	if (mode === "reject")
		setTimeout(() => {
			void Promise.reject(new Error("selftest rejection"));
		}, 3000);
}

/** Start logging. Safe to call twice. */
export function initErrorLog(): void {
	if (started) return;
	started = true;
	try {
		crashed = markRunning();
		installConsoleMirror("ui");
		log("info", "ui", "start", undefined, {
			pid: process.pid,
			bun: Bun.version,
			packaged: /^zotero-next-gpui/i.test(process.execPath.split(/[\\/]/).pop() ?? ""),
		});
		// Monitor listeners only observe: Bun's own handling (message, exit code 1) follows.
		process.on("uncaughtExceptionMonitor", (e) => fatal("uncaughtException", e));
		// A rejection listener replaces Bun's default (print, exit 1), so do that here when nobody else handles it.
		process.on("unhandledRejection", (reason) => {
			fatal("unhandledRejection", reason);
			if (process.listenerCount("unhandledRejection") <= 1) {
				try {
					process.stderr.write(`${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`);
				} catch {
					/* no stderr */
				}
				process.exit(1);
			}
		});
		process.on("exit", () => markCleanExit());
		selfTest();
	} catch {
		/* logging must never stop the app */
	}
}

/** An <ErrorBoundary> caught `err` while rendering `where`. */
export function logBoundary(where: string, err: unknown, area: LogArea = "ui"): void {
	logError(area, err, `error boundary (${where})`);
}
