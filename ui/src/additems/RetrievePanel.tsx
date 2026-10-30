// "Retrieve Metadata" progress panel (bottom-left; Find Full Text uses bottom-right): one row per PDF, a summary
// ("Recognised 3, not found 1") once the queue is empty. Mounted through registerOverlay in register.ts.
import { For, Show, createSignal, type Component } from "solid-js";
import { Check, ChevronDown, ChevronUp, CircleAlert, CircleSlash, Link2, LoaderCircle, X } from "lucide-solid";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { dismissRetrieve, retrieveActive, retrieveRows, type RetrieveRow } from "./client";

const [collapsed, setCollapsed] = createSignal(false);

const RowIcon: Component<{ state: RetrieveRow["state"] }> = (p) => {
	const cls = "size-4 shrink-0";
	switch (p.state) {
		case "retrieved":
			return <Check class={cn(cls, "text-green-600")} />;
		case "existing":
			return <Link2 class={cn(cls, "text-green-600")} />;
		case "failed":
			return <CircleSlash class={cn(cls, "text-muted-foreground")} />;
		case "running":
			return <LoaderCircle class={cn(cls, "animate-spin text-primary")} />;
		default:
			return <span class={cn(cls, "grid place-items-center")}><span class="size-1.5 rounded-full bg-muted-foreground/50" /></span>;
	}
};

const LABEL: Record<RetrieveRow["state"], string> = {
	queued: "Waiting",
	running: "Looking up",
	retrieved: "Parent item created",
	existing: "Attached to existing item",
	failed: "No match found",
};

export const RetrievePanel: Component = () => {
	const total = () => retrieveRows().length;
	const finished = () => retrieveRows().filter((r) => r.state !== "queued" && r.state !== "running").length;
	const found = () => retrieveRows().filter((r) => r.state === "retrieved" || r.state === "existing").length;
	const missed = () => retrieveRows().filter((r) => r.state === "failed").length;
	const summary = () => `Recognised ${found()}${missed() ? `, not found ${missed()}` : ""}`;
	return (
		<Show when={total() > 0}>
			<section
				data-testid="retrieve-panel"
				aria-label="Retrieve Metadata"
				class="fixed bottom-3 left-3 z-40 flex max-h-[50vh] w-[22rem] flex-col overflow-hidden rounded-lg border border-border bg-background text-foreground shadow-lg"
			>
				<header class="flex items-center gap-2 px-3 py-2">
					<div class="min-w-0 flex-1">
						<div class="truncate text-sm font-medium">
							Retrieve Metadata
							<span class="font-normal text-muted-foreground">{retrieveActive() ? ` · ${finished()} of ${total()}` : ` · ${summary()}`}</span>
						</div>
						<Show when={retrieveActive()}>
							<div class="mt-1 h-1 overflow-hidden rounded-full bg-muted">
								<div class="h-full bg-primary transition-all" style={{ width: `${total() ? (finished() / total()) * 100 : 0}%` }} />
							</div>
						</Show>
					</div>
					<Button variant="ghost" size="icon" class="size-6" title={collapsed() ? "Expand" : "Collapse"} onClick={() => setCollapsed(!collapsed())}>
						<Show when={collapsed()} fallback={<ChevronDown />}><ChevronUp /></Show>
					</Button>
					<Show when={!retrieveActive()}>
						<Button variant="ghost" size="icon" class="size-6" title="Dismiss" onClick={dismissRetrieve}><X /></Button>
					</Show>
				</header>
				<Show when={!collapsed()}>
					<ul class="min-h-0 flex-1 overflow-y-auto border-t border-border pb-1">
						<For each={retrieveRows()}>
							{(r) => (
								<li class="flex items-start gap-2 px-3 py-1.5 text-xs" data-state={r.state}>
									<div class="mt-0.5"><RowIcon state={r.state} /></div>
									<div class="min-w-0 flex-1">
										<div class="truncate" title={r.title}>{r.title}</div>
										<div class="flex items-center gap-1 truncate text-muted-foreground" title={r.message}>
											<Show when={r.state === "failed"}><CircleAlert class="size-3 shrink-0" /></Show>
											<span class="truncate">{r.state === "failed" && r.message ? `${LABEL.failed} · ${r.message}` : LABEL[r.state]}</span>
										</div>
									</div>
								</li>
							)}
						</For>
					</ul>
				</Show>
			</section>
		</Show>
	);
};
