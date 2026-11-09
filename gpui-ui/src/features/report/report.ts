// What "Report a problem" collects: the last two days of the local log (redacted), a few facts about the app and the library, and an
// error summary - as ONE text. The dialog shows that text, "Copy" puts it on the clipboard, "Save as zip" writes it as report.txt.
// Nothing is uploaded; the user sends it themselves.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { call } from "../../shell/net";
import { pickFolder, revealInFolder } from "../../shell/native";
import { appVersion, buildVariant, flushLog, formatReport, logDir, logError, makeZip, osVersion, readRecentLogs, redact } from "../../shell/errorlog";
import { clipboard } from "../../ui";

export const REPORT_DAYS = 2;
/** The newest lines kept in a report: what the dialog shows is what is copied and saved, so this is a hard cap. */
export const REPORT_MAX_LINES = 400;

export interface Report {
	text: string;
	/** Lines of the report text, for the dialog. */
	rows: string[];
	logLines: number;
	logTotal: number;
}

async function fact<T>(f: () => Promise<T>, show: (v: T) => string): Promise<string> {
	try { return show(await f()); } catch { return "unknown"; }
}

export async function collectReport(): Promise<Report> {
	await flushLog();
	const { lines, total } = readRecentLogs(REPORT_DAYS, REPORT_MAX_LINES);
	const items = await fact(() => call<{ total: number }>("GET", "/api/items?limit=1"), (p) => String(p.total));
	const sync = await fact(() => call<{ mode: string; push: boolean; files: string }>("GET", "/api/websync/status"), (s) => `${s.mode}${s.push ? ", push on" : ""}, files ${s.files}`);
	const text = formatReport(
		{
			"App version": appVersion(),
			"Build": buildVariant(),
			"OS": osVersion(),
			"Bun": Bun.version,
			"Library items": items,
			"Sync mode": sync,
			"Log folder": redact(logDir()),
			"Log range": `last ${REPORT_DAYS} days`,
			"Created": new Date().toISOString(),
		},
		lines,
		total,
	);
	return { text, rows: text.split("\n"), logLines: lines.length, logTotal: total };
}

export async function copyReport(r: Report): Promise<void> {
	await clipboard.writeText(r.text);
}

const stamp = (d = new Date()) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;

/** Ask for a folder (the native dialog) and write zinc-report-<date>.zip (report.txt inside) there. Returns the path, null if cancelled. */
export async function saveReportZip(r: Report, folder?: string): Promise<string | null> {
	const dir = folder ?? (await pickFolder("Save the report in this folder"));
	if (!dir) return null;
	const file = join(dir, `zinc-report-${stamp()}.zip`);
	writeFileSync(file, makeZip([{ name: "report.txt", data: r.text }]));
	return file;
}

/** Open the log folder in Explorer (created first, so it opens even before anything was logged). */
export function openLogsFolder(): void {
	try { mkdirSync(logDir(), { recursive: true }); } catch (e) { logError("ui", e, "create log folder"); }
	revealInFolder(logDir());
}
