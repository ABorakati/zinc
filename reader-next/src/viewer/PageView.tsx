import { createEffect, createMemo, For, onCleanup, Show } from "solid-js";
import type { PdfRect } from "../contract";
import { pageLook } from "./appearance";
import { appearance } from "./appearance";
import { CSS_PER_PT, type ViewerController } from "./controller";
import type { LinkInfo, PageTextData } from "./pdf";

const MAX_PIXELS = 28_000_000;

function buildTextLayer(el: HTMLElement, d: PageTextData, H: number, page: number, scale: number, rot: number) {
	const frag = document.createDocumentFragment();
	const spans: { span: HTMLSpanElement; w: number }[] = [];
	for (const r of d.runs) {
		const text = r.text.replace(/[\r\n]+/g, "");
		if (!text.trim()) continue;
		const w = r.rect[2] - r.rect[0], h = r.rect[3] - r.rect[1];
		if (w <= 0 || h <= 0 || (h > w * 1.5 && text.length > 2)) continue; // skip rotated runs
		const span = document.createElement("span");
		span.className = "rn-run";
		span.textContent = text;
		const top = H - r.rect[3];
		span.style.cssText = `left:${r.rect[0]}px;top:${top}px;height:${h}px;line-height:${h}px;font-size:${r.fontSize || h * 0.85}px`;
		span.dataset.p = String(page);
		span.dataset.x1 = String(r.rect[0]);
		span.dataset.x2 = String(r.rect[2]);
		span.dataset.y = String((r.rect[1] + r.rect[3]) / 2);
		span.dataset.h = String(h);
		frag.appendChild(span);
		spans.push({ span, w });
	}
	el.replaceChildren(frag);
	// measure all, then write all (one reflow)
	// the layer may be rotated by a multiple of 90deg: the natural width is then the box height
	const widths = spans.map((s) => { const b = s.span.getBoundingClientRect(); return (rot % 180 ? b.height : b.width) / scale; });
	spans.forEach((s, i) => {
		const nat = widths[i];
		if (nat > 0) s.span.style.transform = `scaleX(${s.w / nat})`;
	});
}

export function PageView(props: { ctl: ViewerController; index: number }) {
	const ctl = props.ctl;
	const i = props.index;
	const info = ctl.pages[i];
	const dpr = window.devicePixelRatio || 1;
	let canvas!: HTMLCanvasElement;
	let textEl!: HTMLDivElement;
	let overlayEl!: HTMLDivElement;
	let root!: HTMLDivElement;

	const box = createMemo(() => {
		const l = ctl.layout();
		const r = l.rots[i];
		const sw = r % 180 !== 0;
		return { top: l.tops[i], left: l.lefts[i], w: l.widths[i], h: l.heights[i], r, uw: sw ? l.heights[i] : l.widths[i], uh: sw ? l.widths[i] : l.heights[i] };
	});
	const sc = () => ctl.layout().scale;
	const contentTransform = () => {
		const b = box();
		return b.r === 90 ? `translate(${b.uh}px,0) rotate(90deg)` : b.r === 180 ? `translate(${b.uw}px,${b.uh}px) rotate(180deg)` : b.r === 270 ? `translate(0,${b.uw}px) rotate(270deg)` : "none";
	};
	const look = createMemo(() => pageLook(appearance()));

	// ---- raster
	createEffect(() => {
		const z = ctl.settledZoom[0]();
		let cssScale = z * CSS_PER_PT;
		const pw = info.width * cssScale * dpr, ph = info.height * cssScale * dpr;
		if (pw * ph > MAX_PIXELS) cssScale *= Math.sqrt(MAX_PIXELS / (pw * ph));
		const job = ctl.pdf.renderRaw(i, cssScale, dpr);
		let dead = false;
		onCleanup(() => { dead = true; job.cancel(); });
		job.promise.then((img) => {
			if (dead) return;
			canvas.width = img.width;
			canvas.height = img.height;
			canvas.getContext("2d")!.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
			if (ctl.firstPaintMs[0]() === null) {
				const t0 = (window as unknown as { __rnT0?: number }).__rnT0 ?? 0;
				ctl.firstPaintMs[1](Math.round(performance.now() - t0));
			}
		}).catch(() => {});
	});
	onCleanup(() => { canvas.width = 0; canvas.height = 0; });

	// ---- text + links (page-space, independent of zoom)
	createEffect(() => {
		let dead = false;
		onCleanup(() => { dead = true; textEl.replaceChildren(); });
		void ctl.loadText(i).then((d) => {
			if (dead) return;
			buildTextLayer(textEl, d, info.height, i, ctl.layout().scale, ctl.layout().rots[i]);
		}).catch(() => {});
		void ctl.loadLinks(i);
	});

	// ---- overlay layer for plugins: remounted when callbacks change or zoom settles
	createEffect(() => {
		ctl.overlayEpoch[0]();
		const drawZoom = ctl.zoomVal[0]();
		overlayEl.style.transform = "";
		overlayEl.dataset.drawZoom = String(drawZoom);
		const un = ctl.mountOverlay(i, overlayEl, () => ctl.layout().scale);
		onCleanup(un);
	});
	// between settles, scale the (stale) overlay to follow the zoom
	createEffect(() => {
		const z = ctl.zoomVal[0]();
		const dz = Number(overlayEl.dataset.drawZoom || z);
		overlayEl.style.transform = Math.abs(z - dz) < 1e-4 ? "" : `scale(${z / dz})`;
	});

	// ---- find highlights
	const hits = createMemo(() => {
		const out: { rects: PdfRect[]; current: boolean }[] = [];
		const all = ctl.findHits[0](), cur = ctl.findIndex[0]();
		for (let k = 0; k < all.length; k++) if (all[k].page === i) out.push({ rects: all[k].rects, current: k === cur });
		return out;
	});
	const flash = createMemo(() => { const f = ctl.flash[0](); return f && f.page === i ? f : null; });

	// ---- link hit-testing / hover / click
	let hoverLink: LinkInfo | null = null;
	let hoverTimer = 0;
	let hoverFired = false;
	const ptAt = (e: MouseEvent): [number, number] => {
		const r = root.getBoundingClientRect();
		const s = ctl.layout().scale;
		const a = e.clientX - r.left, b = e.clientY - r.top;
		const { r: rot, uw, uh } = box();
		// inverse of the page rotation: rotated box coords -> unrotated page px
		const [u, v] = rot === 90 ? [b, uh - a] : rot === 180 ? [uw - a, uh - b] : rot === 270 ? [uw - b, a] : [a, b];
		return [u / s, info.height - v / s];
	};
	const linkAt = (x: number, y: number): LinkInfo | null => {
		const links = ctl.linkCache.get(i);
		if (!links) return null;
		let best: LinkInfo | null = null, bestArea = Infinity;
		for (const l of links) {
			const r = l.rect;
			if (x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]) {
				const a = (r[2] - r[0]) * (r[3] - r[1]);
				if (a < bestArea) { best = l; bestArea = a; }
			}
		}
		return best;
	};
	const clearHover = () => {
		clearTimeout(hoverTimer);
		if (hoverFired) { hoverFired = false; ctl.fireHover(null, null); }
		hoverLink = null;
		textEl.style.cursor = "";
	};
	const onMove = (e: PointerEvent) => {
		if (e.buttons) return;
		const [x, y] = ptAt(e);
		const l = linkAt(x, y);
		if (l === hoverLink) return;
		clearHover();
		hoverLink = l;
		if (l) {
			textEl.style.cursor = "pointer";
			const cx = e.clientX, cy = e.clientY;
			hoverTimer = window.setTimeout(() => { hoverFired = true; ctl.fireHover(i, l, cx, cy); }, 250);
		}
	};
	const onClick = (e: MouseEvent) => {
		if (e.button !== 0) return;
		const sel = window.getSelection();
		if (sel && !sel.isCollapsed && sel.toString().length > 0) return;
		const [x, y] = ptAt(e);
		const l = linkAt(x, y);
		if (l) { e.preventDefault(); clearHover(); ctl.activateLink(i, l, e.clientX, e.clientY); }
	};
	onCleanup(() => { clearTimeout(hoverTimer); if (hoverFired) ctl.fireHover(null, null); });

	return (
		<div
			ref={root}
			class="rn-page absolute"
			data-page={i}
			style={{ top: `${box().top}px`, left: `${box().left}px`, width: `${box().w}px`, height: `${box().h}px` }}
			onPointerMove={onMove}
			onPointerLeave={clearHover}
			onClick={onClick}
			onContextMenu={(e) => ctl.showMenu(e, [i], () => ctl.copyText())}
		>
			<div class="absolute left-0 top-0" style={{ width: `${box().uw}px`, height: `${box().uh}px`, "transform-origin": "0 0", transform: contentTransform() }}>
			<div class="absolute inset-0 overflow-hidden shadow-md ring-1 ring-black/10" style={{ isolation: "isolate", ...look().paper }}>
				<canvas ref={canvas} class="absolute inset-0 size-full" style={look().canvas} />
			</div>
			<div class="rn-layer" style={{ width: `${info.width}px`, height: `${info.height}px`, transform: `scale(${sc()})` }}>
				<For each={hits()}>{(h) => <For each={h.rects}>{(r) => (
					<div class={h.current ? "rn-hit rn-hit-cur" : "rn-hit"} style={{ left: `${r[0]}px`, top: `${info.height - r[3]}px`, width: `${r[2] - r[0]}px`, height: `${r[3] - r[1]}px` }} />
				)}</For>}</For>
				<Show when={flash()} keyed>{(f) => (
					<div class="rn-flash" style={{ left: `${f.rect[0] - 2}px`, top: `${info.height - f.rect[3] - 2}px`, width: `${f.rect[2] - f.rect[0] + 4}px`, height: `${f.rect[3] - f.rect[1] + 4}px` }} />
				)}</Show>
			</div>
			<div
				ref={textEl}
				class="rn-layer rn-text"
				style={{ width: `${info.width}px`, height: `${info.height}px`, transform: `scale(${sc()})` }}
			/>
			</div>
			<div ref={overlayEl} class="absolute left-0 top-0 origin-top-left" style={{ width: `${box().w}px`, height: `${box().h}px`, "pointer-events": "none" }} />
		</div>
	);
}
