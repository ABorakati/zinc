import {
	createEffect,
	createMemo,
	createResource,
	createRoot,
	createSignal,
	For,
	Show,
	type Component,
} from "solid-js";
import { Check, Copy, Folder, GitMerge, Link2, Paperclip, Search, Tag, XCircle } from "lucide-solid";
import { toast } from "solid-sonner";
import { api, type Creator, type ItemDetail } from "~/api";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Separator } from "~/components/ui/separator";
import { Skeleton } from "~/components/ui/skeleton";
import { fail } from "~/lib/actions";
import { cn } from "~/lib/utils";
import { store } from "~/store";
import { duplicatesApi, type DuplicateReason, type DuplicateSet } from "./client";

const INTERNAL_FIELDS = new Set([
	"key",
	"version",
	"dateAdded",
	"dateModified",
	"deleted",
	"parentItem",
	"tags",
	"collections",
	"relations",
]);

const FIELD_ORDER_PRIORITY: Record<string, number> = {
	itemType: 1,
	title: 2,
	creators: 3,
	date: 4,
	publicationTitle: 5,
	bookTitle: 6,
	proceedingsTitle: 7,
	DOI: 8,
	ISBN: 9,
	volume: 10,
	issue: 11,
	pages: 12,
	publisher: 13,
	place: 14,
	url: 15,
	abstractNote: 16,
	extra: 17,
};

function formatFieldLabel(field: string, labels?: Record<string, string>): string {
	if (field === "itemType") return "Item Type";
	if (field === "creators") return "Creators";
	if (labels?.[field]) return labels[field];
	return field.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

function formatCreator(c: Creator): string {
	if (c.name) return `${c.name}${c.creatorType && c.creatorType !== "author" ? ` (${c.creatorType})` : ""}`;
	const name = [c.lastName, c.firstName].filter(Boolean).join(", ");
	return `${name}${c.creatorType && c.creatorType !== "author" ? ` (${c.creatorType})` : ""}`;
}

function formatFieldValue(field: string, value: unknown): string {
	if (value === undefined || value === null || value === "") return "";
	if (field === "creators" && Array.isArray(value)) {
		return (value as Creator[]).map(formatCreator).filter(Boolean).join("; ");
	}
	if (typeof value === "string") return value;
	return JSON.stringify(value);
}

function isEmptyField(value: unknown): boolean {
	if (value === undefined || value === null || value === "") return true;
	if (Array.isArray(value)) return value.length === 0;
	return false;
}

function formatDateShort(iso?: string): string {
	if (!iso) return "—";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
	return d.toISOString().replace("T", " ").slice(0, 16);
}

const REASON_LABELS: Record<DuplicateReason, string> = {
	doi: "DOI",
	isbn: "ISBN",
	title: "Title",
};

function createDuplicatesState() {
	const [open, setOpen] = createSignal(false);
	const [dupRev, setDupRev] = createSignal(0);
	const [manualKeys, setManualKeys] = createSignal<string[] | null>(null);
	const [selectedIdx, setSelectedIdx] = createSignal(0);
	const [searchQuery, setSearchQuery] = createSignal("");
	const [reasonFilter, setReasonFilter] = createSignal<"all" | DuplicateReason>("all");

	const bumpDuplicates = () => setDupRev((n) => n + 1);

	const [dupList] = createResource(
		() => [store.itemsRev(), dupRev()] as const,
		() => duplicatesApi.list(true),
	);

	const [schema] = createResource(() => api.schema());

	function openDuplicatesPanel() {
		setManualKeys(null);
		setSelectedIdx(0);
		setOpen(true);
		bumpDuplicates();
	}

	function openMergeForKeys(keys: string[]) {
		if (keys.length < 2) return;
		setManualKeys([...new Set(keys)]);
		setSelectedIdx(0);
		setOpen(true);
	}

	return {
		open,
		setOpen,
		dupList,
		schema,
		manualKeys,
		setManualKeys,
		selectedIdx,
		setSelectedIdx,
		searchQuery,
		setSearchQuery,
		reasonFilter,
		setReasonFilter,
		bumpDuplicates,
		openDuplicatesPanel,
		openMergeForKeys,
	};
}

export const dupState = createRoot(createDuplicatesState);

export const DuplicateSidebarEntry: Component = () => {
	const count = () => dupState.dupList()?.total ?? 0;
	return (
		<div
			role="treeitem"
			aria-selected={dupState.open() && !dupState.manualKeys()}
			data-testid="sidebar-duplicates"
			class={cn(
				"relative flex h-6 cursor-pointer items-center gap-1 pl-6 pr-2 text-[13px] hover:bg-accent",
				dupState.open() && !dupState.manualKeys() && "bg-primary/15 text-foreground hover:bg-primary/20",
			)}
			onClick={() => dupState.openDuplicatesPanel()}
		>
			<Copy class="size-4 flex-none text-muted-foreground" />
			<span class="flex-1 truncate">Duplicate Items</span>
			<span class="ml-1 text-[11px] tabular-nums text-muted-foreground" data-testid="duplicates-count">
				{count()}
			</span>
		</div>
	);
};

export const DuplicateDialog: Component = () => {
	const allSets = createMemo<DuplicateSet[]>(() => {
		const manual = dupState.manualKeys();
		const detected = dupState.dupList()?.sets ?? [];
		if (!manual || manual.length < 2) return detected;
		return [
			{
				keys: manual,
				reason: "title",
				title: `Selected items (${manual.length})`,
			},
			...detected,
		];
	});

	const filteredSets = createMemo<DuplicateSet[]>(() => {
		const q = dupState.searchQuery().trim().toLowerCase();
		const rf = dupState.reasonFilter();
		return allSets().filter((s, idx) => {
			if (dupState.manualKeys() && idx === 0) return true;
			if (rf !== "all" && s.reason !== rf) return false;
			if (!q) return true;
			const title = (s.title ?? "").toLowerCase();
			const creator = (s.creatorsSummary ?? "").toLowerCase();
			const year = s.year ? String(s.year) : "";
			return (
				title.includes(q) ||
				creator.includes(q) ||
				year.includes(q) ||
				s.keys.some((k) => k.toLowerCase().includes(q))
			);
		});
	});

	createEffect(() => {
		const list = filteredSets();
		if (dupState.selectedIdx() >= list.length) {
			dupState.setSelectedIdx(Math.max(0, list.length - 1));
		}
	});

	const activeSet = createMemo<DuplicateSet | null>(() => {
		const list = filteredSets();
		return list[dupState.selectedIdx()] ?? list[0] ?? null;
	});

	const [setDetails] = createResource(
		() => (dupState.open() && activeSet() ? activeSet()!.keys.join(",") : null),
		(keysCsv) => duplicatesApi.setDetails(keysCsv.split(",")),
	);

	const [masterKey, setMasterKey] = createSignal<string>("");
	const [fieldChoices, setFieldChoices] = createSignal<Record<string, string>>({});
	const [busy, setBusy] = createSignal(false);

	// Initialize masterKey (oldest dateAdded) and default fieldChoices when active set details load
	createEffect(() => {
		const d = setDetails();
		if (!d || d.items.length === 0) return;
		const defMaster = d.defaultMasterKey || d.items[0].data.key;
		setMasterKey(defMaster);
		setFieldChoices(buildDefaultChoices(d.items, defMaster, d.differingFields));
	});

	function buildDefaultChoices(items: ItemDetail[], currentMasterKey: string, differingFields: string[]): Record<string, string> {
		const master = items.find((i) => i.data.key === currentMasterKey) ?? items[0];
		const choices: Record<string, string> = {};
		for (const f of differingFields) {
			if (!isEmptyField(master.data[f])) {
				choices[f] = master.data.key;
			} else {
				const withVal = items.find((i) => !isEmptyField(i.data[f]));
				choices[f] = withVal ? withVal.data.key : master.data.key;
			}
		}
		return choices;
	}

	function selectMaster(newMasterKey: string) {
		setMasterKey(newMasterKey);
		const d = setDetails();
		if (!d) return;
		setFieldChoices(buildDefaultChoices(d.items, newMasterKey, d.differingFields));
	}

	function chooseFieldSource(field: string, sourceKey: string) {
		setFieldChoices((prev) => ({ ...prev, [field]: sourceKey }));
	}

	const orderedDifferingFields = createMemo(() => {
		const d = setDetails();
		if (!d) return [];
		return [...d.differingFields].sort((a, b) => {
			const pa = FIELD_ORDER_PRIORITY[a] ?? 100;
			const pb = FIELD_ORDER_PRIORITY[b] ?? 100;
			return pa !== pb ? pa - pb : a.localeCompare(b);
		});
	});

	const matchingFields = createMemo(() => {
		const d = setDetails();
		if (!d || d.items.length === 0) return [];
		const diffSet = new Set(d.differingFields);
		const all = new Set<string>();
		for (const it of d.items) {
			for (const k of Object.keys(it.data)) {
				if (!INTERNAL_FIELDS.has(k) && !diffSet.has(k) && !isEmptyField(it.data[k])) {
					all.add(k);
				}
			}
		}
		return [...all].sort((a, b) => {
			const pa = FIELD_ORDER_PRIORITY[a] ?? 100;
			const pb = FIELD_ORDER_PRIORITY[b] ?? 100;
			return pa !== pb ? pa - pb : a.localeCompare(b);
		});
	});

	const unionedSummary = createMemo(() => {
		const d = setDetails();
		if (!d) return { tags: [] as string[], collections: [] as string[], children: 0, related: 0 };
		const tags = [...new Set(d.items.flatMap((i) => i.tags.map((t) => t.tag)))].sort();
		const colMap = new Map((store.collections() ?? []).map((c) => [c.key, c.name]));
		const collections = [...new Set(d.items.flatMap((i) => i.collections))].map((k) => colMap.get(k) ?? k);
		const children = d.items.reduce((acc, i) => acc + i.children.length, 0);
		const setKeys = new Set(d.items.map((i) => i.data.key));
		const related = new Set(
			d.items.flatMap((i) => (i.related ?? []).map((r) => r.key).filter((k) => !setKeys.has(k))),
		).size;
		return { tags, collections, children, related };
	});

	async function handleMerge() {
		const d = setDetails();
		if (!d || d.items.length < 2 || busy()) return;
		const mKey = masterKey() || d.defaultMasterKey;
		const otherKeys = d.items.map((i) => i.data.key).filter((k) => k !== mKey);
		setBusy(true);
		try {
			await duplicatesApi.merge({
				masterKey: mKey,
				otherKeys,
				fieldChoices: fieldChoices(),
			});
			if (dupState.manualKeys()) dupState.setManualKeys(null);
			dupState.bumpDuplicates();
			store.bumpItems();
			store.refetchCollections();
			store.bumpTags();
			store.selectOnly(mKey);
			toast.success(`Merged ${d.items.length} duplicate items`);
		} catch (e) {
			fail("Could not merge items", e);
		} finally {
			setBusy(false);
		}
	}

	async function handleNotDuplicates() {
		const set = activeSet();
		if (!set || set.keys.length < 2 || busy()) return;
		setBusy(true);
		try {
			await duplicatesApi.markNotDuplicates(set.keys);
			if (dupState.manualKeys()) dupState.setManualKeys(null);
			dupState.bumpDuplicates();
			toast.success("Marked items as not duplicates");
		} catch (e) {
			fail("Could not mark as not duplicates", e);
		} finally {
			setBusy(false);
		}
	}

	const fieldLabels = () => dupState.schema()?.fieldLabels;

	return (
		<Dialog open={dupState.open()} onOpenChange={dupState.setOpen}>
			<DialogContent class="flex h-[90vh] max-h-[90vh] w-[95vw] max-w-6xl flex-col gap-0 overflow-hidden p-0">
				<DialogHeader class="flex-none border-b px-5 py-3.5">
					<div class="flex items-center justify-between pr-6">
						<div class="flex items-center gap-2.5">
							<GitMerge class="size-5 text-primary" />
							<DialogTitle class="text-base">Duplicate Items</DialogTitle>
							<Badge variant="secondary" class="text-xs tabular-nums">
								{dupState.dupList()?.total ?? 0} sets
							</Badge>
						</div>
						<DialogDescription class="text-xs">
							Choose the master item (oldest by default) and click any differing field value to pick which version to keep.
						</DialogDescription>
					</div>
				</DialogHeader>

				<div class="flex min-h-0 flex-1 overflow-hidden">
					{/* Left pane: Duplicate sets list */}
					<div class="flex w-80 flex-none flex-col border-r bg-card/50">
						<div class="flex flex-col gap-2 border-b p-2.5">
							<div class="relative">
								<Search class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
								<Input
									type="search"
									placeholder="Filter duplicate sets…"
									class="h-8 pl-8 text-xs"
									value={dupState.searchQuery()}
									onInput={(e) => {
										dupState.setSearchQuery(e.currentTarget.value);
										dupState.setSelectedIdx(0);
									}}
								/>
							</div>
							<div class="flex items-center gap-1">
								<For each={["all", "doi", "isbn", "title"] as const}>
									{(r) => (
										<button
											type="button"
											onClick={() => {
												dupState.setReasonFilter(r);
												dupState.setSelectedIdx(0);
											}}
											class={cn(
												" rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
												dupState.reasonFilter() === r
													? "bg-primary text-primary-foreground"
													: "bg-muted text-muted-foreground hover:bg-accent hover:text-foreground",
											)}
										>
											{r === "all" ? "All" : REASON_LABELS[r]}
										</button>
									)}
								</For>
							</div>
						</div>

						<div class="min-h-0 flex-1 overflow-y-auto divide-y" role="listbox" aria-label="Duplicate sets">
							<Show
								when={!dupState.dupList.loading || filteredSets().length > 0}
								fallback={
									<div class="space-y-2 p-3">
										<Skeleton class="h-12 w-full" />
										<Skeleton class="h-12 w-full" />
										<Skeleton class="h-12 w-full" />
									</div>
								}
							>
								<For
									each={filteredSets().slice(0, 300)}
									fallback={
										<div class="flex h-40 flex-col items-center justify-center gap-1 p-4 text-center text-xs text-muted-foreground">
											No duplicate sets found.
										</div>
									}
								>
									{(s, idx) => {
										const selected = () => dupState.selectedIdx() === idx();
										return (
											<button
												type="button"
												role="option"
												aria-selected={selected()}
												onClick={() => dupState.setSelectedIdx(idx())}
												class={cn(
													"flex w-full flex-col gap-1 px-3 py-2.5 text-left text-xs transition-colors hover:bg-accent/70",
													selected() && "bg-primary/15 hover:bg-primary/20",
												)}
											>
												<div class="flex items-start justify-between gap-2">
													<span class="line-clamp-2 font-medium text-foreground">
														{s.title || s.keys.join(", ")}
													</span>
													<Badge variant="outline" class="shrink-0 px-1.5 py-0 text-[10px] tabular-nums">
														{s.keys.length}
													</Badge>
												</div>
												<div class="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
													<span class="truncate">
														{[s.creatorsSummary, s.year].filter(Boolean).join(" · ") || s.itemType || "Items"}
													</span>
													<span class="rounded bg-muted px-1.5 py-0.2 text-[10px] font-medium uppercase tracking-wider">
														{REASON_LABELS[s.reason]}
													</span>
												</div>
											</button>
										);
									}}
								</For>
							</Show>
						</div>
					</div>

					{/* Right pane: Side-by-side Merge View */}
					<div class="flex min-w-0 flex-1 flex-col bg-background">
						<Show
							when={activeSet()}
							fallback={
								<div class="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
									<GitMerge class="size-10 opacity-30" />
									<p class="text-sm font-medium">No duplicate set selected</p>
									<p class="text-xs">Select a duplicate set on the left to review and merge items.</p>
								</div>
							}
						>
							{(currentSet) => (
								<>
									{/* Action toolbar */}
									<div class="flex flex-none items-center justify-between gap-3 border-b bg-card px-4 py-2.5">
										<div class="flex items-center gap-2 min-w-0">
											<span class="truncate text-sm font-semibold">
												{setDetails()?.items[0]?.data.title || currentSet().title || "Duplicate Set"}
											</span>
											<Badge variant="secondary" class="shrink-0 text-[11px]">
												Matched by {REASON_LABELS[currentSet().reason]}
											</Badge>
										</div>
										<div class="flex shrink-0 items-center gap-2">
											<Button
												variant="outline"
												size="sm"
												disabled={busy() || setDetails.loading}
												onClick={() => void handleNotDuplicates()}
												data-testid="not-duplicates-btn"
											>
												<XCircle class="size-3.5" />
												Not Duplicates
											</Button>
											<Button
												size="sm"
												disabled={busy() || setDetails.loading || !setDetails()}
												onClick={() => void handleMerge()}
												data-testid="merge-items-btn"
											>
												<GitMerge class="size-3.5" />
												Merge {currentSet().keys.length} items
											</Button>
										</div>
									</div>

									{/* Side-by-side comparison body */}
									<div class="min-h-0 flex-1 overflow-auto p-4">
										<Show
											when={!setDetails.loading && setDetails()}
											fallback={
												<div class="space-y-3">
													<Skeleton class="h-16 w-full" />
													<Skeleton class="h-28 w-full" />
													<Skeleton class="h-28 w-full" />
												</div>
											}
										>
											{(details) => {
												const cols = () => details().items;
												return (
													<div class="space-y-5">
														{/* Master Item Radio Chooser */}
														<div class="rounded-lg border bg-card">
															<div class="border-b bg-muted/40 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
																Master Item (kept item — others move to Trash and transfer children/tags/collections)
															</div>
															<div
																class="grid divide-x"
																style={{ "grid-template-columns": `140px repeat(${cols().length}, minmax(200px, 1fr))` }}
															>
																<div class="flex items-center px-3 py-2.5 text-xs font-medium text-muted-foreground">
																	Master Version
																</div>
																<For each={cols()}>
																	{(item, i) => {
																		const isMaster = () => masterKey() === item.data.key;
																		return (
																			<label
																				class={cn(
																					"flex cursor-pointer flex-col gap-1 p-3 text-xs transition-colors hover:bg-accent/50",
																					isMaster() && "bg-primary/10 ring-1 ring-inset ring-primary/40",
																				)}
																			>
																				<div class="flex items-center justify-between gap-2">
																					<span class="flex items-center gap-2 font-semibold">
																						<input
																							type="radio"
																							name="duplicate-master-key"
																							checked={isMaster()}
																							onChange={() => selectMaster(item.data.key)}
																							class="accent-primary"
																						/>
																						Version {i() + 1} ({item.data.key})
																					</span>
																					<Show when={i() === 0}>
																						<Badge variant="outline" class="px-1.5 py-0 text-[10px]">
																							Oldest
																						</Badge>
																					</Show>
																				</div>
																				<div class="pl-5 text-[11px] text-muted-foreground">
																					Added: {formatDateShort(item.data.dateAdded)}
																				</div>
																				<div class="pl-5 text-[11px] text-muted-foreground">
																					{item.children.filter((c) => c.itemType === "attachment").length} attachments ·{" "}
																					{item.children.filter((c) => c.itemType === "note").length} notes
																				</div>
																			</label>
																		);
																	}}
																</For>
															</div>
														</div>

														{/* Differing Fields Picker */}
														<div class="rounded-lg border bg-card">
															<div class="border-b bg-muted/40 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
																Differing Fields ({orderedDifferingFields().length}) — click a value to choose which version to keep
															</div>
															<Show
																when={orderedDifferingFields().length > 0}
																fallback={
																	<div class="px-3 py-4 text-xs text-muted-foreground">
																		All metadata fields are identical across these versions.
																	</div>
																}
															>
																<div class="divide-y">
																	<For each={orderedDifferingFields()}>
																		{(field) => {
																			const chosenKey = () => fieldChoices()[field] ?? masterKey();
																			return (
																				<div
																					class="grid divide-x"
																					style={{
																						"grid-template-columns": `140px repeat(${cols().length}, minmax(200px, 1fr))`,
																					}}
																				>
																					<div class="flex items-start bg-muted/20 px-3 py-2.5 text-xs font-medium text-foreground">
																						{formatFieldLabel(field, fieldLabels())}
																					</div>
																					<For each={cols()}>
																						{(item) => {
																							const valStr = () => formatFieldValue(field, item.data[field]);
																							const selected = () => chosenKey() === item.data.key;
																							return (
																								<button
																									type="button"
																									onClick={() => chooseFieldSource(field, item.data.key)}
																									class={cn(
																										"flex w-full items-start justify-between gap-2 p-2.5 text-left text-xs transition-colors hover:bg-accent/50",
																										selected() && "bg-primary/10 font-medium text-foreground ring-1 ring-inset ring-primary/30",
																										!valStr() && "italic text-muted-foreground/60",
																									)}
																								>
																									<span class="break-words whitespace-pre-wrap">
																										{valStr() || "Empty"}
																									</span>
																									<Show when={selected()}>
																										<Check class="mt-0.5 size-3.5 shrink-0 text-primary" />
																									</Show>
																								</button>
																							);
																						}}
																					</For>
																				</div>
																			);
																		}}
																	</For>
																</div>
															</Show>
														</div>

														{/* Combined / Unioned Data Summary */}
														<div class="rounded-lg border bg-card p-3 space-y-2.5">
															<div class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
																Combined on Merge (Unioned from all {cols().length} versions)
															</div>
															<div class="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
																<div class="flex items-start gap-2 rounded-md border p-2">
																	<Tag class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
																	<div class="min-w-0">
																		<div class="font-medium">Tags ({unionedSummary().tags.length})</div>
																		<div class="truncate text-[11px] text-muted-foreground">
																			{unionedSummary().tags.join(", ") || "None"}
																		</div>
																	</div>
																</div>
																<div class="flex items-start gap-2 rounded-md border p-2">
																	<Folder class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
																	<div class="min-w-0">
																		<div class="font-medium">Collections ({unionedSummary().collections.length})</div>
																		<div class="truncate text-[11px] text-muted-foreground">
																			{unionedSummary().collections.join(", ") || "None"}
																		</div>
																	</div>
																</div>
																<div class="flex items-start gap-2 rounded-md border p-2">
																	<Paperclip class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
																	<div class="min-w-0">
																		<div class="font-medium">Children ({unionedSummary().children})</div>
																		<div class="text-[11px] text-muted-foreground">
																			Notes & attachments moved to master
																		</div>
																	</div>
																</div>
																<div class="flex items-start gap-2 rounded-md border p-2">
																	<Link2 class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
																	<div class="min-w-0">
																		<div class="font-medium">Relations</div>
																		<div class="text-[11px] text-muted-foreground">
																			{unionedSummary().related} related + dc:replaces
																		</div>
																	</div>
																</div>
															</div>

															<Show when={matchingFields().length > 0}>
																<Separator />
																<div class="space-y-1">
																	<div class="text-[11px] font-medium text-muted-foreground">
																		Identical Fields ({matchingFields().length})
																	</div>
																	<div class="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
																		<For each={matchingFields()}>
																			{(field) => (
																				<div class="flex gap-2 truncate">
																					<span class="font-medium text-muted-foreground">
																						{formatFieldLabel(field, fieldLabels())}:
																					</span>
																					<span class="truncate">
																						{formatFieldValue(field, cols()[0].data[field])}
																					</span>
																				</div>
																			)}
																		</For>
																	</div>
																</div>
															</Show>
														</div>
													</div>
												);
											}}
										</Show>
									</div>
								</>
							)}
						</Show>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
};
