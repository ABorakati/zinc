// "Copy Citation Key": the Quick Copy text (\cite{key}, [@key], @key…) of the selected items, on the clipboard.
import { toast } from "../../ui";
import { copyText } from "../platform";
import { errMsg, plural } from "../text";
import { bbtApi } from "./client";
import { citeRequest } from "./logic";

export async function copyCitationKeys(keys: string[]): Promise<void> {
	if (keys.length === 0) return;
	try {
		const { text } = await bbtApi.cite(citeRequest(keys, await bbtApi.settings()));
		await copyText(text);
		toast(`Copied the citation key${keys.length === 1 ? "" : "s"} of ${plural(keys.length, "item")}`, {
			kind: "success",
			description: text.length > 120 ? `${text.slice(0, 117)}…` : text,
		});
	} catch (e) {
		toast("Could not copy the citation key", { kind: "error", description: errMsg(e) });
	}
}
