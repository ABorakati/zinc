// What the extend handler needs from the running app (selection, list view, tabs). The handler is pure; the UI binds the real
// implementation with `bindExtendHost` (extend/bind.ts) at start-up. Until then, and in tests that do not bind one, every call answers
// `unavailable`.
import type { Context, OpenModeName, SelectOptions, TabInfo, TreeRow, ViewState } from "./wit";

export type { OpenModeName };

export interface ExtendHost {
	/** The context of the window the user last used. */
	getContext(): Context;
	listSelected(offset: number, limit: number): string[];
	getView(): ViewState;
	listViewItems(offset: number, limit: number): Promise<{ keys: string[]; total: number }>;
	selectItems(keys: string[], options: SelectOptions): Promise<number>;
	selectRow(row: TreeRow): void;
	setSearch(text: string): void;
	setPanelVisible(panel: "collections-sidebar" | "item-pane", visible: boolean): void;
	/** Settings tab; `paneId` is a plugin pane's namespaced section id. */
	openSettings(sectionId?: string): void;
	openItem(key: string, mode: OpenModeName): Promise<void>;
	/** Show a tab: "library", a reader tab id, the settings tab id or "plugin:<plugin>:<tab>". */
	setActiveTab(id: string): void;
	activeTabId(): string;
	/** Library, reader and settings tabs (plugin tabs are the registry's). */
	builtinTabs(): TabInfo[];
	/** Item types of these keys (conditions on `item-types`), from the list cache. Unknown keys are left out. */
	itemTypes(keys: string[]): Map<string, string>;
}

let host: ExtendHost | undefined;
export const bindExtendHostImpl = (h: ExtendHost | undefined): void => {
	host = h;
};
export const getExtendHost = (): ExtendHost | undefined => host;
