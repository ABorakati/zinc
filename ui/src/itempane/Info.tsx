import { createMemo, createSignal, For, Index, Show, type Component } from "solid-js";
import { AlertTriangle, ArrowDown, ArrowUp, ExternalLink, Info, Minus, Plus, Replace } from "lucide-solid";
import { DateParts } from "~/components/DateParts";
import type { Creator } from "../api";
import { fail } from "~/lib/actions";
import { ipApi, type ZoteroSchemaField, type ZoteroSchemaItemType } from "./api";
import { fmtTimestamp, usePane } from "./ctx";
import { Editable, IconBtn, NativeSelect, Row, Section, TextBtn } from "./ui";

const HIDDEN = new Set(["abstractNote", "dateAdded", "dateModified", "accessDate_", "itemType", "creators"]);
const FALLBACK: ZoteroSchemaField[] = [
	{ field: "title", label: "Title" },
	{ field: "publicationTitle", label: "Publication" },
	{ field: "date", label: "Date" },
	{ field: "DOI", label: "DOI" },
	{ field: "url", label: "URL" },
	{ field: "extra", label: "Extra" },
];

const COLLAPSE_AT = 10;
const SHOW_WHEN_COLLAPSED = 5;

/** Work out how to move to another item type: fields to rewrite/clear and the labels of those that will be lost. */
function planTypeChange(
	data: Record<string, unknown>,
	from: ZoteroSchemaItemType | undefined,
	to: ZoteroSchemaItemType,
): { patch: Record<string, unknown>; lost: string[] } {
	// Core converts like Zotero: a field survives if the new type has the same name or the same baseField.
	const lost: string[] = [];
	for (const f of from?.fields ?? []) {
		const v = data[f.field];
		if (typeof v !== "string" || !v) continue;
		const kept = to.fields.some(
			(n) => n.field === f.field || (!!f.baseField && (n.field === f.baseField || n.baseField === f.baseField)) || n.baseField === f.field,
		);
		if (!kept) lost.push(f.label);
	}
	return { patch: { itemType: to.itemType }, lost };
}

const CreatorRows: Component<{ st: () => ZoteroSchemaItemType | undefined }> = (p) => {
	const { d, save } = usePane();
	const [expanded, setExpanded] = createSignal(false);
	const creators = () => (d.data.creators ?? []) as Creator[];
	const typeOpts = () => (p.st()?.creatorTypes ?? [{ creatorType: "author", label: "Author", primary: true }]).map((c) => ({ value: c.creatorType, label: c.label }));
	const defaultType = () => p.st()?.creatorTypes.find((c) => c.primary)?.creatorType ?? "author";
	const labelOf = (t: string) => typeOpts().find((o) => o.value === t)?.label ?? t;
	const collapsed = () => creators().length > COLLAPSE_AT && !expanded();
	const visibleCount = () => (collapsed() ? SHOW_WHEN_COLLAPSED : creators().length);

	const commit = (list: Creator[]) => save({ creators: list });
	const patchAt = (i: number, patch: Partial<Creator>) =>
		commit(creators().map((c, j) => (j === i ? { ...c, ...patch } : { ...c })));
	const insertAfter = (i: number) => {
		const list = creators().map((c) => ({ ...c }));
		const t = list[i]?.creatorType ?? defaultType();
		list.splice(i + 1, 0, { creatorType: t, lastName: "", firstName: "" });
		commit(list);
	};
	const remove = (i: number) => commit(creators().filter((_, j) => j !== i).map((c) => ({ ...c })));
	const move = (i: number, dir: -1 | 1) => {
		const list = creators().map((c) => ({ ...c }));
		const j = i + dir;
		if (j < 0 || j >= list.length) return;
		[list[i], list[j]] = [list[j], list[i]];
		commit(list);
	};
	const toggleMode = (i: number) => {
		const c = creators()[i];
		let next: Creator;
		if (c.name !== undefined) {
			const parts = c.name.trim().split(/\s+/).filter(Boolean);
			const last = parts.pop() ?? "";
			next = { creatorType: c.creatorType, lastName: last, firstName: parts.join(" ") };
		} else {
			next = { creatorType: c.creatorType, name: [c.firstName, c.lastName].filter(Boolean).join(" ") };
		}
		commit(creators().map((x, j) => (j === i ? next : { ...x })));
	};

	return (
		<>
			<Show when={creators().length === 0}>
				<Row label={labelOf(defaultType())}>
					<TextBtn onClick={() => commit([{ creatorType: defaultType(), lastName: "", firstName: "" }])} title="Add creator">
						<Plus /> Add
					</TextBtn>
				</Row>
			</Show>
			<Index each={creators().slice(0, visibleCount())}>
				{(c, i) => (
					<div class="group/row grid grid-cols-[var(--ip-label)_minmax(0,1fr)] items-start gap-x-3 py-[2px]" data-creator={i}>
						<div class="flex justify-start pt-[1px]">
							<NativeSelect
								ariaLabel={`Creator type ${i + 1}`}
								class="bg-transparent px-0 text-xs text-muted-foreground"
								value={c().creatorType}
								options={typeOpts().some((o) => o.value === c().creatorType) ? typeOpts() : [...typeOpts(), { value: c().creatorType, label: c().creatorType }]}
								onChange={(v) => patchAt(i, { creatorType: v })}
							/>
						</div>
						{/* When the pane is too narrow for names + buttons, the buttons wrap to their own line (right-aligned)
						    instead of squeezing the names to nothing. */}
						<div class="flex min-w-0 flex-wrap items-start gap-x-0.5 gap-y-0.5">
							{/* Names stay on one line and truncate (full value on hover / when editing). */}
							<div class="flex min-w-[6.5rem] flex-1 items-start">
								<Show
									when={c().name === undefined}
									fallback={
										<Editable ariaLabel={`Creator ${i + 1} name`} class="truncate whitespace-nowrap" value={c().name ?? ""} placeholder="Name" onSave={(v) => patchAt(i, { name: v })} />
									}
								>
									<Editable ariaLabel={`Creator ${i + 1} last name`} class="min-w-[4rem] flex-[1.2] truncate whitespace-nowrap" value={c().lastName ?? ""} placeholder="Last" onSave={(v) => patchAt(i, { lastName: v })} />
									<span class="px-0.5 pt-[3px] text-muted-foreground">,</span>
									<Editable ariaLabel={`Creator ${i + 1} first name`} class="min-w-[3rem] flex-1 truncate whitespace-nowrap" value={c().firstName ?? ""} placeholder="First" onSave={(v) => patchAt(i, { firstName: v })} />
								</Show>
							</div>
							{/* Always-visible actions in their own strip (never over the names). */}
							<div class="ml-auto flex flex-none items-center pt-[2px]">
								<IconBtn title={c().name !== undefined ? "Switch to two fields" : "Switch to single field"} onClick={() => toggleMode(i)}><Replace /></IconBtn>
								<IconBtn title="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp /></IconBtn>
								<IconBtn title="Move down" disabled={i === creators().length - 1} onClick={() => move(i, 1)}><ArrowDown /></IconBtn>
								<IconBtn title="Remove creator" onClick={() => remove(i)}><Minus /></IconBtn>
								<IconBtn title="Add creator" onClick={() => insertAfter(i)}><Plus /></IconBtn>
							</div>
						</div>
					</div>
				)}
			</Index>
			<Show when={creators().length > COLLAPSE_AT}>
				<Row label="">
					<button type="button" class="px-1.5 text-xs text-primary hover:underline" onClick={() => setExpanded(!expanded())}>
						{collapsed() ? `${creators().length - SHOW_WHEN_COLLAPSED} more… (et al.)` : "Show fewer"}
					</button>
				</Row>
			</Show>
		</>
	);
};

export const InfoSection: Component = () => {
	const { d, save, schema } = usePane();
	const st = () => schema()?.itemTypes.find((t) => t.itemType === d.data.itemType);
	const fields = createMemo<ZoteroSchemaField[]>(() => {
		let f = (st()?.fields ?? FALLBACK).filter((x) => !HIDDEN.has(x.field));
		if (!f.some((x) => x.field === "title")) f = [{ field: "title", label: "Title" }, ...f];
		if (!f.some((x) => x.field === "extra")) f = [...f, { field: "extra", label: "Extra" }];
		return f;
	});
	const typeOptions = createMemo(() => {
		const list = (schema()?.itemTypes ?? []).filter((t) => t.itemType !== "attachment" && t.itemType !== "note" && t.itemType !== "annotation");
		const opts = list.map((t) => ({ value: t.itemType, label: t.label })).sort((a, b) => a.label.localeCompare(b.label));
		return opts.some((o) => o.value === d.data.itemType) ? opts : [{ value: d.data.itemType, label: st()?.label ?? d.data.itemType }, ...opts];
	});

	const [pending, setPending] = createSignal<{ to: ZoteroSchemaItemType; patch: Record<string, unknown>; lost: string[] } | null>(null);
	const changeType = (v: string) => {
		const to = schema()?.itemTypes.find((t) => t.itemType === v);
		if (!to || v === d.data.itemType) return;
		const plan = planTypeChange(d.data as Record<string, unknown>, st(), to);
		if (plan.lost.length) setPending({ to, ...plan });
		else void save(plan.patch);
	};

	const url = (f: string, v: string) => (f === "DOI" ? "https://doi.org/" + encodeURI(v.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")) : v);
	const openLink = async (f: string, v: string) => {
		try { await ipApi.openUrl(url(f, v)); } catch (e) { fail("Could not open link", e); }
	};
	const isLink = (f: string, v: string) => !!v && (f === "DOI" || (f === "url" && /^https?:\/\//i.test(v)));

	return (
		<Section id="info" title="Info" icon={Info}>
			<div class="flex flex-col gap-px">
				<Row label="Item Type" id="itemType">
					<NativeSelect
						ariaLabel="Item type"
						value={pending()?.to.itemType ?? d.data.itemType}
						options={typeOptions()}
						onChange={changeType}
						class="font-medium"
					/>
				</Row>
				<Show when={pending()}>
					{(pd) => (
						<Row label="">
							<div class="my-0.5 rounded-md border border-warning-foreground/30 bg-warning p-2 text-xs text-warning-foreground" role="alert">
								<div class="flex items-start gap-1.5">
									<AlertTriangle class="mt-px size-3.5 flex-none" />
									<div>
										Changing to <b>{pd().to.label}</b> will remove these fields: <b>{pd().lost.join(", ")}</b>.
									</div>
								</div>
								<div class="mt-1.5 flex justify-end gap-1.5">
									<TextBtn onClick={() => setPending(null)}>Cancel</TextBtn>
									<TextBtn primary onClick={() => { const p = pd(); setPending(null); void save(p.patch); }}>Change Item Type</TextBtn>
								</div>
							</div>
						</Row>
					)}
				</Show>
				<For each={fields()}>
					{(f) => (
						<>
							<Row label={f.label} id={f.field}>
								{(() => {
									const v = () => (d.data[f.field] as string | undefined) ?? "";
									return (
										<Show when={f.field !== "date"} fallback={
											<DateParts ariaLabel={f.label} value={v()} onChange={(nv) => save({ date: nv })} />
										}>
											<Editable
												ariaLabel={f.label}
												value={v()}
												multiline={f.field === "extra"}
												onSave={(nv) => save({ [f.field]: nv })}
												end={
													<Show when={isLink(f.field, v())}>
														<button
															type="button"
															class="ml-1 inline-flex translate-y-[2px] text-muted-foreground hover:text-primary"
															title={`Open ${f.label}`}
															onClick={(e) => { e.stopPropagation(); void openLink(f.field, v()); }}
														>
															<ExternalLink class="size-3.5" />
														</button>
													</Show>
												}
											/>
										</Show>
									);
								})()}
							</Row>
							<Show when={f.field === "title"}>
								<CreatorRows st={st} />
							</Show>
						</>
					)}
				</For>
				<Row label="Date Added" id="dateAdded"><div class="px-1.5 py-[2px] text-muted-foreground">{fmtTimestamp(d.data.dateAdded)}</div></Row>
				<Row label="Modified" id="dateModified"><div class="px-1.5 py-[2px] text-muted-foreground">{fmtTimestamp(d.data.dateModified)}</div></Row>
			</div>
		</Section>
	);
};
