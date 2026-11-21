// PROTOTYPE switch: Settings > General > "Show notes natively" (off by default). Only offered when Zinc runs from source, where the
// parser's inputs (Zotero's note-editor sources, core's jsdom) are on disk (parse.ts).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isBool, persisted } from "../../shell/prefs";

export const [nativeNotes, setNativeNotes] = persisted<boolean>("notes.nativeView", false, isBool);

/** Whether the native note view can run here (from source, not a packaged build). */
export const nativeNotesSupported = ((): boolean => {
	try {
		return (
			existsSync(fileURLToPath(new URL("../../../../vendor/note-editor/src/core/schema/index.js", import.meta.url))) &&
			existsSync(fileURLToPath(new URL("../../../../core/node_modules/jsdom/package.json", import.meta.url)))
		);
	} catch {
		return false;
	}
})();
