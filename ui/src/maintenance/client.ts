// Client for /api/maintenance/* (see core/src/maintenance/api.ts).

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch("/api/maintenance" + path, {
		method,
		headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	if (!res.ok) {
		let msg = res.statusText;
		try { msg = (await res.json()).error ?? msg; } catch { /* keep status text */ }
		throw new Error(msg);
	}
	return res.json() as Promise<T>;
}

export interface EraseReport { erased: number; topLevel: number; filesRemoved: number; filesKept: number; missing: string[] }
export interface RenameFileResult { key: string; status: "renamed" | "skipped"; reason?: string; path?: string }

export const maintenance = {
	trashCounts: () => call<{ items: number; total: number }>("GET", "/trash"),
	erasePreview: (keys: string[]) => call<{ items: number; total: number }>("POST", "/erase/preview", { keys }),
	erase: (keys: string[]) => call<EraseReport>("POST", "/erase", { keys }),
	emptyTrash: (olderThanDays?: number) => call<EraseReport>("POST", "/empty-trash", { olderThanDays }),
	renameTag: (from: string, to: string) => call<{ items: number; merged: boolean }>("POST", "/tags/rename", { from, to }),
	deleteTags: (tags: string[]) => call<{ tags: number; items: number }>("POST", "/tags/delete", { tags }),
	automaticTags: () => call<{ tag: string; count: number }[]>("GET", "/tags/automatic"),
	deleteAutomaticTags: () => call<{ tags: number; items: number }>("POST", "/tags/delete-automatic", {}),
	renameFiles: (attachmentKeys: string[]) => call<{ results: RenameFileResult[] }>("POST", "/rename-files", { attachmentKeys }),
};
