import { toast } from "solid-sonner";
import { api } from "~/api";
import { store } from "~/store";

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const fail = (what: string, e: unknown) => toast.error(what, { description: errMsg(e) });

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export async function addItemsToCollection(collKey: string, name: string, keys: string[]) {
	try {
		await api.addToCollection(collKey, keys);
		store.refetchCollections();
		toast.success(`Added ${plural(keys.length, "item")} to "${name}"`);
	} catch (e) {
		fail("Could not add to collection", e);
	}
}

export async function trashItems(keys: string[], trashed: boolean) {
	try {
		await Promise.all(keys.map((k) => api.setDeleted(k, trashed)));
		store.bumpItems();
		store.refetchCollections();
		toast.success(`${trashed ? "Moved" : "Restored"} ${plural(keys.length, "item")} ${trashed ? "to Trash" : "from Trash"}`);
	} catch (e) {
		fail(trashed ? "Could not move to Trash" : "Could not restore", e);
	}
}

export async function copyDoi(key: string) {
	try {
		const doi = (await api.item(key)).data.DOI;
		if (!doi) return void toast.info("This item has no DOI");
		await navigator.clipboard.writeText(doi);
		toast.success("DOI copied", { description: doi });
	} catch (e) {
		fail("Could not copy DOI", e);
	}
}
