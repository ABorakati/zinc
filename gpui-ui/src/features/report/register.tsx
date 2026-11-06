// Report a problem: Tools menu entry, and Settings > System rows (log folder + Open logs folder, Report a problem).
import { registerAppAction } from "../../registry";
import { t } from "../../shell/kit";
import { logDir } from "../../shell/errorlog";
import { Btn, Value } from "../../settings/controls";
import { registerSettings } from "../../settings/registry";
import { openLogsFolder } from "./report";
import { openReport } from "./ReportDialog";

export function register(): void {
	registerAppAction({ id: "report-problem", label: "Report a problem…", icon: "bug", menu: "tools", run: () => openReport() });
	registerSettings([
		{
			id: "system.logs", section: "system", group: "Diagnostics", label: "Error log",
			description: "Errors and crashes are written to files in this folder, on this computer only. Nothing is uploaded. The last 14 days are kept.",
			keywords: ["log", "logs", "errors", "crash", "diagnostics", "folder", "debug"],
			control: () => (
				<div style={{ ...t("flex flex-col items-end gap-1"), maxWidth: 420 }}>
					<Value wrap>{logDir()}</Value>
					<Btn onClick={openLogsFolder} icon="folder-open">Open logs folder</Btn>
				</div>
			),
		},
		{
			id: "system.report", section: "system", group: "Diagnostics", label: "Report a problem",
			description: "Shows the last two days of the error log, redacted, so you can copy it or save it as a zip and send it yourself.",
			keywords: ["bug", "feedback", "support", "crash", "error report", "help"],
			control: () => <Btn onClick={() => openReport()} icon="bug">Report a problem…</Btn>,
		},
	]);
}
