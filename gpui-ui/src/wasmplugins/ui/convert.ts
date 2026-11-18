// Tree conversion, all pure: nested JSON form -> flat WIT tree (jsonToTree), flat tree -> the nested VNode tree the renderers use
// (buildNested), and patch-set application on a VNode tree (applyPatch). The JSON form is documented in
// plugin-api/ui-schema/ui-tree.schema.json: camelCase names, a node's `type` is the kind, `on` maps event kinds to handlers.
import {
	KIND_TAGS,
	type Cell,
	type Color,
	type Dim,
	type Edges,
	type FlatNode,
	type IconRef,
	type KindTag,
	type MenuT,
	type NamedStyle,
	type NodeKind,
	type NodeProps,
	type PatchSet,
	type Row,
	type Space,
	type Spec,
	type Style,
	type Tree,
	type UiText,
	type VNode,
} from "./types";

/** Host limits (ui.md "Host limits"). */
export const LIMITS = { nodes: 5000, depth: 64, drawOps: 20000 } as const;

export class TreeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TreeError";
	}
}

// ---------------------------------------------------------------------------------------------------- JSON -> flat

const COLOR_TOKENS = new Set([
	"background", "foreground", "card", "muted", "muted-foreground", "popover", "popover-foreground", "border", "input", "ring",
	"primary", "primary-foreground", "primary-soft", "primary-tint", "primary-line", "primary-deep",
	"secondary", "secondary-foreground", "accent", "accent-foreground",
	"destructive", "destructive-foreground", "success", "success-foreground", "warning", "warning-foreground", "error", "error-foreground",
	"palette-blue", "palette-sky", "palette-green", "palette-amber", "palette-rust", "palette-rose", "palette-violet", "palette-slate",
]); // prettier-ignore
export const isColorToken = (s: string) => COLOR_TOKENS.has(s);

type Any = any;
const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

/** "#rrggbb" or "#rrggbbaa" -> 0xRRGGBBAA (unsigned). */
export function hexToRgba(hex: string): number {
	const h = hex.replace("#", "");
	if (!/^([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(h)) throw new TreeError(`bad colour "${hex}"`);
	const v = parseInt(h.length === 6 ? h + "ff" : h, 16);
	return v >>> 0;
}
export function rgbaToHex(v: number, alpha = true): string {
	const h = (v >>> 0).toString(16).padStart(8, "0");
	return "#" + (alpha ? h : h.slice(0, 6));
}

const text = (v: Any): UiText => {
	if (typeof v === "string") return { tag: "plain", val: v };
	if (!isObj(v) || typeof v.id !== "string") throw new TreeError("bad text: " + JSON.stringify(v));
	const args = Object.entries(v.args ?? {}).map(([name, a]: [string, Any]) => ({
		name,
		value:
			typeof a === "string"
				? { tag: "text", val: a }
				: typeof a === "number"
					? Number.isInteger(a)
						? { tag: "integer", val: BigInt(a) }
						: { tag: "number", val: a }
					: { tag: "date", val: BigInt(a?.date ?? 0) },
	}));
	return { tag: "localized", val: { id: v.id, args, fallback: v.fallback } };
};
const optText = (v: Any) => (v === undefined || v === null ? undefined : text(v));
const icon = (v: Any): IconRef => {
	if (typeof v === "string") return { tag: "builtin", val: v };
	if (isObj(v) && typeof v.bundled === "string") return { tag: "bundled", val: v.bundled };
	if (isObj(v) && typeof v.svg === "string") return { tag: "svg", val: v.svg };
	throw new TreeError("bad icon: " + JSON.stringify(v));
};
const optIcon = (v: Any) => (v === undefined || v === null ? undefined : icon(v));
const color = (v: Any): Color => {
	if (typeof v === "string") {
		if (v.startsWith("#")) return { tag: "rgba", val: hexToRgba(v) };
		if (isColorToken(v)) return { tag: "token", val: v };
		throw new TreeError(`unknown colour token "${v}"`);
	}
	if (isObj(v) && typeof v.token === "string") return { tag: "token-alpha", val: { token: v.token, alpha: v.alpha ?? 255 } };
	if (isObj(v) && typeof v.light === "string") return { tag: "themed", val: { light: hexToRgba(v.light), dark: hexToRgba(v.dark ?? v.light) } };
	throw new TreeError("bad colour: " + JSON.stringify(v));
};
const optColor = (v: Any) => (v === undefined || v === null ? undefined : color(v));
const space = (v: Any): Space => {
	if (typeof v === "number") return { tag: "step", val: v };
	const m = /^([0-9.]+)px$/.exec(String(v));
	if (!m) throw new TreeError("bad space: " + JSON.stringify(v));
	return { tag: "px", val: parseFloat(m[1]!) };
};
const optSpace = (v: Any) => (v === undefined || v === null ? undefined : space(v));
const dim = (v: Any): Dim => {
	if (typeof v === "number") return { tag: "step", val: v };
	if (v === "auto" || v === "fill" || v === "content") return { tag: v };
	const m = /^([0-9.]+)(px|%)$/.exec(String(v));
	if (!m) throw new TreeError("bad dimension: " + JSON.stringify(v));
	return { tag: m[2] === "%" ? "percent" : "px", val: parseFloat(m[1]!) };
};
const optDim = (v: Any) => (v === undefined || v === null ? undefined : dim(v));
const edges = (v: Any): Edges => {
	if (!isObj(v)) {
		const s = space(v);
		return { top: s, end: s, bottom: s, start: s };
	}
	const e: Edges = {};
	if (v.x !== undefined) e.start = e.end = space(v.x);
	if (v.y !== undefined) e.top = e.bottom = space(v.y);
	for (const k of ["top", "end", "bottom", "start"] as const) if (v[k] !== undefined) e[k] = space(v[k]);
	return e;
};
const border = (v: Any) => ({ width: Number(v.width ?? 1), color: color(v.color), dashed: !!v.dashed });
const gridSpan = (v: Any) => ({ start: v.start, span: v.span ?? 1 });

const DIMS = ["width", "height", "minWidth", "minHeight", "maxWidth", "maxHeight", "flexBasis"];
const EDGES = ["padding", "margin", "inset"];
const BORDERS = ["border", "borderTop", "borderBottom", "borderStart", "borderEnd"];
export function convStyle(v: Any): Style {
	if (!isObj(v)) return {};
	const s: Record<string, unknown> = {};
	for (const [k, x] of Object.entries(v)) {
		if (x === undefined || x === null) continue;
		if (DIMS.includes(k)) s[k] = dim(x);
		else if (EDGES.includes(k)) s[k] = edges(x);
		else if (BORDERS.includes(k)) s[k] = border(x);
		else if (k === "gap") s[k] = space(x);
		else if (k === "background" || k === "foreground") s[k] = color(x);
		else if (k === "gridColumn" || k === "gridRow") s[k] = gridSpan(x);
		else s[k] = x;
	}
	return s as Style;
}
function convStates(v: Any) {
	if (!isObj(v)) return undefined;
	const o: Record<string, Style> = {};
	for (const k of ["hover", "pressed", "focusVisible", "disabled", "selected"]) if (v[k]) o[k] = convStyle(v[k]);
	return o;
}
export function convNamedStyles(v: Any): NamedStyle[] {
	return (Array.isArray(v) ? v : []).map((n: Any) => ({ name: String(n.name), style: convStyle(n.style), states: convStates(n.states) }));
}
function convBinding(kind: string, b: Any) {
	const o = typeof b === "string" ? { handler: b } : b;
	return {
		event: kind,
		handler: String(o.handler),
		debounceMs: o.debounceMs,
		throttleMs: o.throttleMs,
		keys: o.keys ?? [],
		preventDefault: !!o.preventDefault,
		stopPropagation: !!o.stopPropagation,
	};
}
function convDrag(v: Any) {
	if (!isObj(v)) return undefined;
	if (v.items) return { tag: "items", val: v.items };
	if (v.text !== undefined) return { tag: "text", val: v.text };
	if (v.custom !== undefined) return { tag: "custom", val: v.custom };
	return undefined;
}
function convValue(v: Any) {
	if (typeof v === "string") return { tag: "text", val: v };
	if (typeof v === "number") return { tag: "number", val: v };
	if (typeof v === "boolean") return { tag: "flag", val: v };
	return { tag: "none" };
}

class Builder {
	nodes: FlatNode[] = [];
	n = 0;

	menu(v: Any): MenuT | undefined {
		if (!isObj(v)) return undefined;
		const items: Any[] = [];
		const add = (it: Any): number => {
			const idx = items.length;
			items.push(null);
			const kids: number[] = (it.children ?? []).map(add);
			items[idx] = {
				kind: it.kind ?? (it.children ? "submenu" : "item"),
				id: String(it.id ?? ""),
				label: optText(it.label),
				icon: optIcon(it.icon),
				shortcut: it.shortcut,
				checked: !!it.checked,
				disabled: !!it.disabled,
				hidden: !!it.hidden,
				danger: !!it.danger,
				children: kids,
			};
			return idx;
		};
		const roots = (v.items ?? []).map(add);
		return { roots, items };
	}

	cell(c: Any): Cell {
		return {
			text: optText(c.text),
			icon: optIcon(c.icon),
			tooltip: optText(c.tooltip),
			color: optColor(c.color),
			bold: !!c.bold,
			sortValue: c.sortValue === undefined ? undefined : (convValue(c.sortValue) as Any),
			content: c.content ? this.node(c.content, 1) : undefined,
		};
	}
	row(r: Any): Row {
		return {
			id: String(r.id),
			depth: r.depth ?? 0,
			expandable: !!r.expandable,
			expanded: !!r.expanded,
			cells: (r.cells ?? []).map((c: Any) => this.cell(c)),
			content: r.content ? this.node(r.content, 1) : undefined,
			height: r.height,
			style: r.style ? convStyle(r.style) : undefined,
			tooltip: optText(r.tooltip),
			draggable: convDrag(r.draggable) as Any,
			disabled: !!r.disabled,
		};
	}
	rows(v: Any) {
		if (Array.isArray(v)) return { tag: "inline", val: v.map((r) => this.row(r)) };
		return { tag: "virtual", val: { count: v.count ?? 0, rowHeight: v.rowHeight ?? 28, overscan: v.overscan ?? 20 } };
	}
	suggest(v: Any) {
		if (!isObj(v)) return undefined;
		return {
			items: (v.items ?? []).map((s: Any) => this.suggestion(s)),
			dynamic: !!v.dynamic,
			minChars: v.minChars ?? 1,
			debounceMs: v.debounceMs ?? 150,
		};
	}
	suggestion(s: Any) {
		return { value: String(s.value), label: text(s.label), detail: optText(s.detail), icon: optIcon(s.icon) };
	}
	choice(c: Any) {
		return {
			value: String(c.value),
			label: text(c.label),
			icon: optIcon(c.icon),
			description: optText(c.description),
			disabled: !!c.disabled,
			group: optText(c.group),
		};
	}
	imageSource(s: Any): Any {
		if (!isObj(s)) throw new TreeError("bad image source");
		if (s.asset !== undefined) return { tag: "asset", val: s.asset };
		if (s.png !== undefined) return { tag: "png", val: Uint8Array.from(Buffer.from(s.png, "base64")) };
		if (s.jpeg !== undefined) return { tag: "jpeg", val: Uint8Array.from(Buffer.from(s.jpeg, "base64")) };
		if (s.svg !== undefined) return { tag: "svg", val: s.svg };
		if (s.attachment !== undefined) return { tag: "attachment", val: s.attachment };
		throw new TreeError("bad image source");
	}
	shape(s: Any) {
		if (!isObj(s)) return {};
		return {
			fill: optColor(s.fill),
			stroke: s.stroke ? { color: color(s.stroke.color), width: s.stroke.width, dashed: !!s.stroke.dashed, roundCaps: !!s.stroke.roundCaps } : undefined,
			opacity: s.opacity,
			hit: s.hit,
			hoverTip: optText(s.hoverTip),
		};
	}
	op(o: Any): Any {
		const { op, ...rest } = o;
		switch (op) {
			case "rect":
				return { tag: "rect", val: { x: rest.x, y: rest.y, width: rest.width, height: rest.height, cornerRadius: rest.cornerRadius ?? 0, style: this.shape(rest.style) } };
			case "ellipse":
				return { tag: "ellipse", val: { cx: rest.cx, cy: rest.cy, rx: rest.rx, ry: rest.ry, style: this.shape(rest.style) } };
			case "line":
				return { tag: "line", val: { x1: rest.x1, y1: rest.y1, x2: rest.x2, y2: rest.y2, style: this.shape(rest.style) } };
			case "polyline":
				return { tag: "polyline", val: { points: rest.points, closed: !!rest.closed, style: this.shape(rest.style) } };
			case "path":
				return { tag: "path", val: { d: rest.d, style: this.shape(rest.style) } };
			case "text":
				return {
					tag: "text",
					val: {
						x: rest.x, y: rest.y, text: text(rest.text), size: rest.size ?? "base", weight: rest.weight ?? "normal", family: rest.family ?? "sans",
						color: rest.color ? color(rest.color) : { tag: "token", val: "foreground" }, anchor: rest.anchor ?? "start", maxWidth: rest.maxWidth, hit: rest.hit,
					},
				}; // prettier-ignore
			case "image":
				return { tag: "image", val: { source: this.imageSource(rest.source), x: rest.x, y: rest.y, width: rest.width, height: rest.height, hit: rest.hit } };
			case "push-group":
				return { tag: "push-group", val: { translateX: rest.translateX ?? 0, translateY: rest.translateY ?? 0, scale: rest.scale ?? 1, rotateDegrees: rest.rotateDegrees ?? 0, clip: rest.clip, opacity: rest.opacity } };
			case "pop-group":
				return { tag: "pop-group" };
		}
		throw new TreeError(`unknown draw op "${op}"`);
	}
	textRun(r: Any) {
		const o = typeof r === "string" ? { text: r } : r;
		return {
			text: text(o.text),
			bold: !!o.bold, italic: !!o.italic, underline: !!o.underline, strike: !!o.strike, mono: !!o.mono,
			color: optColor(o.color), size: o.size,
			link: o.link ? (o.link.url !== undefined ? { tag: "url", val: o.link.url } : { tag: "handler", val: o.link.handler }) : undefined,
		}; // prettier-ignore
	}
	linkTarget(t: Any) {
		return t.url !== undefined ? { tag: "url", val: t.url } : { tag: "handler", val: t.handler };
	}

	/** The kind and its spec from a JSON node. */
	kind(type: string, j: Any): NodeKind {
		const tag = type as KindTag;
		if (!KIND_TAGS.includes(tag)) throw new TreeError(`unknown node type "${type}"`);
		const b = (v: unknown) => !!v;
		let val: Spec | undefined;
		switch (tag) {
			case "box": case "card": case "spacer": break;
			case "grid": val = { columns: (j.columns ?? []).map(dim), rows: (j.rows ?? []).map(dim), columnGap: optSpace(j.columnGap), rowGap: optSpace(j.rowGap) }; break;
			case "scroll": val = { axis: j.axis ?? "vertical", scrollTo: j.scrollTo ? { key: j.scrollTo.key, align: j.scrollTo.align ?? "nearest" } : undefined, stickToEnd: b(j.stickToEnd), alwaysShowBars: b(j.alwaysShowBars) }; break;
			case "split": val = { orientation: j.orientation ?? "row", sizes: j.sizes ?? [], minSizes: j.minSizes ?? [], persistKey: j.persistKey, collapsible: j.collapsible ?? [] }; break;
			case "tabs": val = { tabs: (j.tabs ?? []).map((t: Any) => ({ key: t.key, label: text(t.label), icon: optIcon(t.icon), closable: b(t.closable), disabled: b(t.disabled), badge: t.badge })), selected: j.selected, look: j.look ?? "underline", keepAlive: b(j.keepAlive) }; break;
			case "deck": val = { selected: j.selected ?? 0 }; break;
			case "section": val = { title: text(j.title ?? ""), icon: optIcon(j.icon), open: j.open, summary: optText(j.summary), count: j.count, buttons: (j.buttons ?? []).map((x: Any) => ({ id: x.id, icon: icon(x.icon), label: optText(x.label), disabled: b(x.disabled), hidden: b(x.hidden) })), persistKey: j.persistKey }; break;
			case "group": val = { caption: optText(j.caption) }; break;
			case "toolbar": val = { overflow: j.overflow ?? "wrap" }; break;
			case "separator": val = { orientation: j.orientation ?? "horizontal" }; break;
			case "text": val = { kind: j.kind ?? "body", runs: j.runs ? j.runs.map((r: Any) => this.textRun(r)) : j.text !== undefined ? [this.textRun({ text: j.text })] : [], selectable: b(j.selectable) }; break;
			case "link": val = { label: text(j.label), target: this.linkTarget(j.target), icon: optIcon(j.icon) }; break;
			case "image": val = { source: this.imageSource(j.source), fit: j.fit ?? "contain", alt: optText(j.alt) }; break;
			case "icon": val = { icon: icon(j.icon), size: j.size, color: optColor(j.color), spin: b(j.spin) }; break;
			case "progress": val = { value: j.value, look: j.look ?? "bar", label: optText(j.label) }; break;
			case "badge": val = { label: text(j.label), tone: j.tone ?? "neutral", color: optColor(j.color), icon: optIcon(j.icon), removable: b(j.removable) }; break;
			case "callout": val = { tone: j.tone ?? "info", title: optText(j.title), message: optText(j.message), icon: optIcon(j.icon), dismissible: b(j.dismissible) }; break;
			case "rich-text": val = { format: j.format ?? "markdown", source: j.source ?? "", selectable: b(j.selectable), linkHandler: j.linkHandler }; break;
			case "code": val = { source: j.source ?? "", language: j.language, lineNumbers: b(j.lineNumbers), wrap: b(j.wrap), copyButton: b(j.copyButton) }; break;
			case "skeleton": val = { width: optDim(j.width), height: optDim(j.height) }; break;
			case "button": val = { label: optText(j.label), icon: optIcon(j.icon), look: j.look ?? "standard", size: j.size ?? "md", pressed: j.pressed, loading: b(j.loading), menu: this.menu(j.menu), menuMode: j.menuMode ?? "dropdown", submit: b(j.submit) }; break;
			case "checkbox": val = { label: optText(j.label), checked: b(j.checked), indeterminate: b(j.indeterminate) }; break;
			case "switch": val = { label: optText(j.label), on: b(j.on) }; break;
			case "radio-group": val = { options: (j.options ?? []).map((c: Any) => this.choice(c)), value: j.value, orientation: j.orientation ?? "vertical" }; break;
			case "select": val = { options: (j.options ?? []).map((c: Any) => this.choice(c)), value: j.value, placeholder: optText(j.placeholder), multiple: b(j.multiple), values: j.values ?? [], searchable: b(j.searchable) }; break;
			case "text-input": val = { value: j.value ?? "", placeholder: optText(j.placeholder), kind: j.kind ?? "text", look: j.look ?? "field", multiline: b(j.multiline), minRows: j.minRows, maxRows: j.maxRows, maxLength: j.maxLength, readOnly: b(j.readOnly), selectOnFocus: b(j.selectOnFocus), clearButton: b(j.clearButton), spellcheck: b(j.spellcheck), prefixIcon: optIcon(j.prefixIcon), suggest: this.suggest(j.suggest) }; break;
			case "number-input": val = { value: j.value, min: j.min, max: j.max, step: j.step, unit: optText(j.unit), placeholder: optText(j.placeholder) }; break;
			case "slider": val = { value: j.value ?? 0, min: j.min ?? 0, max: j.max ?? 1, step: j.step, showValue: b(j.showValue) }; break;
			case "color-input": val = { value: j.value ?? "#000000", alpha: b(j.alpha), swatches: j.swatches ?? [] }; break;
			case "date-input": val = { value: j.value ?? "", kind: j.kind ?? "date", min: j.min, max: j.max }; break;
			case "token-input": val = { tokens: (j.tokens ?? []).map((t: Any) => ({ id: String(t.id), label: text(t.label), color: optColor(t.color) })), placeholder: optText(j.placeholder), suggest: this.suggest(j.suggest), allowNew: b(j.allowNew) }; break;
			case "form": val = { busy: b(j.busy) }; break;
			case "list-view": val = { rows: this.rows(j.rows ?? []), selection: j.selection ?? "none", selected: j.selected ?? [], focusRow: j.focusRow, empty: optText(j.empty), persistKey: j.persistKey }; break;
			case "table": val = { columns: (j.columns ?? []).map((c: Any) => ({ key: c.key, label: optText(c.label), icon: optIcon(c.icon), width: c.width, minWidth: c.minWidth, flex: c.flex, align: c.align, sortable: b(c.sortable), resizable: b(c.resizable), hidden: b(c.hidden) })), rows: this.rows(j.rows ?? []), selection: j.selection ?? "none", selected: j.selected ?? [], focusRow: j.focusRow, sort: j.sort, tree: b(j.tree), header: j.header !== false, striped: b(j.striped), empty: optText(j.empty), persistKey: j.persistKey }; break;
			case "popover": val = { open: b(j.open), placement: j.placement ?? "bottom-start", dismissOnOutside: j.dismissOnOutside !== false, width: j.width, maxHeight: j.maxHeight, arrow: b(j.arrow) }; break;
			case "canvas": val = { width: j.width ?? 100, height: j.height ?? 100, background: optColor(j.background), ops: (j.ops ?? []).map((o: Any) => this.op(o)), panZoom: b(j.panZoom), view: j.view ? { zoom: 1, ...j.view } : undefined }; break;
			case "web-view": {
				const s = j.source ?? {};
				val = { source: s.url !== undefined ? { tag: "url", val: s.url } : s.html !== undefined ? { tag: "html", val: s.html } : { tag: "asset", val: s.asset ?? "" }, sandbox: { scripts: b(j.sandbox?.scripts), forms: b(j.sandbox?.forms), popups: b(j.sandbox?.popups), downloads: b(j.sandbox?.downloads), persistStorage: b(j.sandbox?.persistStorage) }, allowHosts: j.allowHosts ?? [], background: optColor(j.background), messaging: b(j.messaging) };
				break;
			}
			case "embed": val = { component: j.component, params: typeof j.params === "string" ? j.params : JSON.stringify(j.params ?? {}) }; break;
		}
		return val === undefined ? { tag } : { tag, val };
	}

	props(j: Any): NodeProps {
		return {
			key: j.key,
			name: j.name,
			pref: j.pref,
			class: j.class ?? [],
			style: convStyle(j.style),
			states: convStates(j.states),
			events: Object.entries(j.on ?? {}).map(([k, b]) => convBinding(k, b)) as Any,
			a11y: { role: j.a11y?.role, label: optText(j.a11y?.label), description: optText(j.a11y?.description), live: j.a11y?.live, hidden: !!j.a11y?.hidden, tabIndex: j.a11y?.tabIndex },
			tooltip: optText(j.tooltip),
			contextMenu: this.menu(j.contextMenu),
			disabled: !!j.disabled,
			hidden: !!j.hidden,
			draggable: convDrag(j.draggable) as Any,
			dropTarget: j.dropTarget ? { accepts: j.dropTarget.accepts ?? [], highlight: !!j.dropTarget.highlight } : undefined,
			autoFocus: !!j.autoFocus,
			testId: j.testId,
		};
	}

	node(j: Any, depth: number): number {
		if (!isObj(j) || typeof j.type !== "string") throw new TreeError("a node needs a `type`");
		if (depth > LIMITS.depth) throw new TreeError(`tree deeper than ${LIMITS.depth}`);
		if (++this.n > LIMITS.nodes) throw new TreeError(`more than ${LIMITS.nodes} nodes`);
		const idx = this.nodes.length;
		this.nodes.push(null as unknown as FlatNode);
		const kind = this.kind(j.type, j);
		const props = this.props(j);
		const children = (j.children ?? []).map((c: Any) => this.node(c, depth + 1));
		this.nodes[idx] = { props, kind, children };
		return idx;
	}
}

let revCounter = 0n;
/** The nested JSON form (a JSON string, or the parsed object) -> the flat WIT tree. Throws TreeError. */
export function jsonToTree(json: unknown): Tree {
	let j: Any = json;
	if (typeof json === "string") {
		try {
			j = JSON.parse(json);
		} catch (e) {
			throw new TreeError("the JSON tree does not parse: " + (e as Error).message);
		}
	}
	if (!isObj(j) || !j.root) throw new TreeError("the JSON tree needs a `root`");
	const b = new Builder();
	const root = b.node(j.root, 0);
	return { rev: j.rev !== undefined ? BigInt(j.rev) : ++revCounter, root, nodes: b.nodes, styles: convNamedStyles(j.styles) };
}

// ---------------------------------------------------------------------------------------------------- flat -> nested

export interface NestedOptions {
	/** Prefix for ids (subtrees of patches and row content). */
	prefix?: string;
	/** Id of the root. Default: `k:<key>` if the root has a key, else `<prefix>0`. */
	rootId?: string;
}

/** Flat -> nested. Resolves `row.content` and `cell.content` of inline rows into `contentNode`. Throws TreeError (cycle, shared node, limits). */
export function buildNested(tree: Pick<Tree, "root" | "nodes">, o: NestedOptions = {}): VNode {
	const seen = new Set<number>();
	let count = 0;
	const prefix = o.prefix ?? "";
	const build = (idx: number, id: string, depth: number): VNode => {
		const n = tree.nodes[idx];
		if (!n) throw new TreeError(`node index ${idx} is out of range`);
		if (seen.has(idx)) throw new TreeError(`node ${idx} is used twice (a cycle or two parents)`);
		seen.add(idx);
		if (depth > LIMITS.depth) throw new TreeError(`tree deeper than ${LIMITS.depth}`);
		if (++count > LIMITS.nodes) throw new TreeError(`more than ${LIMITS.nodes} nodes`);
		const kind = resolveRowContent(n.kind, (ci, cid) => build(ci, cid, depth + 1), id);
		return {
			id,
			props: n.props,
			kind,
			// list<u32> arrives as a Uint32Array from some guests: make it a plain array
			children: Array.from(n.children).map((c, i) => {
				const child = tree.nodes[c];
				return build(c, child?.props.key !== undefined ? "k:" + child.props.key : `${id}/${i}`, depth + 1);
			}),
		};
	};
	const root = tree.nodes[tree.root];
	return build(tree.root, o.rootId ?? (root?.props.key !== undefined ? "k:" + root.props.key : `${prefix}0`), 0);
}

function resolveRowContent(kind: NodeKind, make: (idx: number, id: string) => VNode, nodeId: string): NodeKind {
	if (kind.tag !== "list-view" && kind.tag !== "table") return kind;
	const rows = kind.val?.rows;
	if (!rows || rows.tag !== "inline") return kind;
	const out: Row[] = (rows.val as Row[]).map((r) => ({
		...r,
		contentNode: r.content !== undefined ? make(r.content, `${nodeId}#${r.id}`) : undefined,
		cells: r.cells.map((c, i) => ({ ...c, contentNode: c.content !== undefined ? make(c.content, `${nodeId}#${r.id}:${i}`) : undefined })),
	}));
	return { tag: kind.tag, val: { ...kind.val, rows: { tag: "inline", val: out } } };
}

/** Rows answered by `render-range`: their content indices point into `batch.nodes`. */
export function resolveBatchRows(rows: Row[], nodes: FlatNode[], nodeId: string): Row[] {
	const tree = { root: 0, nodes };
	return rows.map((r) => {
		const one = (idx: number, id: string) => {
			const used = new Set<number>();
			void used;
			return buildNested({ root: idx, nodes: tree.nodes }, { rootId: id });
		};
		return {
			...r,
			contentNode: r.content !== undefined ? one(r.content, `${nodeId}#${r.id}`) : undefined,
			cells: r.cells.map((c, i) => ({ ...c, contentNode: c.content !== undefined ? one(c.content, `${nodeId}#${r.id}:${i}`) : undefined })),
		};
	});
}

// ---------------------------------------------------------------------------------------------------- patches

function find(root: VNode, key: string): { node: VNode; parent?: VNode; index: number } | undefined {
	const id = "k:" + key;
	const walk = (n: VNode, parent: VNode | undefined, index: number): { node: VNode; parent?: VNode; index: number } | undefined => {
		if (n.id === id) return { node: n, parent, index };
		for (let i = 0; i < n.children.length; i++) {
			const r = walk(n.children[i]!, n, i);
			if (r) return r;
		}
		return undefined;
	};
	return walk(root, undefined, 0);
}

/**
 * Apply a patch-set to a nested tree. Mutates `root` and `styles` (call it on a Solid `produce` draft or a copy). Returns false
 * (and leaves the tree as it was before the failing op) when an op names a key the tree does not have: the caller then asks for a resync.
 */
export function applyPatch(root: VNode, styles: Record<string, NamedStyle>, patch: PatchSet): boolean {
	for (const op of patch.ops) {
		switch (op.tag) {
			case "set-styles":
				for (const s of op.val) styles[s.name] = s;
				break;
			case "set-node": {
				const hit = find(root, op.val.key);
				if (!hit) return false;
				hit.node.props = op.val.props;
				hit.node.kind = op.val.kind;
				break;
			}
			case "replace": {
				const hit = find(root, op.val.key);
				if (!hit) return false;
				const sub = buildNested(op.val.subtree, { rootId: hit.node.id });
				for (const s of op.val.subtree.styles) styles[s.name] = s;
				if (hit.parent) hit.parent.children[hit.index] = sub;
				else {
					hit.node.props = sub.props;
					hit.node.kind = sub.kind;
					hit.node.children = sub.children;
				}
				break;
			}
			case "insert": {
				const parent = find(root, op.val.parent);
				if (!parent) return false;
				const sub = buildNested(op.val.subtree, { prefix: `${parent.node.id}/i${op.val.index}.` });
				for (const s of op.val.subtree.styles) styles[s.name] = s;
				parent.node.children.splice(Math.min(op.val.index, parent.node.children.length), 0, sub);
				break;
			}
			case "remove": {
				const hit = find(root, op.val);
				if (!hit?.parent) return false;
				hit.parent.children.splice(hit.index, 1);
				break;
			}
			case "move": {
				const hit = find(root, op.val.key);
				const to = find(root, op.val.parent);
				if (!hit?.parent || !to) return false;
				const [n] = hit.parent.children.splice(hit.index, 1);
				to.node.children.splice(Math.min(op.val.index, to.node.children.length), 0, n!);
				break;
			}
		}
	}
	return true;
}
