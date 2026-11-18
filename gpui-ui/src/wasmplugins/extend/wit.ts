// TypeScript shapes of plugin-api/wit/extend.wit as jco hands them over: camelCase fields, `option<T>` as T | undefined (null is
// accepted too), variants as { tag, val }, enums as their kebab-case string, flags as an object of booleans.
// Only what the host reads is typed strictly; everything else stays `unknown`.
export type Opt<T> = T | undefined | null;

export type L10nRef = { id: string; args?: { name: string; value?: unknown }[]; fallback?: Opt<string> };
export type LocalizedString = { tag: "plain"; val: string } | { tag: "localized"; val: L10nRef };
export type IconRef = { tag: "builtin" | "bundled" | "svg"; val: string };
export type ThemedIcon = { light: IconRef; dark?: Opt<IconRef> };
export type ColorToken = string;
export type Color =
	| { tag: "token"; val: ColorToken }
	| { tag: "token-alpha"; val: { token: ColorToken; alpha: number } }
	| { tag: "rgba"; val: number }
	| { tag: "themed"; val: { light: number; dark: number } };

export interface TabRef {
	id: string;
	kind: string;
	subtype?: Opt<string>;
}
export interface TabInfo {
	ref: TabRef;
	window: number;
	title: string;
	pinned: boolean;
	item?: Opt<string>;
}
export type RowKind =
	| "library"
	| "group-library"
	| "collection"
	| "saved-search"
	| "unfiled"
	| "trash"
	| "duplicates"
	| "publications"
	| "feed"
	| "other";
export interface TreeRow {
	kind: RowKind;
	library: number;
	key?: Opt<string>;
}
export interface Context {
	window: number;
	tab: TabRef;
	library?: Opt<number>;
	rows: TreeRow[];
	items: string[];
	itemCount: number;
	itemsTruncated: boolean;
	editable: boolean;
	field?: Opt<string>;
}
export interface SortLevel {
	key: string;
	descending: boolean;
}
export interface ViewState {
	row: TreeRow;
	searchText?: Opt<string>;
	tagFilter: string[];
	sort: SortLevel[];
	itemCount: number;
}
export interface Condition {
	tabKinds?: string[];
	minItems?: Opt<number>;
	maxItems?: Opt<number>;
	itemTypes?: string[];
	rowKinds?: RowKind[];
	requireEditable?: boolean;
}

export type MenuTarget =
	| "menubar-file"
	| "menubar-edit"
	| "menubar-view"
	| "menubar-go"
	| "menubar-tools"
	| "menubar-help"
	| "library-item"
	| "library-collection"
	| "library-add-attachment"
	| "library-add-note"
	| "library-add"
	| "tab"
	| "item-info-row"
	| "notes-add-item-note"
	| "notes-add-standalone-note"
	| "sidenav-locate";
export interface MenuHooks {
	showing?: boolean;
	shown?: boolean;
	hiding?: boolean;
	hidden?: boolean;
}
export interface MenuEntry {
	id: string;
	parent?: Opt<string>;
	kind: "item" | "separator" | "submenu";
	label?: Opt<LocalizedString>;
	icon?: Opt<ThemedIcon>;
	swatch?: Opt<Color>;
	check?: Opt<boolean>;
	accelerator?: Opt<string>;
	visibleWhen?: Opt<Condition>;
	enabledWhen?: Opt<Condition>;
	hooks?: MenuHooks;
}
export interface MenuRegistration {
	menuId: string;
	target: MenuTarget;
	entries: MenuEntry[];
}
export interface EntryPatch {
	id: string;
	hidden?: Opt<boolean>;
	disabled?: Opt<boolean>;
	label?: Opt<LocalizedString>;
	icon?: Opt<ThemedIcon>;
	checked?: Opt<boolean>;
}

export interface SectionButton {
	id: string;
	icon: ThemedIcon;
	tooltip?: Opt<LocalizedString>;
	hidden: boolean;
	disabled: boolean;
}
export interface SectionRegistration {
	paneId: string;
	header: { label: LocalizedString; icon: ThemedIcon };
	sidenav: { label: LocalizedString; icon: ThemedIcon; orderable: boolean };
	enabledFor?: Opt<Condition>;
	buttons: SectionButton[];
	bodyHeight?: Opt<number>;
	defaultOpen: boolean;
	decidesEnabled: boolean;
}
export interface InfoRowRegistration {
	rowId: string;
	label: LocalizedString;
	position: "start" | "after-creators" | "end";
	multiline: boolean;
	nowrap: boolean;
	editable: boolean;
	enabledFor?: Opt<Condition>;
}
export interface InfoRowValue {
	value: string;
	enabled: boolean;
	editable: boolean;
}
export interface ColumnRegistration {
	dataKey: string;
	label: LocalizedString;
	trees?: string[];
	sort: "none" | "text" | "number";
	sortReverse?: boolean;
	flex?: Opt<number>;
	width?: Opt<number>;
	minWidth?: Opt<number>;
	fixedWidth?: boolean;
	staticWidth?: boolean;
	noPadding?: boolean;
	icon?: Opt<ThemedIcon>;
	align: "start" | "end" | "center";
	showInPicker?: boolean;
	pickerSubmenu?: boolean;
}
export type CellBody =
	| { tag: "text"; val: string }
	| { tag: "icon"; val: IconRef }
	| { tag: "bar"; val: number }
	| { tag: "rating"; val: { value: number; max: number } }
	| { tag: "chips"; val: { text: string; color?: Opt<Color> }[] };
export interface Cell {
	body: CellBody;
	tooltip?: Opt<string>;
	color?: Opt<Color>;
	style?: "normal" | "bold" | "italic" | "muted" | "strikethrough";
	sortKey?: Opt<{ tag: "text"; val: string } | { tag: "number"; val: number }>;
}
export interface RowStyleRegistration {
	styleId: string;
	trees?: string[];
	priority: number;
}
export interface RowStyle {
	textColor?: Opt<Color>;
	background?: Opt<Color>;
	style?: Cell["style"];
	leadingIcon?: Opt<IconRef>;
	tooltip?: Opt<string>;
}
export interface DecorationRegistration {
	decorationId: string;
}
export interface Decoration {
	badge?: Opt<string>;
	icon?: Opt<IconRef>;
	color?: Opt<Color>;
	tooltip?: Opt<string>;
}
export interface VirtualCollectionRegistration {
	viewId: string;
	label: LocalizedString;
	icon?: Opt<IconRef>;
	parent?: Opt<string>;
	libraries?: number[];
	order: number;
}
export type ToolbarSlot = "library-toolbar" | "top-bar";
export interface ToolbarButtonRegistration {
	buttonId: string;
	slot: ToolbarSlot;
	icon: ThemedIcon;
	tooltip: LocalizedString;
	label?: Opt<LocalizedString>;
	toggle?: Opt<boolean>;
	menu?: MenuEntry[];
	accelerator?: Opt<string>;
	visibleWhen?: Opt<Condition>;
	enabledWhen?: Opt<Condition>;
	order: number;
}
export interface ButtonState {
	icon?: Opt<ThemedIcon>;
	tooltip?: Opt<LocalizedString>;
	hidden?: Opt<boolean>;
	disabled?: Opt<boolean>;
	toggled?: Opt<boolean>;
	badge?: Opt<string>;
}
export interface ToolbarViewRegistration {
	viewId: string;
	slot: ToolbarSlot;
	width?: Opt<number>;
	visibleWhen?: Opt<Condition>;
	order: number;
}
export interface SidePanelRegistration {
	panelId: string;
	title: LocalizedString;
	icon: ThemedIcon;
	side: "left" | "right";
	defaultWidth: number;
	minWidth: number;
	tabKinds?: string[];
	defaultOpen: boolean;
}
export interface ShortcutRegistration {
	shortcutId: string;
	label: LocalizedString;
	defaultAccelerator?: Opt<string>;
	scope: "global" | "library" | "reader";
	enabledWhen?: Opt<Condition>;
	inCommandSearch?: boolean;
}
export type SettingControl =
	| { tag: "toggle"; val: string }
	| { tag: "text"; val: { pref: string; placeholder?: Opt<LocalizedString>; secret: boolean; multiline: boolean } }
	| { tag: "number"; val: { pref: string; min?: Opt<number>; max?: Opt<number>; step?: Opt<number> } }
	| { tag: "choice"; val: { pref: string; options: { value: string; label: LocalizedString }[] } }
	| { tag: "button"; val: { actionId: string; text: LocalizedString } }
	| { tag: "note" }
	| { tag: "custom"; val?: Opt<number> };
export type PrefValue = { tag: "flag"; val: boolean } | { tag: "integer"; val: number } | { tag: "text"; val: string };
export interface SettingRow {
	id: string;
	group?: Opt<LocalizedString>;
	label: LocalizedString;
	description?: Opt<LocalizedString>;
	keywords?: string[];
	control: SettingControl;
	enabledWhen?: Opt<{ pref: string; equals: PrefValue }>;
	visibleWhen?: Opt<{ pref: string; equals: PrefValue }>;
}
export interface PrefPaneRegistration {
	paneId: string;
	parent?: Opt<string>;
	label?: Opt<LocalizedString>;
	icon?: Opt<ThemedIcon>;
	helpUrl?: Opt<string>;
	order: number;
	content: { tag: "rows"; val: SettingRow[] } | { tag: "view" };
	openCloseHooks: boolean;
}
export interface TabSpec {
	tabId: string;
	kind: string;
	title: LocalizedString;
	icon?: Opt<ThemedIcon>;
	index?: Opt<number>;
	select: boolean;
	pinned: boolean;
	closable: boolean;
	state?: Opt<string>;
	item?: Opt<string>;
}
export interface BannerSpec {
	bannerId: string;
	kind: "info" | "warning" | "error";
	text: LocalizedString;
	actions: { id: string; label: LocalizedString }[];
	dismissable: boolean;
	tabKinds?: string[];
}
export interface FileGrant {
	id: string;
	name: string;
	isDirectory: boolean;
	size?: Opt<bigint | number>;
}
export interface DropRegistration {
	dropId: string;
	target: "item-list" | "item-pane" | "collection-row" | "window";
	accepts: { files?: boolean; urls?: boolean; text?: boolean; items?: boolean };
	extensions?: string[];
	label: LocalizedString;
	enabledWhen?: Opt<Condition>;
}
export interface DropPayload {
	files: FileGrant[];
	urls: string[];
	text?: Opt<string>;
	items: string[];
	row?: Opt<TreeRow>;
	item?: Opt<string>;
}
export interface DragFormatRegistration {
	formatId: string;
	mimeType: string;
	label: LocalizedString;
}
export interface SelectOptions {
	clearFilters: boolean;
	focusLibraryTab: boolean;
}
export type SubscribedEvents = { selectionChanged?: boolean; viewChanged?: boolean; tabChanged?: boolean; themeChanged?: boolean };
export type RegistrationKind =
	| "menu"
	| "section"
	| "info-row"
	| "column"
	| "row-style"
	| "collection-decoration"
	| "virtual-collection"
	| "toolbar-button"
	| "toolbar-view"
	| "side-panel"
	| "shortcut"
	| "pref-pane"
	| "drop-target"
	| "drag-format";
export type HostEvent =
	| { tag: "selection-changed"; val: Context }
	| { tag: "view-changed"; val: ViewState }
	| { tag: "tab-added" | "tab-selected" | "tab-moved"; val: TabInfo }
	| { tag: "tab-closed"; val: string }
	| { tag: "theme-changed"; val: "light" | "dark" };
export type OpenModeName = "default" | "reader" | "external-app" | "show-in-folder";
