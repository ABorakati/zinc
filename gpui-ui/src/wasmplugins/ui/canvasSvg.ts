// `canvas`: the vector draw list -> one SVG document (drawn by GPUIX as a full-colour image, text included) plus the shapes the host
// hit-tests itself. Pure. A canvas of 20,000 ops is lowered per update, so ops are written as compact strings.
import type { Mode } from "../../contracts";
import { svgColor } from "./colors";
import { FONT_FAMILY, FONT_SIZE } from "./styleMap";
import type { Color, UiText } from "./types";

type Any = any;

export interface View {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** A clickable shape in canvas coordinates (group translate/scale already applied). */
export interface HitShape {
	id: string;
	tip?: string;
	/** Bounding box. */
	x: number;
	y: number;
	w: number;
	h: number;
	kind: "rect" | "ellipse" | "line" | "poly" | "box";
	/** line / polyline points, flat. */
	pts?: number[];
	closed?: boolean;
	pad?: number;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (n: number) => (Number.isFinite(n) ? +n.toFixed(3) : 0);

export interface BuildOptions {
	mode: Mode;
	txt: (t: UiText | undefined) => string;
	/** A data URL for an image source, or undefined. */
	image: (src: Any) => string | undefined;
}

function paint(attr: "fill" | "stroke", c: Color | undefined, mode: Mode): string {
	const s = svgColor(c, mode);
	if (!s) return attr === "fill" ? ` fill="none"` : "";
	return s.opacity < 1 ? ` ${attr}="${s.color}" ${attr}-opacity="${s.opacity}"` : ` ${attr}="${s.color}"`;
}

function shapeAttrs(st: Any, mode: Mode, defaultFill: boolean): string {
	let a = st?.fill ? paint("fill", st.fill, mode) : defaultFill ? "" : ` fill="none"`;
	if (!st?.fill) a = ` fill="none"`;
	if (st?.stroke) {
		a += paint("stroke", st.stroke.color, mode) + ` stroke-width="${num(st.stroke.width)}"`;
		if (st.stroke.dashed) a += ` stroke-dasharray="${num(st.stroke.width * 3)} ${num(st.stroke.width * 2)}"`;
		if (st.stroke.roundCaps) a += ` stroke-linecap="round" stroke-linejoin="round"`;
	}
	if (st?.opacity !== undefined && st.opacity < 1) a += ` opacity="${st.opacity}"`;
	return a;
}

interface Xf {
	tx: number;
	ty: number;
	s: number;
}

/** Build the SVG for the visible `view` (a region of canvas space) and the hit shapes. */
export function buildCanvas(spec: Any, view: View, o: BuildOptions): { svg: string; hits: HitShape[] } {
	const out: string[] = [];
	const hits: HitShape[] = [];
	const stack: Xf[] = [];
	let xf: Xf = { tx: 0, ty: 0, s: 1 };
	let open = 0;
	let clipN = 0;
	const addHit = (h: Omit<HitShape, "x" | "y" | "w" | "h"> & { x: number; y: number; w: number; h: number }) => {
		hits.push({ ...h, x: h.x * xf.s + xf.tx, y: h.y * xf.s + xf.ty, w: h.w * xf.s, h: h.h * xf.s, pts: h.pts?.map((v, i) => (i % 2 === 0 ? v * xf.s + xf.tx : v * xf.s + xf.ty)), pad: (h.pad ?? 0) * xf.s });
	};
	const bg = svgColor(spec.background, o.mode);
	out.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${num(view.width)}" height="${num(view.height)}" viewBox="${num(view.x)} ${num(view.y)} ${num(view.width)} ${num(view.height)}" preserveAspectRatio="xMidYMid meet">`);
	if (bg) out.push(`<rect x="${num(view.x)}" y="${num(view.y)}" width="${num(view.width)}" height="${num(view.height)}" fill="${bg.color}" fill-opacity="${bg.opacity}"/>`);
	let skipped = 0;
	for (const op of (Array.isArray(spec?.ops) ? spec.ops : []) as { tag: string; val?: Any }[]) {
		try {
		const v = op.val;
		switch (op.tag) {
			case "rect": {
				out.push(`<rect x="${num(v.x)}" y="${num(v.y)}" width="${num(v.width)}" height="${num(v.height)}"${v.cornerRadius ? ` rx="${num(v.cornerRadius)}"` : ""}${shapeAttrs(v.style, o.mode, false)}/>`);
				if (v.style?.hit) addHit({ id: v.style.hit, tip: v.style.hoverTip && o.txt(v.style.hoverTip), kind: "rect", x: v.x, y: v.y, w: v.width, h: v.height });
				break;
			}
			case "ellipse": {
				out.push(`<ellipse cx="${num(v.cx)}" cy="${num(v.cy)}" rx="${num(v.rx)}" ry="${num(v.ry)}"${shapeAttrs(v.style, o.mode, false)}/>`);
				if (v.style?.hit) addHit({ id: v.style.hit, tip: v.style.hoverTip && o.txt(v.style.hoverTip), kind: "ellipse", x: v.cx - v.rx, y: v.cy - v.ry, w: v.rx * 2, h: v.ry * 2 });
				break;
			}
			case "line": {
				out.push(`<line x1="${num(v.x1)}" y1="${num(v.y1)}" x2="${num(v.x2)}" y2="${num(v.y2)}"${shapeAttrs({ ...v.style, fill: undefined }, o.mode, false)}/>`);
				if (v.style?.hit) addHit({ id: v.style.hit, tip: v.style.hoverTip && o.txt(v.style.hoverTip), kind: "line", x: Math.min(v.x1, v.x2), y: Math.min(v.y1, v.y2), w: Math.abs(v.x2 - v.x1), h: Math.abs(v.y2 - v.y1), pts: [v.x1, v.y1, v.x2, v.y2], pad: Math.max(4, (v.style.stroke?.width ?? 1) / 2 + 2) });
				break;
			}
			case "polyline": {
				const pts: number[] = v.points;
				const pairs: string[] = [];
				for (let i = 0; i + 1 < pts.length; i += 2) pairs.push(`${num(pts[i]!)},${num(pts[i + 1]!)}`);
				out.push(`<${v.closed ? "polygon" : "polyline"} points="${pairs.join(" ")}"${shapeAttrs(v.closed ? v.style : { ...v.style, fill: undefined }, o.mode, false)}/>`);
				if (v.style?.hit) {
					const xs = pts.filter((_, i) => i % 2 === 0),
						ys = pts.filter((_, i) => i % 2 === 1);
					const b = boxOf(xs, ys);
					if (b) addHit({ id: v.style.hit, tip: v.style.hoverTip && o.txt(v.style.hoverTip), kind: "poly", closed: !!v.closed && !!v.style.fill, ...b, pts, pad: Math.max(4, (v.style.stroke?.width ?? 1) / 2 + 2) });
				}
				break;
			}
			case "path": {
				out.push(`<path d="${esc(v.d)}"${shapeAttrs(v.style, o.mode, false)}/>`);
				if (v.style?.hit) {
					const b = pathBox(v.d);
					if (b) addHit({ id: v.style.hit, tip: v.style.hoverTip && o.txt(v.style.hoverTip), kind: "box", ...b });
				}
				break;
			}
			case "text": {
				const size = FONT_SIZE[v.size] ?? 13;
				const c = svgColor(v.color, o.mode);
				const text = o.txt(v.text);
				const anchor = v.anchor === "middle" ? "middle" : v.anchor === "end" ? "end" : "start";
				let body = esc(text);
				let extra = "";
				if (v.maxWidth) {
					const maxChars = Math.max(1, Math.floor(v.maxWidth / (size * 0.55)));
					if (text.length > maxChars) body = esc(text.slice(0, Math.max(1, maxChars - 1)) + "…");
				}
				if (v.weight && v.weight !== "normal") extra += ` font-weight="${v.weight === "medium" ? 500 : v.weight === "semibold" ? 600 : 700}"`;
				out.push(`<text x="${num(v.x)}" y="${num(v.y)}" font-family="${FONT_FAMILY[v.family] ?? "Inter"}" font-size="${size}" text-anchor="${anchor}"${extra} fill="${c?.color ?? "#000"}"${c && c.opacity < 1 ? ` fill-opacity="${c.opacity}"` : ""}>${body}</text>`);
				if (v.hit) {
					const w = body.length * size * 0.55;
					const x0 = anchor === "middle" ? v.x - w / 2 : anchor === "end" ? v.x - w : v.x;
					addHit({ id: v.hit, kind: "rect", x: x0, y: v.y - size, w, h: size * 1.3 });
				}
				break;
			}
			case "image": {
				const href = o.image(v.source);
				if (href) out.push(`<image x="${num(v.x)}" y="${num(v.y)}" width="${num(v.width)}" height="${num(v.height)}" preserveAspectRatio="xMidYMid meet" xlink:href="${href}" href="${href}"/>`);
				if (v.hit) addHit({ id: v.hit, kind: "rect", x: v.x, y: v.y, w: v.width, h: v.height });
				break;
			}
			case "push-group": {
				stack.push(xf);
				const s = v.scale || 1;
				// hit shapes only follow translate and scale (rotation is drawn, not hit-tested)
				xf = { tx: xf.tx + v.translateX * xf.s, ty: xf.ty + v.translateY * xf.s, s: xf.s * s };
				let attrs = `transform="translate(${num(v.translateX)} ${num(v.translateY)}) scale(${num(s)})${v.rotateDegrees ? ` rotate(${num(v.rotateDegrees)})` : ""}"`;
				if (v.opacity !== undefined && v.opacity < 1) attrs += ` opacity="${v.opacity}"`;
				if (v.clip) {
					const id = `c${clipN++}`;
					out.push(`<clipPath id="${id}"><rect x="${num(v.clip.x)}" y="${num(v.clip.y)}" width="${num(v.clip.width)}" height="${num(v.clip.height)}"/></clipPath>`);
					attrs += ` clip-path="url(#${id})"`;
				}
				out.push(`<g ${attrs}>`);
				open++;
				break;
			}
			case "pop-group": {
				if (open > 0) {
					out.push("</g>");
					open--;
					xf = stack.pop() ?? xf;
				}
				break;
			}
		}
		} catch (e) {
			// A draw op the host cannot read (a pre-built tree skips the schema check): skip it, draw the rest, say so once per build.
			if (!skipped++) console.error("[canvas] skipped a malformed draw op:", e instanceof Error ? e.message : e);
		}
	}
	while (open-- > 0) out.push("</g>");
	out.push("</svg>");
	return { svg: out.join(""), hits };
}

/** A rough bounding box of SVG path data (all coordinates it mentions; arcs and relative moves are approximated). */
export function pathBox(d: string): { x: number; y: number; w: number; h: number } | undefined {
	// Bounded work on the UI thread: a path string this long gets no hit box (it is still drawn).
	if (typeof d !== "string" || d.length > MAX_PATH_CHARS) return undefined;
	const toks = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g);
	if (!toks) return undefined;
	let cx = 0,
		cy = 0;
	const xs: number[] = [],
		ys: number[] = [];
	let cmd = "M";
	let i = 0;
	const take = (n: number) => toks.slice(i, i + n).map(Number);
	const arity: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
	while (i < toks.length) {
		// Every pass consumes a token or stops: a number after `Z` or after a command with no arity is skipped, not retried forever.
		const isCmd = /[a-zA-Z]/.test(toks[i]!);
		if (isCmd) cmd = toks[i++]!;
		const up = cmd.toUpperCase();
		const rel = cmd !== up;
		const n = arity[up] ?? 0;
		if (n === 0) {
			if (!isCmd) i++;
			continue;
		}
		const a = take(n);
		if (a.length < n || !a.every(Number.isFinite)) break;
		i += n;
		const px = (v: number) => (rel ? cx + v : v);
		const py = (v: number) => (rel ? cy + v : v);
		if (up === "H") cx = px(a[0]!);
		else if (up === "V") cy = py(a[0]!);
		else if (up === "A") {
			cx = px(a[5]!);
			cy = py(a[6]!);
		} else {
			for (let k = 0; k < n; k += 2) {
				xs.push(px(a[k]!));
				ys.push(py(a[k + 1]!));
			}
			cx = px(a[n - 2]!);
			cy = py(a[n - 1]!);
		}
		xs.push(cx);
		ys.push(cy);
		if (up === "M") cmd = rel ? "l" : "L";
	}
	return boxOf(xs, ys);
}

/** Longest path string that gets a hit box. */
const MAX_PATH_CHARS = 4_000_000;

/** The bounding box of paired coordinate lists; undefined when empty or not finite. A loop, not `Math.min(...xs)`: a spread of a big array overflows the stack. */
function boxOf(xs: readonly number[], ys: readonly number[]): { x: number; y: number; w: number; h: number } | undefined {
	if (!xs.length || !ys.length) return undefined;
	let x0 = Infinity,
		x1 = -Infinity,
		y0 = Infinity,
		y1 = -Infinity;
	for (const v of xs) {
		if (v < x0) x0 = v;
		if (v > x1) x1 = v;
	}
	for (const v of ys) {
		if (v < y0) y0 = v;
		if (v > y1) y1 = v;
	}
	const b = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
	return Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.w) && Number.isFinite(b.h) ? b : undefined;
}

function distToSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
	const dx = x2 - x1,
		dy = y2 - y1;
	const l2 = dx * dx + dy * dy;
	const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l2));
	return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function inPoly(px: number, py: number, pts: number[]): boolean {
	let inside = false;
	for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
		const xi = pts[i]!,
			yi = pts[i + 1]!,
			xj = pts[j]!,
			yj = pts[j + 1]!;
		if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

/** The top-most shape under a point in canvas coordinates. */
export function hitTest(hits: HitShape[], x: number, y: number): HitShape | undefined {
	for (let i = hits.length - 1; i >= 0; i--) {
		const h = hits[i]!;
		const pad = h.pad ?? 0;
		if (x < h.x - pad || x > h.x + h.w + pad || y < h.y - pad || y > h.y + h.h + pad) continue;
		switch (h.kind) {
			case "rect":
			case "box":
				return h;
			case "ellipse": {
				const rx = h.w / 2,
					ry = h.h / 2;
				if (rx > 0 && ry > 0 && ((x - (h.x + rx)) / rx) ** 2 + ((y - (h.y + ry)) / ry) ** 2 <= 1) return h;
				break;
			}
			case "line":
			case "poly": {
				const p = h.pts ?? [];
				if (h.kind === "poly" && h.closed && inPoly(x, y, p)) return h;
				for (let k = 0; k + 3 < p.length; k += 2) if (distToSeg(x, y, p[k]!, p[k + 1]!, p[k + 2]!, p[k + 3]!) <= pad) return h;
				break;
			}
		}
	}
	return undefined;
}
