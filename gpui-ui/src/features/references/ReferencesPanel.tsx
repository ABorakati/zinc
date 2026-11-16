// The References panel of an item: its bibliography as resolved by the core (OpenAlex / Crossref / Semantic Scholar / the PDF),
// with a filter, "in library" markers, and per-reference details with Add to library. Embed it with
// <ReferencesPanel itemKey=... onOpenItem=... /> (an item key or an attachment key) or open it as a dialog via openReferences().
import { createEffect, createMemo, createSignal, For, on, Show, type JSX } from "solid-js";
import { Icon } from "../../icons";
import { Button, Checkbox, openDialog, TextInput } from "../../ui";
import { Chip, IconBtn, Line, Para, Scroll, t, tok, Txt } from "../kit";
import { errMsg } from "../text";
import { referencesApi, type Reference, type ReferenceList } from "./api";
import { openLink, ReferenceCard, type ReferenceActions } from "./ReferenceCard";
import { referenceUrl } from "./match";

export type { Reference };

export interface ReferencesPanelProps extends ReferenceActions {
	/** Item key or attachment key of the document (the core resolves attachments to their parent). */
	itemKey: string;
	/** Scroll to and highlight a reference ("show-references" from the reader). Pass a new object each time. */
	focus?: { index: number } | null;
	height?: number | string;
}

const SHOWN = 120;

function matches(r: Reference, q: string) {
	const hay = [r.index, r.title, r.raw, r.authors?.join(" "), r.year, r.venue, r.doi]
		.filter((x) => x != null)
		.join(" ")
		.toLowerCase();
	return q.split(/\s+/).every((tok) => hay.includes(tok));
}

export function ReferencesPanel(props: ReferencesPanelProps): JSX.Element {
	const [list, setList] = createSignal<ReferenceList | undefined>();
	const [loading, setLoading] = createSignal(true);
	const [error, setError] = createSignal("");
	const [filter, setFilter] = createSignal("");
	const [hideInLibrary, setHideInLibrary] = createSignal(false);
	const [open, setOpen] = createSignal<number | null>(null);
	const [limit, setLimit] = createSignal(SHOWN);
	let seq = 0;

	const load = (refresh: boolean) => {
		const my = ++seq;
		setLoading(true);
		setError("");
		referencesApi
			.list(props.itemKey, refresh)
			.then(
				(l) => {
					if (my === seq) setList(l);
				},
				(e) => {
					if (my === seq) setError(errMsg(e));
				},
			)
			.finally(() => {
				if (my === seq) setLoading(false);
			});
	};
	createEffect(
		on(
			() => props.itemKey,
			() => {
				setList(undefined);
				setOpen(null);
				load(false);
			},
		),
	);
	createEffect(
		on(
			() => props.focus,
			(f) => {
				if (f) {
					setFilter("");
					setHideInLibrary(false);
					setLimit(Math.max(SHOWN, f.index + 1));
					setOpen(f.index);
				}
			},
		),
	);

	const all = () => list()?.references ?? [];
	const visible = createMemo(() => {
		const q = filter().trim().toLowerCase();
		return all().filter((r) => (!hideInLibrary() || !r.inLibraryKey) && (!q || matches(r, q)));
	});
	const inLibraryCount = () => all().filter((r) => r.inLibraryKey).length;
	const markInLibrary = (index: number, key: string) =>
		setList((l) => l && { ...l, references: l.references.map((r) => (r.index === index ? { ...r, inLibraryKey: key } : r)) });
	const onAdded = (index: number, key: string) => {
		markInLibrary(index, key);
		props.onAdded?.(index, key);
	};
	const meta = (r: Reference) =>
		[r.authors?.[0] && (r.authors.length > 1 ? `${r.authors[0]} et al.` : r.authors[0]), r.year, r.venue].filter(Boolean).join(" · ");

	return (
		<div style={{ ...t("flex flex-col min-h-0 bg-background"), width: "100%", height: props.height }}>
			<div style={t("flex flex-col gap-2 border-b px-3 py-2")}>
				<div style={t("flex flex-row items-center gap-2")}>
					<Txt class="text-sm font-semibold text-foreground">References</Txt>
					<Show when={list()}>
						<Txt class="text-xs text-muted-foreground">
							{visible().length === all().length ? String(all().length) : `${visible().length} / ${all().length}`}
						</Txt>
						<Chip>{list()!.source}</Chip>
					</Show>
					<div style={{ flexGrow: 1 }} />
					<IconBtn icon="refresh-cw" onClick={() => !loading() && load(true)} />
				</div>
				<TextInput
					value={filter()}
					onInput={(v) => {
						setFilter(v);
						setLimit(SHOWN);
					}}
					placeholder="Filter references"
				/>
				<div style={t("flex flex-row items-center gap-2")}>
					<Checkbox checked={hideInLibrary()} onChange={setHideInLibrary} label="Hide items in library" />
					<div style={{ flexGrow: 1 }} />
					<Show when={list()}>
						<Txt class="text-xs text-muted-foreground">{`${inLibraryCount()} in library`}</Txt>
					</Show>
				</div>
			</div>
			<Scroll style={{ flexGrow: 1, flexShrink: 1 }}>
				<Show
					when={!error()}
					fallback={
						<div style={t("flex flex-col items-center gap-2 px-6 py-10")}>
							<Icon name="circle-alert" size={24} color={tok("destructive")} />
							<Txt class="text-sm font-medium text-foreground">Could not load references</Txt>
							<Para class="text-xs text-muted-foreground" style={{ textAlign: "center" }}>
								{error()}
							</Para>
							<Button size="sm" variant="outline" onClick={() => load(false)}>
								Try again
							</Button>
						</div>
					}
				>
					<Show
						when={list()}
						fallback={
							<div style={t("px-6 py-10")}>
								<Txt class="text-sm text-muted-foreground">{loading() ? "Loading references…" : ""}</Txt>
							</div>
						}
					>
						<For
							each={visible().slice(0, limit())}
							fallback={
								<div style={t("px-6 py-10")}>
									<Txt class="text-sm text-muted-foreground">
										{all().length
											? "No references match the current filter."
											: "No references were found for this item."}
									</Txt>
								</div>
							}
						>
							{(r) => (
								<>
									<div
										style={{
											...t(`flex flex-col border-b ${open() === r.index ? "bg-primary/10" : ""}`),
											flexShrink: 0,
										}}
									>
										<div
											onClick={() => setOpen(open() === r.index ? null : r.index)}
											style={{
												...t(`flex flex-row gap-2 px-3 pt-2 ${open() === r.index ? "" : "hover:bg-accent/60"}`),
												cursor: "pointer",
											}}
										>
											<Txt
												class="text-[11px] text-muted-foreground"
												style={{ width: 24, textAlign: "right", flexShrink: 0 }}
											>
												{String(r.index)}
											</Txt>
											<div style={{ ...t("flex flex-col gap-0.5 pb-1"), flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
												<Para
													class={r.title ? "text-[13px] font-medium text-foreground" : "text-xs text-foreground"}
													style={{ lineClamp: 2 }}
												>
													{r.title ?? r.raw ?? "Untitled reference"}
												</Para>
												<Show when={meta(r)}>
													<Line class="text-[11px] text-muted-foreground">{meta(r)}</Line>
												</Show>
											</div>
										</div>
										<Show when={r.inLibraryKey || r.openAccessUrl || (r.doi && referenceUrl(r))}>
											<div style={{ ...t("flex flex-row flex-wrap items-center gap-1 pb-2"), paddingLeft: 44 }}>
												<Show when={r.inLibraryKey}>
													<div onClick={() => props.onOpenItem?.(r.inLibraryKey!)} style={{ cursor: "pointer" }}>
														<Chip tone="success">In library</Chip>
													</div>
												</Show>
												<Show when={r.openAccessUrl}>
													<div onClick={() => openLink(r.openAccessUrl!)} style={{ cursor: "pointer" }}>
														<Chip tone="warning">Open access</Chip>
													</div>
												</Show>
												<Show when={r.doi && referenceUrl(r)}>
													<div onClick={() => openLink(referenceUrl(r)!)} style={{ cursor: "pointer" }}>
														<Chip>DOI</Chip>
													</div>
												</Show>
											</div>
										</Show>
									</div>
									<Show when={open() === r.index}>
										<ReferenceCard reference={r} onOpenItem={props.onOpenItem} onAdded={onAdded} />
									</Show>
								</>
							)}
						</For>
						<Show when={visible().length > limit()}>
							<div
								onClick={() => setLimit(limit() + SHOWN)}
								style={{
									...t("flex items-center justify-center py-2 hover:bg-accent/60"),
									flexShrink: 0,
									cursor: "pointer",
								}}
							>
								<Txt class="text-xs text-muted-foreground">{`Show more (${limit()} of ${visible().length})`}</Txt>
							</div>
						</Show>
					</Show>
				</Show>
			</Scroll>
		</div>
	);
}

/** The panel in a dialog (used by the item menu's "References…"). */
export function openReferences(itemKey: string, onOpenItem?: (key: string) => void): Promise<void> {
	return openDialog<void>(
		(close) => (
			<ReferencesPanel
				itemKey={itemKey}
				height={560}
				onOpenItem={(k) => {
					close();
					onOpenItem?.(k);
				}}
			/>
		),
		{ title: "References", width: 600 },
	).then(() => undefined);
}
