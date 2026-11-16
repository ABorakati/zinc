// Where the web reader (reader-host, served by the core at /reader-host/) lives, and which attachments open in it.
// core.ts reports the in-process core's loopback URL once it serves reader-host (setWebBase); in the direct (no-HTTP) mode or when the
// reader-host build is missing there is no base, and attachments other than PDFs open in their default app instead.
import { createSignal } from "solid-js";
import { BASE_URL } from "../api";
import { webViewSupported } from "./host";

let base: string | null | undefined;

/** core.ts: the core's HTTP URL when it serves /reader-host/, null when it cannot. */
export function setWebBase(url: string | null): void {
	base = url ? url.replace(/\/+$/, "") : null;
}

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

// ---- Zotero's note editor (note-host, served at /note-host/; itempane/RichNote.tsx) ----
// The in-process core says whether it serves the build (setNoteBase); an external core is asked once (GET /note-host/editor.html).
const [noteSig, setNoteSig] = createSignal<string | null | undefined>(undefined);
let probed = false;

/** core.ts: the core's HTTP URL when it serves /note-host/, null when it cannot (direct mode, build missing). */
export function setNoteBase(url: string | null): void {
	setNoteSig(url ? url.replace(/\/+$/, "") : null);
}

/** Base URL of the core that serves the note editor; null when notes must use the built-in Markdown editor; undefined while unknown. */
export function noteBase(): string | null | undefined {
	if (!webViewSupported()) return null;
	const v = noteSig();
	if (v !== undefined || probed || process.env.ZN_DB) return v;
	probed = true;
	const b = BASE_URL;
	void fetch(`${b}/note-host/editor.html`, { signal: AbortSignal.timeout(4000) }).then(
		(r) => {
			void r.body?.cancel();
			if (noteSig() === undefined) setNoteSig(r.ok ? b : null);
		},
		() => {
			if (noteSig() === undefined) setNoteSig(null);
		},
	);
	return undefined;
}

/** The note editor page (Zotero's note-editor web build; the app talks to it directly, see webview/notes.ts). */
export function noteEditorUrl(): string | null {
	const b = noteBase();
	return b ? `${b}/note-host/editor.html` : null;
}
