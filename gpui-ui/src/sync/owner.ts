// Who runs the Zotero sync / Zotero port for this library: this window's own process, or another zotero-next (see ../services.ts).
// Kept apart from state.ts so services.ts can set it without pulling in the UI modules.
import { createSignal } from "solid-js";

export type SyncOwner = "self" | "other" | "off";

const [owner, setOwner] = createSignal<SyncOwner>("self");
const [ownerNote, setOwnerNote] = createSignal("");
export { owner as syncOwner, ownerNote as syncOwnerNote };

export function setSyncOwner(o: SyncOwner, note = ""): void {
	setOwner(o);
	setOwnerNote(note);
}
