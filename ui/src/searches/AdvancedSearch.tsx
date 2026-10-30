import { createEffect, createMemo, createResource, createSignal, For, on, Show, type Component } from "solid-js";
import { Minus, Plus, Search as SearchIcon } from "lucide-solid";
import { toast } from "solid-sonner";
import {
	api, type Collection, type ItemSummary, type Operator, type SavedSearch, type SearchCondition, type SearchOptions,
} from "~/api";
import { store } from "~/store";
import { fail } from "~/lib/actions";
import { itemTypeIcon } from "~/lib/icons";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import {
	BASE_FIELDS, FILE_TYPES, OPERATOR_LABELS, OPERATORS_BY_KIND, PERIOD_UNITS, blankCondition, fieldKind, parsePeriod, schemaFields,
	type FieldDef,
} from "./conditions";
import { dialogOpen, editKey, refreshSavedSearches, savedSearches, setDialogOpen, setEditKey } from "./state";

const DEFAULT_OPTIONS: SearchOptions = {
	match: "all", includeParentsAndChildren: false, searchSubcollections: false, topLevelOnly: false, includeTrash: false,
};
const selectCls = "h-7 rounded-md border border-input bg-background px-1.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/30";

interface Row extends SearchCondition { id: number }
let nextId = 1;

let schemaPromise: ReturnType<typeof api.schema> | null = null;
const loadSchema = () => (schemaPromise ??= api.schema().catch((e) => { schemaPromise = null; throw e; }));

/** Collections flattened depth-first with their nesting depth, for the picker. */
function flatCollections(list: Collection[]): { key: string; label: string }[] {
	const by = new Map<string | null, Collection[]>();
	for (const c of list) {
		const p = c.parentKey && list.some((x) => x.key === c.parentKey) ? c.parentKey : null;
		by.set(p, [...(by.get(p) ?? []), c]);
	}
	const out: { key: string; label: string }[] = [];
	const walk = (p: string | null, depth: number) => {
		for (const c of (by.get(p) ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
			out.push({ key: c.key, label: "  ".repeat(depth) + c.name });
			walk(c.key, depth + 1);
		}
	};
	walk(null, 0);
	return out;
}

const ValueEditor: Component<{
	row: Row; kind: ReturnType<typeof fieldKind>; tags: string[]; itemTypes: { itemType: string; label: string }[];
	onChange: (v: string) => void;
}> = (p) => {
	const v = () => p.row.value;
	const collections = createMemo(() => flatCollections(store.collections() ?? []));
	return (
		<>
			{(() => {
				const k = p.kind;
				if (k === "itemType") {
					return (
						<select class={selectCls + " min-w-0 flex-1"} value={v()} onChange={(e) => p.onChange(e.currentTarget.value)}>
							<option value="">Choose…</option>
							<For each={p.itemTypes}>{(t) => <option value={t.itemType}>{t.label}</option>}</For>
						</select>
					);
				}
				if (k === "collection") {
					return (
						<select class={selectCls + " min-w-0 flex-1"} value={v()} onChange={(e) => p.onChange(e.currentTarget.value)}>
							<option value="">Choose…</option>
							<For each={collections()}>{(c) => <option value={c.key}>{c.label}</option>}</For>
						</select>
					);
				}
				if (k === "fileType") {
					return (
						<select class={selectCls + " min-w-0 flex-1"} value={v()} onChange={(e) => p.onChange(e.currentTarget.value)}>
							<option value="">Choose…</option>
							<For each={FILE_TYPES}>{([id, label]) => <option value={id}>{label}</option>}</For>
						</select>
					);
				}
				if ((k === "date" || k === "datetime") && p.row.operator === "isInTheLast") {
					const per = () => parsePeriod(v());
					return (
						<div class="flex min-w-0 flex-1 gap-1.5">
							<Input type="number" min="1" class="w-20" value={per().n} placeholder="3"
								onInput={(e) => p.onChange(e.currentTarget.value ? `${e.currentTarget.value} ${per().unit}` : "")} />
							<select class={selectCls} value={per().unit}
								onChange={(e) => per().n && p.onChange(`${per().n} ${e.currentTarget.value}`)}>
								<For each={PERIOD_UNITS}>{(u) => <option value={u}>{u}</option>}</For>
							</select>
						</div>
					);
				}
				if (k === "datetime") {
					return <Input type="date" class="min-w-0 flex-1" value={v().slice(0, 10)} onInput={(e) => p.onChange(e.currentTarget.value)} />;
				}
				if (k === "date") {
					return <Input class="min-w-0 flex-1" value={v()} placeholder="YYYY, YYYY-MM or YYYY-MM-DD" onInput={(e) => p.onChange(e.currentTarget.value)} />;
				}
				if (k === "year") {
					return <Input type="number" class="min-w-0 flex-1" value={v()} placeholder="2020" onInput={(e) => p.onChange(e.currentTarget.value)} />;
				}
				const listId = k === "tag" ? "zn-search-tags" : undefined;
				return (
					<>
						<Input class="min-w-0 flex-1" list={listId} value={v()}
							placeholder={k === "note" || k === "fulltext" ? 'words, "phrases", prefix*' : undefined}
							onInput={(e) => p.onChange(e.currentTarget.value)} />
						<Show when={k === "tag"}>
							<datalist id="zn-search-tags"><For each={p.tags.slice(0, 500)}>{(t) => <option value={t} />}</For></datalist>
						</Show>
					</>
				);
			})()}
		</>
	);
};

const ResultRow: Component<{ item: ItemSummary; onPick: () => void }> = (p) => {
	const Icon = itemTypeIcon(p.item.itemType);
	return (
		<button type="button" class="flex w-full items-center gap-2 px-2 py-1 text-left text-[13px] hover:bg-accent" onClick={p.onPick}>
			<Icon class="size-3.5 flex-none text-muted-foreground" />
			<span class="min-w-0 flex-1 truncate">{p.item.title || "(untitled)"}</span>
			<span class="max-w-40 flex-none truncate text-xs text-muted-foreground">{p.item.creatorsSummary}</span>
			<span class="w-10 flex-none text-right text-xs tabular-nums text-muted-foreground">{p.item.year ?? ""}</span>
		</button>
	);
};

export const AdvancedSearchDialog: Component = () => {
	const [schema] = createResource(() => dialogOpen() || undefined, () => loadSchema().catch(() => undefined));
	const [tagList] = createResource(() => dialogOpen() || undefined, () => api.tags().then((t) => t.map((x) => x.tag)).catch(() => [] as string[]));
	const extra = createMemo<FieldDef[]>(() => schemaFields(schema()));

	const [rows, setRows] = createSignal<Row[]>([{ id: nextId++, ...blankCondition("title", []) }]);
	const [options, setOptions] = createSignal<SearchOptions>({ ...DEFAULT_OPTIONS });
	const [name, setName] = createSignal("");
	const [naming, setNaming] = createSignal(false);
	const [result, setResult] = createSignal<{ total: number; items: ItemSummary[] } | null>(null);
	const [busy, setBusy] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);

	const editing = createMemo<SavedSearch | null>(() => {
		const k = editKey();
		return k ? (savedSearches() ?? []).find((s) => s.key === k) ?? null : null;
	});

	// Load the saved search into the form whenever the dialog opens.
	createEffect(on(dialogOpen, (open) => {
		if (!open) return;
		const s = editing();
		setNaming(false);
		setResult(null);
		setError(null);
		if (s) {
			setRows(s.conditions.map((c) => ({ ...c, id: nextId++ })));
			setOptions({ ...DEFAULT_OPTIONS, ...s.options });
			setName(s.name);
		} else {
			setRows([{ id: nextId++, ...blankCondition("title", []) }]);
			setOptions({ ...DEFAULT_OPTIONS });
			setName("");
		}
	}));

	const effective = () => rows().filter((r) => r.value.trim() !== "").map(({ field, operator, value }) => ({ field, operator, value: value.trim() }));

	// Live results: debounced, stale responses dropped.
	let seq = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	createEffect(() => {
		if (!dialogOpen()) return;
		const conds = effective();
		const opts = options();
		clearTimeout(timer);
		const my = ++seq;
		if (conds.length === 0) {
			setResult(null);
			setError(null);
			setBusy(false);
			return;
		}
		setBusy(true);
		timer = setTimeout(async () => {
			try {
				const res = await api.runSearch(conds, opts, 100, 0);
				if (my !== seq) return;
				setResult(res);
				setError(null);
			} catch (e) {
				if (my !== seq) return;
				setResult(null);
				setError(e instanceof Error ? e.message : String(e));
			} finally {
				if (my === seq) setBusy(false);
			}
		}, 250);
	});

	const patchRow = (id: number, p: Partial<SearchCondition>) => setRows((l) => l.map((r) => (r.id === id ? { ...r, ...p } : r)));
	const setField = (r: Row, field: string) => {
		const kind = fieldKind(field, extra());
		const op = OPERATORS_BY_KIND[kind].includes(r.operator) ? r.operator : OPERATORS_BY_KIND[kind][0];
		patchRow(r.id, { field, operator: op, value: "" });
	};
	const addRow = (after: number) => setRows((l) => {
		const i = l.findIndex((r) => r.id === after);
		const n: Row = { id: nextId++, ...blankCondition("title", []) };
		return [...l.slice(0, i + 1), n, ...l.slice(i + 1)];
	});
	const removeRow = (id: number) => setRows((l) => (l.length > 1 ? l.filter((r) => r.id !== id) : [{ ...blankCondition("title", []), id }]));
	const setOpt = <K extends keyof SearchOptions>(k: K, v: SearchOptions[K]) => setOptions((o) => ({ ...o, [k]: v }));

	const close = () => { setDialogOpen(false); setEditKey(null); };

	async function save(asNew: boolean) {
		const conds = effective();
		const nm = name().trim();
		if (!nm) return void toast.error("Give the saved search a name");
		try {
			const cur = editing();
			const s = cur && !asNew
				? await api.patchSavedSearch(cur.key, { name: nm, conditions: conds, options: options() })
				: await api.createSavedSearch(nm, conds, options());
			refreshSavedSearches();
			store.setView({ kind: "search", key: s.key });
			store.bumpItems();
			toast.success(`Saved search "${s.name}"`);
			close();
		} catch (e) {
			fail("Could not save search", e);
		}
	}

	function pick(it: ItemSummary) {
		store.setView({ kind: "library" });
		store.setActiveTab("library");
		store.selectOnly(it.key);
		close();
	}

	const onNameKey = (e: KeyboardEvent) => {
		e.stopPropagation();
		if (e.key === "Enter") { e.preventDefault(); save(false); }
		if (e.key === "Escape") setNaming(false);
	};

	return (
		<Dialog open={dialogOpen()} onOpenChange={(o) => (o ? setDialogOpen(true) : close())}>
			<DialogContent class="flex max-h-[90vh] max-w-3xl flex-col gap-3 p-4">
				<div>
					<DialogTitle class="text-base font-semibold">{editing() ? `Edit Saved Search` : "Advanced Search"}</DialogTitle>
					<DialogDescription class="sr-only">Build a search from conditions on fields, tags, collections and text.</DialogDescription>
				</div>

				<div class="flex flex-wrap items-center gap-2 text-[13px]">
					<span>Match</span>
					<select class={selectCls} aria-label="Match all or any" value={options().match}
						onChange={(e) => setOpt("match", e.currentTarget.value as "all" | "any")}>
						<option value="all">all</option>
						<option value="any">any</option>
					</select>
					<span>of the following:</span>
				</div>

				<div class="flex min-h-0 flex-col gap-1.5 overflow-y-auto" role="group" aria-label="Search conditions">
					<For each={rows()}>{(r) => {
						const kind = () => fieldKind(r.field, extra());
						return (
							<div class="flex items-center gap-1.5">
								<select class={selectCls + " w-44 flex-none"} aria-label="Field" value={r.field} onChange={(e) => setField(r, e.currentTarget.value)}>
									<For each={BASE_FIELDS}>{(f) => <option value={f.id}>{f.label}</option>}</For>
									<Show when={extra().length}>
										<optgroup label="More fields">
											<For each={extra()}>{(f) => <option value={f.id}>{f.label}</option>}</For>
										</optgroup>
									</Show>
								</select>
								<select class={selectCls + " w-36 flex-none"} aria-label="Operator" value={r.operator}
									onChange={(e) => patchRow(r.id, { operator: e.currentTarget.value as Operator, value: "" })}>
									<For each={OPERATORS_BY_KIND[kind()]}>{(o) => <option value={o}>{OPERATOR_LABELS[o]}</option>}</For>
								</select>
								<ValueEditor row={r} kind={kind()} tags={tagList() ?? []} itemTypes={schema()?.itemTypes ?? []}
									onChange={(v) => patchRow(r.id, { value: v })} />
								<Button variant="outline" size="icon" class="size-7 flex-none" aria-label="Remove condition" onClick={() => removeRow(r.id)}><Minus /></Button>
								<Button variant="outline" size="icon" class="size-7 flex-none" aria-label="Add condition" onClick={() => addRow(r.id)}><Plus /></Button>
							</div>
						);
					}}</For>
				</div>

				<div class="grid grid-cols-1 gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-2">
					<Checkbox checked={options().includeParentsAndChildren} onChange={(v: boolean) => setOpt("includeParentsAndChildren", v)}
						label={<span>Include parent and child items of matches</span>} />
					<Checkbox checked={options().searchSubcollections} onChange={(v: boolean) => setOpt("searchSubcollections", v)}
						label={<span>Search subcollections</span>} />
					<Checkbox checked={options().topLevelOnly} onChange={(v: boolean) => setOpt("topLevelOnly", v)}
						label={<span>Show only top-level items</span>} />
					<Checkbox checked={options().includeTrash} onChange={(v: boolean) => setOpt("includeTrash", v)}
						label={<span>Include items in the trash</span>} />
				</div>

				<div class="flex min-h-0 flex-1 flex-col rounded-md border" aria-live="polite">
					<div class="flex flex-none items-center gap-2 border-b px-2 py-1 text-xs text-muted-foreground">
						<SearchIcon class="size-3.5" />
						<Show when={error()} fallback={
							<Show when={result()} fallback={<span>{busy() ? "Searching…" : "Enter a value to search"}</span>}>
								{(r) => <span>{r().total} {r().total === 1 ? "result" : "results"}{r().total > r().items.length ? ` (showing ${r().items.length})` : ""}</span>}
							</Show>
						}>
							<span class="text-destructive">{error()}</span>
						</Show>
					</div>
					<div class="h-52 min-h-24 flex-1 overflow-y-auto">
						<For each={result()?.items ?? []}>{(it) => <ResultRow item={it} onPick={() => pick(it)} />}</For>
					</div>
				</div>

				<div class="flex flex-wrap items-center justify-end gap-2">
					<Show when={naming() || editing()} fallback={
						<>
							<Button variant="outline" size="sm" class="h-8" onClick={close}>Close</Button>
							<Button size="sm" class="h-8" disabled={effective().length === 0} onClick={() => { setName(name() || suggestName()); setNaming(true); }}>
								Save Search…
							</Button>
						</>
					}>
						<Input class="h-8 w-56" placeholder="Name this search" aria-label="Saved search name" value={name()}
							ref={(el) => queueMicrotask(() => el.focus())}
							onInput={(e) => setName(e.currentTarget.value)} onKeyDown={onNameKey} />
						<Button variant="outline" size="sm" class="h-8" onClick={() => (editing() ? close() : setNaming(false))}>
							{editing() ? "Cancel" : "Back"}
						</Button>
						<Show when={editing()}>
							<Button variant="outline" size="sm" class="h-8" disabled={effective().length === 0} onClick={() => save(true)}>Save as New</Button>
						</Show>
						<Button size="sm" class="h-8" disabled={effective().length === 0 || !name().trim()} onClick={() => save(false)}>
							{editing() ? "Save Changes" : "Save"}
						</Button>
					</Show>
				</div>
			</DialogContent>
		</Dialog>
	);

	function suggestName(): string {
		const c = effective()[0];
		if (!c) return "";
		const label = BASE_FIELDS.find((f) => f.id === c.field)?.label ?? extra().find((f) => f.id === c.field)?.label ?? c.field;
		return `${label} ${OPERATOR_LABELS[c.operator]} ${c.value}`.slice(0, 60);
	}
};
