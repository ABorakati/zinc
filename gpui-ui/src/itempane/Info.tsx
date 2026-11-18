// Info section: item type, every field of that type (from the core schema) with inline editing, the creators editor (type, two-field /
// single-field names, add, remove, reorder) and the date as year / month / day parts. Port of ui/src/itempane/Info.tsx + DateParts.
import { pluginInfoEntries } from "../wasmplugins/extend/InfoRows";
import { createEffect, createMemo, createSignal, on, Show, type JSX } from "solid-js";
import { Icon } from "../icons";
import { Select } from "../ui";
import {
	Block,
	BoxInput,
	Field,
	IconBtn,
	MiniSelect,
	Row,
	SectionHead,
	TextBtn,
	isCollapsed,
	labelW,
	locked,
	t,
	tok,
	tx,
	type Entry,
} from "./kit";
import { gatedHover } from "../cards/scrolling";
import { usePane } from "./model";
import { clearTitleEdit, titleEditWanted } from "./focus";
import { openLink } from "./actions";
import { CITATION_KEY_FIELD, CitationKeyBlock } from "../features/bbt/InfoRow";
import type { Creator, ZoteroSchemaField, ZoteroSchemaItemType } from "./net";
import { daysIn, fmtTimestamp, formatDateParts, isPlainDate, MONTH_ABBR, parseDate } from "./util";

const HIDDEN = new Set(["abstractNote", "dateAdded", "dateModified", "accessDate_", "itemType", "creators"]);
const FALLBACK: ZoteroSchemaField[] = [
	{ field: "title", label: "Title" },
	{ field: "publicationTitle", label: "Publication" },
	{ field: "date", label: "Date" },
	{ field: "DOI", label: "DOI" },
	{ field: "url", label: "URL" },
	{ field: "extra", label: "Extra" },
];
const FIELD_ICONS: Record<string, string> = {
	title: "type",
	publicationTitle: "book-open",
	bookTitle: "book-open",
	proceedingsTitle: "book-open",
	websiteTitle: "globe",
	date: "calendar",
	volume: "list-ordered",
	issue: "list-ordered",
	pages: "file-text",
	DOI: "link-2",
	url: "globe",
};

/** Creators shown at first when a long list is collapsed, and how many each "more" click reveals. */
const COLLAPSE_AT = 10;
const SHOW_WHEN_COLLAPSED = 5;
const PAGE = 50;

/** Work out how to move to another item type: the patch and the labels of the fields that will be lost. */
function planTypeChange(data: Record<string, unknown>, from: ZoteroSchemaItemType | undefined, to: ZoteroSchemaItemType) {
	// Core converts like Zotero: a field survives if the new type has the same name or the same baseField.
	const lost: string[] = [];
	for (const f of from?.fields ?? []) {
		const v = data[f.field];
		if (typeof v !== "string" || !v) continue;
		const kept = to.fields.some(
			(n) =>
				n.field === f.field ||
				(!!f.baseField && (n.field === f.baseField || n.baseField === f.baseField)) ||
				n.baseField === f.field,
		);
		if (!kept) lost.push(f.label);
	}
	return { patch: { itemType: to.itemType }, lost };
}

// ---- date as year / month / day ----

function DateParts(p: { value: string; onChange: (v: string) => void }): JSX.Element {
	const parsed = () => parseDate(p.value) ?? {};
	const [y, setY] = createSignal(parsed().y ?? "");
	const [m, setM] = createSignal(parsed().m ?? "");
	const [d, setD] = createSignal(parsed().d ?? "");
	const [textMode, setTextMode] = createSignal(!isPlainDate(p.value));
	createEffect(
		on(
			() => p.value,
			(v) => {
				const q = parseDate(v) ?? {};
				setY(q.y ?? "");
				setM(q.m ?? "");
				setD(q.d ?? "");
				if (!isPlainDate(v)) setTextMode(true);
			},
			{ defer: true },
		),
	);

	const commit = (ny = y(), nm = m(), nd = d()) => {
		// keep the day valid for the month / year
		if (nd && nm && +nd > daysIn(+ny, +nm)) nd = String(daysIn(+ny, +nm));
		if (!nm) nd = "";
		setY(ny);
		setM(nm);
		setD(nd);
		const out = ny ? formatDateParts(ny, nm, nd) : "";
		if (out !== p.value.trim()) p.onChange(out);
	};
	const monthOpts = [{ value: "", label: "Month" }, ...MONTH_ABBR.map((n, i) => ({ value: String(i + 1), label: n }))];
	const dayOpts = () => [
		{ value: "", label: "Day" },
		...Array.from({ length: m() ? daysIn(+y(), +m()) : 31 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) })),
	];

	return (
		<div style={{ ...t("flex items-center gap-1 w-full min-w-0") }}>
			<Show
				when={!textMode()}
				fallback={<Field value={p.value} placeholder="e.g. Spring 2020, in press" onSave={(v) => p.onChange(v.trim())} />}
			>
				<BoxInput value={y()} width={52} placeholder="Year" numeric onInput={(v) => setY(v)} onCommit={(v) => commit(v)} />
				<Select value={m()} options={monthOpts} onChange={(v) => commit(y(), v, d())} width={80} disabled={locked()} />
				<Select value={d()} options={dayOpts()} onChange={(v) => commit(y(), m(), v)} width={64} disabled={locked()} />
			</Show>
			<IconBtn
				icon={textMode() ? "calendar-days" : "type"}
				title={textMode() ? "Pick year, month and day" : "Edit as text"}
				box={24}
				onClick={() => setTextMode(!textMode())}
			/>
		</div>
	);
}

// ---- creators ----
// ---- creators ----

type MakeEntry = (id: string, render: () => JSX.Element) => Entry;
const NO_CREATOR: Creator = { creatorType: "author" };

/**
 * The creators editor as entries of the pane's virtual list: one per creator row (row i follows creators()[i]), the "Add" row of an
 * item without creators and the "N more…" row of a long list.
 */
function createCreatorEntries(st: () => ZoteroSchemaItemType | undefined, entry: MakeEntry): () => Entry[] {
	const pane = usePane();
	const [shown, setShown] = createSignal(0); // 0 = default (all, or SHOW_WHEN_COLLAPSED when long)
	createEffect(on(pane.itemKey, () => setShown(0), { defer: true }));
	const creators = () => (pane.detail()?.data.creators ?? []) as Creator[];
	const typeOpts = () =>
		(st()?.creatorTypes ?? [{ creatorType: "author", label: "Author", primary: true }]).map((c) => ({
			value: c.creatorType,
			label: c.label,
		}));
	const defaultType = () => st()?.creatorTypes.find((c) => c.primary)?.creatorType ?? "author";
	const labelOf = (ty: string) => typeOpts().find((o) => o.value === ty)?.label ?? ty;
	const count = createMemo(() => creators().length);
	const limit = createMemo(() => (count() <= COLLAPSE_AT ? count() : shown() || SHOW_WHEN_COLLAPSED));
	const hidden = () => Math.max(0, count() - limit());

	const commit = (list: Creator[]) => pane.save({ creators: list });
	const patchAt = (i: number, patch: Partial<Creator>) =>
		void commit(creators().map((c, j) => (j === i ? { ...c, ...patch } : { ...c })));
	const insertAfter = (i: number) => {
		const list = creators().map((c) => ({ ...c }));
		list.splice(i + 1, 0, { creatorType: list[i]?.creatorType ?? defaultType(), lastName: "", firstName: "" });
		if (i + 2 > limit()) setShown(i + 2);
		void commit(list);
	};
	const remove = (i: number) =>
		void commit(
			creators()
				.filter((_, j) => j !== i)
				.map((c) => ({ ...c })),
		);
	const move = (i: number, dir: -1 | 1) => {
		const list = creators().map((c) => ({ ...c }));
		const j = i + dir;
		if (j < 0 || j >= list.length) return;
		[list[i], list[j]] = [list[j]!, list[i]!];
		void commit(list);
	};
	const toggleMode = (i: number) => {
		const c = creators()[i];
		if (!c) return;
		let next: Creator;
		if (c.name !== undefined) {
			const parts = c.name.trim().split(/\s+/).filter(Boolean);
			const last = parts.pop() ?? "";
			next = { creatorType: c.creatorType, lastName: last, firstName: parts.join(" ") };
		} else {
			next = { creatorType: c.creatorType, name: [c.firstName, c.lastName].filter(Boolean).join(" ") };
		}
		void commit(creators().map((x, j) => (j === i ? next : { ...x })));
	};

	const creatorRow = (i: number): JSX.Element => {
		const c = () => creators()[i] ?? NO_CREATOR;
		// the five action icons float over the row's right edge while the pointer is on it or one of its fields is being edited, so they
		// do not take ~100 px from the names the rest of the time
		const [hot, setHot] = createSignal(false);
		const [editing, setEditing] = createSignal(false);
		const hover = gatedHover(setHot);
		const actions = () => !locked() && (hot() || editing());
		return (
			<div
				onMouseEnter={hover.enter}
				onMouseLeave={hover.leave}
				style={{ ...t("flex items-start gap-x-3 py-[2px] w-full"), position: "relative" }}
			>
				<div style={{ width: labelW(), flexShrink: 0, paddingTop: 1 }}>
					<MiniSelect
						value={c().creatorType}
						options={
							typeOpts().some((o) => o.value === c().creatorType)
								? typeOpts()
								: [...typeOpts(), { value: c().creatorType, label: c().creatorType }]
						}
						onChange={(v) => patchAt(i, { creatorType: v })}
						width={labelW() - 4}
					/>
				</div>
				<div style={{ ...t("flex items-start"), flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 }}>
					<div style={{ ...t("flex items-start"), flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 }}>
						<Show
							when={c().name === undefined}
							fallback={
								<Field
									nowrap
									value={c().name ?? ""}
									placeholder="Name"
									onEditing={setEditing}
									onSave={(v) => patchAt(i, { name: v })}
								/>
							}
						>
							<Field
								nowrap
								value={c().lastName ?? ""}
								placeholder="Last"
								onEditing={setEditing}
								rootStyle={{ width: "auto", flexGrow: 1.2, flexBasis: 0, minWidth: 40 }}
								onSave={(v) => patchAt(i, { lastName: v })}
							/>
							<text style={{ ...tx("text-[13px] text-muted-foreground"), paddingLeft: 2, paddingRight: 2, paddingTop: 3 }}>
								,
							</text>
							<Field
								nowrap
								value={c().firstName ?? ""}
								placeholder="First"
								onEditing={setEditing}
								rootStyle={{ width: "auto", flexGrow: 1, flexBasis: 0, minWidth: 36 }}
								onSave={(v) => patchAt(i, { firstName: v })}
							/>
						</Show>
					</div>
					<Show when={actions()}>
						<div
							style={{
								...t("flex items-center rounded-md border shadow-sm"),
								position: "absolute",
								right: 0,
								top: 0,
								paddingLeft: 2,
								paddingRight: 2,
								backgroundColor: tok("card"),
								borderColor: tok("border-soft"),
							}}
						>
							<IconBtn
								icon="replace"
								size={13}
								title={c().name !== undefined ? "Switch to two fields" : "Switch to single field"}
								onClick={() => toggleMode(i)}
							/>
							<IconBtn icon="arrow-up" size={13} title="Move up" disabled={i === 0} onClick={() => move(i, -1)} />
							<IconBtn
								icon="arrow-down"
								size={13}
								title="Move down"
								disabled={i === count() - 1}
								onClick={() => move(i, 1)}
							/>
							<IconBtn icon="minus" size={13} title="Remove creator" onClick={() => remove(i)} />
							<IconBtn icon="plus" size={13} title="Add creator" onClick={() => insertAfter(i)} />
						</div>
					</Show>
				</div>
			</div>
		);
	};

	return createMemo(() => {
		const out: Entry[] = [];
		if (count() === 0) {
			out.push(
				entry("c:add", () => (
					<Block>
						<Row label={labelOf(defaultType())}>
							<Show when={!locked()}>
								<TextBtn
									icon="plus"
									label="Add"
									title="Add creator"
									onClick={() => void commit([{ creatorType: defaultType(), lastName: "", firstName: "" }])}
								/>
							</Show>
						</Row>
					</Block>
				)),
			);
		}
		for (let i = 0; i < limit(); i++) out.push(entry(`c:${i}`, () => <Block>{creatorRow(i)}</Block>));
		if (count() > COLLAPSE_AT) {
			out.push(
				entry("c:more", () => (
					<Block>
						<Row label="">
							<div style={{ ...t("flex items-center gap-3 px-1.5") }}>
								<Show when={hidden() > 0}>
									<div role="button" onClick={() => setShown(limit() + PAGE)} style={{ cursor: "pointer" }}>
										<text
											style={{ ...tx("text-xs"), color: tok("primary") }}
										>{`${Math.min(PAGE, hidden())} more… (${hidden()} hidden)`}</text>
									</div>
								</Show>
								<Show when={limit() > SHOW_WHEN_COLLAPSED}>
									<div role="button" onClick={() => setShown(SHOW_WHEN_COLLAPSED)} style={{ cursor: "pointer" }}>
										<text style={{ ...tx("text-xs"), color: tok("primary") }}>Show fewer</text>
									</div>
								</Show>
							</div>
						</Row>
					</Block>
				)),
			);
		}
		return out;
	});
}

// ---- the section ----

/**
 * The Info section as entries of the pane's virtual list (header, item type, every field, the creators, dates): the native list builds
 * only the rows on screen, where one scrolling container would lay out and paint all ~25 rows on every frame.
 * Entries are cached by id, so a structural change (item type, creator count) keeps the rows that stay.
 */
export function useInfoEntries(): () => Entry[] {
	const pane = usePane();
	const data = () => pane.detail()!.data;
	const st = () => pane.schema()?.itemTypes.find((x) => x.itemType === data().itemType);
	const fields = createMemo<ZoteroSchemaField[]>(() => {
		let f = (st()?.fields ?? FALLBACK).filter((x) => !HIDDEN.has(x.field) && x.field !== CITATION_KEY_FIELD); // the Citation Key row is the BBT one
		if (!f.some((x) => x.field === "title")) f = [{ field: "title", label: "Title" }, ...f];
		if (!f.some((x) => x.field === "extra")) f = [...f, { field: "extra", label: "Extra" }];
		return f;
	});
	const fieldDefs = createMemo(() => new Map(fields().map((f) => [f.field, f])));
	const typeOptions = createMemo(() => {
		const list = (pane.schema()?.itemTypes ?? []).filter((x) => !["attachment", "note", "annotation"].includes(x.itemType));
		const opts = list.map((x) => ({ value: x.itemType, label: x.label })).sort((a, b) => a.label.localeCompare(b.label));
		return opts.some((o) => o.value === data().itemType)
			? opts
			: [{ value: data().itemType, label: st()?.label ?? data().itemType }, ...opts];
	});

	const [pending, setPending] = createSignal<{ to: ZoteroSchemaItemType; patch: Record<string, unknown>; lost: string[] } | null>(null);
	createEffect(on(pane.itemKey, () => setPending(null), { defer: true }));
	const changeType = (v: string) => {
		const to = pane.schema()?.itemTypes.find((x) => x.itemType === v);
		if (!to || v === data().itemType) return;
		const plan = planTypeChange(data() as Record<string, unknown>, st(), to);
		if (plan.lost.length) setPending({ to, ...plan });
		else void pane.save(plan.patch);
	};

	const linkUrl = (f: string, v: string) =>
		f === "DOI" ? "https://doi.org/" + encodeURI(v.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")) : v;
	const isLink = (f: string, v: string) => !!v && (f === "DOI" || (f === "url" && /^https?:\/\//i.test(v)));

	const cache = new Map<string, Entry>();
	const entry: MakeEntry = (id, render) => {
		let e = cache.get(id);
		if (!e) {
			e = { id, section: "info", render };
			cache.set(id, e);
		}
		return e;
	};
	const creatorEntries = createCreatorEntries(st, entry);

	const fieldRow = (field: string): JSX.Element => {
		const f = () => fieldDefs().get(field) ?? { field, label: field };
		const v = () => (data()[field] as string | undefined) ?? "";
		return (
			<Block>
				<Row label={f().label} icon={FIELD_ICONS[field]}>
					<Show when={field !== "date"} fallback={<DateParts value={v()} onChange={(nv) => void pane.save({ date: nv })} />}>
						<Field
							value={v()}
							multiline={field === "extra"}
							onSave={(nv) => void pane.save({ [field]: nv })}
							// Duplicate Item / Create Parent Item open the new item's title for editing (focusTitle in ./focus)
							startEditing={field === "title" && titleEditWanted(data().key)}
							onEditing={(e) => {
								if (!e && field === "title") clearTitleEdit(data().key);
							}}
							end={
								<Show when={isLink(field, v())}>
									<div
										role="button"
										aria-label={`Open ${f().label}`}
										onClick={() => void openLink(linkUrl(field, v()))}
										style={{ cursor: "pointer", marginLeft: 4, paddingTop: 2 }}
									>
										<Icon name="external-link" size={14} color={tok("muted-foreground")} />
									</div>
								</Show>
							}
						/>
					</Show>
				</Row>
			</Block>
		);
	};

	const head = entry("head", () => <SectionHead id="info" title="Info" icon="info" first />);
	const itemType = entry("type", () => (
		<Block first>
			<Row label="Item Type">
				<Select
					value={pending()?.to.itemType ?? data().itemType}
					options={typeOptions()}
					onChange={changeType}
					disabled={locked()}
				/>
			</Row>
		</Block>
	));
	const warning = entry("pending", () => (
		<Block>
			<Show when={pending()}>
				{(pd) => (
					<Row label="">
						<div
							style={{
								...t("flex flex-col w-full rounded-md border p-2 gap-1.5"),
								backgroundColor: tok("warning"),
								borderColor: tok("warning-foreground"),
							}}
						>
							<div style={{ ...t("flex items-start gap-1.5") }}>
								<Icon name="triangle-alert" size={14} color={tok("warning-foreground")} />
								<text style={{ ...tx("text-xs"), color: tok("warning-foreground"), flexShrink: 1, minWidth: 0 }}>
									{`Changing to ${pd().to.label} will remove these fields: ${pd().lost.join(", ")}.`}
								</text>
							</div>
							<div style={{ ...t("flex justify-end gap-1.5") }}>
								<TextBtn label="Cancel" onClick={() => setPending(null)} />
								<TextBtn
									primary
									label="Change Item Type"
									onClick={() => {
										const x = pd();
										setPending(null);
										void pane.save(x.patch);
									}}
								/>
							</div>
						</div>
					</Row>
				)}
			</Show>
		</Block>
	));
	const added = entry("added", () => (
		<Block>
			<Row label="Date Added">
				<text style={{ ...tx("text-[13px] text-muted-foreground"), paddingLeft: 6, paddingTop: 2 }}>
					{fmtTimestamp(data().dateAdded)}
				</text>
			</Row>
		</Block>
	));
	const modified = entry("modified", () => (
		<Block last>
			<Row label="Modified">
				<text style={{ ...tx("text-[13px] text-muted-foreground"), paddingLeft: 6, paddingTop: 2 }}>
					{fmtTimestamp(data().dateModified)}
				</text>
			</Row>
		</Block>
	));

	return createMemo(() => {
		if (isCollapsed("info")) return [head];
		const out: Entry[] = [head, itemType, ...pluginInfoEntries("start", data().key)]; // + rows WASM plugins added (wasmplugins/extend/InfoRows.tsx)
		if (pending()) out.push(warning);
		for (const f of fields()) {
			out.push(entry(`f:${f.field}`, () => fieldRow(f.field)));
			if (f.field === "title") {
				out.push(...creatorEntries(), ...pluginInfoEntries("after-creators", data().key));
				out.push(entry("citekey", () => <CitationKeyBlock itemType={data().itemType} />));
			}
		}
		out.push(...pluginInfoEntries("end", data().key), added, modified);
		return out;
	});
}
