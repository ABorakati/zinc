// The strip of plugin UI above a note editor (`note-editor.register-head`). itempane/RichNote.tsx (not this area's file) should draw
// `<NoteEditorHead noteKey={...} />` between its header and the editor box; nothing is drawn while no plugin registered a head.
import { For, type JSX } from "solid-js";
import { noteHeads } from "./noteevents";
import { WasmView } from "./view";

export function NoteEditorHead(p: { noteKey: string; library?: number }): JSX.Element {
	return (
		<For each={noteHeads()}>
			{([plugin, id]) => (
				<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 6, width: "100%" }}>
					<WasmView
						plugin={plugin}
						view={id}
						surface="toolbar-slot"
						params={() => ({
							slot: "note-editor-head",
							editor: {
								id: `note:${p.noteKey}`,
								note: { library: p.library ?? 1, key: p.noteKey },
								placement: "item-pane",
								readOnly: false,
							},
						})}
					/>
				</div>
			)}
		</For>
	);
}
