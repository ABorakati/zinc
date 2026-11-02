// "Annotations" side panel: all annotations in document order, search, colour/tag filters, inline comments, click to jump,
// delete, and "Add note from annotations" (reader-next/src/annotations/Panel.tsx).
import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { Icon } from "../../icons";
import { Button } from "../../ui";
import type { ReaderContext } from "../plugins";
import { Field, Swatches, kit } from "../structure/kit";
import { COLORS, matchesFilter, type Annotation } from "./model";
import { sessionFor } from "./session";
import { CommentBox, TYPE_ICON } from "./Widgets";

function Item(p: { ctx: ReaderContext; id: string }): JSX.Element {
	const s = sessionFor(p.ctx);
	const k = kit(p.ctx.mode);
	const a = createMemo<Annotation | undefined>(() => s.store.get(p.id));
	const selected = () => s.ui.selectedId() === p.id;
	return (
		<Show when={a()}>
			<div
				onClick={() => s.act.jump(a()!)}
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
					<div onClick={(e) => { (e as { stopPropagation?: () => void }).stopPropagation?.(); s.act.remove([p.id]); }} style={{ cursor: "pointer", display: "flex" }}>
						<Icon name="trash-2" size={13} color={k.tok("muted-foreground")} />
					</div>
				</div>
				<Show when={a()!.text}>
					<div style={{ ...k.t("flex border-l-2 pl-2"), borderColor: a()!.color }}>
						<text style={{ ...k.tx("text-[12.5px] text-foreground"), lineClamp: 6 }}>{a()!.text}</text>
					</div>
				</Show>
				<Show when={a()!.type === "image"}>
					<text style={k.tx("text-[12px] text-muted-foreground")}>Image area</text>
				</Show>
				<Show when={a()!.type === "ink"}>
					<text style={{ ...k.tx("text-[12px] text-muted-foreground"), opacity: 0.85 }}>Ink drawing</text>
				</Show>
				<div onClick={(e) => (e as { stopPropagation?: () => void }).stopPropagation?.()}>
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

export function AnnotationsPanel(p: { ctx: ReaderContext }): JSX.Element {
	const s = sessionFor(p.ctx);
	const k = kit(p.ctx.mode);
	const [query, setQuery] = createSignal("");
	const [colors, setColors] = createSignal<string[]>([]);
	const [tag, setTag] = createSignal("");
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
	const cycleTag = () => {
		const tags = allTags();
		const i = tags.indexOf(tag());
		setTag(i + 1 < tags.length ? tags[i + 1]! : i === -1 && tags.length ? tags[0]! : "");
	};
	return (
		<div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", minHeight: 0 }}>
			<div style={{ ...k.t("flex flex-none flex-col border-b"), padding: 8, gap: 8 }}>
				<Field k={k} icon="search" value={query()} placeholder="Search annotations" onInput={setQuery} />
				<Show when={usedColors().length > 1 || allTags().length > 0}>
					<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 6 }}>
						<Swatches k={k} colors={usedColors()} size={16} dim={colors().length > 0} value={undefined} onPick={toggle} />
						<div style={{ flexGrow: 1 }} />
						<Show when={allTags().length > 0}>
							<div onClick={cycleTag} style={{ ...k.t("flex items-center rounded border px-1.5"), height: 22, borderColor: k.tok("input"), cursor: "pointer" }}>
								<text style={{ ...k.tx("text-[11px] text-muted-foreground"), whiteSpace: "nowrap" }}>{tag() ? `Tag: ${tag()}` : "All tags"}</text>
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

