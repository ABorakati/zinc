// What the academic cards can do outside the reader: open an item in the library tab, open an attachment in a reader tab, open a
// URL. The app store is imported lazily, so the plugins load (and the headless harness runs) without starting the library.
import type { ReaderContext } from "../plugins";
import type { AcademicApi } from "./api";

export async function openInLibrary(key: string): Promise<void> {
	const { store } = await import("../../store");
	store.setActiveTab("library");
	store.selectItem(key);
}

export async function openAttachmentTab(key: string, title: string, itemKey: string): Promise<void> {
	const { store } = await import("../../store");
	store.openAttachment(key, title, itemKey);
}

/** Open a web address in the system browser (the core's /api/open-url, or the reader core's openUrl when it has one). */
export function openUrl(ctx: ReaderContext, api: AcademicApi, url: string): void {
	if (ctx.openUrl?.(url)) return;
	void api.openUrl(url).catch((e) => console.warn("[academic] open-url failed:", (e as Error).message));
}
