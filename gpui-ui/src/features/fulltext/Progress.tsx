// Find Full Text progress panel (bottom-right): one block per job, one row per item with state, source, an "Open" action for
// hand-offs, a "Sign in" action for items waiting on the institution, and Cancel. The header row opens the institution
// sign-in window and the Find Full Text settings.
import { For, Show, onMount, type JSX } from "solid-js";
import { Icon } from "../../icons";
import { Button } from "../../ui";
import { FloatingPanel, IconBtn, Line, Progress, t, tok, Txt } from "../kit";
import type { FullTextItemState } from "../types";
import { cancelJob, clearFinished, dismissJob, jobs, panelCollapsed, setPanelCollapsed, summarize, type TrackedJob } from "./jobs";
import { openFullTextSettings } from "./settings";
import { openInBrowser, refreshSignInStatus, signInAndRetry, signInStatus, signInToInstitution, signingIn } from "./signin";

const STATE_LABEL: Record<FullTextItemState, string> = {
	queued: "Waiting",
	searching: "Searching",
	downloading: "Downloading",
	attached: "PDF attached",
	"already-has-pdf": "Already has a PDF",
	"needs-sign-in": "Sign-in needed",
	"not-found": "Not found",
	failed: "Failed",
	cancelled: "Cancelled",
};
const STATE_ICON: Record<FullTextItemState, string> = {
	queued: "circle",
	searching: "loader-circle",
	downloading: "loader-circle",
	attached: "check",
	"already-has-pdf": "file-check",
	"needs-sign-in": "log-in",
	"not-found": "circle-slash",
	failed: "circle-alert",
	cancelled: "ban",
};
const stateColor = (s: FullTextItemState) =>
	s === "attached"
		? "#16a34a"
		: s === "needs-sign-in"
			? "#d97706"
			: s === "failed"
				? tok("destructive")
				: s === "searching" || s === "downloading"
					? tok("primary")
					: tok("muted-foreground");

const institutionName = () => signInStatus()?.institution ?? "your institution";

function JobBlock(p: { tracked: TrackedJob }): JSX.Element {
	const job = () => p.tracked.job;
	const counts = () => summarize(job());
	const total = () => job().items.length;
	const finished = () => total() - counts().open;
	const canSignIn = () => signInStatus()?.available === true;
	const waitingKeys = () =>
		job()
			.items.filter((i) => i.state === "needs-sign-in")
			.map((i) => i.key);
	return (
		<div style={{ ...t("flex flex-col border-b"), flexShrink: 0 }}>
			<div style={t("flex flex-row items-center gap-2 px-3 py-2")}>
				<div style={{ ...t("flex flex-col gap-1"), flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
					<Line class="text-xs font-medium text-foreground">
						{`${p.tracked.openAccessOnly ? "Open access full text" : "Full text"} · ${job().done ? `${counts().attached} of ${total()} attached` : `${finished()} of ${total()}`}`}
					</Line>
					<Show when={!job().done}>
						<Progress value={total() ? finished() / total() : 0} />
					</Show>
					<Show when={job().done && canSignIn() && waitingKeys().length > 1}>
						<div onClick={() => !signingIn() && void signInAndRetry(waitingKeys())} style={{ cursor: "pointer" }}>
							<Txt class="text-xs text-primary">{`Sign in to ${institutionName()} and retry ${waitingKeys().length} items`}</Txt>
						</div>
					</Show>
					<Show when={p.tracked.error}>
						<Txt class="text-xs text-destructive">{p.tracked.error}</Txt>
					</Show>
				</div>
				<Show when={!job().done} fallback={<IconBtn icon="x" onClick={() => dismissJob(job().id)} />}>
					<Button variant="outline" size="sm" disabled={p.tracked.cancelling} onClick={() => void cancelJob(job().id)}>
						{p.tracked.cancelling ? "Cancelling" : "Cancel"}
					</Button>
				</Show>
			</div>
			<For each={job().items}>
				{(item) => (
					<div style={{ ...t("flex flex-row items-start gap-2 px-3 py-1.5"), flexShrink: 0 }}>
						<div style={{ marginTop: 1 }}>
							<Icon name={STATE_ICON[item.state]} size={16} color={stateColor(item.state)} />
						</div>
						<div style={{ ...t("flex flex-col"), flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
							<Line class="text-xs text-foreground">{item.title || item.key}</Line>
							<Line class="text-xs text-muted-foreground">{`${STATE_LABEL[item.state]}${item.source ? ` · ${item.source}` : ""}${item.message && item.state !== "attached" ? ` · ${item.message}` : ""}`}</Line>
						</div>
						<Show when={item.state === "needs-sign-in" && canSignIn()}>
							<Button
								variant="primary"
								size="sm"
								icon="log-in"
								disabled={signingIn()}
								onClick={() => void signInAndRetry([item.key])}
							>
								Sign in
							</Button>
						</Show>
						<Show when={item.handoffUrl}>
							<Button
								variant={item.state === "needs-sign-in" && !canSignIn() ? "default" : "ghost"}
								size="sm"
								icon="external-link"
								onClick={() => void openInBrowser(item.handoffUrl!)}
							>
								Open
							</Button>
						</Show>
					</div>
				)}
			</For>
		</div>
	);
}

export function FullTextProgress(): JSX.Element {
	const running = () => jobs().filter((j) => !j.job.done).length;
	const status = () => signInStatus();
	onMount(() => void refreshSignInStatus());
	return (
		<Show when={jobs().length > 0}>
			<FloatingPanel
				side="right"
				title="Find Full Text"
				subtitle={running() > 0 ? `${running()} running` : undefined}
				collapsed={panelCollapsed()}
				onToggle={() => setPanelCollapsed(!panelCollapsed())}
				actions={
					<Show when={jobs().some((j) => j.job.done)}>
						<Button variant="ghost" size="sm" onClick={clearFinished}>
							Clear
						</Button>
					</Show>
				}
			>
				<div style={t("flex flex-row items-center gap-1 border-b px-3 py-1.5")}>
					<Show when={status()?.available}>
						<Button
							variant={status()?.signedIn ? "ghost" : "outline"}
							size="sm"
							icon="log-in"
							disabled={signingIn()}
							onClick={() => void signInToInstitution()}
						>{`Sign in to ${institutionName()}…`}</Button>
						<Show when={status()?.signedIn}>
							<Icon name="check" size={14} color="#16a34a" />
						</Show>
					</Show>
					<div style={{ flexGrow: 1 }} />
					<IconBtn icon="settings" onClick={openFullTextSettings} />
				</div>
				<For each={jobs()}>{(j) => <JobBlock tracked={j} />}</For>
			</FloatingPanel>
		</Show>
	);
}
