// Where the web reader (reader-host, served by the core at /reader-host/) lives, and which attachments open in it.
// core.ts reports the in-process core's loopback URL once it serves reader-host (setWebBase); in the direct (no-HTTP) mode or when the
// reader-host build is missing there is no base, and attachments other than PDFs open in their default app instead.
import { BASE_URL } from "../api";
import { webViewSupported } from "./host";

let base: string | null | undefined;

/** core.ts: the core's HTTP URL when it serves /reader-host/, null when it cannot. */
export function setWebBase(url: string | null): void { base = url ? url.replace(/\/+$/, "") : null; }

/** Base URL of the core that serves the web reader, or null when web tabs are unavailable. An external core (no ZN_DB) is assumed to serve it, as zotero-next's own does. */
export function webBase(): string | null {
	if (!webViewSupported()) return null;
	if (base !== undefined) return base;
	return process.env.ZN_DB ? null : BASE_URL;
}

/** Content types the web reader opens (snapshots and EPUBs); PDFs go to the native reader. */
export const isWebContent = (contentType: string): boolean => /html|epub/i.test(contentType);

/** The page of the Electrobun app's reader tab (ui/src/App.tsx readerSrc), absolute. */
export function webTabUrl(attachmentKey: string): string | null {
	const b = webBase();
	return b ? `${b}/reader-host/index.html?attachment=${encodeURIComponent(attachmentKey)}` : null;
}
