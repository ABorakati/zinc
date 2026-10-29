// Zotero sync indicator for the toolbar/status bar, with a popover (Sync now, write opt-in, conflicts).
// Mount once, e.g. in the header:  <SyncStatus onChanged={refreshLists} />
// onChanged fires when a pull brought changes from Zotero in (refresh item lists and collections).
import { createEffect, createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js";
import { Check, CircleAlert, RefreshCw, TriangleAlert } from "lucide-solid";
import { Button } from "~/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { cn } from "~/lib/utils";

interface Status {
	enabled: boolean;
	zotero: "closed" | "running" | "missing" | "error";
	dataDir: string;
	pending: number;
	lastPullAt?: string;
	lastPushAt?: string;
	lastBackup?: string;
	lastError?: string;
	conflicts: number;
	changeCount?: number;
	busy?: boolean;
}

interface Conflict {
	id: number;
	type: string;
	key: string;
	title: string;
	local: unknown;
	remote: unknown;
	resolved: "local" | "remote";
	at: string;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(`/api/sync/${path}`, {
		method,
		headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	if (!res.ok) {
		let msg = res.statusText;
		try {
			msg = (await res.json()).error ?? msg;
		} catch {}
		throw new Error(msg);
	}
	return res.json() as Promise<T>;
}

function ago(iso?: string): string {
	if (!iso) return "never";
	const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
	if (s < 10) return "just now";
	if (s < 90) return `${Math.round(s)} s ago`;
	if (s < 5400) return `${Math.round(s / 60)} min ago`;
	if (s < 86400 * 1.5) return `${Math.round(s / 3600)} h ago`;
	return new Date(iso).toLocaleDateString();
}

const ZOTERO_LABEL: Record<Status["zotero"], string> = {
	closed: "Zotero closed",
	running: "Zotero running",
	missing: "Zotero not found",
	error: "Zotero unreadable",
};

function show(v: unknown): string {
	if (v === null || v === undefined) return "(none)";
	if (typeof v !== "object") return String(v);
	const o = v as Record<string, unknown>;
	const keep: Record<string, unknown> = {};
	for (const k of ["title", "name", "itemType", "date", "abstractNote", "note", "text", "comment", "url", "publicationTitle", "dateModified"]) {
		if (o[k] !== undefined && o[k] !== "") keep[k] = typeof o[k] === "string" && (o[k] as string).length > 160 ? `${(o[k] as string).slice(0, 160)}…` : o[k];
	}
	if (Array.isArray(o.tags)) keep.tags = (o.tags as { tag?: string }[]).map((t) => t.tag).join(", ");
	return Object.entries(keep)
		.map(([k, x]) => `${k}: ${String(x)}`)
		.join("\n");
}

export const SyncStatus: Component<{ onChanged?: () => void; pollMs?: number }> = (props) => {
	const [st, setSt] = createSignal<Status | null>(null);
	const [conflicts, setConflicts] = createSignal<Conflict[]>([]);
	const [open, setOpen] = createSignal(false);
	const [confirming, setConfirming] = createSignal(false);
	const [working, setWorking] = createSignal(false);
	const [error, setError] = createSignal("");
	let lastChange: number | undefined;

	const apply = (s: Status) => {
		if (lastChange !== undefined && s.changeCount !== undefined && s.changeCount !== lastChange) props.onChanged?.();
		lastChange = s.changeCount;
		setSt(s);
	};
	const refresh = async () => {
		try {
			apply(await call<Status>("GET", "status"));
			if (open()) setConflicts((await call<{ conflicts: Conflict[] }>("GET", "conflicts")).conflicts);
		} catch {
			// service unreachable: keep the last known state
		}
	};
	onMount(() => {
		void refresh();
		const t = setInterval(() => void refresh(), props.pollMs ?? 5000);
		onCleanup(() => clearInterval(t));
	});
	createEffect(() => {
		if (open()) void refresh();
		else setConfirming(false);
	});

	const run = async (fn: () => Promise<Status>) => {
		setWorking(true);
		setError("");
		try {
			apply(await fn());
			setConflicts((await call<{ conflicts: Conflict[] }>("GET", "conflicts")).conflicts);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setWorking(false);
		}
	};
	const syncNow = () => run(() => call<Status>("POST", "now"));
	const setEnabled = (enabled: boolean) => run(() => call<Status>("POST", "enable", { enabled })).then(() => setConfirming(false));
	const dismiss = async (id?: number) => {
		await call("DELETE", id === undefined ? "conflicts" : `conflicts?id=${id}`);
		await refresh();
	};

	const problem = () => !!st()?.lastError || st()?.zotero === "error";
	const busy = () => working() || !!st()?.busy;

	return (
		<Popover open={open()} onOpenChange={setOpen} placement="bottom-end">
			<PopoverTrigger
				as={Button}
				variant="ghost"
				size="sm"
				class="h-7 gap-1.5 px-2 text-xs"
				title="Zotero sync"
				aria-label="Zotero sync status"
			>
				<Show
					when={!problem()}
					fallback={<CircleAlert class="!size-3.5 text-destructive" />}
				>
					<RefreshCw class={cn("!size-3.5", busy() && "animate-spin", st()?.zotero === "missing" && "text-muted-foreground")} />
				</Show>
				<span class="hidden sm:inline">{st() ? ZOTERO_LABEL[st()!.zotero] : "Zotero"}</span>
				<Show when={(st()?.pending ?? 0) > 0}>
					<span class="rounded-full bg-primary px-1.5 text-[10px] leading-4 text-primary-foreground" title="Changes waiting to be written to Zotero">
						{st()!.pending}
					</span>
				</Show>
				<Show when={(st()?.conflicts ?? 0) > 0}>
					<TriangleAlert class="!size-3.5 text-amber-600" />
				</Show>
			</PopoverTrigger>
			<PopoverContent class="w-[26rem] max-w-[95vw] space-y-3 p-3 text-xs">
				<Show when={st()} fallback={<div class="text-muted-foreground">Sync is not available.</div>}>
					{(s) => (
						<>
							<div class="flex items-center justify-between gap-2">
								<div class="min-w-0">
									<div class="font-medium">{ZOTERO_LABEL[s().zotero]}</div>
									<div class="truncate text-muted-foreground" title={s().dataDir}>{s().dataDir}</div>
								</div>
								<Button size="sm" variant="outline" class="h-7 shrink-0 gap-1 px-2 text-xs" disabled={busy() || s().zotero === "missing"} onClick={syncNow}>
									<RefreshCw class={cn("!size-3", busy() && "animate-spin")} />
									Sync now
								</Button>
							</div>

							<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-muted-foreground">
								<dt>Last read from Zotero</dt>
								<dd class="text-foreground">{ago(s().lastPullAt)}</dd>
								<dt>Last written to Zotero</dt>
								<dd class="text-foreground">{s().enabled ? ago(s().lastPushAt) : "writing is off"}</dd>
								<dt>Waiting to write</dt>
								<dd class="text-foreground">
									{s().pending}
									<Show when={s().pending > 0 && s().zotero === "running"}>{" (written once Zotero is closed)"}</Show>
									<Show when={s().pending > 0 && !s().enabled}>{" (writing is off)"}</Show>
								</dd>
							</dl>

							<Show when={s().lastError || error()}>
								<div class="flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-destructive">
									<CircleAlert class="mt-0.5 !size-3.5 shrink-0" />
									<div class="min-w-0 break-words">{error() || s().lastError}</div>
								</div>
							</Show>

							<div class="space-y-2 rounded-md border border-border p-2">
								<div class="flex items-center justify-between gap-2">
									<div>
										<div class="font-medium">Write changes into Zotero</div>
										<div class="text-muted-foreground">{s().enabled ? "On" : "Off: Zotero changes are still read in."}</div>
									</div>
									<Show
										when={s().enabled}
										fallback={
											<Button size="sm" variant="outline" class="h-7 px-2 text-xs" disabled={busy()} onClick={() => setConfirming(true)}>
												Turn on
											</Button>
										}
									>
										<Button size="sm" variant="outline" class="h-7 px-2 text-xs" disabled={busy()} onClick={() => setEnabled(false)}>
											Turn off
										</Button>
									</Show>
								</div>
								<Show when={confirming() && !s().enabled}>
									<div class="space-y-2 rounded-md bg-amber-500/10 p-2">
										<div class="flex gap-2 text-amber-800 dark:text-amber-300">
											<TriangleAlert class="mt-0.5 !size-3.5 shrink-0" />
											<p>
												This writes directly into Zotero's database (zotero.sqlite) and storage folder, only while Zotero is closed.
												A backup of zotero.sqlite is made before every write session (the last 5 are kept in zotero-next-backups).
												Make your own backup of the Zotero data folder first if you want extra safety.
											</p>
										</div>
										<div class="flex justify-end gap-2">
											<Button size="sm" variant="ghost" class="h-7 px-2 text-xs" onClick={() => setConfirming(false)}>
												Cancel
											</Button>
											<Button size="sm" class="h-7 px-2 text-xs" disabled={busy()} onClick={() => setEnabled(true)}>
												I have a backup, turn on
											</Button>
										</div>
									</div>
								</Show>
								<Show when={s().enabled && s().lastBackup}>
									<div class="truncate text-muted-foreground" title={s().lastBackup}>Last backup: {s().lastBackup}</div>
								</Show>
							</div>

							<div class="space-y-1.5">
								<div class="flex items-center justify-between">
									<div class="font-medium">
										Conflicts <span class="font-normal text-muted-foreground">({conflicts().length})</span>
									</div>
									<Show when={conflicts().length > 0}>
										<Button size="sm" variant="ghost" class="h-6 px-2 text-xs" onClick={() => dismiss()}>
											Dismiss all
										</Button>
									</Show>
								</div>
								<Show
									when={conflicts().length > 0}
									fallback={
										<div class="flex items-center gap-1.5 text-muted-foreground">
											<Check class="!size-3.5" />
											Nothing changed on both sides.
										</div>
									}
								>
									<ul class="max-h-64 space-y-2 overflow-y-auto pr-1">
										<For each={conflicts()}>
											{(c) => (
												<li class="space-y-1 rounded-md border border-border p-2">
													<div class="flex items-start justify-between gap-2">
														<div class="min-w-0 truncate font-medium" title={c.title}>{c.title}</div>
														<Button size="sm" variant="ghost" class="h-5 shrink-0 px-1.5 text-[10px]" onClick={() => dismiss(c.id)}>
															Dismiss
														</Button>
													</div>
													<div class="text-muted-foreground">
														{c.type}, {ago(c.at)}:{" "}
														<span class="font-medium text-foreground">{c.resolved === "remote" ? "Zotero's version kept" : "your version kept"}</span>
													</div>
													<div class="grid grid-cols-2 gap-2">
														<div class={cn("rounded p-1.5", c.resolved === "local" ? "bg-primary/10" : "bg-muted/60")}>
															<div class="mb-0.5 font-medium">Zotero-next{c.resolved === "local" ? " (kept)" : ""}</div>
															<pre class="whitespace-pre-wrap break-words font-sans">{show(c.local)}</pre>
														</div>
														<div class={cn("rounded p-1.5", c.resolved === "remote" ? "bg-primary/10" : "bg-muted/60")}>
															<div class="mb-0.5 font-medium">Zotero{c.resolved === "remote" ? " (kept)" : ""}</div>
															<pre class="whitespace-pre-wrap break-words font-sans">{show(c.remote)}</pre>
														</div>
													</div>
												</li>
											)}
										</For>
									</ul>
								</Show>
							</div>
						</>
					)}
				</Show>
			</PopoverContent>
		</Popover>
	);
};
