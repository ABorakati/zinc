// Native note switches: Settings > Experimental > "Show notes natively" and "Edit notes natively" (both off by default).
import { createElement } from "@gpuix/solid";
import { isBool, persisted } from "../../shell/prefs";
import * as gpuixNative from "@gpuix/native";

export const [nativeNotes, setNativeNotes] = persisted<boolean>("notes.nativeView", false, isBool);

/** Edit opens the `<richtext>` editor (the GPUIX fork's WYSIWYG note editor) instead of the usual one. */
export const [richTextEditor, setRichTextEditor] = persisted<boolean>("notes.richText", false, isBool);

/** Whether the GPUIX JS in use knows `<richtext>` (npm @gpuix/solid 0.11 throws "Unsupported GPUIX element"; patches/ adds it). */
const jsKnowsRichText: boolean = (() => {
	try {
		createElement("richtext"); // a detached host element is a plain object until mounted: no side effect
		return true;
	} catch {
		return false;
	}
})();

/**
 * Whether the native note editor works here: the JS layer must know `<richtext>` AND the native renderer must draw it. The npm renderer
 * accepts the element without a word and draws nothing, so typing in it would be lost; only the GPUIX fork's renderer has the static
 * GpuixRenderer.supportsElementType. (A namespace import: the web build's module may not have the class at all.)
 */
const nativeDrawsRichText: boolean = (() => {
	const cls = (gpuixNative as unknown as { GpuixRenderer?: { supportsElementType?: (type: string) => boolean } }).GpuixRenderer;
	try {
		return cls?.supportsElementType?.("richtext") === true;
	} catch {
		return false;
	}
})();

export function richTextSupported(): boolean {
	return jsKnowsRichText && nativeDrawsRichText;
}
