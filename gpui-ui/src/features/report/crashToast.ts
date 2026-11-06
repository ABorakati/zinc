// "Zotero Next closed unexpectedly last time": a non-blocking toast with a Report a problem button, when the crash marker found one.
import { previousCrash } from "../../shell/errorlog";
import { toast } from "../../ui";

export function showCrashToast(): void {
	const c = previousCrash();
	if (!c) return;
	void import("./ReportDialog").then(({ openReport }) => {
		toast("Zotero Next closed unexpectedly last time", {
			id: "closed-unexpectedly",
			description: c.lastLogAt ? `Last activity ${new Date(c.lastLogAt).toLocaleString()}` : undefined,
			action: { label: "Report a problem", run: () => openReport() },
			durationMs: 15000,
		});
	});
}
