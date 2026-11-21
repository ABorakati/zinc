// Native note switches: Settings > Experimental > "Show notes natively" and "Edit notes natively" (both off by default).
import { isBool, persisted } from "../../shell/prefs";

export const [nativeNotes, setNativeNotes] = persisted<boolean>("notes.nativeView", false, isBool);

/**
 * Edit opens the `<richtext>` editor (the GPUIX fork's WYSIWYG note editor) instead of the usual one. The npm @gpuix/native 0.11
 * does not have that element and offers no way to ask, so this is a switch: turn it on only with a build of the fork that has it.
 */
export const [richTextEditor, setRichTextEditor] = persisted<boolean>("notes.richText", false, isBool);
