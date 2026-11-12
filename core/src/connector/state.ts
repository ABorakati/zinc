// In-memory state shared by the Connector endpoints and the UI: what the UI currently has selected (the save
// target, like Zotero's "currently selected collection") and a revision counter the UI polls to refresh its
// lists after the browser extension saved something.

export type SelectionKind = "library" | "unfiled" | "trash" | "collection" | "search";
export interface UiSelection {
	kind: SelectionKind;
	key?: string;
}

const KINDS: SelectionKind[] = ["library", "unfiled", "trash", "collection", "search"];

let selection: UiSelection = { kind: "library" };
let rev = 0;

export function getSelection(): UiSelection {
	return selection;
}

/** Validate and store the UI's current view. Returns false for a malformed value. */
export function setSelection(v: unknown): boolean {
	if (!v || typeof v !== "object") return false;
	const { kind, key } = v as { kind?: unknown; key?: unknown };
	if (typeof kind !== "string" || !KINDS.includes(kind as SelectionKind)) return false;
	if ((kind === "collection" || kind === "search") && (typeof key !== "string" || !/^[A-Za-z0-9]{1,32}$/.test(key))) return false;
	selection = kind === "collection" || kind === "search" ? { kind: kind as SelectionKind, key: key as string } : { kind: kind as SelectionKind };
	return true;
}

export function getRev(): number {
	return rev;
}

/** Something in the library changed because of the Connector; the polling UI reloads when this moves. */
export function bumpRev(): number {
	return ++rev;
}

// Recently used save targets (Zotero keeps 7), marked `recent: true` in getSelectedCollection.
let recents: { id: string; sessionID: string }[] = [];

export function updateRecents(targetID: string, sessionID: string): void {
	for (const r of recents) {
		if (r.sessionID === sessionID) {
			r.id = targetID;
			break;
		}
	}
	const pos = recents.findIndex((r) => r.id === targetID);
	if (pos !== -1) recents = [...recents.slice(0, pos), ...recents.slice(pos + 1), recents[pos]];
	else recents = recents.concat([{ id: targetID, sessionID }]);
	recents = recents.slice(-7);
}

export function recentTargetIds(): Set<string> {
	return new Set(recents.map((r) => r.id));
}

/** Tests only. */
export function resetConnectorState(): void {
	selection = { kind: "library" };
	recents = [];
	reveal = null;
	revealSeq = 0;
}

// "Show this item in the library" requests (POST /api/ui/reveal, used by the Word sidebar). The UI polls
// /api/ui/selection, sees a new `seq` and selects the item. In memory only: a request is for the running UI.
export interface RevealRequest {
	key: string;
	title: string;
	seq: number;
	/** Date.now() when requested; a UI that starts later still acts on a recent one. */
	at: number;
	/** also open this attachment of the item in the reader ("Open item" in the connector's popup) */
	open?: { key: string; title: string };
}
let reveal: RevealRequest | null = null;
let revealSeq = 0;

export function getReveal(): RevealRequest | null {
	return reveal;
}

/** Ask the UI to show an item (any change moves `rev` too, so a UI that only watches `rev` reloads). */
export function requestReveal(key: string, title: string, open?: { key: string; title: string }): RevealRequest {
	reveal = { key, title, seq: ++revealSeq, at: Date.now(), ...(open ? { open } : {}) };
	bumpRev();
	return reveal;
}

/** Tests only. */
export function resetReveal(): void {
	reveal = null;
	revealSeq = 0;
}
