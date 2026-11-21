// Native note switches: Settings > Experimental > "Show notes natively" and "Edit notes natively" (both off by default).
import { createElement } from "@gpuix/solid";
import { isBool, persisted } from "../../shell/prefs";

export const [nativeNotes, setNativeNotes] = persisted<boolean>("notes.nativeView", false, isBool);

/** Edit opens the `<richtext>` editor (the GPUIX fork's WYSIWYG note editor) instead of the usual one. */
export const [richTextEditor, setRichTextEditor] = persisted<boolean>("notes.richText", false, isBool);

/**
 * Whether the GPUIX JS in use knows `<richtext>`: npm @gpuix/solid 0.11 throws "Unsupported GPUIX element" for it, so the editor
 * needs the fork's JS (and its native addon). Creating a detached host element has no side effect: it is a plain object until mounted.
 */
export const richTextSupported: boolean = (() => {
	try {
		createElement("richtext");
		return true;
	} catch {
		return false;
	}
})();
