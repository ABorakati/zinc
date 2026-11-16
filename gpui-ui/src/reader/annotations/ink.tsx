// Freehand ink drawing and eraser tools for Zotero reader annotations.
// Draws ink strokes with colour and stroke width, saved as type "ink" with paths.
// The eraser tool removes parts of ink annotations intersecting the eraser radius.
import { useGpuix } from "@gpuix/solid";
import type { EventPayload } from "@gpuix/native";
import { createSignal, Show, type Accessor, type JSX } from "solid-js";
import type { ReaderContext } from "../plugins";
import { thinInk } from "./geometry";
import { inkPosition, makeAnnotation, pageLabelFor, type Annotation } from "./model";
import type { Session } from "./session";

export interface InkOverlayProps {
	ctx: ReaderContext;
	page: number;
	box: Accessor<{ width: number; height: number }>;
	sc: Accessor<number>;
	ph: Accessor<number>;
	s: Session;
}

export function InkOverlay(p: InkOverlayProps): JSX.Element {
	const gpuix = useGpuix();
	let catcherEl: { id: number } | undefined;

	const [drawing, setDrawing] = createSignal(false);
	const [erasing, setErasing] = createSignal(false);
	const [livePath, setLivePath] = createSignal<number[] | null>(null);

	function toPdfCoords(clientX: number, clientY: number): [number, number] | null {
		const b = catcherEl ? gpuix?.renderer.getElementBounds?.(catcherEl.id) : null;
		if (!b) return null;
		const x = (clientX - b.x) / p.sc();
		const y = p.ph() - (clientY - b.y) / p.sc();
		return [x, y];
	}

	function onMouseDown(e: EventPayload) {
		if ((e.button ?? 0) !== 0 || e.x === undefined || e.y === undefined) return;
		const pt = toPdfCoords(e.x, e.y);
		if (!pt) return;

		if (p.s.ui.tool() === "ink") {
			setDrawing(true);
			setLivePath([pt[0], pt[1]]);
		} else if (p.s.ui.tool() === "eraser") {
			setErasing(true);
			eraseAt(pt[0], pt[1]);
		}
	}

	function onMouseMove(e: EventPayload) {
		if (e.x === undefined || e.y === undefined) return;
		const pt = toPdfCoords(e.x, e.y);
		if (!pt) return;

		if (drawing() && p.s.ui.tool() === "ink") {
			setLivePath((prev) => (prev ? [...prev, pt[0], pt[1]] : [pt[0], pt[1]]));
		} else if (erasing() && p.s.ui.tool() === "eraser") {
			eraseAt(pt[0], pt[1]);
		}
	}

	async function onMouseUp() {
		if (erasing()) {
			setErasing(false);
		}
		if (!drawing()) return;
		setDrawing(false);
		const raw = livePath();
		setLivePath(null);
		if (!raw || raw.length < 4) return;

		const path = thinInk(raw);
		const stroke = path.length === 2 ? [...path, ...path] : path;
		const width = p.s.ui.inkWidth?.() ?? 2;
		const pos = inkPosition(p.page, width, [stroke]);
		const sortIdx = await p.s.act.sortIndex(pos);
		const label = pageLabelFor(p.page, p.s.store.list());

		const ann = makeAnnotation({
			type: "ink",
			color: p.s.ui.color(),
			position: pos,
			sortIndex: sortIdx,
			pageLabel: label,
		});
		p.s.store.add(ann);
		p.s.ui.select(ann.id);
	}

	/** Erase parts of ink annotations whose strokes intersect the eraser circle at (ex, ey). */
	function eraseAt(ex: number, ey: number, radius = 12) {
		const inkAnns = p.s.store.list().filter((a: Annotation) => a.type === "ink" && a.position.pageIndex === p.page);
		for (const a of inkAnns) {
			let changed = false;
			const newPaths: number[][] = [];
			for (const stroke of a.position.paths ?? []) {
				let cur: number[] = [];
				let strokeHit = false;
				for (let i = 0; i + 1 < stroke.length; i += 2) {
					const px = stroke[i]!,
						py = stroke[i + 1]!;
					if (Math.hypot(px - ex, py - ey) <= radius) {
						strokeHit = true;
						if (cur.length >= 4) {
							newPaths.push(cur);
						}
						cur = [];
					} else {
						cur.push(px, py);
					}
				}
				if (cur.length >= 4) {
					newPaths.push(cur);
				}
				if (strokeHit) {
					changed = true;
				} else {
					newPaths.push(stroke);
				}
			}
			if (changed) {
				if (newPaths.length === 0) {
					p.s.store.remove([a.id]);
				} else {
					p.s.store.update(a.id, { position: inkPosition(p.page, a.position.width ?? 2, newPaths) });
				}
			}
		}
	}

	const pathSvg = () => {
		const pts = livePath();
		if (!pts || pts.length < 2) return "";
		let d = "";
		for (let i = 0; i + 1 < pts.length; i += 2) {
			const sx = pts[i]! * p.sc();
			const sy = (p.ph() - pts[i + 1]!) * p.sc();
			d += `${i === 0 ? "M" : " L"} ${sx.toFixed(1)} ${sy.toFixed(1)}`;
		}
		const strokeW = (p.s.ui.inkWidth?.() ?? 2) * p.sc();
		return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${p.box().width} ${p.box().height}"><path d="${d}" fill="none" stroke="${p.s.ui.color()}" stroke-width="${strokeW}" stroke-linecap="round" stroke-linejoin="round" /></svg>`;
	};

	return (
		<div
			ref={(el: { id: number }) => {
				catcherEl = el;
			}}
			onMouseDown={onMouseDown}
			onMouseMove={onMouseMove}
			onMouseUp={onMouseUp}
			style={{
				position: "absolute",
				left: 0,
				top: 0,
				width: p.box().width,
				height: p.box().height,
				cursor: "crosshair",
				pointerEvents: "auto",
			}}
		>
			<Show when={livePath() && livePath()!.length >= 4}>
				<svg
					source={pathSvg()}
					style={{ position: "absolute", left: 0, top: 0, width: p.box().width, height: p.box().height, pointerEvents: "none" }}
				/>
			</Show>
		</div>
	);
}
