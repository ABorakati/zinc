// A note in Zotero's own rich-text editor: a placeholder box that the shared note-editor WebView2 popup (webview/notes.ts) covers. The
// placeholder only reserves the space and shows "Opening note…" until the editor is over it; loading, saving and switching notes are
// the controller's. NoteClip (provided by the item pane's scroller) is the box the editor is cut to when the placeholder scrolls.
import { createContext, createEffect, on, onCleanup, onMount, Show, useContext, type JSX } from "solid-js";
import type { HostElement } from "@gpuix/solid";
import { Icon } from "../icons";
import { claimNote, focusNote, noteShown, noteStatus } from "../webview/notes";
import { t, tok, tx } from "./kit";

/** The scroller a note placeholder sits in (the item pane's list): the editor popup is cut to it, and the wheel goes on to it at the
 *  end of the note's own scrolling. */
export const NoteClip = createContext<{ el: () => HostElement | undefined; scrollBy?: (dy: number) => void } | undefined>(undefined);

export function RichNoteEditor(p: {
	noteKey: string;
	/** take keyboard focus once shown (a new note, "Edit note") */
	startEditing?: boolean;
	onClose?: () => void;
	onSaved?: (html: string) => void;
	/** editor height in px; ignored with `fill` */
	height?: number;
	/** fill the parent's height (a top-level note) */
	fill?: boolean;
}): JSX.Element {
	const clip = useContext(NoteClip);
	let box: HostElement | undefined;
	onMount(() => {
		const release = claimNote({
			key: () => p.noteKey,
			el: () => box,
			clip: clip?.el,
			scrollBy: clip?.scrollBy,
			focus: !!p.startEditing,
			onSaved: (html) => p.onSaved?.(html),
		});
		onCleanup(release);
	});
	createEffect(on(() => p.startEditing, (v) => { if (v) focusNote(); }, { defer: true }));
	const status = () => noteStatus(p.noteKey);

	return (
		<div
			style={{
				...t("flex flex-col w-full overflow-hidden rounded-md border"),
				backgroundColor: tok("background"), borderColor: tok("border"),
				...(p.fill ? { flexGrow: 1, minHeight: 0 } : {}),
			}}
		>
			<div style={{ ...t("flex flex-none h-7 items-center gap-2 border-b px-2"), backgroundColor: tok("muted"), borderColor: tok("border") }}>
				<text style={{ ...tx("text-[11px] text-muted-foreground"), flexGrow: 1, whiteSpace: "nowrap" }}>{status() || "Note"}</text>
				<Show when={p.onClose}>
					<div role="button" aria-label="Close" onClick={() => p.onClose!()} style={{ ...t("flex items-center gap-0.5 rounded px-1"), cursor: "pointer", hover: { backgroundColor: tok("accent") } }}>
						<Icon name="x" size={12} color={tok("muted-foreground")} />
						<text style={{ ...tx("text-[11px] text-muted-foreground") }}>Close</text>
					</div>
				</Show>
			</div>
			<div
				ref={(el: HostElement) => { box = el; }}
				testId="rich-note-box"
				style={{
					...t("flex flex-col items-center justify-center"),
					width: "100%", backgroundColor: tok("background"),
					...(p.fill ? { flexGrow: 1, minHeight: 0 } : { height: p.height ?? 320, flexShrink: 0 }),
				}}
			>
				<text style={{ ...tx("text-xs text-muted-foreground"), opacity: noteShown(p.noteKey) ? 0 : 1 }}>Opening note…</text>
			</div>
		</div>
	);
}
