// "Annotations" side panel: all annotations in document order, search, colour/tag filters, inline comments, click to jump,
// delete, and "Add note from annotations" (reader-next/src/annotations/Panel.tsx).
import { createMemo, createSignal, For, Show, type Accessor, type JSX } from "solid-js";
import type { HostElement } from "@gpuix/solid";
import type { EventPayload } from "@gpuix/native";
import { Icon } from "../../icons";
import { Button, openMenu, type MenuItem } from "../../ui";
import { boundsOf } from "../../ui/core";
import type { ReaderContext } from "../plugins";
import { Field, kit } from "../structure/kit";
import { annotationContextMenu } from "./contextMenu";
import { copyAnnotationImage, exportAnnotationImage } from "./imageExport";
import { COLORS, matchesFilter, type Annotation } from "./model";
import { sessionFor } from "./session";
import { CommentBox, TYPE_ICON } from "./Widgets";

function stop(e: unknown) {
	if (e && typeof e === "object" && "stopPropagation" in e && typeof e.stopPropagation === "function") {
		e.stopPropagation();
	}
}

function Item(p: { ctx: ReaderContext; id: string }): JSX.Element {
	const s = sessionFor(p.ctx);
	const k = kit(p.ctx.mode);
	const a = createMemo<Annotation | undefined>(() => s.store.get(p.id));
	const selected = () => s.ui.selectedId() === p.id;
	return (
		<Show when={a()}>
			<div
				onClick={() => s.act.jump(a()!)}
				onAuxClick={(e: EventPayload) => {
					if (e.isRightClick || e.button === 2) {
						openMenu({ x: e.x ?? 0, y: e.y ?? 0 }, () => annotationContextMenu(p.ctx, a()!));
					}
				}}
				style={{
					...k.t("flex flex-col border-b"), position: "relative", paddingTop: 8, paddingBottom: 8, paddingLeft: 14, paddingRight: 8, gap: 5, cursor: "pointer",
					backgroundColor: selected() ? k.tok("accent") : "transparent", hover: k.t("bg-accent/60"),
				}}
			>
				<div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 4, backgroundColor: a()!.color }} />
				<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 6 }}>
					<Icon name={TYPE_ICON[a()!.type] ?? "highlighter"} size={13} color={k.tok("muted-foreground")} />
					<text style={{ ...k.tx("text-[11px] text-muted-foreground"), whiteSpace: "nowrap" }}>{`Page ${a()!.pageLabel || a()!.position.pageIndex + 1}`}</text>
					<div style={{ flexGrow: 1 }} />
					<div onClick={(e) => { stop(e); s.act.remove([p.id]); }} style={{ cursor: "pointer", display: "flex" }}>
						<Icon name="trash-2" size={13} color={k.tok("muted-foreground")} />
					</div>
				</div>
				<Show when={a()!.text}>
					<div style={{ ...k.t("flex border-l-2 pl-2"), borderColor: a()!.color }}>
						<text style={{ ...k.tx("text-[12.5px] text-foreground"), lineClamp: 6 }}>{a()!.text}</text>
					</div>
				</Show>
				<Show when={a()!.type === "image"}>
					<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 6 }}>
						<text style={k.tx("text-[12px] text-muted-foreground")}>Image area</text>
						<div style={{ flexGrow: 1 }} />
						<div
							onClick={(e) => { stop(e); void copyAnnotationImage(p.ctx, a()!, s.ui.notify); }}
							style={{ cursor: "pointer", display: "flex", padding: 2 }}
						>
							<Icon name="copy" size={13} color={k.tok("muted-foreground")} />
						</div>
						<div
							onClick={(e) => { stop(e); void exportAnnotationImage(p.ctx, a()!, undefined, s.ui.notify); }}
							style={{ cursor: "pointer", display: "flex", padding: 2 }}
						>
							<Icon name="download" size={13} color={k.tok("muted-foreground")} />
						</div>
					</div>
				</Show>
				<Show when={a()!.type === "ink"}>
					<text style={{ ...k.tx("text-[12px] text-muted-foreground"), opacity: 0.85 }}>Ink drawing</text>
				</Show>
				<div onClick={stop}>
					<CommentBox k={k} s={s} id={p.id} />
				</div>
				<Show when={(a()!.tags ?? []).length}>
					<div style={{ display: "flex", flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
						<For each={a()!.tags}>
							{(t) => (
								<div style={{ ...k.t("flex items-center rounded bg-accent px-1.5"), height: 18 }}>
									<text style={{ ...k.tx("text-[11px] text-foreground"), whiteSpace: "nowrap" }}>{t.name}</text>
								</div>
							)}
						</For>
					</div>
				</Show>
			</div>
		</Show>
	);
}

export interface AnnotationsFilterState {
	query?: Accessor<string>;
	setQuery?: (q: string) => void;
	colors?: Accessor<string[]>;
	setColors?: (c: string[]) => void;
	tag?: Accessor<string>;
	setTag?: (t: string) => void;
}

export function AnnotationsPanel(p: { ctx: ReaderContext; filter?: AnnotationsFilterState }): JSX.Element {
	const s = sessionFor(p.ctx);
	const k = kit(p.ctx.mode);
	const [localQuery, setLocalQuery] = createSignal("");
	const [localColors, setLocalColors] = createSignal<string[]>([]);
	const [localTag, setLocalTag] = createSignal("");
	const query = () => p.filter?.query ? p.filter.query() : localQuery();
	const setQuery = (q: string) => (p.filter?.setQuery ? p.filter.setQuery(q) : setLocalQuery(q));
	const colors = () => p.filter?.colors ? p.filter.colors() : localColors();
	const setColors = (valOrUpdater: string[] | ((prev: string[]) => string[])) => {
		const next = typeof valOrUpdater === "function" ? valOrUpdater(colors()) : valOrUpdater;
		if (p.filter?.setColors) p.filter.setColors(next);
		else setLocalColors(next);
	};
	const tag = () => p.filter?.tag ? p.filter.tag() : localTag();
	const setTag = (t: string) => (p.filter?.setTag ? p.filter.setTag(t) : setLocalTag(t));
	const allTags = createMemo(() => [...new Set(s.store.list().flatMap((a) => (a.tags ?? []).map((t) => t.name)))].sort((x, y) => x.localeCompare(y)));
	const usedColors = createMemo(() => COLORS.filter((c) => s.store.list().some((a) => a.color === c.value)));
	const shown = createMemo(
		() => s.store.list().filter((a) => matchesFilter(a, { query: query(), colors: colors(), tag: tag() })).map((a) => a.id),
		[] as string[],
		{ equals: (x, y) => x.length === y.length && x.every((v, i) => v === y[i]) },
	);
	const toggle = (c: string) => setColors((cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]));
	const filtered = () => !!(query().trim() || colors().length || tag());
	const total = () => s.store.list().length;
	const count = () => (filtered() ? `${shown().length} of ${total()}` : `${total()} annotation${total() === 1 ? "" : "s"}`);
	const status = () => (s.store.status() === "saved" ? "Saved" : s.store.status() === "saving" ? "Saving..." : "Not saved, retrying");
	let tagBtnEl: HostElement | undefined;
	const openTagPicker = (e: EventPayload) => {
		const b = boundsOf(tagBtnEl);
		const items: MenuItem[] = [
			{
				label: "All tags",
				checked: !tag(),
				onSelect: () => setTag(""),
			},
			{ separator: true },
			...allTags().map((t) => ({
				label: t,
				checked: tag() === t,
				onSelect: () => setTag(t),
			})),
		];
		openMenu(b ? { rect: b } : { x: e.x ?? 0, y: e.y ?? 0 }, items, { minWidth: 140 });
	};
	return (
		<div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", minHeight: 0 }}>
			<div style={{ ...k.t("flex flex-none flex-col border-b"), padding: 8, gap: 8 }}>
				<Field k={k} icon="search" value={query()} placeholder="Search annotations and comments" onInput={setQuery} />
				<Show when={usedColors().length > 0 || allTags().length > 0}>
					<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
						<For each={usedColors()}>
							{(c) => {
								const isPicked = () => colors().includes(c.value);
								return (
									<div
										onClick={() => toggle(c.value)}
										style={{
											width: 18, height: 18, borderRadius: 9, flexShrink: 0, backgroundColor: c.value, cursor: "pointer",
											borderWidth: isPicked() ? 2 : 1,
											borderColor: isPicked() ? k.tok("foreground") : "rgba(0, 0, 0, 0.2)",
											opacity: colors().length > 0 && !isPicked() ? 0.35 : 1,
										}}
									/>
								);
							}}
						</For>
						<div style={{ flexGrow: 1 }} />
						<Show when={allTags().length > 0}>
							<div
								ref={(el) => { tagBtnEl = el; }}
								onClick={openTagPicker}
								style={{
									...k.t("flex items-center rounded border bg-background px-2"),
									height: 22, maxWidth: 130, borderColor: tag() ? k.tok("primary") : k.tok("input"), cursor: "pointer", gap: 4,
								}}
							>
								<Icon name="tag" size={11} color={tag() ? k.tok("primary") : k.tok("muted-foreground")} />
								<text style={{ ...k.tx("text-[11px]"), color: tag() ? k.tok("primary") : k.tok("muted-foreground"), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
									{tag() ? tag() : "All tags"}
								</text>
								<Icon name="chevron-down" size={10} color={k.tok("muted-foreground")} />
							</div>
						</Show>
					</div>
				</Show>
				<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 8 }}>
					<text style={{ ...k.tx("text-[11px] text-muted-foreground"), whiteSpace: "nowrap" }}>{count()}</text>
					<Show when={filtered()}>
						<div onClick={() => { setQuery(""); setColors([]); setTag(""); }} style={{ cursor: "pointer" }}>
							<text style={{ ...k.tx("text-[11px] text-foreground"), textDecoration: "underline" }}>Clear</text>
						</div>
					</Show>
					<div style={{ flexGrow: 1 }} />
					<text style={{ ...k.tx(`text-[11px] ${s.store.status() === "error" ? "text-destructive" : "text-muted-foreground"}`), whiteSpace: "nowrap" }}>{status()}</text>
				</div>
				<Button
					variant="outline" size="sm" icon="file-plus" disabled={!p.ctx.itemKey || total() === 0}
					onClick={() => void s.act.noteFromAnnotations(s.store.list().filter((a) => shown().includes(a.id)))}
					style={{ width: "100%", justifyContent: "flex-start" }}
				>
					{filtered() ? "Add note from annotations (filtered)" : "Add note from annotations"}
				</Button>
				<Show when={s.ui.message()}>
					<text style={k.tx("text-[11.5px] text-muted-foreground")}>{s.ui.message() ?? ""}</text>
				</Show>
			</div>
			<Show
				when={total() > 0}
				fallback={
					<div style={{ padding: 16 }}>
						<text style={k.tx("text-[12px] text-muted-foreground")}>
							{s.store.loaded() ? "No annotations yet. Select text to highlight it, or use the note tool in the toolbar." : "Loading annotations..."}
						</text>
					</div>
				}
			>
				<Show when={shown().length > 0} fallback={<div style={{ padding: 16 }}><text style={k.tx("text-[12px] text-muted-foreground")}>No annotations match.</text></div>}>
					<virtual-list estimatedItemHeight={96} overdraw={300} style={{ width: "100%", flexGrow: 1, minHeight: 0 }}>
						<For each={shown()}>{(id) => <Item ctx={p.ctx} id={id} />}</For>
					</virtual-list>
				</Show>
			</Show>
		</div>
	);
}

