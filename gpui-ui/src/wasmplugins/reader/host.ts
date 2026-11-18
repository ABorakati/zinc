// What the reader bridge needs from the running app and the open readers. The app binds the tab functions with `bindReaderApp`
// (the store: open / close / select a reader tab); everything else comes from the readers themselves (reader/plugins.ts openReaders,
// reader/ops.ts). Without a binding, calls that need the tab strip answer `unavailable`.
import { createSignal } from "solid-js";
import { opsOf } from "../../reader/ops";
import { openReaders, type ReaderContext } from "../../reader/plugins";
import { fail, type ReaderInfo } from "./types";

export interface ReaderApp {
	/** Zotero's numeric library id the attachment lives in (default 1). */
	libraryId?(attachmentKey: string): number;
	/** Open the attachment in a reader tab, or select its tab. */
	openAttachment?(attachmentKey: string, title: string, itemKey: string): void;
	closeTab?(attachmentKey: string): void;
	/** Select a tab ("library" or a reader's attachment key). */
	setActiveTab?(id: string): void;
	/** The shown tab's id. */
	activeTab?(): string;
	/** Select an item in the library tab. */
	selectItem?(key: string): void;
}

const [appSig, setAppSig] = createSignal<ReaderApp>({});
export const bindReaderApp = (a: ReaderApp | undefined): void => {
	setAppSig(a ?? {});
};
/** Reactive: an effect that reads it (or a function of it) follows a later `bindReaderApp`. */
export const readerApp = (): ReaderApp => appSig();

/** The reader id a plugin sees: the attachment key (one reader per attachment, as the tab id is the attachment key). */
export const readerIdOf = (ctx: ReaderContext): string => ctx.attachmentKey;

export function infoOf(ctx: ReaderContext): ReaderInfo {
	const o = opsOf(ctx)?.info();
	const app = readerApp();
	const active = app.activeTab ? app.activeTab() === ctx.attachmentKey : (o?.active ?? true);
	return {
		id: ctx.attachmentKey,
		kind: "pdf",
		attachment: { library: app.libraryId?.(ctx.attachmentKey) ?? 1, key: ctx.attachmentKey },
		parentItem: ctx.itemKey || undefined,
		tabId: ctx.attachmentKey,
		window: undefined,
		title: o?.title ?? "",
		readOnly: !!ctx.readOnly,
		selected: active,
	};
}

export const allReaders = (): ReaderContext[] => openReaders();
export const findReader = (id: string): ReaderContext | undefined => openReaders().find((c) => c.attachmentKey === id);
export function requireReader(id: string): ReaderContext {
	return findReader(id) ?? fail("not-found", `no open reader ${JSON.stringify(id)}`);
}
