// Plugin `style` (WIT record) -> a GPUIX style object. Pure (takes the mode). Text properties inherit in the plugin model but GPUIX
// has no inheritance, so they are kept apart (TextProps) and merged down the tree by the renderer.
import type { Mode } from "../../contracts";
import { shadows } from "../../theme";
import { resolveColor } from "./colors";
import type { Border, Dim, Edges, Space, StateStyles, Style } from "./types";

type Gx = Record<string, unknown>;

export const space = (s: Space | undefined): number | undefined => (s ? (s.tag === "step" ? s.val * 4 : s.val) : undefined);

/** A dimension as a GPUIX value. `fill` and `content` are flex tricks handled by the caller (see `dimInto`). */
function dimValue(d: Dim): number | string | undefined {
	switch (d.tag) {
		case "px":
			return d.val;
		case "percent":
			return `${d.val}%`;
		case "step":
			return d.val * 4;
		case "auto":
		case "content":
			return "auto";
		case "fill":
			return undefined;
	}
}

const RADIUS: Record<string, number> = { none: 0, xs: 2, sm: 4, md: 6, lg: 8, xl: 12, full: 9999 };
export const FONT_SIZE: Record<string, number> = { xs: 11, sm: 12, base: 13, lg: 15, xl: 18, xl2: 22, xl3: 28 };
export const FONT_FAMILY: Record<string, string> = { sans: "Inter", title: "Source Serif 4", mono: "Cascadia Mono" };
const WEIGHT: Record<string, number> = { normal: 400, medium: 500, semibold: 600, bold: 700 };
const ALIGN: Record<string, string> = { start: "flex-start", center: "center", end: "flex-end", stretch: "stretch", baseline: "baseline" };
const JUSTIFY: Record<string, string> = {
	start: "flex-start",
	center: "center",
	end: "flex-end",
	"space-between": "space-between",
	"space-around": "space-around",
	"space-evenly": "space-evenly",
};
const CURSOR: Record<string, string> = {
	standard: "default",
	pointer: "pointer",
	text: "text",
	grab: "grab",
	grabbing: "grabbing",
	"not-allowed": "not-allowed",
	crosshair: "crosshair",
	move: "move",
	wait: "default",
	help: "default",
};

function edgesInto(out: Gx, base: "padding" | "margin", e: Edges | undefined) {
	if (!e) return;
	const v = { Top: space(e.top), Right: space(e.end), Bottom: space(e.bottom), Left: space(e.start) };
	for (const [side, n] of Object.entries(v)) if (n !== undefined) out[base + side] = n;
}

function borderInto(out: Gx, side: "" | "Top" | "Bottom" | "Left" | "Right", b: Border | undefined, mode: Mode) {
	if (!b) return;
	out[`border${side}Width`] = b.width;
	const c = resolveColor(b.color, mode);
	if (c) out.borderColor = c;
	if (b.dashed) out.borderStyle = "dashed";
}

function dimInto(out: Gx, key: "width" | "height", d: Dim | undefined) {
	if (!d) return;
	if (d.tag === "fill") {
		out.flexGrow = 1;
		out.flexShrink = 1;
		out.flexBasis = 0;
		out[key === "width" ? "minWidth" : "minHeight"] = 0;
		return;
	}
	const v = dimValue(d);
	if (v !== undefined) out[key] = v;
}

/** Everything in `style` that GPUIX applies to the element itself (layout, size, paint). Text properties are NOT here. */
export function mapBox(s: Style | undefined, mode: Mode): Gx {
	const out: Gx = {};
	if (!s) return out;
	if (s.direction !== undefined || s.wrap !== undefined || s.alignItems !== undefined || s.justifyContent !== undefined || s.gap !== undefined) {
		out.display = "flex";
	}
	if (s.direction !== undefined) out.flexDirection = s.direction;
	if (s.wrap) out.flexWrap = "wrap";
	if (s.alignItems) out.alignItems = ALIGN[s.alignItems];
	if (s.justifyContent) out.justifyContent = JUSTIFY[s.justifyContent];
	const gap = space(s.gap);
	if (gap !== undefined) out.gap = gap;
	if (s.alignSelf) out.alignSelf = ALIGN[s.alignSelf];
	if (s.flexGrow !== undefined) out.flexGrow = s.flexGrow;
	if (s.flexShrink !== undefined) out.flexShrink = s.flexShrink;
	if (s.flexBasis) {
		const v = dimValue(s.flexBasis);
		if (typeof v === "number") out.flexBasis = v;
	}
	dimInto(out, "width", s.width);
	dimInto(out, "height", s.height);
	for (const [k, d] of [
		["minWidth", s.minWidth],
		["minHeight", s.minHeight],
		["maxWidth", s.maxWidth],
		["maxHeight", s.maxHeight],
	] as const) {
		if (!d) continue;
		const v = dimValue(d);
		if (v !== undefined) out[k] = v;
	}
	if (s.aspectRatio !== undefined) out.aspectRatio = s.aspectRatio;
	edgesInto(out, "padding", s.padding);
	edgesInto(out, "margin", s.margin);
	if (s.overflow) {
		out.overflow = s.overflow === "auto" || s.overflow === "scroll" ? "scroll" : s.overflow;
	}
	if (s.position) out.position = s.position;
	if (s.inset) {
		const i = s.inset;
		const v = { top: space(i.top), right: space(i.end), bottom: space(i.bottom), left: space(i.start) };
		for (const [k, n] of Object.entries(v)) if (n !== undefined) out[k] = n;
	}
	const bg = resolveColor(s.background, mode);
	if (bg) out.backgroundColor = bg;
	borderInto(out, "", s.border, mode);
	borderInto(out, "Top", s.borderTop, mode);
	borderInto(out, "Bottom", s.borderBottom, mode);
	borderInto(out, "Left", s.borderStart, mode);
	borderInto(out, "Right", s.borderEnd, mode);
	if (s.radius) out.borderRadius = RADIUS[s.radius] ?? 0;
	if (s.opacity !== undefined) out.opacity = s.opacity;
	if (s.shadow === "raised") out.boxShadow = shadows[mode].raised;
	else if (s.shadow === "pill") out.boxShadow = shadows[mode].pill;
	if (s.cursor) out.cursor = CURSOR[s.cursor] ?? "default";
	return out;
}

/** The inherited text properties of a style. */
export interface TextProps {
	color?: string;
	fontSize?: number;
	fontFamily?: string;
	fontWeight?: number;
	italic?: boolean;
	underline?: boolean;
	strike?: boolean;
	lineHeight?: number;
	textAlign?: string;
	textWrap?: string;
	maxLines?: number;
	cursor?: string;
}

/** `parent` with the text properties of `s` laid over. Returns `parent` itself when `s` sets none (cheap for the memo). */
export function mergeText(parent: TextProps, s: Style | undefined, mode: Mode): TextProps {
	if (!s) return parent;
	if (
		s.foreground === undefined && s.fontSize === undefined && s.fontFamily === undefined && s.fontWeight === undefined &&
		s.italic === undefined && s.underline === undefined && s.strike === undefined && s.lineHeight === undefined &&
		s.textAlign === undefined && s.textWrap === undefined && s.maxLines === undefined
	)
		return parent; // prettier-ignore
	const o: TextProps = { ...parent };
	const c = resolveColor(s.foreground, mode);
	if (c) o.color = c;
	if (s.fontSize) o.fontSize = FONT_SIZE[s.fontSize] ?? 13;
	if (s.fontFamily) o.fontFamily = FONT_FAMILY[s.fontFamily] ?? "Inter";
	if (s.fontWeight) o.fontWeight = WEIGHT[s.fontWeight] ?? 400;
	if (s.italic !== undefined) o.italic = s.italic;
	if (s.underline !== undefined) o.underline = s.underline;
	if (s.strike !== undefined) o.strike = s.strike;
	if (s.lineHeight !== undefined) o.lineHeight = s.lineHeight;
	if (s.textAlign) o.textAlign = s.textAlign === "start" ? "left" : s.textAlign === "end" ? "right" : s.textAlign;
	if (s.textWrap) o.textWrap = s.textWrap;
	if (s.maxLines !== undefined) o.maxLines = s.maxLines;
	return o;
}

/** The GPUIX style of a `<text>` from inherited properties (+ the defaults of the element's role). */
export function textStyleOf(t: TextProps, base: { fontSize: number; fontWeight?: number; fontFamily?: string; color: string }): Gx {
	const fontSize = t.fontSize ?? base.fontSize;
	const out: Gx = {
		color: t.color ?? base.color,
		fontSize,
		fontFamily: t.fontFamily ?? base.fontFamily ?? FONT_FAMILY.sans,
		fontWeight: t.fontWeight ?? base.fontWeight ?? 400,
		lineHeight: +(fontSize * (t.lineHeight ?? 1.4)).toFixed(2),
	};
	if (t.underline) out.textDecoration = "underline";
	else if (t.strike) out.textDecoration = "line-through";
	if (t.textAlign) out.textAlign = t.textAlign;
	if (t.textWrap === "nowrap") out.whiteSpace = "nowrap";
	else if (t.textWrap === "truncate") {
		out.whiteSpace = "nowrap";
		out.overflow = "hidden";
		out.textOverflow = "ellipsis";
		if ((t.maxLines ?? 1) > 1) {
			out.whiteSpace = "normal";
			out.lineClamp = t.maxLines;
		}
	}
	if (t.cursor) out.cursor = t.cursor;
	return out;
}

/** hover / active / focusVisible from `states`; `disabled` and `selected` are merged by the caller when they apply. */
export function mapStates(st: StateStyles | undefined, mode: Mode): Gx {
	if (!st) return {};
	const out: Gx = {};
	if (st.hover) out.hover = mapBox(st.hover, mode);
	if (st.pressed) out.active = mapBox(st.pressed, mode);
	if (st.focusVisible) out.focusVisible = mapBox(st.focusVisible, mode);
	return out;
}
