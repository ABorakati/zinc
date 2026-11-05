// Export through a Zotero translator: the same folder-picker flow as the built-in formats (io/client.ts runExport).
import { saveTextToFolder, type ExportTarget } from "../io/client";
import { plural, errMsg } from "../text";
import { toast } from "../../ui";
import { translateApi } from "./client";

export async function runTranslatorExport(target: ExportTarget, translatorID: string, includeNotes: boolean): Promise<boolean> {
	try {
		const scope = target.kind === "items" ? { keys: target.keys } : { collectionKey: target.collectionKey };
		const r = await translateApi.export({ ...scope, translatorID, includeNotes });
		const path = await saveTextToFolder(r.filename, r.text);
		if (!path) return false;
		toast(`Exported ${plural(r.count, "item")}`, { kind: "success", description: path });
		return true;
	} catch (e) {
		toast("Export failed", { kind: "error", description: errMsg(e) });
		return false;
	}
}
