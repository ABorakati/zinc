// Types of the plugin UI in jco's JS representation (what `supervisor.call` returns for `ui-events.*` and what the `ui` import
// handler receives) plus the internal normalized tree (`Tree` / `FlatNode` / `VNode`) used by the Solid renderers.
// Wire trees, patches, row content and styles arrive as JSON strings validated against `plugin-api/ui-schema/ui-tree.schema.json`
// and normalized by `convert.ts`.

export type Spec = Record<string, any>;

export interface L10nRef {
	id: string;
	args: { name: string; value: { tag: string; val: unknown } }[];
	fallback?: string;
}
export type UiText = { tag: "plain"; val: string } | { tag: "localized"; val: L10nRef };
export type IconRef = { tag: "builtin" | "bundled" | "svg"; val: string };
export type Color =
	| { tag: "token"; val: string }
	| { tag: "token-alpha"; val: { token: string; alpha: number } }
	| { tag: "rgba"; val: number }
	| { tag: "themed"; val: { light: number; dark: number } };
export type Space = { tag: "step" | "px"; val: number };
export type Dim = { tag: "px" | "percent" | "step"; val: number } | { tag: "auto" | "fill" | "content" };
export interface Edges {
	top?: Space;
	end?: Space;
	bottom?: Space;
	start?: Space;
}
export interface Border {
	width: number;
	color: Color;
	dashed: boolean;
}
export interface GridSpan {
	start?: number;
	span: number;
}

export interface Style {
	direction?: string;
	wrap?: boolean;
	alignItems?: string;
	justifyContent?: string;
	gap?: Space;
	alignSelf?: string;
	flexGrow?: number;
	flexShrink?: number;
	flexBasis?: Dim;
	width?: Dim;
	height?: Dim;
	minWidth?: Dim;
	minHeight?: Dim;
	maxWidth?: Dim;
	maxHeight?: Dim;
	aspectRatio?: number;
	padding?: Edges;
	margin?: Edges;
	overflow?: string;
	position?: string;
	inset?: Edges;
	zIndex?: number;
	gridColumn?: GridSpan;
	gridRow?: GridSpan;
	background?: Color;
	foreground?: Color;
	border?: Border;
	borderTop?: Border;
	borderBottom?: Border;
	borderStart?: Border;
	borderEnd?: Border;
	radius?: string;
	opacity?: number;
	shadow?: string;
	cursor?: string;
	fontSize?: string;
	fontFamily?: string;
	fontWeight?: string;
	italic?: boolean;
	underline?: boolean;
	strike?: boolean;
	lineHeight?: number;
	textAlign?: string;
	textWrap?: string;
	maxLines?: number;
}
export interface StateStyles {
	hover?: Style;
	pressed?: Style;
	focusVisible?: Style;
	disabled?: Style;
	selected?: Style;
}
export interface NamedStyle {
	name: string;
	style: Style;
	states?: StateStyles;
}

export type EventKind =
	| "press"
	| "double-press"
	| "context-menu"
	| "change"
	| "input"
	| "submit"
	| "focus"
	| "blur"
	| "key-down"
	| "key-up"
	| "hover-enter"
	| "hover-leave"
	| "toggle"
	| "select"
	| "activate"
	| "sort"
	| "resize"
	| "scroll"
	| "drop"
	| "drag-start"
	| "close"
	| "message"
	| "web"
	| "pointer-down"
	| "pointer-move"
	| "pointer-up"
	| "wheel"
	| "view-changed"
	| "visible"
	| "embed";

export interface EventBinding {
	event: EventKind;
	handler: string;
	debounceMs?: number;
	throttleMs?: number;
	keys: string[];
	preventDefault: boolean;
	stopPropagation: boolean;
}

export type UiValue =
	| { tag: "text"; val: string }
	| { tag: "number"; val: number }
	| { tag: "flag"; val: boolean }
	| { tag: "texts"; val: string[] }
	| { tag: "color"; val: string }
	| { tag: "none" };
export interface FormField {
	name: string;
	value: UiValue;
}

export type EventPayloadValue = { tag: string; val?: unknown };
export interface Modifiers {
	shift: boolean;
	ctrl: boolean;
	alt: boolean;
	meta: boolean;
}
export interface UiEvent {
	handler: string;
	nodeKey?: string;
	kind: EventKind;
	modifiers: Modifiers;
	payload: EventPayloadValue;
	rev: bigint;
}

export interface MenuItemT {
	kind: "item" | "check" | "radio" | "separator" | "heading" | "submenu";
	id: string;
	label?: UiText;
	icon?: IconRef;
	shortcut?: string;
	checked: boolean;
	disabled: boolean;
	hidden: boolean;
	danger: boolean;
	children: number[];
}
export interface MenuT {
	roots: number[];
	items: MenuItemT[];
}

export interface A11y {
	role?: string;
	label?: UiText;
	description?: UiText;
	live?: string;
	hidden: boolean;
	tabIndex?: number;
}
export type DragPayload = { tag: "items"; val: string[] } | { tag: "text" | "custom"; val: string };
export interface DropTarget {
	accepts: string[];
	highlight: boolean;
}

export interface NodeProps {
	key?: string;
	name?: string;
	pref?: string;
	class: string[];
	style: Style;
	states?: StateStyles;
	events: EventBinding[];
	a11y: A11y;
	tooltip?: UiText;
	contextMenu?: MenuT;
	disabled: boolean;
	hidden: boolean;
	draggable?: DragPayload;
	dropTarget?: DropTarget;
	autoFocus: boolean;
	testId?: string;
}

export type KindTag =
	| "box"
	| "grid"
	| "scroll"
	| "split"
	| "tabs"
	| "deck"
	| "section"
	| "group"
	| "toolbar"
	| "card"
	| "spacer"
	| "separator"
	| "text"
	| "link"
	| "image"
	| "icon"
	| "progress"
	| "badge"
	| "callout"
	| "rich-text"
	| "code"
	| "skeleton"
	| "button"
	| "checkbox"
	| "switch"
	| "radio-group"
	| "select"
	| "text-input"
	| "number-input"
	| "slider"
	| "color-input"
	| "date-input"
	| "token-input"
	| "form"
	| "list-view"
	| "table"
	| "popover"
	| "canvas"
	| "web-view"
	| "embed";
export const KIND_TAGS: readonly KindTag[] = [
	"box",
	"grid",
	"scroll",
	"split",
	"tabs",
	"deck",
	"section",
	"group",
	"toolbar",
	"card",
	"spacer",
	"separator",
	"text",
	"link",
	"image",
	"icon",
	"progress",
	"badge",
	"callout",
	"rich-text",
	"code",
	"skeleton",
	"button",
	"checkbox",
	"switch",
	"radio-group",
	"select",
	"text-input",
	"number-input",
	"slider",
	"color-input",
	"date-input",
	"token-input",
	"form",
	"list-view",
	"table",
	"popover",
	"canvas",
	"web-view",
	"embed",
];

export interface NodeKind {
	tag: KindTag;
	val?: Spec;
}
/** A node of the normalized flat tree. */
export interface FlatNode {
	props: NodeProps;
	kind: NodeKind;
	children: number[];
}
export interface Tree {
	rev: bigint;
	root: number;
	nodes: FlatNode[];
	styles: NamedStyle[];
}

/** A node of the nested tree the renderers use. `id` is the key (`k:<key>`) or the position (`<parent>/<index>`), stable across renders. */
export interface VNode {
	id: string;
	props: NodeProps;
	kind: NodeKind;
	children: VNode[];
}

export interface Row {
	id: string;
	depth: number;
	expandable: boolean;
	expanded: boolean;
	cells: Cell[];
	/** JSON node string (from `render-range`), node object, or flat node index (for inline rows converted by `Builder`). */
	content?: number | string | Record<string, unknown>;
	height?: number;
	/** JSON style string (from `render-range`) or normalized `Style`. */
	style?: Style | string;
	tooltip?: UiText;
	draggable?: DragPayload;
	disabled: boolean;
	/** Resolved `content` (set by convert.ts; not part of the WIT record). */
	contentNode?: VNode;
}
export interface Cell {
	text?: UiText;
	icon?: IconRef;
	tooltip?: UiText;
	color?: Color;
	bold: boolean;
	sortValue?: UiValue;
	/** JSON node string (from `render-range`), node object, or flat node index (for inline rows converted by `Builder`). */
	content?: number | string | Record<string, unknown>;
	contentNode?: VNode;
}

export type PatchOp =
	| { tag: "set-node"; val: { key: string; props: NodeProps; kind: NodeKind } }
	| { tag: "replace"; val: { key: string; subtree: Tree } }
	| { tag: "insert"; val: { parent: string; index: number; subtree: Tree } }
	| { tag: "remove"; val: string }
	| { tag: "move"; val: { key: string; parent: string; index: number } }
	| { tag: "set-styles"; val: NamedStyle[] };
export interface PatchSet {
	baseRev: bigint;
	rev: bigint;
	ops: PatchOp[];
}
export type ContentUpdate =
	| { tag: "unchanged" }
	| { tag: "json"; val: string }
	| { tag: "patch"; val: string | PatchSet }
	| { tag: "full"; val: Tree };

export interface ButtonState {
	id: string;
	disabled: boolean;
	hidden: boolean;
}
export interface ViewMeta {
	title?: UiText;
	summary?: UiText;
	enabled?: boolean;
	badge?: number;
	buttons: ButtonState[];
}
export interface RenderResult {
	content: ContentUpdate;
	meta?: ViewMeta;
	focus?: string;
}

export type Surface =
	| "item-pane-section"
	| "preferences-pane"
	| "dialog"
	| "window"
	| "tab"
	| "side-panel"
	| "popover"
	| "toolbar-slot"
	| "reader-sidebar"
	| "reader-overlay"
	| "toast"
	| "custom";

export interface ViewContext {
	view: string;
	surface: Surface;
	/** JSON text. */
	params: string;
	theme: "light" | "dark";
	width?: number;
	height?: number;
	locale: string;
}

export interface SortSpec {
	column: string;
	direction: "ascending" | "descending";
}
export interface RowBatch {
	start: number;
	rows: Row[];
	styles?: string | NamedStyle[];
	nodes?: FlatNode[];
	total?: number;
}
export interface Suggestion {
	value: string;
	label: UiText;
	detail?: UiText;
	icon?: IconRef;
}

/**
 * What the UI needs from the plugin supervisor (`createPluginSupervisor` in plugin-host/src/supervisor.ts satisfies it).
 * Declared here so gpui-ui does not type-check the plugin-host package.
 */
export interface UiSupervisor {
	call(id: string, iface: string, fn: string, args?: unknown[], opts?: { timeoutMs?: number }): Promise<unknown>;
	get?(id: string): { id: string; dir: string; status: string; grants?: { capabilities: string[]; netHosts: string[] } } | undefined;
	on?(event: "host-restart" | "host-restarted" | "status", handler: (e: any) => void): () => void;
}

export type LinkTarget = { tag: "url" | "handler"; val: string };
