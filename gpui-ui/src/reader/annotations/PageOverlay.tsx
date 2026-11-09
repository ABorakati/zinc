// Annotation drawing for one page, inside the reader's per-page overlay (sized to the page box). Annotation fills take no pointer
// input (pointerEvents none), so text selection keeps working through highlights; an annotation is selected through a small
// handle at its top-left (or the note icon itself), through the side panel list, or after it is created. The active tool's
// surface (notes) and the popup of the selected annotation do take input.
import { useGpuix } from "@gpuix/solid";
import { createMemo, createSignal, For, Match, Show, Switch, type Accessor, type JSX } from "solid-js";
import type { EventPayload } from "@gpuix/native";
import { Icon } from "../../icons";
import { Button, openMenu } from "../../ui";
import { withAlpha } from "../../theme";
import type { ReaderContext } from "../plugins";
import { kit, clamp, IconButton, Swatches, type Kit } from "../structure/kit";
import type { PdfRect } from "../structure/types";
import { annotationContextMenu } from "./contextMenu";
import { rectsOnPage } from "./geometry";
import { copyAnnotationImage, exportAnnotationImage } from "./imageExport";
import { InkOverlay } from "./ink";
import { boundingRect, COLORS, NOTE_SIZE, type Annotation } from "./model";
import { sessionFor, type Session } from "./session";
import { CommentBox, TagEditor } from "./Widgets";

const POP_W = 300;

function inkSvg(a: Annotation, pw: number, ph: number): string {
	const paths = (a.position.paths ?? []).map((p) => {
		let d = "";
		for (let i = 0; i + 1 < p.length; i += 2) d += `${i ? "L" : "M"}${p[i]!.toFixed(2)} ${(ph - p[i + 1]!).toFixed(2)} `;
		if (p.length === 2) d += `L${p[0]!.toFixed(2)} ${(ph - p[1]! + 0.01).toFixed(2)}`;
		return `<path d="${d}"/>`;
	}).join("");
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${pw} ${ph}" fill="none" stroke="#000" stroke-width="${a.position.width ?? 2}" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

function AnnotationPopup(p: { k: Kit; s: Session; a: Annotation; box: Accessor<{ width: number; height: number }>; sc: Accessor<number>; ph: Accessor<number> }): JSX.Element {
	const { store, act } = p.s;
	const b = () => boundingRect(p.a.position);
	const left = () => clamp((b()[0] + b()[2]) / 2 * p.sc() - POP_W / 2, 4, Math.max(4, p.box().width - POP_W - 4));
	const bottom = () => (p.ph() - b()[1]) * p.sc();
	const top = () => (p.ph() - b()[3]) * p.sc();
	// below the annotation when there is room (about 190 px), else above
	const below = () => bottom() + 8 + 190 < p.box().height || top() < 200;
	return (
		<div
			style={{
				...p.k.t("flex flex-col rounded-lg border bg-popover"), position: "absolute", left: left(), width: POP_W, padding: 8, gap: 6,
				...(below() ? { top: Math.min(bottom() + 8, p.box().height - 120) } : { top: Math.max(4, top() - 8 - 150) }),
				borderColor: p.k.tok("border"),
				boxShadow: [{ offsetX: 0, offsetY: 6, blurRadius: 14, spreadRadius: -2, color: "rgba(0, 0, 0, 0.28)" }],
			}}
		>
			<Show when={!store.readOnly()}>
			<div style={{ display: "flex", flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
			<Swatches k={p.k} colors={COLORS} value={p.a.color} size={16} onPick={(c) => { p.s.ui.setColor(c); store.update(p.a.id, { color: c }); }} />
			<IconButton k={p.k} icon="trash-2" title="Delete" size={14} box={24} onClick={() => act.remove([p.a.id])} />
			</div>
			</Show>
			<Show when={p.a.text}>
				<div style={{ ...p.k.t("flex border-l-2 pl-2"), borderColor: p.a.color }}>
					<text style={{ ...p.k.tx("text-[11.5px] text-muted-foreground"), lineClamp: 3 }}>{p.a.text}</text>
				</div>
			</Show>
			<Show when={p.a.type === "image"}>
				<div style={{ display: "flex", flexDirection: "row", gap: 6, marginTop: 2 }}>
					<Button size="sm" variant="outline" icon="copy" onClick={() => void copyAnnotationImage(p.s.ctx, p.a, p.s.ui.notify)}>
						Copy Image
					</Button>
					<Button size="sm" variant="outline" icon="download" onClick={() => void exportAnnotationImage(p.s.ctx, p.a, undefined, p.s.ui.notify)}>
						Export Image…
					</Button>
				</div>
			</Show>
			<CommentBox k={p.k} s={p.s} id={p.a.id} rows={2} />
			<TagEditor k={p.k} s={p.s} id={p.a.id} />
		</div>
	);
}

export function PageAnnotations(p: { ctx: ReaderContext; page: number; box: Accessor<{ width: number; height: number }> }): JSX.Element {
	const s = sessionFor(p.ctx);
	const k = kit(p.ctx.mode);
	const gpuix = useGpuix();
	const page = p.page;
	const size = () => p.ctx.pageSize(page);
	const sc = () => p.box().width / size().w; // px per PDF point
	const ph = () => size().h;
	const ids = createMemo(
		() => s.store.list().filter((a) => a.position.pageIndex === page || (a.position.nextPageRects && a.position.pageIndex + 1 === page)).map((a) => a.id),
		[] as string[],
		{ equals: (x, y) => x.length === y.length && x.every((v, i) => v === y[i]) },
	);
	const box = (r: PdfRect) => ({ left: r[0] * sc(), top: (ph() - r[3]) * sc(), width: (r[2] - r[0]) * sc(), height: (r[3] - r[1]) * sc() });
	const selected = createMemo(() => { const id = s.ui.selectedId(); return id ? s.store.get(id) : undefined; });
	const selectedHere = () => { const a = selected(); return a && a.position.pageIndex === page ? a : undefined; };

	let catcher: { id: number } | undefined;
	function onCatch(e: { x?: number; y?: number }) {
		const b = catcher ? gpuix?.renderer.getElementBounds?.(catcher.id) : null;
		if (!b || e.x === undefined || e.y === undefined) return;
		const xn = clamp((e.x - b.x) / b.width, 0, 1), yn = clamp((e.y - b.y) / b.height, 0, 1);
		void s.act.placeNote(page, xn, yn, s.ui.color());
		s.ui.setTool(null);
	}

	function Ann(q: { id: string }): JSX.Element {
		const a = createMemo(() => s.store.get(q.id));
		const rects = () => (a() ? rectsOnPage(a()!.position, page) : []);
		const color = () => a()?.color ?? "#ffd400";
		const isSel = () => s.ui.selectedId() === q.id;
		const own = () => a()?.position.pageIndex === page;
		const bounds = () => {
			const pos = a()!.position;
			return pos.pageIndex === page ? boundingRect(pos) : boundingRect({ pageIndex: page, rects: pos.nextPageRects });
		};
		const handle = () => {
			const r = box(bounds());
			return { left: Math.max(0, r.left - 13), top: r.top + Math.min(2, r.height / 4) };
		};
		const toggle = () => s.ui.select(isSel() ? null : q.id);
		return (
			<Show when={a()}>
				<Switch>
					<Match when={a()!.type === "highlight"}>
						<For each={rects()}>
							{(r) => <div style={{ position: "absolute", ...box(r), backgroundColor: withAlpha(color(), 0.4), borderRadius: 2, pointerEvents: "none" }} />}
						</For>
					</Match>
					<Match when={a()!.type === "underline"}>
						<For each={rects()}>
							{(r) => <div style={{ position: "absolute", left: box(r).left, top: box(r).top + box(r).height - 2, width: box(r).width, height: 2, backgroundColor: color(), pointerEvents: "none" }} />}
						</For>
					</Match>
					<Match when={a()!.type === "note"}>
						<div
							onClick={toggle}
							style={{
								position: "absolute", ...box(a()!.position.rects![0]!), cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
								backgroundColor: color(), borderRadius: 4, borderWidth: 1, borderColor: "rgba(0, 0, 0, 0.35)",
							}}
						>
							<Icon name="message-square-text" size={Math.max(8, NOTE_SIZE * sc() * 0.62)} color="rgba(0, 0, 0, 0.7)" />
						</div>
					</Match>
					<Match when={a()!.type === "image" || a()!.type === "text"}>
						<For each={rects()}>
							{(r) => (
								<div
									onClick={toggle}
									onAuxClick={(e: EventPayload) => {
										if (e.isRightClick || e.button === 2) {
											openMenu({ x: e.x ?? 0, y: e.y ?? 0 }, () => annotationContextMenu(p.ctx, a()!));
										}
									}}
									style={{ position: "absolute", ...box(r), borderWidth: 2, borderColor: color(), borderStyle: "dashed", borderRadius: 2, pointerEvents: "auto", cursor: "pointer" }}
								/>
							)}
						</For>
					</Match>
					<Match when={a()!.type === "ink"}>
						<svg source={inkSvg(a()!, size().w, ph())} style={{ position: "absolute", left: 0, top: 0, width: p.box().width, height: p.box().height, color: color(), pointerEvents: "none" }} />
					</Match>
				</Switch>
				<Show when={isSel() && own()}>
					<div style={{ position: "absolute", ...box(bounds()), left: box(bounds()).left - 2, top: box(bounds()).top - 2, width: box(bounds()).width + 4, height: box(bounds()).height + 4, borderWidth: 1.5, borderColor: k.tok("ring"), borderRadius: 3, pointerEvents: "none" }} />
				</Show>
				<Show when={own() && a()!.type !== "note"}>
					<div
						onClick={toggle}
						onAuxClick={(e: EventPayload) => {
							if (e.isRightClick || e.button === 2) {
								openMenu({ x: e.x ?? 0, y: e.y ?? 0 }, () => annotationContextMenu(p.ctx, a()!));
							}
						}}
						style={{
							position: "absolute", ...handle(), width: 10, height: 10, borderRadius: 5, backgroundColor: color(), cursor: "pointer",
							borderWidth: isSel() ? 2 : 1, borderColor: isSel() ? k.tok("foreground") : "rgba(0, 0, 0, 0.3)", opacity: isSel() ? 1 : 0.85,
						}}
					/>
				</Show>
			</Show>
		);
	}

	return (
		<div style={{ position: "absolute", left: 0, top: 0, width: p.box().width, height: p.box().height, pointerEvents: "none" }}>
			<For each={ids()}>{(id) => <Ann id={id} />}</For>
			<Show when={s.ui.tool() === "note"}>
				<div
					ref={(el: { id: number }) => { catcher = el; }}
					onClick={onCatch}
					style={{ position: "absolute", left: 0, top: 0, width: p.box().width, height: p.box().height, cursor: "crosshair", pointerEvents: "auto" }}
				/>
			</Show>
			<Show when={s.ui.tool() === "ink" || s.ui.tool() === "eraser"}>
				<InkOverlay ctx={p.ctx} page={page} box={p.box} sc={sc} ph={ph} s={s} />
			</Show>
			<Show when={selectedHere()}>
				{(a) => <AnnotationPopup k={k} s={s} a={a()} box={p.box} sc={sc} ph={ph} />}
			</Show>
		</div>
	);
}
