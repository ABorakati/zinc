// Advanced Search / Edit Saved Search dialog: the conditions editor of ui/src/searches/AdvancedSearch.tsx on the shared
// UI primitives (openDialog, Select, TextInput, Checkbox, Button). Live results as you type; Save... names the search.
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { Icon, itemTypeIconName } from "../icons";
import { setView } from "../sidebar/bridge";
import {
	errMsg,
	sidebarApi,
	type Operator,
	type SavedSearch,
	type SearchCondition,
	type SearchOptions,
	type ZoteroSchema,
} from "../sidebar/client";
import { collections } from "../sidebar/Collections";
import { muted, t, tok, tx } from "../sidebar/parts";
import { store } from "../store";
import { Button, Checkbox, openDialog, Select, TextInput, toast } from "../ui";
import {
	BASE_FIELDS,
	FILE_TYPES,
	OPERATOR_LABELS,
	OPERATORS_BY_KIND,
	PERIOD_UNITS,
	blankCondition,
	fieldKind,
	parsePeriod,
	schemaFields,
	type FieldDef,
	type Kind,
} from "./conditions";
import { refreshSavedSearches, savedSearches } from "./state";
import { refreshStore } from "../sidebar/bridge";
import type { Collection } from "../contracts";

const DEFAULT_OPTIONS: SearchOptions = {
	match: "all",
	includeParentsAndChildren: false,
	searchSubcollections: false,
	topLevelOnly: false,
	includeTrash: false,
};

interface Row extends SearchCondition {
	id: number;
}
let nextId = 1;

interface Hit {
	key: string;
	itemType: string;
	title: string;
	creatorsSummary?: string;
	year?: number | string | null;
}

let schemaPromise: Promise<ZoteroSchema> | null = null;
const loadSchema = () =>
	(schemaPromise ??= sidebarApi.schema().catch((e) => {
		schemaPromise = null;
		throw e;
	}));

/** Collections flattened depth-first with their nesting, for the picker. */
function flatCollections(list: Collection[], depth = 0, out: { value: string; label: string }[] = []) {
	for (const c of list) {
		out.push({ value: c.key, label: (depth ? "· ".repeat(depth) : "") + c.name });
		if (c.children) flatCollections(c.children, depth + 1, out);
	}
	return out;
}

/** Open the dialog for a fresh advanced search, or for editing the saved search `editKey`. */
export function openAdvancedSearch(editKey?: string): Promise<void> {
	const editing = editKey ? (savedSearches().find((s) => s.key === editKey) ?? null) : null;
	return openDialog<void>((close) => <AdvancedSearchForm editing={editing} close={() => close()} />, {
		title: editing ? "Edit Saved Search" : "Advanced Search",
		width: 780,
	}).then(() => undefined);
}

/**
 * The value control for one condition. `kind` and `operator` must be stable (memoised) accessors: the IIFE below re-runs, and
 * so re-creates the input and drops its focus, whenever something it read changes, so it must not read the typed value.
 */
function ValueEditor(p: {
	kind: Kind;
	operator: Operator;
	value: string;
	tags: string[];
	itemTypes: { itemType: string; label: string }[];
	onChange: (v: string) => void;
}): JSX.Element {
	const flex = { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 };
	const v = () => p.value;
	const colOptions = createMemo(() => flatCollections(collections()));
	return (
		<div style={{ ...t("flex items-center gap-1.5"), ...flex }}>
			{(() => {
				const k = p.kind;
				if (k === "itemType") {
					return (
						<Select
							value={v()}
							width={260}
							options={[{ value: "", label: "Choose…" }, ...p.itemTypes.map((x) => ({ value: x.itemType, label: x.label }))]}
							onChange={p.onChange}
						/>
					);
				}
				if (k === "collection") {
					return (
						<Select
							value={v()}
							width={260}
							options={[{ value: "", label: "Choose…" }, ...colOptions()]}
							onChange={p.onChange}
						/>
					);
				}
				if (k === "fileType") {
					return (
						<Select
							value={v()}
							width={260}
							options={[
								{ value: "", label: "Choose…" },
								...FILE_TYPES.map(([id, label]) => ({ value: id as string, label })),
							]}
							onChange={p.onChange}
						/>
					);
				}
				if ((k === "date" || k === "datetime") && p.operator === "isInTheLast") {
					const per = () => parsePeriod(v());
					return (
						<>
							<TextInput
								value={per().n}
								placeholder="3"
								style={{ width: 70 }}
								onInput={(x) => p.onChange(x.replace(/\D/g, "") ? `${x.replace(/\D/g, "")} ${per().unit}` : "")}
							/>
							<Select
								value={per().unit}
								width={110}
								options={PERIOD_UNITS.map((u) => ({ value: u, label: u }))}
								onChange={(u) => per().n && p.onChange(`${per().n} ${u}`)}
							/>
						</>
					);
				}
				if (k === "date" || k === "datetime") {
					return (
						<TextInput
							value={k === "datetime" ? v().slice(0, 10) : v()}
							placeholder="YYYY-MM-DD"
							style={flex}
							onInput={p.onChange}
						/>
					);
				}
				if (k === "year") return <TextInput value={v()} placeholder="2020" style={flex} onInput={p.onChange} />;
				return (
					<TextInput
						value={v()}
						placeholder={k === "note" || k === "fulltext" ? 'words, "phrases", prefix*' : k === "tag" ? "tag name" : undefined}
						style={flex}
						onInput={p.onChange}
					/>
				);
			})()}
		</div>
	);
}

function TagSuggestions(p: { value: string; tags: string[]; onPick: (t: string) => void }): JSX.Element {
	const hits = createMemo(() => {
		const q = p.value.trim().toLowerCase();
		if (!q) return [];
		const out: string[] = [];
		for (const x of p.tags) {
			if (x.toLowerCase().includes(q) && x !== p.value) out.push(x);
			if (out.length >= 6) break;
		}
		return out;
	});
	return (
		<Show when={hits().length}>
			<div style={{ ...t("flex flex-wrap items-center gap-1.5"), paddingLeft: 4 }}>
				<text style={tx("text-xs text-muted-foreground")}>Tags:</text>
				<For each={hits()}>
					{(x) => (
						<div
							role="button"
							onClick={() => p.onPick(x)}
							style={{
								...t(
									"inline-flex h-6 max-w-full cursor-pointer items-center rounded-full bg-background px-2.5 ring-1 ring-border hover:ring-primary/50",
								),
								cursor: "pointer",
							}}
						>
							<text style={{ ...tx("text-xs text-secondary-foreground"), whiteSpace: "nowrap" }}>{x}</text>
						</div>
					)}
				</For>
			</div>
		</Show>
	);
}

function ResultRow(p: { item: Hit; onPick: () => void }): JSX.Element {
	return (
		<div
			role="button"
			onClick={p.onPick}
			style={{ ...t("flex w-full items-center gap-2 px-2 py-1 hover:bg-accent"), cursor: "pointer" }}
		>
			<Icon name={itemTypeIconName(p.item.itemType)} size={14} color={muted()} />
			<text
				style={{
					...tx("text-[13px] text-foreground"),
					flexGrow: 1,
					flexBasis: 0,
					minWidth: 0,
					overflow: "hidden",
					whiteSpace: "nowrap",
					textOverflow: "ellipsis",
				}}
			>
				{p.item.title || "(untitled)"}
			</text>
			<text
				style={{
					...tx("text-xs text-muted-foreground"),
					maxWidth: 160,
					flexShrink: 0,
					overflow: "hidden",
					whiteSpace: "nowrap",
					textOverflow: "ellipsis",
				}}
			>
				{p.item.creatorsSummary ?? ""}
			</text>
			<text style={{ ...tx("text-xs text-muted-foreground"), width: 40, flexShrink: 0, textAlign: "right" }}>
				{String(p.item.year ?? "")}
			</text>
		</div>
	);
}

function AdvancedSearchForm(p: { editing: SavedSearch | null; close: () => void }): JSX.Element {
	const editing = p.editing;
	const [schema] = createResource(() => loadSchema().catch(() => undefined));
	const [tagList] = createResource(() =>
		sidebarApi
			.tags()
			.then((x) => x.map((y) => y.tag))
			.catch(() => [] as string[]),
	);
	const extra = createMemo<FieldDef[]>(() => schemaFields(schema()));

	const [rows, setRows] = createSignal<Row[]>(
		editing ? editing.conditions.map((c) => ({ ...c, id: nextId++ })) : [{ id: nextId++, ...blankCondition("title", []) }],
	);
	const [options, setOptions] = createSignal<SearchOptions>({ ...DEFAULT_OPTIONS, ...(editing?.options ?? {}) });
	const [name, setName] = createSignal(editing?.name ?? "");
	const [naming, setNaming] = createSignal(false);
	const [result, setResult] = createSignal<{ total: number; items: Hit[] } | null>(null);
	const [busy, setBusy] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);

	const rowIds = createMemo(() => rows().map((r) => r.id));
	const effective = (): SearchCondition[] =>
		rows()
			.filter((r) => r.value.trim() !== "")
			.map(({ field, operator, value }) => ({ field, operator, value: value.trim() }));

	// Live results: debounced, stale responses dropped.
	let seq = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	onCleanup(() => {
		clearTimeout(timer);
		seq++;
	});
	createEffect(() => {
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
				const res = await sidebarApi.runSearch(conds, opts, 100, 0);
				if (my !== seq) return;
				setResult({ total: res.total, items: res.items as unknown as Hit[] });
				setError(null);
			} catch (e) {
				if (my !== seq) return;
				setResult(null);
				setError(errMsg(e));
			} finally {
				if (my === seq) setBusy(false);
			}
		}, 250);
	});

	const patchRow = (id: number, q: Partial<SearchCondition>) => setRows((l) => l.map((r) => (r.id === id ? { ...r, ...q } : r)));
	const setField = (r: Row, field: string) => {
		const kind = fieldKind(field, extra());
		const op = OPERATORS_BY_KIND[kind].includes(r.operator) ? r.operator : OPERATORS_BY_KIND[kind][0]!;
		patchRow(r.id, { field, operator: op, value: "" });
	};
	const addRow = (after: number) =>
		setRows((l) => {
			const i = l.findIndex((r) => r.id === after);
			const n: Row = { id: nextId++, ...blankCondition("title", []) };
			return [...l.slice(0, i + 1), n, ...l.slice(i + 1)];
		});
	const removeRow = (id: number) =>
		setRows((l) => (l.length > 1 ? l.filter((r) => r.id !== id) : [{ ...blankCondition("title", []), id }]));
	const setOpt = <K extends keyof SearchOptions>(k: K, v: SearchOptions[K]) => setOptions((o) => ({ ...o, [k]: v }));

	function suggestName(): string {
		const c = effective()[0];
		if (!c) return "";
		const label = BASE_FIELDS.find((f) => f.id === c.field)?.label ?? extra().find((f) => f.id === c.field)?.label ?? c.field;
		return `${label} ${OPERATOR_LABELS[c.operator]} ${c.value}`.slice(0, 60);
	}

	async function save(asNew: boolean) {
		const conds = effective();
		const nm = name().trim();
		if (!nm) return void toast("Give the saved search a name", { kind: "error" });
		try {
			const s =
				editing && !asNew
					? await sidebarApi.patchSavedSearch(editing.key, { name: nm, conditions: conds, options: options() })
					: await sidebarApi.createSavedSearch(nm, conds, options());
			await refreshSavedSearches();
			refreshStore(); // the search may be on show: its list follows the new conditions
			setView({ kind: "savedSearch", key: s.key });
			toast(`Saved search "${s.name}"`, { kind: "success" });
			p.close();
		} catch (e) {
			toast("Could not save search", { kind: "error", description: errMsg(e) });
		}
	}

	function pick(it: Hit) {
		setView({ kind: "library" });
		store.setActiveTab("library");
		store.selectItem(it.key);
		p.close();
	}

	const fieldOptions = createMemo(() => [
		...BASE_FIELDS.map((f) => ({ value: f.id, label: f.label })),
		...extra().map((f) => ({ value: f.id, label: f.label, hint: "More fields" })),
	]);
	const sectionBorder: Record<string, unknown> = { borderWidth: 1, borderColor: tok("border"), borderRadius: 8 };

	return (
		<div style={{ ...t("flex flex-col gap-3"), width: "100%", minHeight: 0 }}>
			<div style={t("flex flex-wrap items-center gap-2")}>
				<text style={tx("text-[13px] text-foreground")}>Match</text>
				<Select
					value={options().match}
					width={80}
					options={[
						{ value: "all", label: "all" },
						{ value: "any", label: "any" },
					]}
					onChange={(v) => setOpt("match", v as "all" | "any")}
				/>
				<text style={tx("text-[13px] text-foreground")}>of the following:</text>
			</div>

			<div style={{ ...t("flex flex-col gap-1.5"), maxHeight: 230, overflowY: "scroll" }}>
				{/* keyed by row id: a keystroke replaces the row object, and re-creating its inputs would drop their focus */}
				<For each={rowIds()}>
					{(id) => {
						const r = () => rows().find((x) => x.id === id) ?? ({ id, field: "title", operator: "contains", value: "" } as Row);
						const kind = createMemo(() => fieldKind(r().field, extra()));
						const operator = createMemo(() => r().operator);
						return (
							<>
								<div style={t("flex items-center gap-1.5")}>
									<Select value={r().field} width={190} options={fieldOptions()} onChange={(f) => setField(r(), f)} />
									<Select
										value={r().operator}
										width={150}
										options={OPERATORS_BY_KIND[kind()].map((o) => ({ value: o, label: OPERATOR_LABELS[o] }))}
										onChange={(o) => patchRow(id, { operator: o as Operator, value: "" })}
									/>
									<ValueEditor
										kind={kind()}
										operator={operator()}
										value={r().value}
										tags={tagList() ?? []}
										itemTypes={schema()?.itemTypes ?? []}
										onChange={(v) => patchRow(id, { value: v })}
									/>
									<Button variant="outline" size="icon" icon="minus" onClick={() => removeRow(id)}>
										{""}
									</Button>
									<Button variant="outline" size="icon" icon="plus" onClick={() => addRow(id)}>
										{""}
									</Button>
								</div>
								<Show when={kind() === "tag"}>
									<TagSuggestions value={r().value} tags={tagList() ?? []} onPick={(x) => patchRow(id, { value: x })} />
								</Show>
							</>
						);
					}}
				</For>
			</div>

			<div style={t("flex flex-col gap-1.5")}>
				<div style={t("flex gap-6")}>
					<div style={{ ...t("flex flex-col gap-1.5"), flexGrow: 1, flexBasis: 0 }}>
						<Checkbox
							checked={options().includeParentsAndChildren}
							onChange={(v) => setOpt("includeParentsAndChildren", v)}
							label="Include parent and child items of matches"
						/>
						<Checkbox
							checked={options().topLevelOnly}
							onChange={(v) => setOpt("topLevelOnly", v)}
							label="Show only top-level items"
						/>
					</div>
					<div style={{ ...t("flex flex-col gap-1.5"), flexGrow: 1, flexBasis: 0 }}>
						<Checkbox
							checked={options().searchSubcollections}
							onChange={(v) => setOpt("searchSubcollections", v)}
							label="Search subcollections"
						/>
						<Checkbox
							checked={options().includeTrash}
							onChange={(v) => setOpt("includeTrash", v)}
							label="Include items in the trash"
						/>
					</div>
				</div>
			</div>

			<div style={{ ...t("flex flex-col"), ...sectionBorder, overflow: "hidden" }}>
				<div style={{ ...t("flex flex-none items-center gap-2 px-2 py-1"), borderBottomWidth: 1, borderColor: tok("border") }}>
					<Icon name="search" size={14} color={muted()} />
					<text style={{ ...tx(error() ? "text-xs text-destructive" : "text-xs text-muted-foreground") }}>
						{error() ??
							(result()
								? `${result()!.total} ${result()!.total === 1 ? "result" : "results"}${result()!.total > result()!.items.length ? ` (showing ${result()!.items.length})` : ""}`
								: busy()
									? "Searching…"
									: "Enter a value to search")}
					</text>
				</div>
				<div style={{ height: 190, overflowY: "scroll" }}>
					<For each={result()?.items ?? []}>{(it) => <ResultRow item={it} onPick={() => pick(it)} />}</For>
				</div>
			</div>

			<div style={t("flex flex-wrap items-center justify-end gap-2")}>
				<Show
					when={naming() || editing}
					fallback={
						<>
							<Button variant="outline" size="sm" onClick={p.close}>
								Close
							</Button>
							<Button
								variant="primary"
								size="sm"
								disabled={effective().length === 0}
								onClick={() => {
									setName(name() || suggestName());
									setNaming(true);
								}}
							>
								Save Search…
							</Button>
						</>
					}
				>
					<TextInput
						value={name()}
						placeholder="Name this search"
						autofocus={!editing}
						style={{ width: 240 }}
						onInput={setName}
						onEnter={() => void save(false)}
					/>
					<Button variant="outline" size="sm" onClick={() => (editing ? p.close() : setNaming(false))}>
						{editing ? "Cancel" : "Back"}
					</Button>
					<Show when={editing}>
						<Button variant="outline" size="sm" disabled={effective().length === 0} onClick={() => void save(true)}>
							Save as New
						</Button>
					</Show>
					<Button
						variant="primary"
						size="sm"
						disabled={effective().length === 0 || !name().trim()}
						onClick={() => void save(false)}
					>
						{editing ? "Save Changes" : "Save"}
					</Button>
				</Show>
			</div>
		</div>
	);
}
