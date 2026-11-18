// The reader area of the plugin API (plugin-api/wit/reader.wit) in jco's JS representation: camelCase record fields, `option<T>` as
// `T | undefined`, variants as `{ tag, val }` (a case without a payload is `{ tag }`), enums as strings, u64 as bigint, tuples as arrays,
// `json` as a string. Hand-written, loose where the WIT is large (menu entries come from the extend area's types).
import type { MenuEntry } from "../extend/wit";

export type { MenuEntry };
export type Rect = [number, number, number, number];
export type ItemRef = { library: number; key: string };

export type AnnotationKind = "highlight" | "underline" | "note" | "image" | "ink" | "text";
export interface WitPosition {
	pageIndex?: number;
	rects: Rect[];
	nextPageRects: Rect[];
	paths: number[][];
	width?: number;
	fontSize?: number;
	rotation?: number;
	selector?: string;
}
export interface WitAnnotation {
	key: string;
	library: number;
	attachment: string;
	kind: AnnotationKind;
	color: string;
	text?: string;
	comment: string;
	pageLabel?: string;
	sortIndex: string;
	position: WitPosition;
	tags: { name: string; color?: string }[];
	authorName?: string;
	isExternal: boolean;
	readOnly: boolean;
	hasImage: boolean;
	dateAdded: bigint;
	dateModified: bigint;
}
export interface WitNewAnnotation {
	key?: string;
	kind: AnnotationKind;
	color?: string;
	text?: string;
	comment?: string;
	pageLabel?: string;
	sortIndex?: string;
	position: WitPosition;
	tags: string[];
	authorName?: string;
	isExternal: boolean;
}
export interface WitAnnotationPatch {
	key: string;
	kind?: AnnotationKind;
	color?: string;
	text?: string;
	comment?: string;
	pageLabel?: string;
	sortIndex?: string;
	position?: WitPosition;
	tags?: string[];
}

export type ReaderKind = "pdf" | "epub" | "snapshot";
export interface ReaderInfo {
	id: string;
	kind: ReaderKind;
	attachment: ItemRef;
	parentItem?: string;
	tabId?: string;
	window?: number;
	title: string;
	readOnly: boolean;
	selected: boolean;
}
export interface WitLocation {
	annotation?: string;
	position?: string;
	pdfDest?: string;
	pageIndex?: number;
	pageLabel?: string;
	cfi?: string;
	href?: string;
	scrollYPercent?: number;
}
export interface ViewStats {
	pageIndex?: number;
	pageLabel?: string;
	pagesCount?: number;
	zoom?: number;
	zoomMode?: "custom" | "auto" | "page-width" | "page-height";
	scrollMode?: "vertical" | "horizontal" | "wrapped" | "page";
	spreadMode?: "none" | "odd" | "even";
	flowMode?: string;
	canGoBack: boolean;
	canGoForward: boolean;
}
export type ToolKind = "pointer" | "hand" | "highlight" | "underline" | "note" | "image" | "text" | "ink" | "eraser";
export interface ToolState {
	kind: ToolKind;
	color?: string;
}
export interface AnnotationFilter {
	query: string;
	colors: string[];
	tags: string[];
	authors: string[];
}
export interface FindState {
	active: boolean;
	query: string;
	caseSensitive: boolean;
	entireWord: boolean;
	highlightAll: boolean;
	total?: number;
	index?: number;
}
export interface ReaderState {
	info: ReaderInfo;
	primary: ViewStats;
	secondary?: ViewStats;
	primaryIsActive: boolean;
	primaryViewState: string;
	secondaryViewState?: string;
	tool: ToolState;
	selectedAnnotations: string[];
	filter: AnnotationFilter;
	showAnnotations: boolean;
	sidebar: { open: boolean; view: string; width: number };
	split?: "vertical" | "horizontal";
	find: FindState;
}
export interface TextSelection {
	text: string;
	draft: WitNewAnnotation;
}

export type SlotKind = "toolbar" | "text-selection-popup" | "sidebar-annotation-header";
export type MenuKind = "color" | "view" | "annotation" | "thumbnail" | "selector" | "theme";
export type ListenerTarget = { tag: "slot"; val: SlotKind } | { tag: "menu"; val: MenuKind };
export interface ListenerRegistration {
	id: string;
	target: ListenerTarget;
	readerKinds: ReaderKind[];
	staticMenu: MenuEntry[];
}
export interface PanelRegistration {
	id: string;
	placement: "sidebar-tab" | "alt-view";
	label: { tag: "plain"; val: string } | { tag: "localized"; val: { id: string; fallback?: string } };
	icon?: { tag: "builtin" | "bundled" | "svg"; val: string };
	readerKinds: ReaderKind[];
}
export interface OverlayRegistration {
	id: string;
	readerKinds: ReaderKind[];
}
export interface LinkInterceptorRegistration {
	id: string;
	internal: boolean;
	external: boolean;
}
export type EventKind =
	| "opened"
	| "closed"
	| "tab-selected"
	| "page-changed"
	| "selection-changed"
	| "annotations-selected"
	| "annotations-changed"
	| "tool-changed"
	| "view-state-changed";

export type MenuParams =
	| { tag: "color" }
	| { tag: "view" }
	| { tag: "annotation"; val: { annotations: WitAnnotation[]; current?: string; fromView: boolean; popup: boolean } }
	| { tag: "thumbnail"; val: number[] }
	| { tag: "selector"; val: { enableClearSelection: boolean } }
	| { tag: "theme"; val: string };
export interface MenuContext {
	reader: ReaderInfo;
	params: MenuParams;
}
export interface OverlayShape {
	kind: "fill" | "outline" | "underline";
	rects: Rect[];
	color?: string;
	opacity?: number;
	tooltip?: string;
	command?: string;
}
export type ReaderEvent =
	| { tag: "opened" | "closed" | "tab-selected"; val: ReaderInfo }
	| { tag: "page-changed"; val: { reader: string; pageIndex?: number; pageLabel?: string } }
	| { tag: "selection-changed"; val: { reader: string; selection?: TextSelection } }
	| { tag: "annotations-selected"; val: { reader: string; keys: string[] } }
	| {
			tag: "annotations-changed";
			val: { attachment: ItemRef; added: string[]; modified: string[]; removed: string[]; byThisPlugin: boolean };
	  }
	| { tag: "tool-changed"; val: { reader: string; tool: ToolState } }
	| { tag: "view-state-changed"; val: string };
export type NoteEvent =
	| { tag: "editor-opened" | "editor-closed"; val: EditorInfo }
	| { tag: "note-saved"; val: { editor: string; note: ItemRef; byThisPlugin: boolean } };
export type NoteEventKind = "editor-opened" | "editor-closed" | "note-saved";
export interface EditorInfo {
	id: string;
	note: ItemRef;
	placement: "item-pane" | "note-tab" | "note-window" | "reader-context-pane";
	readOnly: boolean;
	tabId?: string;
	window?: number;
	reader?: string;
}

/** The part of the handler context the service uses (plugin-host's HandlerContext satisfies it). */
export interface PluginCtx {
	readonly pluginId: string;
	has(permission: string): boolean;
	require(permission: string): void;
}

/** How the service reaches a plugin's exports (the supervisor's `call`). */
export type CallPlugin = (plugin: string, iface: string, fn: string, args: unknown[], opts?: { timeoutMs?: number }) => Promise<unknown>;

export class WitFailure extends Error {
	constructor(
		readonly tag: "not-found" | "invalid-argument" | "permission-denied" | "read-only" | "conflict" | "limit-exceeded" | "unavailable" | "internal",
		readonly text: string,
	) {
		super(`${tag}: ${text}`);
		this.name = "WitFailure";
	}
}
export const fail = (tag: WitFailure["tag"], text: string): never => {
	throw new WitFailure(tag, text);
};
