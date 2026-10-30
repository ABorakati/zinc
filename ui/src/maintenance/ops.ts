// User-facing maintenance operations: confirm, call the API, refresh the stores, toast.
import { toast } from "solid-sonner";
import { api } from "~/api";
import { store } from "~/store";
import { fail, trashItems } from "~/lib/actions";
import { maintenance } from "./client";
import { confirmAction, promptText } from "./dialogs";

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function refreshAll() {
	store.bumpItems();
	store.bumpTags();
	store.refetchCollections();
}

function reportErase(r: { erased: number; filesRemoved: number }) {
	toast.success(`Permanently deleted ${plural(r.erased, "item")}`, {
		description: r.filesRemoved ? `${plural(r.filesRemoved, "stored file")} removed` : undefined,
	});
}

// ---------------------------------------------------------------- trash

export async function deletePermanently(keys: string[]): Promise<void> {
	if (!keys.length) return;
	try {
		const p = await maintenance.erasePreview(keys);
		const extra = p.total - p.items;
		const ok = await confirmAction({
			title: `Permanently delete ${plural(p.items, "item")}?`,
			description:
				`${plural(p.items, "item")}${extra > 0 ? ` and ${plural(extra, "attached file, note or annotation set")} that belong to ${p.items === 1 ? "it" : "them"}` : ""} ` +
				"will be deleted for good and removed from your Zotero library at the next sync. This cannot be undone.",
			confirmLabel: "Delete Permanently",
			destructive: true,
		});
		if (!ok) return;
		const r = await maintenance.erase(keys);
		store.selectOnly(null);
		refreshAll();
		reportErase(r);
	} catch (e) {
		fail("Could not delete permanently", e);
	}
}

export async function emptyTrash(): Promise<void> {
	try {
		const c = await maintenance.trashCounts();
		if (!c.items) return void toast.info("The Trash is empty");
		const extra = c.total - c.items;
		const ok = await confirmAction({
			title: "Empty Trash?",
			description:
				`${plural(c.items, "item")}${extra > 0 ? ` (${plural(c.total, "record")} including attachments and notes)` : ""} ` +
				"will be deleted permanently and removed from your Zotero library at the next sync. This cannot be undone.",
			confirmLabel: "Empty Trash",
			destructive: true,
		});
		if (!ok) return;
		const r = await maintenance.emptyTrash();
		store.selectOnly(null);
		refreshAll();
		reportErase(r);
	} catch (e) {
		fail("Could not empty the Trash", e);
	}
}

/** Delete key: trash (confirm when several); in the Trash view it deletes permanently. Shift+Delete always does. */
export async function deleteSelected(permanent: boolean): Promise<void> {
	const keys = [...store.selected()];
	if (!keys.length) return;
	if (permanent || store.view().kind === "trash") return deletePermanently(keys);
	if (keys.length > 1) {
		const ok = await confirmAction({
			title: `Move ${plural(keys.length, "item")} to the Trash?`,
			description: "You can restore them from the Trash later.",
			confirmLabel: "Move to Trash",
		});
		if (!ok) return;
	}
	await trashItems(keys, true);
	store.selectOnly(null);
}

// ---------------------------------------------------------------- tags

export async function renameTag(tag: string): Promise<void> {
	const to = await promptText({ title: "Rename tag", description: "If a tag with the new name exists, the two are merged.", initial: tag, confirmLabel: "Rename" });
	if (!to || to === tag) return;
	try {
		const r = await maintenance.renameTag(tag, to);
		if (store.tag() === tag) store.setTag(to);
		store.bumpTags();
		store.bumpItems();
		toast.success(r.merged ? `Merged "${tag}" into "${to}"` : `Renamed "${tag}" to "${to}"`, { description: plural(r.items, "item") + " updated" });
	} catch (e) {
		fail("Could not rename tag", e);
	}
}

export async function deleteTag(tag: string, count?: number): Promise<void> {
	const ok = await confirmAction({
		title: `Delete tag "${tag}"?`,
		description: `The tag will be removed from ${count === undefined ? "all items" : plural(count, "item")} in your library.`,
		confirmLabel: "Delete Tag",
		destructive: true,
	});
	if (!ok) return;
	try {
		const r = await maintenance.deleteTags([tag]);
		if (store.tag() === tag) store.setTag(null);
		store.bumpTags();
		store.bumpItems();
		toast.success(`Deleted tag "${tag}"`, { description: plural(r.items, "item") + " updated" });
	} catch (e) {
		fail("Could not delete tag", e);
	}
}

export async function deleteAutomaticTags(): Promise<void> {
	try {
		const auto = await maintenance.automaticTags();
		if (!auto.length) return void toast.info("There are no automatic tags in this library");
		const ok = await confirmAction({
			title: "Delete automatic tags?",
			description: `${plural(auto.length, "automatic tag")} will be removed from all items in your library. Manually added tags are kept.`,
			confirmLabel: "Delete Automatic Tags",
			destructive: true,
		});
		if (!ok) return;
		const r = await maintenance.deleteAutomaticTags();
		const t = store.tag();
		if (t && auto.some((a) => a.tag === t)) store.setTag(null);
		store.bumpTags();
		store.bumpItems();
		toast.success(`Deleted ${plural(r.tags, "automatic tag")}`, { description: plural(r.items, "item") + " updated" });
	} catch (e) {
		fail("Could not delete automatic tags", e);
	}
}

// ---------------------------------------------------------------- files

/** Rename stored attachment files of the given top-level items from their parent metadata. */
export async function renameFilesFromParent(itemKeys: string[]): Promise<void> {
	try {
		const details = await Promise.all(itemKeys.map((k) => api.item(k)));
		const attachmentKeys = details.flatMap((d) => d.children.filter((c) => c.itemType === "attachment" && c.hasFile).map((c) => c.key));
		if (!attachmentKeys.length) return void toast.info("No attached files to rename");
		const { results } = await maintenance.renameFiles(attachmentKeys);
		const renamed = results.filter((r) => r.status === "renamed").length;
		const skipped = results.filter((r) => r.status === "skipped");
		store.bumpItems();
		if (renamed) toast.success(`Renamed ${plural(renamed, "file")}`, { description: skipped.length ? `${skipped.length} skipped: ${skipped[0].reason}` : undefined });
		else toast.info("No files were renamed", { description: skipped[0]?.reason });
	} catch (e) {
		fail("Could not rename files", e);
	}
}
