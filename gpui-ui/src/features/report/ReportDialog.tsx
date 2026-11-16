// "Report a problem": shows exactly what would be shared (redacted, nothing leaves the computer) and offers Copy, Save as zip, Open logs folder.
import { createSignal, For, Show, type JSX } from "solid-js";
import { Button, openDialog, toast } from "../../ui";
import { logError } from "../../shell/errorlog";
import { revealInFolder } from "../../shell/native";
import { markdownTheme } from "../../itempane/Notes";
import { Footer, Line, Para, Scroll, t, tok, tx, Txt } from "../kit";
import { openUrl } from "../platform";

/** The size of the dialog's other text (text-sm), for the <markdown> paragraph. */
const smallText = () => {
	const s = tx("text-sm") as { fontSize?: number; lineHeight?: number };
	return { fontSize: s.fontSize ?? 13, lineHeight: s.lineHeight ?? 19 };
};
import { collectReport, copyReport, openLogsFolder, REPORT_DAYS, saveReportZip, type Report } from "./report";

/** Where problems are reported: a new issue on the app's GitHub repository. */
export const ISSUE_URL = "https://github.com/ABorakati/zinc/issues/new";

/** `seed`: a ready report (screenshot scripts); normally it is collected when the dialog opens. */
function ReportDialog(p: { close: () => void; seed?: Report }): JSX.Element {
	const [report, setReport] = createSignal<Report | undefined>(p.seed);
	const [err, setErr] = createSignal("");
	if (!p.seed)
		collectReport().then(setReport, (e) => {
			logError("ui", e, "collect report");
			setErr(String(e instanceof Error ? e.message : e));
		});

	const copy = async () => {
		const r = report();
		if (!r) return;
		try {
			await copyReport(r);
			toast.success("Report copied", { description: "Paste it into an email or message yourself." });
		} catch (e) {
			logError("ui", e, "copy report");
			toast.error("Could not copy the report");
		}
	};
	// copies the report, then opens a new issue on GitHub for the user to describe the problem and paste the log into
	const fileIssue = async () => {
		const r = report();
		if (!r) return;
		try {
			await copyReport(r);
			toast.success("Report copied", { description: "Describe the problem in the new issue, then paste the log below it." });
		} catch (e) {
			logError("ui", e, "copy report");
			toast.error("Could not copy the report", { description: "Use Copy to clipboard, then paste it into the issue." });
		}
		void openUrl(ISSUE_URL);
	};
	const save = async () => {
		const r = report();
		if (!r) return;
		try {
			const f = await saveReportZip(r);
			if (f) {
				toast.success("Report saved", { description: f });
				revealInFolder(f);
			}
		} catch (e) {
			logError("ui", e, "save report");
			toast.error("Could not save the report", { description: e instanceof Error ? e.message : String(e) });
		}
	};

	return (
		<div style={{ ...t("flex flex-col gap-3"), width: "100%" }}>
			<Para class="text-sm text-muted-foreground">
				{`Nothing is sent anywhere. This is what a report contains: the last ${REPORT_DAYS} days of the error log with keys, tokens, item titles and your user folder removed. Copy it or save it as a zip, then send it yourself.`}
			</Para>
			{/* <markdown>, not <Para>: GPUIX <text> holds one plain run, so a clickable link inside a sentence needs the markdown element */}
			<markdown
				source={`To report it, [file an issue on GitHub](${ISSUE_URL}): say what you did and what went wrong, then paste the copied log below. **File an issue** copies the log and opens the page.`}
				theme={{
					...markdownTheme(),
					text: tok("muted-foreground"),
					link: tok("primary"),
					metrics: { ...markdownTheme().metrics, mdTextSize: smallText().fontSize, mdLineHeight: smallText().lineHeight },
				}}
				onLinkClick={(e) => void openUrl(String((e as { value?: string }).value || ISSUE_URL))}
				style={{ width: "100%" }}
			/>
			<Show
				when={report()}
				fallback={<Txt class="text-xs text-muted-foreground">{err() ? `Could not read the logs: ${err()}` : "Collecting…"}</Txt>}
			>
				{(r) => (
					<>
						<Scroll height={340} border style={{ padding: 8, gap: 2 }}>
							<For each={r().rows}>
								{(row) => (
									<Txt
										class="text-[11px] text-foreground"
										style={{ whiteSpace: "normal", fontFamily: "Consolas", flexShrink: 0 }}
									>
										{row === "" ? " " : row}
									</Txt>
								)}
							</For>
						</Scroll>
						<Line class="text-xs text-muted-foreground">
							{r().logLines === 0
								? `No log lines in the last ${REPORT_DAYS} days.`
								: `${r().logLines} log line${r().logLines === 1 ? "" : "s"} included${r().logTotal > r().logLines ? ` (the newest of ${r().logTotal})` : ""}.`}
						</Line>
					</>
				)}
			</Show>
			<Footer
				left={
					<Button variant="outline" size="sm" icon="folder-open" onClick={openLogsFolder}>
						Open logs folder
					</Button>
				}
			>
				<Button variant="outline" size="sm" icon="external-link" disabled={!report()} onClick={() => void fileIssue()}>
					File an issue
				</Button>
				<Button variant="outline" size="sm" disabled={!report()} onClick={() => void copy()}>
					Copy to clipboard
				</Button>
				<Button variant="outline" size="sm" disabled={!report()} onClick={() => void save()}>
					Save as zip…
				</Button>
				<Button variant="primary" size="sm" onClick={p.close}>
					Close
				</Button>
			</Footer>
		</div>
	);
}

let open = false;
export function openReport(seed?: Report): void {
	if (open) return;
	open = true;
	void openDialog<void>((close) => <ReportDialog close={() => close()} seed={seed} />, { title: "Report a problem", width: 760 }).finally(
		() => {
			open = false;
		},
	);
}
