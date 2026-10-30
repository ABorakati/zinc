// Preferences that more than one part of the UI reads: the Settings page edits them, the owning feature uses them.
// All live in localStorage (which may be unavailable), so every access is try/catch'd.
import { createSignal } from "solid-js";

/** A persisted boolean (localStorage may be unavailable). Key is stored as "zn.flag.<key>". */
export function persistedFlag(key: string, fallback: boolean) {
	const k = "zn.flag." + key;
	let initial = fallback;
	try {
		const v = localStorage.getItem(k);
		if (v !== null) initial = v === "1";
	} catch { /* ignore */ }
	const [flag, setFlag] = createSignal(initial);
	return [flag, (v: boolean) => {
		setFlag(v);
		try { localStorage.setItem(k, v ? "1" : "0"); } catch { /* ignore */ }
	}] as const;
}

/** Which reader opens PDFs: Zotero's own reader, or zotero-next's (reflow, rotation, citation cards).
 *  EPUBs and snapshots always use Zotero's reader. The last choice applies to new tabs. */
export type PdfReader = "zotero" | "next";
const READER_KEY = "zn.pdfReader";
export const READERS: { id: PdfReader; label: string; hint: string }[] = [
	{ id: "zotero", label: "Zotero reader", hint: "Annotations, Zotero look" },
	{ id: "next", label: "Zotero Next reader", hint: "Reflow, fonts, rotation, figures" },
];
const [defaultReader, setDefaultReaderRaw] = createSignal<PdfReader>((() => {
	try { return localStorage.getItem(READER_KEY) === "next" ? "next" : "zotero"; } catch { return "zotero"; }
})());
export const setDefaultReader = (r: PdfReader) => {
	setDefaultReaderRaw(r);
	try { localStorage.setItem(READER_KEY, r); } catch { /* ignore */ }
};
export { defaultReader };

/** Reader tabs idle this many minutes are unloaded (iframe removed, tab kept); 0 = never. */
export const UNLOAD_CHOICES = [0, 5, 10, 30, 60] as const;
const UNLOAD_KEY = "zn.unloadTabsMinutes";
const [unloadTabsMinutes, setUnloadTabsMinutesRaw] = createSignal<number>((() => {
	try {
		const v = Number(localStorage.getItem(UNLOAD_KEY));
		if (localStorage.getItem(UNLOAD_KEY) !== null && (UNLOAD_CHOICES as readonly number[]).includes(v)) return v;
	} catch { /* ignore */ }
	return 10;
})());
export const setUnloadTabsMinutes = (m: number) => {
	setUnloadTabsMinutesRaw(m);
	try { localStorage.setItem(UNLOAD_KEY, String(m)); } catch { /* ignore */ }
};
export { unloadTabsMinutes };

/** References side panel beside Zotero-reader tabs (one toggle for all tabs). */
export const [refsOpen, setRefsOpen] = persistedFlag("references", true);
/** Recognise PDFs added as standalone attachments (drag-drop, Add Attachment) and give them a parent item. */
export const [autoRetrieveMetadata, setAutoRetrieveMetadata] = persistedFlag("autoRetrieveMetadata", true);
/** Tag selector: show tags that were added automatically (by importers/translators). */
export const [showAutoTags, setShowAutoTags] = persistedFlag("showAutomaticTags", true);
