// Find Full Text progress panel: one row per item with state, source, an "open in browser" action for
// hand-offs, a "Sign in" action for items waiting on the institution, and cancel. The header row opens the
// institution sign-in window and the Find Full Text settings. Mount once in App.tsx:  <FullTextProgress />
import { For, Show, onMount, type Component } from "solid-js";
import {
	Ban, Check, ChevronDown, ChevronUp, CircleAlert, CircleSlash, ExternalLink, FileCheck, LoaderCircle, LogIn, Settings as SettingsIcon, X,
} from "lucide-solid";
import type { FullTextItemState } from "../../../core/src/api-types";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import {
	cancelJob, clearFinished, dismissJob, jobs, openInBrowser, panelCollapsed, setPanelCollapsed, summarize, type TrackedJob,
} from "./jobs";
import { FullTextSettingsDialog, openFullTextSettings } from "./Settings";
import { refreshSignInStatus, signInAndRetry, signInStatus, signInToInstitution, signingIn } from "./signin";

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

const StateIcon: Component<{ state: FullTextItemState }> = (props) => {
	const cls = "size-4 shrink-0";
	switch (props.state) {
		case "attached":
			return <Check class={cn(cls, "text-green-600")} />;
		case "already-has-pdf":
			return <FileCheck class={cn(cls, "text-muted-foreground")} />;
		case "needs-sign-in":
			return <LogIn class={cn(cls, "text-amber-600")} />;
		case "not-found":
			return <CircleSlash class={cn(cls, "text-muted-foreground")} />;
		case "failed":
			return <CircleAlert class={cn(cls, "text-destructive")} />;
		case "cancelled":
			return <Ban class={cn(cls, "text-muted-foreground")} />;
		case "queued":
			return <span class={cn(cls, "grid place-items-center")}><span class="size-1.5 rounded-full bg-muted-foreground/50" /></span>;
		default:
			return <LoaderCircle class={cn(cls, "animate-spin text-primary")} />;
	}
};

const institutionName = () => signInStatus()?.institution ?? "your institution";

const JobBlock: Component<{ t: TrackedJob }> = (props) => {
	const job = () => props.t.job;
	const counts = () => summarize(job());
	const total = () => job().items.length;
	const finished = () => total() - counts().open;
	const canSignIn = () => signInStatus()?.available === true;
	const waitingKeys = () => job().items.filter((i) => i.state === "needs-sign-in").map((i) => i.key);
	return (
		<div class="border-b border-border last:border-b-0">
			<div class="flex items-center gap-2 px-3 py-2">
				<div class="min-w-0 flex-1">
					<div class="truncate text-xs font-medium">
						{props.t.openAccessOnly ? "Open access full text" : "Full text"}
						<span class="font-normal text-muted-foreground">
							{" "}
							{job().done ? `${counts().attached} of ${total()} attached` : `${finished()} of ${total()}`}
						</span>
					</div>
					<Show when={!job().done}>
						<div class="mt-1 h-1 overflow-hidden rounded-full bg-muted">
							<div class="h-full bg-primary transition-all" style={{ width: `${total() ? (finished() / total()) * 100 : 0}%` }} />
						</div>
					</Show>
					<Show when={job().done && canSignIn() && waitingKeys().length > 1}>
						<button
							type="button"
							class="mt-1 text-left text-xs text-primary underline-offset-2 hover:underline disabled:opacity-50"
							disabled={signingIn()}
							onClick={() => void signInAndRetry(waitingKeys())}
						>
							{`Sign in to ${institutionName()} and retry ${waitingKeys().length} items`}
						</button>
					</Show>
					<Show when={props.t.error}>
						<div class="mt-1 text-xs text-destructive">{props.t.error}</div>
					</Show>
				</div>
				<Show
					when={!job().done}
					fallback={
						<Button variant="ghost" size="icon" class="size-6" title="Dismiss" onClick={() => dismissJob(job().id)}>
							<X />
						</Button>
					}
				>
					<Button variant="outline" size="sm" class="h-6 px-2" disabled={props.t.cancelling} onClick={() => cancelJob(job().id)}>
						{props.t.cancelling ? "Cancelling" : "Cancel"}
					</Button>
				</Show>
			</div>
			<ul class="pb-1">
				<For each={job().items}>
					{(item) => (
						<li class="flex items-start gap-2 px-3 py-1.5 text-xs hover:bg-accent/40" data-state={item.state}>
							<div class="mt-0.5">
								<StateIcon state={item.state} />
							</div>
							<div class="min-w-0 flex-1">
								<div class="truncate" title={item.title}>{item.title || item.key}</div>
								<div class="truncate text-muted-foreground" title={item.message}>
									{STATE_LABEL[item.state]}
									<Show when={item.source}>{` · ${item.source}`}</Show>
									<Show when={item.message && item.state !== "attached"}>{` · ${item.message}`}</Show>
								</div>
							</div>
							<Show when={item.state === "needs-sign-in" && canSignIn()}>
								<Button
									variant="default"
									size="sm"
									class="h-6 shrink-0 gap-1 px-2 text-xs"
									title={`Sign in to ${institutionName()}, then try this item again`}
									disabled={signingIn()}
									onClick={() => void signInAndRetry([item.key])}
								>
									<LogIn class="!size-3" />
									Sign in
								</Button>
							</Show>
							<Show when={item.handoffUrl}>
								<Button
									variant={item.state === "needs-sign-in" && !canSignIn() ? "default" : "ghost"}
									size="sm"
									class="h-6 shrink-0 gap-1 px-2 text-xs"
									title="Open in your browser"
									onClick={() => openInBrowser(item.handoffUrl!)}
								>
									<ExternalLink class="!size-3" />
									Open
								</Button>
							</Show>
						</li>
					)}
				</For>
			</ul>
		</div>
	);
};

export const FullTextProgress: Component = () => {
	const anyFinished = () => jobs().some((t) => t.job.done);
	const running = () => jobs().filter((t) => !t.job.done).length;
	const status = () => signInStatus();
	onMount(() => void refreshSignInStatus());
	return (
		<>
			<FullTextSettingsDialog />
			<Show when={jobs().length > 0}>
				<section
					class="fixed bottom-3 right-3 z-40 flex max-h-[60vh] w-[22rem] flex-col overflow-hidden rounded-lg border border-border bg-background text-foreground shadow-lg"
					aria-label="Find Full Text"
				>
					<header class="flex items-center gap-2 border-b border-border px-3 py-2">
						<span class="flex-1 truncate text-sm font-medium">
							Find Full Text
							<Show when={running() > 0}>
								<span class="font-normal text-muted-foreground">{` · ${running()} running`}</span>
							</Show>
						</span>
						<Show when={anyFinished()}>
							<Button variant="ghost" size="sm" class="h-6 px-2 text-xs" onClick={clearFinished}>
								Clear
							</Button>
						</Show>
						<Button
							variant="ghost"
							size="icon"
							class="size-6"
							title={panelCollapsed() ? "Expand" : "Collapse"}
							onClick={() => setPanelCollapsed(!panelCollapsed())}
						>
							<Show when={panelCollapsed()} fallback={<ChevronDown />}>
								<ChevronUp />
							</Show>
						</Button>
					</header>
					<Show when={!panelCollapsed()}>
						<div class="flex items-center gap-1 border-b border-border px-3 py-1.5">
							<Show when={status()?.available}>
								<Button
									variant={status()?.signedIn ? "ghost" : "outline"}
									size="sm"
									class="h-6 min-w-0 gap-1 px-2 text-xs"
									disabled={signingIn()}
									title={status()?.signedIn ? "You appear to be signed in. Open the sign-in window again." : "Open the sign-in window of your institution"}
									onClick={() => void signInToInstitution()}
								>
									<LogIn class="!size-3 shrink-0" />
									<span class="truncate">{`Sign in to ${institutionName()}…`}</span>
								</Button>
								<Show when={status()?.signedIn}>
									<Check class="size-3.5 shrink-0 text-green-600" aria-label="Signed in" />
								</Show>
							</Show>
							<span class="flex-1" />
							<Button variant="ghost" size="icon" class="size-6" title="Find Full Text settings" onClick={openFullTextSettings}>
								<SettingsIcon />
							</Button>
						</div>
						<div class="min-h-0 flex-1 overflow-y-auto">
							<For each={jobs()}>{(t) => <JobBlock t={t} />}</For>
						</div>
					</Show>
				</section>
			</Show>
		</>
	);
};

export default FullTextProgress;
