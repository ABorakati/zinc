// Annotation drawing for one page, rendered into the viewer's per-page overlay layer (pointer-events none, so text
// selection works through highlights). Clicks on annotations are hit-tested in index.ts; only a selected annotation
// (move/resize) and the active tool's surface take pointer events.
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import type { PdfRect } from "../contract";
import type { Ctx } from "./actions";
import { rectsOnPage, resizeRect } from "./geometry";
import { boundingRect, translatePosition, withRect, type Position } from "./model";

export type ToScreen = (r: PdfRect) => { left: number; top: number; width: number; height: number };
type Handle = "nw" | "ne" | "sw" | "se";
const px = (n: number) => `${n}px`;

export function PageAnnotations(props: { ctx: Ctx; page: number; toScreen: ToScreen }) {
	const { store, ui, act, viewer } = props.ctx;
	const page = props.page;
	const toScreen = props.toScreen;
	const k = toScreen([0, 0, 1, 1]).width; // CSS px per PDF point
	const box = (r: PdfRect) => { const s = toScreen(r); return { left: px(s.left), top: px(s.top), width: px(s.width), height: px(s.height) }; };

	const ids = createMemo(
		() => store.list().filter((a) => a.position.pageIndex === page || (a.position.nextPageRects && a.position.pageIndex + 1 === page)).map((a) => a.id),
		[] as string[],
		{ equals: (x, y) => x.length === y.length && x.every((v, i) => v === y[i]) },
	);
	// move/resize preview; committed on release
	const [drag, setDrag] = createSignal<{ id: string; position: Position } | null>(null);

	function startDrag(id: string, e: PointerEvent, handle?: Handle) {
		const a = store.get(id);
		if (!a || e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		const start = viewer.pagePoint(page, e.clientX, e.clientY);
		const orig = a.position;
		const r0 = orig.rects?.[0];
		const move = (ev: PointerEvent) => {
			const [x, y] = viewer.pagePoint(page, ev.clientX, ev.clientY);
			const position = handle && r0 ? withRect(orig, resizeRect(r0, handle, x, y)) : translatePosition(orig, x - start[0], y - start[1]);
			setDrag({ id, position });
		};
		const up = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			const d = drag();
			setDrag(null);
			if (d) act.reposition(id, d.position);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	}

	function Ann(p: { id: string }) {
		const a = createMemo(() => store.get(p.id));
		const pos = () => { const d = drag(); return d && d.id === p.id ? d.position : a()!.position; };
		const rects = () => rectsOnPage(pos(), page);
		const color = () => a()!.color;
		const selected = () => ui.selectedId() === p.id;
		const bounds = () => {
			const pp = pos();
			return pp.pageIndex === page ? boundingRect(pp) : boundingRect({ pageIndex: page, rects: pp.nextPageRects });
		};
		const outline = () => {
			const b = bounds();
			const s = toScreen([b[0], b[1], b[2], b[3]]);
			return { left: px(s.left - 2), top: px(s.top - 2), width: px(s.width + 4), height: px(s.height + 4) };
		};
		const movable = () => selected() && a()!.position.pageIndex === page && ["note", "image", "text", "ink"].includes(a()!.type);
		const resizable = () => selected() && (a()!.type === "image" || a()!.type === "text") && a()!.position.pageIndex === page;
		const handles: { h: Handle; style: Record<string, string> }[] = [
			{ h: "nw", style: { left: "-5px", top: "-5px", cursor: "nwse-resize" } },
			{ h: "ne", style: { right: "-5px", top: "-5px", cursor: "nesw-resize" } },
			{ h: "sw", style: { left: "-5px", bottom: "-5px", cursor: "nesw-resize" } },
			{ h: "se", style: { right: "-5px", bottom: "-5px", cursor: "nwse-resize" } },
		];
		return (
			<Show when={a()}>
				<div data-ann={p.id} data-ann-type={a()!.type}>
					<Switch>
						<Match when={a()!.type === "highlight"}>
							<For each={rects()}>{(r) => <div class="rn-ann-hl" style={{ ...box(r), background: color() }} />}</For>
						</Match>
						<Match when={a()!.type === "underline"}>
							<For each={rects()}>{(r) => {
								const s = toScreen(r);
								return <div class="rn-ann-ul" style={{ left: px(s.left), top: px(s.top + s.height - 2), width: px(s.width), background: color() }} />;
							}}</For>
						</Match>
						<Match when={a()!.type === "note"}>
							<For each={rects()}>{(r) => (
								<svg class="rn-ann-note" viewBox="0 0 22 22" style={box(r)}>
									<path d="M1.5 1.5h19v13l-6 6h-13z" fill={color()} stroke="rgba(0,0,0,.55)" stroke-width="1" stroke-linejoin="round" />
									<path d="M20.5 14.5h-6v6" fill="rgba(255,255,255,.55)" stroke="rgba(0,0,0,.55)" stroke-width="1" stroke-linejoin="round" />
									<path d="M5 6.5h12M5 10h12M5 13.5h6" stroke="rgba(0,0,0,.5)" stroke-width="1.2" stroke-linecap="round" />
								</svg>
							)}</For>
						</Match>
						<Match when={a()!.type === "image"}>
							<For each={rects()}>{(r) => <div class="rn-ann-area" style={{ ...box(r), "border-color": color() }} />}</For>
						</Match>
						<Match when={a()!.type === "text"}>
							<For each={rects()}>{(r) => (
								<div class="rn-ann-text" style={{ ...box(r), color: color(), "font-size": px((pos().fontSize ?? 12) * k) }}>{a()!.comment}</div>
							)}</For>
						</Match>
						<Match when={a()!.type === "ink"}>
							<svg class="rn-ann-ink" width="1" height="1">
								<For each={pos().paths ?? []}>{(path) => {
									let d = "";
									for (let i = 0; i + 1 < path.length; i += 2) {
										const s = toScreen([path[i]!, path[i + 1]!, path[i]!, path[i + 1]!]);
										d += `${i ? "L" : "M"}${s.left.toFixed(2)} ${s.top.toFixed(2)}`;
									}
									return <path d={d} fill="none" stroke={color()} stroke-width={(pos().width ?? 2) * k} stroke-linecap="round" stroke-linejoin="round" />;
								}}</For>
							</svg>
						</Match>
					</Switch>
					<Show when={selected()}>
						<div class="rn-ann-sel" style={outline()} />
					</Show>
					<Show when={movable()}>
						<div
							class="rn-ann-grip" style={outline()} onPointerDown={(e) => startDrag(p.id, e)}
						>
							<Show when={resizable()}>
								<For each={handles}>{(hd) => <span class="rn-ann-handle" style={hd.style} onPointerDown={(e) => startDrag(p.id, e, hd.h)} />}</For>
							</Show>
						</div>
					</Show>
				</div>
			</Show>
		);
	}

	// ---- tool surface: note (click), area (drag), ink (draw)
	const surfaceTool = () => { const t = ui.tool(); return t === "note" || t === "image" || t === "ink" ? t : null; };
	const [liveRect, setLiveRect] = createSignal<PdfRect | null>(null);
	const [livePath, setLivePath] = createSignal<number[] | null>(null);
	let origin: [number, number] | null = null;

	const onDown = (e: PointerEvent) => {
		const tool = surfaceTool();
		if (!tool || e.button !== 0) return;
		e.preventDefault();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		const [x, y] = viewer.pagePoint(page, e.clientX, e.clientY);
		origin = [x, y];
		if (tool === "note") void act.placeNote(page, x, y, ui.color());
		else if (tool === "image") setLiveRect([x, y, x, y]);
		else setLivePath([x, y]);
	};
	const onMove = (e: PointerEvent) => {
		if (!origin) return;
		const [x, y] = viewer.pagePoint(page, e.clientX, e.clientY);
		if (ui.tool() === "image") setLiveRect([Math.min(origin[0], x), Math.min(origin[1], y), Math.max(origin[0], x), Math.max(origin[1], y)]);
		else if (ui.tool() === "ink") setLivePath((p) => (p ? [...p, x, y] : p));
	};
	const onUp = (e: PointerEvent) => {
		if (!origin) return;
		const o = origin;
		origin = null;
		const [x, y] = viewer.pagePoint(page, e.clientX, e.clientY);
		if (ui.tool() === "image") { setLiveRect(null); void act.addArea(page, o, [x, y], ui.color()); }
		else if (ui.tool() === "ink") { const p = livePath(); setLivePath(null); if (p) void act.addInk(page, [...p, x, y], ui.color()); }
	};

	return (
		<div class="rn-ann-host">
			<For each={ids()}>{(id) => <Ann id={id} />}</For>
			<Show when={liveRect()}>{(r) => <div class="rn-ann-area" style={{ ...box(r()), "border-color": ui.color() }} />}</Show>
			<Show when={livePath()}>{(path) => {
				const d = () => {
					let s = "";
					for (let i = 0; i + 1 < path().length; i += 2) { const q = toScreen([path()[i]!, path()[i + 1]!, path()[i]!, path()[i + 1]!]); s += `${i ? "L" : "M"}${q.left.toFixed(1)} ${q.top.toFixed(1)}`; }
					return s;
				};
				return (
					<svg class="rn-ann-ink" width="1" height="1">
						<path d={d()} fill="none" stroke={ui.color()} stroke-width={2 * k} stroke-linecap="round" stroke-linejoin="round" />
					</svg>
				);
			}}</Show>
			<Show when={surfaceTool()}>
				<div class="rn-ann-surface" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
			</Show>
		</div>
	);
}
