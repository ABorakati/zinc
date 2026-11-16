// The ZotMoov item commands: pick the files, call the core (/api/files/organize, /attach-newest), refresh, toast.
// The core copies each file, checks it (size and SHA-256), records it and only then removes the original.
import { canPickFolder, pickFolder } from "../../shell/native";
import { toast } from "../../ui";
import { post } from "../http";
import { promptText } from "../kit";
import { currentView, refresh } from "../shared";
import { baseName, errMsg } from "../text";
import { refreshStorage, storage, type StorageInfo } from "./state";
import { describeOrganize, type OrganizeAction, type OrganizeReport } from "./summary";

const fail = (what: string, e: unknown) => toast(what, { kind: "error", description: errMsg(e) });
const show = (s: ReturnType<typeof describeOrganize>) => toast(s.title, { kind: s.kind, description: s.description });

/** The collection being looked at (the %c wildcard prefers it when the item is filed in several). */
const collectionKey = (): string | undefined => {
	const v = currentView();
	return v.kind === "collection" ? v.key : undefined;
};

/** Move, copy or convert the attachments of the given items. `dir`: another folder than the storage folder. */
export async function organize(keys: string[], action: OrganizeAction, dir?: string): Promise<void> {
	try {
		const r = await post<OrganizeReport>("/api/files/organize", { action, keys, dir, collectionKey: collectionKey() });
		refresh();
		show(describeOrganize(r, action));
	} catch (e) {
		fail(
			action === "copy"
				? "Could not copy the files"
				: action === "to-stored"
					? "Could not convert the files"
					: "Could not move the files",
			e,
		);
	}
}

/** Choose a folder with the native dialog, then move or copy there. */
export async function organizeToFolder(keys: string[], action: "move" | "copy"): Promise<void> {
	if (!canPickFolder())
		return void toast("No folder dialog here", {
			kind: "info",
			description: "Set the storage folder in Settings > Files and folders instead.",
		});
	try {
		const dir = await pickFolder(action === "copy" ? "Copy files to" : "Move files to");
		if (dir) await organize(keys, action, dir);
	} catch (e) {
		fail("Could not open the folder dialog", e);
	}
}

interface AttachPreview {
	source: string;
	size: number;
	proposedName: string;
	dir: string;
}
interface AttachResult extends AttachPreview {
	sourceRemoved: boolean;
	note?: string;
}

/** Attach the newest file of the "attach from" folder to an item (asks for the name first when Settings say so). */
export async function attachNewest(parentKey: string): Promise<void> {
	await refreshStorage();
	const s: StorageInfo | null = storage();
	if (!s?.attachDir)
		return void toast("Choose the folder to attach files from", {
			kind: "info",
			description: "Settings > Files and folders > Attach newest file from.",
		});
	try {
		let name: string | undefined;
		if (s.attachConfirm) {
			const p = await post<AttachPreview>("/api/files/attach-newest", { parentKey, preview: true });
			const chosen = await promptText({
				title: "Attach newest file",
				description: `${baseName(p.source)} will be attached as:`,
				initial: p.proposedName.replace(/\.[^./\\]+$/, ""),
				confirmLabel: "Attach",
			});
			if (!chosen) return;
			name = chosen;
		}
		const r = await post<AttachResult>("/api/files/attach-newest", { parentKey, name });
		refresh();
		toast(`Attached ${baseName(r.source)}`, {
			kind: "success",
			description:
				r.note ??
				(r.sourceRemoved
					? `Now in ${r.dir === s.attachDir && s.dir ? s.dir : "the library"}; removed from ${baseName(r.dir)}.`
					: undefined),
		});
	} catch (e) {
		fail("Could not attach the newest file", e);
	}
}
