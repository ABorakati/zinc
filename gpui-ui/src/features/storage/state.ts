// The attachment storage settings as the item menu and Settings share them (core: GET /api/files/settings, .storage).
import { createRoot, createSignal } from "solid-js";
import { get } from "../http";

export interface StorageInfo {
	dir: string | null;
	subfolder: string;
	linked: boolean;
	ownDir: string | null;
	patternHelp: string;
	auto: boolean;
	behavior: "move" | "copy";
	allowedExt: string[];
	rename: boolean;
	renameTitle: boolean;
	addTag: boolean;
	tag: string;
	stripDiacritics: boolean;
	undefinedStr: string;
	deleteFiles: boolean;
	pruneEmptyDirs: boolean;
	attachDir: string | null;
	attachConfirm: boolean;
	/** Folders worth offering (the OneDrive "Zotero Library" folder), not checked on disk. */
	suggestions: string[];
}

const [storage, setStorage] = createRoot(() => createSignal<StorageInfo | null>(null));
export { storage, setStorage };

/** Fetch the settings (the menu labels depend on them). Quiet when the core is not reachable yet. */
export async function refreshStorage(): Promise<void> {
	try {
		setStorage((await get<{ storage: StorageInfo }>("/api/files/settings")).storage);
	} catch {
		/* the next menu use or Settings visit retries */
	}
}
