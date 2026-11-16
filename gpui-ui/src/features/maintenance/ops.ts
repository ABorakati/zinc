// User-facing maintenance operations: confirm, call the API, refresh the stores, toast. (core: /api/maintenance/*)
import { confirm, toast } from "../../ui";
import { get, call, post } from "../http";
import { promptText } from "../kit";
import { currentView, libraryId, refresh, selectOnly, selectedKeys } from "../shared";
import { errMsg, plural } from "../text";
import type { ItemDetail } from "../types";

export interface EraseReport {
	erased: number;
	topLevel: number;
	filesRemoved: number;
	filesKept: number;
	linkedFilesRemoved?: number;
	missing: string[];
}
export interface RenameFileResult {
	key: string;
	status: "renamed" | "skipped";
	reason?: string;
	path?: string;
}

export const maintenance = {
	trashCounts: () => get<{ items: number; total: number }>("/api/maintenance/trash"),
	erasePreview: (keys: string[]) => post<{ items: number; total: number }>("/api/maintenance/erase/preview", { keys }),
	erase: (keys: string[]) => post<EraseReport>("/api/maintenance/erase", { keys }),
	emptyTrash: (olderThanDays?: number) => post<EraseReport>("/api/maintenance/empty-trash", { olderThanDays }),
	// tag routes act on one library (core/src/maintenance/api.ts: `library`, default My Library; 403 for a read-only group)
	renameTag: (from: string, to: string, library = 1) =>
		post<{ items: number; merged: boolean }>("/api/maintenance/tags/rename", { from, to, library }),
	deleteTags: (tags: string[], library = 1) => post<{ tags: number; items: number }>("/api/maintenance/tags/delete", { tags, library }),
	automaticTags: (library = 1) => get<{ tag: string; count: number }[]>("/api/maintenance/tags/automatic?library=" + library),
	deleteAutomaticTags: (library = 1) => post<{ tags: number; items: number }>("/api/maintenance/tags/delete-automatic", { library }),
	renameFiles: (attachmentKeys: string[]) => post<{ results: RenameFileResult[] }>("/api/maintenance/rename-files", { attachmentKeys }),
};

const fail = (what: string, e: unknown) => toast(what, { kind: "error", description: errMsg(e) });

function reportErase(r: { erased: number; filesRemoved: number; linkedFilesRemoved?: number }) {
	const parts = [
		r.filesRemoved ? `${plural(r.filesRemoved, "stored file")} removed` : "",
		r.linkedFilesRemoved ? `${plural(r.linkedFilesRemoved, "file")} removed from the storage folder` : "",
	].filter(Boolean);
	toast(`Permanently deleted ${plural(r.erased, "item")}`, { kind: "success", description: parts.join(", ") || undefined });
}

// ---------------------------------------------------------------- trash

/** Move items to the Trash (trashed) or restore them. */
export async function trashItems(keys: string[], trashed: boolean): Promise<void> {
	try {
		await Promise.all(keys.map((k) => call("PATCH", `/api/items/${encodeURIComponent(k)}`, { data: { deleted: trashed ? 1 : 0 } })));
		refresh();
		toast(`${trashed ? "Moved" : "Restored"} ${plural(keys.length, "item")} ${trashed ? "to Trash" : "from Trash"}`, {
			kind: "success",
		});
	} catch (e) {
		fail(trashed ? "Could not move to Trash" : "Could not restore", e);
	}
}

export async function deletePermanently(keys: string[]): Promise<void> {
	if (!keys.length) return;
	try {
		const p = await maintenance.erasePreview(keys);
		const extra = p.total - p.items;
		const ok = await confirm({
			title: `Permanently delete ${plural(p.items, "item")}?`,
			body:
				`${plural(p.items, "item")}${extra > 0 ? ` and ${plural(extra, "attached file, note or annotation set")} that belong to ${p.items === 1 ? "it" : "them"}` : ""} ` +
				"will be deleted for good and removed from your Zotero library at the next sync. This cannot be undone.",
			confirmLabel: "Delete Permanently",
			danger: true,
		});
		if (!ok) return;
		const r = await maintenance.erase(keys);
		selectOnly(null);
		refresh();
		reportErase(r);
	} catch (e) {
		fail("Could not delete permanently", e);
	}
}

export async function emptyTrash(): Promise<void> {
	try {
		const c = await maintenance.trashCounts();
		if (!c.items) return void toast("The Trash is empty", { kind: "info" });
		const extra = c.total - c.items;
		const ok = await confirm({
			title: "Empty Trash?",
			body:
				`${plural(c.items, "item")}${extra > 0 ? ` (${plural(c.total, "record")} including attachments and notes)` : ""} ` +
				"will be deleted permanently and removed from your Zotero library at the next sync. This cannot be undone.",
			confirmLabel: "Empty Trash",
			danger: true,
		});
		if (!ok) return;
		const r = await maintenance.emptyTrash();
		selectOnly(null);
		refresh();
		reportErase(r);
	} catch (e) {
		fail("Could not empty the Trash", e);
	}
}

/** Delete key: trash (confirm when several); in the Trash view it deletes permanently. Shift+Delete always does. */
export async function deleteSelected(permanent: boolean): Promise<void> {
	const keys = selectedKeys();
	if (!keys.length) return;
	if (permanent || currentView().kind === "trash") return deletePermanently(keys);
	if (keys.length > 1) {
		const ok = await confirm({
			title: `Move ${plural(keys.length, "item")} to the Trash?`,
			body: "You can restore them from the Trash later.",
			confirmLabel: "Move to Trash",
		});
		if (!ok) return;
	}
	await trashItems(keys, true);
	selectOnly(null);
}

// ---------------------------------------------------------------- tags (the tag pane calls these from its menu)

export async function renameTag(tag: string): Promise<void> {
	const to = await promptText({
		title: "Rename tag",
		description: "If a tag with the new name exists, the two are merged.",
		initial: tag,
		confirmLabel: "Rename",
	});
	if (!to || to === tag) return;
	try {
		const r = await maintenance.renameTag(tag, to, libraryId());
		refresh();
		toast(r.merged ? `Merged "${tag}" into "${to}"` : `Renamed "${tag}" to "${to}"`, {
			kind: "success",
			description: plural(r.items, "item") + " updated",
		});
	} catch (e) {
		fail("Could not rename tag", e);
	}
}

export async function deleteTag(tag: string, count?: number): Promise<void> {
	const ok = await confirm({
		title: `Delete tag "${tag}"?`,
		body: `The tag will be removed from ${count === undefined ? "all items" : plural(count, "item")} in your library.`,
		confirmLabel: "Delete Tag",
		danger: true,
	});
	if (!ok) return;
	try {
		const r = await maintenance.deleteTags([tag], libraryId());
		refresh();
		toast(`Deleted tag "${tag}"`, { kind: "success", description: plural(r.items, "item") + " updated" });
	} catch (e) {
		fail("Could not delete tag", e);
	}
}

export async function deleteAutomaticTags(): Promise<void> {
	try {
		const auto = await maintenance.automaticTags(libraryId());
		if (!auto.length) return void toast("There are no automatic tags in this library", { kind: "info" });
		const ok = await confirm({
			title: "Delete automatic tags?",
			body: `${plural(auto.length, "automatic tag")} will be removed from all items in your library. Manually added tags are kept.`,
			confirmLabel: "Delete Automatic Tags",
			danger: true,
		});
		if (!ok) return;
		const r = await maintenance.deleteAutomaticTags(libraryId());
		refresh();
		toast(`Deleted ${plural(r.tags, "automatic tag")}`, { kind: "success", description: plural(r.items, "item") + " updated" });
	} catch (e) {
		fail("Could not delete automatic tags", e);
	}
}

// ---------------------------------------------------------------- files

/** Rename stored attachment files of the given top-level items from their parent metadata. */
export async function renameFilesFromParent(itemKeys: string[]): Promise<void> {
	try {
		const details = await Promise.all(itemKeys.map((k) => get<ItemDetail>(`/api/items/${encodeURIComponent(k)}`)));
		const attachmentKeys = details.flatMap((d) => d.children.filter((c) => c.itemType === "attachment" && c.hasFile).map((c) => c.key));
		if (!attachmentKeys.length) return void toast("No attached files to rename", { kind: "info" });
		const { results } = await maintenance.renameFiles(attachmentKeys);
		const renamed = results.filter((r) => r.status === "renamed").length;
		const skipped = results.filter((r) => r.status === "skipped");
		refresh();
		if (renamed)
			toast(`Renamed ${plural(renamed, "file")}`, {
				kind: "success",
				description: skipped.length ? `${skipped.length} skipped: ${skipped[0]!.reason}` : undefined,
			});
		else toast("No files were renamed", { kind: "info", description: skipped[0]?.reason });
	} catch (e) {
		fail("Could not rename files", e);
	}
}
