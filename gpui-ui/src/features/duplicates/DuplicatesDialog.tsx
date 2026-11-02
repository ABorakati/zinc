// Duplicate Items: duplicate sets on the left; for the chosen set the master item (oldest by default) and, per differing field,
// which version's value to keep. Merging moves the others to the Trash and unions tags, collections, children and relations.
import { createEffect, createMemo, createSignal, For, on, onMount, Show, type JSX } from "solid-js";
import type { Collection } from "../../contracts";
import { Icon } from "../../icons";
import { Button, openDialog, TextInput, toast } from "../../ui";
import { Chip, Line, Para, Row, Scroll, t, tok, Txt } from "../kit";
import { refresh, selectOnly } from "../shared";
import { errMsg } from "../text";
import type { Creator, ItemDetail } from "../types";
import { store } from "../../store";
import { duplicatesApi, fieldLabels, type DuplicateReason, type DuplicateSet, type DuplicateSetDetails } from "./client";

const INTERNAL_FIELDS = new Set(["key", "version", "dateAdded", "dateModified", "deleted", "parentItem", "tags", "collections", "relations"]);
const PRIORITY: Record<string, number> = {
	itemType: 1, title: 2, creators: 3, date: 4, publicationTitle: 5, bookTitle: 6, proceedingsTitle: 7, DOI: 8, ISBN: 9,
	volume: 10, issue: 11, pages: 12, publisher: 13, place: 14, url: 15, abstractNote: 16, extra: 17,
};
const byPriority = (a: string, b: string) => ((PRIORITY[a] ?? 100) - (PRIORITY[b] ?? 100)) || a.localeCompare(b);
const REASON: Record<DuplicateReason, string> = { doi: "DOI", isbn: "ISBN", title: "Title" };

function label(field: string, labels: Record<string, string>): string {
	if (field === "itemType") return "Item Type";
	if (field === "creators") return "Creators";
	return labels[field] ?? field.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}
function creatorText(c: Creator): string {
	const n = c.name ?? [c.lastName, c.firstName].filter(Boolean).join(", ");
	return `${n}${c.creatorType && c.creatorType !== "author" ? ` (${c.creatorType})` : ""}`;
}
function valueText(field: string, v: unknown): string {
	if (v === undefined || v === null || v === "") return "";
	if (field === "creators" && Array.isArray(v)) return (v as Creator[]).map(creatorText).filter(Boolean).join("; ");
	return typeof v === "string" ? v : JSON.stringify(v);
}
const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
const dateShort = (iso?: string) => (iso ? iso.replace("T", " ").slice(0, 16) : "—");

function defaultChoices(items: ItemDetail[], masterKey: string, differing: string[]): Record<string, string> {
	const master = items.find((i) => i.data.key === masterKey) ?? items[0]!;
	const out: Record<string, string> = {};
	for (const f of differing) {
		if (!isEmpty(master.data[f])) out[f] = master.data.key;
		else out[f] = (items.find((i) => !isEmpty(i.data[f])) ?? master).data.key;
	}
	return out;
}

const SectionHead = (p: { children: string }) => (
	<div style={{ ...t("border-b bg-muted px-3 py-1.5"), width: "100%" }}><Txt class="text-[11px] font-semibold text-muted-foreground">{p.children}</Txt></div>
);
const LABEL_W = 130;
const Cols = (p: { head?: JSX.Element; children: JSX.Element; border?: boolean }) => (
	<div style={{ ...t(`flex flex-row ${p.border ? "border-b" : ""}`), width: "100%", flexShrink: 0 }}>
		<div style={{ ...t("flex px-3 py-2 bg-muted/50"), width: LABEL_W, flexShrink: 0 }}>{p.head}</div>
		{p.children}
	</div>
);
const colStyle = { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 } as const;

export function DuplicatesDialog(p: { manualKeys?: string[]; close: () => void }): JSX.Element {
	const [sets, setSets] = createSignal<DuplicateSet[]>([]);
	const [loading, setLoading] = createSignal(true);
	const [listError, setListError] = createSignal("");
	const [query, setQuery] = createSignal("");
	const [reasonFilter, setReasonFilter] = createSignal<"all" | DuplicateReason>("all");
	const [idx, setIdx] = createSignal(0);
	const [details, setDetails] = createSignal<DuplicateSetDetails | null>(null);
	const [detailError, setDetailError] = createSignal("");
	const [master, setMaster] = createSignal("");
	const [choices, setChoices] = createSignal<Record<string, string>>({});
	const [labels, setLabels] = createSignal<Record<string, string>>({});
	const [busy, setBusy] = createSignal(false);
	const [manual, setManual] = createSignal<string[] | null>(p.manualKeys && p.manualKeys.length >= 2 ? [...new Set(p.manualKeys)] : null);
	let detailSeq = 0;

	const load = () => {
		setLoading(true);
		duplicatesApi.list().then((l) => { setSets(l.sets); setListError(""); }, (e) => setListError(errMsg(e))).finally(() => setLoading(false));
	};
	onMount(() => { load(); void fieldLabels().then(setLabels); });

	const all = createMemo<DuplicateSet[]>(() => {
		const m = manual();
		return m ? [{ keys: m, reason: "title", title: `Selected items (${m.length})` }, ...sets()] : sets();
	});
	const filtered = createMemo(() => {
		const q = query().trim().toLowerCase();
		const rf = reasonFilter();
		return all().filter((s, i) => {
			if (manual() && i === 0) return true;
			if (rf !== "all" && s.reason !== rf) return false;
			if (!q) return true;
			return [s.title, s.creatorsSummary, s.year ? String(s.year) : ""].some((x) => (x ?? "").toLowerCase().includes(q)) || s.keys.some((k) => k.toLowerCase().includes(q));
		});
	});
	const active = createMemo<DuplicateSet | null>(() => filtered()[idx()] ?? filtered()[0] ?? null);

	createEffect(on(active, (s) => {
		const my = ++detailSeq;
		setDetails(null);
		setDetailError("");
		if (!s) return;
		duplicatesApi.setDetails(s.keys).then((d) => {
			if (my !== detailSeq) return;
			const m = d.defaultMasterKey || d.items[0]?.data.key || "";
			setDetails(d);
			setMaster(m);
			setChoices(defaultChoices(d.items, m, d.differingFields));
		}, (e) => { if (my === detailSeq) setDetailError(errMsg(e)); });
	}));

	const pickMaster = (key: string) => {
		setMaster(key);
		const d = details();
		if (d) setChoices(defaultChoices(d.items, key, d.differingFields));
	};
	const differing = createMemo(() => [...(details()?.differingFields ?? [])].sort(byPriority));
	const identical = createMemo(() => {
		const d = details();
		if (!d?.items.length) return [];
		const diff = new Set(d.differingFields);
		const names = new Set<string>();
		for (const it of d.items) for (const k of Object.keys(it.data)) if (!INTERNAL_FIELDS.has(k) && !diff.has(k) && !isEmpty(it.data[k])) names.add(k);
		return [...names].sort(byPriority);
	});
	const union = createMemo(() => {
		const d = details();
		if (!d) return { tags: [] as string[], collections: [] as string[], children: 0, related: 0 };
		const names = new Map<string, string>();
		const walk = (l: Collection[]): void => {
			for (const c of l) { names.set(c.key, c.name); if (c.children) walk(c.children); }
		};
		walk(store.collections());
		const keys = new Set(d.items.map((i) => i.data.key));
		return {
			tags: [...new Set(d.items.flatMap((i) => i.tags.map((x) => x.tag)))].sort(),
			collections: [...new Set(d.items.flatMap((i) => i.collections))].map((k) => names.get(k) ?? k),
			children: d.items.reduce((n, i) => n + i.children.length, 0),
			related: new Set(d.items.flatMap((i) => (i.related ?? []).map((r) => r.key).filter((k) => !keys.has(k)))).size,
		};
	});

	async function merge() {
		const d = details();
		if (!d || d.items.length < 2 || busy()) return;
		const m = master() || d.defaultMasterKey;
		setBusy(true);
		try {
			await duplicatesApi.merge({ masterKey: m, otherKeys: d.items.map((i) => i.data.key).filter((k) => k !== m), fieldChoices: choices() });
			setManual(null);
			refresh();
			selectOnly(m);
			toast(`Merged ${d.items.length} duplicate items`, { kind: "success" });
			load();
		} catch (e) {
			toast("Could not merge items", { kind: "error", description: errMsg(e) });
		} finally {
			setBusy(false);
		}
	}
	async function notDuplicates() {
		const s = active();
		if (!s || s.keys.length < 2 || busy()) return;
		setBusy(true);
		try {
			await duplicatesApi.markNotDuplicates(s.keys);
			setManual(null);
			toast("Marked items as not duplicates", { kind: "success" });
			load();
		} catch (e) {
			toast("Could not mark as not duplicates", { kind: "error", description: errMsg(e) });
		} finally {
			setBusy(false);
		}
	}

	const H = 600;
	return (
		<div style={{ ...t("flex flex-row border-t"), width: "100%", height: H, marginTop: -4 }}>
			{/* ---- left: duplicate sets */}
			<div style={{ ...t("flex flex-col border-r bg-card"), width: 300, flexShrink: 0, height: H }}>
				<div style={t("flex flex-col gap-2 border-b p-2.5")}>
					<TextInput value={query()} onInput={(v) => { setQuery(v); setIdx(0); }} placeholder="Filter duplicate sets…" />
					<div style={t("flex flex-row items-center gap-1")}>
						<For each={["all", "doi", "isbn", "title"] as const}>
							{(r) => (
								<div onClick={() => { setReasonFilter(r); setIdx(0); }} style={{ ...t(`rounded px-2 py-0.5 ${reasonFilter() === r ? "bg-primary" : "bg-muted hover:bg-accent"}`), cursor: "pointer" }}>
									<Txt class={`text-[11px] font-medium ${reasonFilter() === r ? "text-primary-foreground" : "text-muted-foreground"}`}>{r === "all" ? "All" : REASON[r]}</Txt>
								</div>
							)}
						</For>
						<div style={{ flexGrow: 1 }} />
						<Txt class="text-[11px] text-muted-foreground">{`${filtered().length} sets`}</Txt>
					</div>
				</div>
				<Scroll style={{ flexGrow: 1, flexShrink: 1 }}>
					<For each={filtered().slice(0, 300)} fallback={
						<div style={t("flex flex-col items-center justify-center p-4")}>
							<Txt class="text-xs text-muted-foreground">{listError() || (loading() ? "Looking for duplicates…" : "No duplicate sets found.")}</Txt>
						</div>
					}>
						{(s, i) => (
							<Row selected={idx() === i()} onClick={() => setIdx(i())} class="border-b" style={{ flexShrink: 0, flexDirection: "column", alignItems: "stretch", gap: 4, padding: 10 }}>
								<div style={t("flex flex-row items-start gap-2")}>
									<Para class="text-xs font-medium text-foreground" style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, lineClamp: 2, overflow: "hidden" }}>{s.title || s.keys.join(", ")}</Para>
									<Chip>{String(s.keys.length)}</Chip>
								</div>
								<div style={t("flex flex-row items-center gap-2")}>
									<Line class="text-[11px] text-muted-foreground" style={{ flexGrow: 1 }}>{[s.creatorsSummary, s.year].filter(Boolean).join(" · ") || s.itemType || "Items"}</Line>
									<Chip>{REASON[s.reason].toUpperCase()}</Chip>
								</div>
							</Row>
						)}
					</For>
				</Scroll>
			</div>
			{/* ---- right: side-by-side merge */}
			<div style={{ ...t("flex flex-col bg-background"), flexGrow: 1, flexShrink: 1, minWidth: 0, height: H }}>
				<Show when={active()} fallback={
					<div style={{ ...t("flex flex-col items-center justify-center gap-2 p-8"), flexGrow: 1 }}>
						<Icon name="git-merge" size={40} color={tok("muted-foreground")} style={{ opacity: 0.3 }} />
						<Txt class="text-sm font-medium text-muted-foreground">No duplicate set selected</Txt>
						<Txt class="text-xs text-muted-foreground">Select a duplicate set on the left to review and merge items.</Txt>
					</div>
				}>
					{(cur) => (
						<>
							<div style={t("flex flex-row items-center gap-3 border-b bg-card px-4 py-2.5")}>
								<div style={{ ...t("flex flex-row items-center gap-2"), flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
									<Line class="text-sm font-semibold text-foreground">{String(details()?.items[0]?.data.title || cur().title || "Duplicate Set")}</Line>
									<Chip>{`Matched by ${REASON[cur().reason]}`}</Chip>
								</div>
								<Button variant="outline" size="sm" disabled={busy() || !details()} onClick={() => void notDuplicates()}>Not Duplicates</Button>
								<Button variant="primary" size="sm" icon="git-merge" disabled={busy() || !details()} onClick={() => void merge()}>{`Merge ${cur().keys.length} items`}</Button>
							</div>
							<Scroll style={{ flexGrow: 1, flexShrink: 1, padding: 16, gap: 16 }}>
								<Show when={details()} fallback={<Txt class="text-xs text-muted-foreground">{detailError() || "Loading…"}</Txt>}>
									{(d) => (
										<>
											<div style={{ ...t("flex flex-col rounded-lg border bg-card overflow-hidden"), flexShrink: 0 }}>
												<SectionHead>MASTER ITEM (KEPT; THE OTHERS MOVE TO THE TRASH AND PASS ON THEIR CHILDREN, TAGS AND COLLECTIONS)</SectionHead>
												<Cols head={<Txt class="text-xs font-medium text-muted-foreground">Master Version</Txt>}>
													<For each={d().items}>
														{(item, i) => (
															<div onClick={() => pickMaster(item.data.key)} style={{ ...t(`flex flex-col gap-1 p-3 border-l ${master() === item.data.key ? "bg-primary/10" : "hover:bg-accent/50"}`), ...colStyle, cursor: "pointer" }}>
																<div style={t("flex flex-row items-center gap-2")}>
																	<div style={{ ...t("flex items-center justify-center rounded-full border"), width: 14, height: 14, borderColor: master() === item.data.key ? tok("primary") : tok("input"), flexShrink: 0 }}>
																		<Show when={master() === item.data.key}><div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tok("primary") }} /></Show>
																	</div>
																	<Line class="text-xs font-semibold text-foreground">{`Version ${i() + 1} (${item.data.key})`}</Line>
																	<Show when={i() === 0}><Chip>Oldest</Chip></Show>
																</div>
																<Txt class="text-[11px] text-muted-foreground" style={{ paddingLeft: 22 }}>{`Added: ${dateShort(item.data.dateAdded)}`}</Txt>
																<Txt class="text-[11px] text-muted-foreground" style={{ paddingLeft: 22 }}>{`${item.children.filter((c) => c.itemType === "attachment").length} attachments · ${item.children.filter((c) => c.itemType === "note").length} notes`}</Txt>
															</div>
														)}
													</For>
												</Cols>
											</div>

											<div style={{ ...t("flex flex-col rounded-lg border bg-card overflow-hidden"), flexShrink: 0 }}>
												<SectionHead>{`DIFFERING FIELDS (${differing().length}) — CLICK A VALUE TO CHOOSE WHICH VERSION TO KEEP`}</SectionHead>
												<Show when={differing().length > 0} fallback={<div style={t("px-3 py-4")}><Txt class="text-xs text-muted-foreground">All metadata fields are identical across these versions.</Txt></div>}>
													<For each={differing()}>
														{(field) => {
															const chosen = () => choices()[field] ?? master();
															return (
																<Cols border head={<Txt class="text-xs font-medium text-foreground">{label(field, labels())}</Txt>}>
																	<For each={d().items}>
																		{(item) => {
																			const v = () => valueText(field, item.data[field]);
																			const sel = () => chosen() === item.data.key;
																			return (
																				<div onClick={() => setChoices({ ...choices(), [field]: item.data.key })} style={{ ...t(`flex flex-row items-start gap-2 p-2.5 border-l ${sel() ? "bg-primary/10" : "hover:bg-accent/50"}`), ...colStyle, cursor: "pointer" }}>
																					<Para class={`text-xs ${v() ? (sel() ? "font-medium text-foreground" : "text-foreground") : "text-muted-foreground"}`} style={{ flexGrow: 1, flexShrink: 1, minWidth: 0 }}>{v() || "Empty"}</Para>
																					<Show when={sel()}><Icon name="check" size={14} color={tok("primary")} /></Show>
																				</div>
																			);
																		}}
																	</For>
																</Cols>
															);
														}}
													</For>
												</Show>
											</div>

											<div style={{ ...t("flex flex-col gap-2 rounded-lg border bg-card p-3"), flexShrink: 0 }}>
												<Txt class="text-[11px] font-semibold text-muted-foreground">{`COMBINED ON MERGE (UNIONED FROM ALL ${d().items.length} VERSIONS)`}</Txt>
												<Para class="text-xs text-foreground">{`Tags (${union().tags.length}): ${union().tags.join(", ") || "None"}`}</Para>
												<Para class="text-xs text-foreground">{`Collections (${union().collections.length}): ${union().collections.join(", ") || "None"}`}</Para>
												<Para class="text-xs text-foreground">{`Children (${union().children}): notes and attachments move to the master`}</Para>
												<Para class="text-xs text-foreground">{`Relations: ${union().related} related + dc:replaces`}</Para>
												<Show when={identical().length > 0}>
													<div style={{ ...t("border-t"), height: 1, width: "100%", marginTop: 4, marginBottom: 4 }} />
													<Txt class="text-[11px] font-medium text-muted-foreground">{`Identical fields (${identical().length})`}</Txt>
													<For each={identical()}>
														{(f) => <Line class="text-xs text-foreground">{`${label(f, labels())}: ${valueText(f, d().items[0]!.data[f])}`}</Line>}
													</For>
												</Show>
											</div>
										</>
									)}
								</Show>
							</Scroll>
						</>
					)}
				</Show>
			</div>
		</div>
	);
}

/** Open the merge UI: no keys = every detected set; with keys, those items first as a manual set. */
export function openDuplicates(manualKeys?: string[]): Promise<void> {
	return openDialog<void>((close) => <DuplicatesDialog manualKeys={manualKeys} close={() => close()} />, { title: "Duplicate Items", width: 1120 }).then(() => undefined);
}
