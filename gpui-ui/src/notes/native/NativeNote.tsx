// PROTOTYPE: a note shown natively and read-only (NoteDocView), with an Edit button that opens the native <richtext> editor when the
// addon has it (RichTextEditor), else hands it to the usual editor (Zotero's editor in its web view, or the Markdown editor). Used by itempane/Notes.tsx when Settings > Experimental > "Show notes natively" is on.
import { createEffect, createMemo, createResource, createSignal, on, Show, type JSX } from "solid-js";
import { Icon } from "../../icons";
import { ipApi } from "../../itempane/net";
import { fail } from "../../itempane/model";
import { locked, t, tok, tx } from "../../itempane/kit";
import { store } from "../../store";
import { loadNoteParser } from "./parse";
import { NoteDocView } from "./NoteDocView";
import { richTextEditor, richTextSupported } from "./prefs";
import { openCitation, RichTextEditor } from "./RichTextEditor";

export interface NativeNoteProps {
	noteKey: string;
	startEditing?: boolean;
	onClose?: () => void;
	onSaved?: (html: string) => void;
	height?: number;
	fill?: boolean;
	/** the usual editor, for Edit */
	editor: () => JSX.Element;
}

export function NativeNote(p: NativeNoteProps): JSX.Element {
	const [editing, setEditing] = createSignal(!!p.startEditing && !locked());
	// the parent reads the key from pane.detail(), which is a new object after every reload (each save causes one): only a different key counts
	const noteKey = createMemo(() => p.noteKey);
	createEffect(
		on(
			noteKey,
			() => setEditing(!!p.startEditing && !locked()),
			{ defer: true },
		),
	);
	const [html, { mutate }] = createResource(
		() => p.noteKey,
		async (k) => {
			try {
				const d = await ipApi.item(k);
				return (d.data.note as string | undefined) ?? "";
			} catch (e) {
				fail("Could not load the note", e);
				return "";
			}
		},
	);
	const [parser] = createResource(loadNoteParser);
	const doc = () => {
		const h = html(),
			ps = parser();
		return h !== undefined && ps ? ps.parse(h) : null;
	};

	return (
		<Show
			when={!editing()}
			fallback={
				// the native editor when the addon has <richtext>; Done returns to this view with the saved note, else the usual editor
				<Show when={richTextEditor() && richTextSupported} fallback={p.editor()}>
					<RichTextEditor
						noteKey={p.noteKey}
						height={p.height}
						fill={p.fill}
						onSaved={(h, saved) => {
							p.onSaved?.(h);
							if (saved === p.noteKey) mutate(h); // a save landing after the note changed must not replace the new note's text
						}}
						onClose={() => setEditing(false)}
					/>
				</Show>
			}
		>
			<div
				testId="native-note-pane"
				style={{ ...t("flex flex-col"), width: "100%", ...(p.fill ? { height: "100%", minHeight: 0 } : {}) }}
			>
				<div style={{ ...t("flex flex-row items-center gap-2 px-1 pb-1"), flexShrink: 0 }}>
					<Icon name="zap" size={12} color={tok("muted-foreground")} />
					<text style={{ ...tx("text-[11px] text-muted-foreground"), flexGrow: 1 }}>Native view (preview)</text>
					<Show when={!locked()}>
						<div
							testId="native-note-edit"
							role="button"
							aria-label="Edit note"
							onClick={() => setEditing(true)}
							style={{
								...t("flex h-6 items-center gap-1 rounded-md px-2"),
								cursor: "pointer",
								backgroundColor: tok("muted"),
							}}
						>
							<Icon name="pencil" size={12} color={tok("foreground")} />
							<text style={{ ...tx("text-[12px]") }}>Edit</text>
						</div>
					</Show>
					<Show when={p.onClose}>
						<div
							role="button"
							aria-label="Close"
							onClick={() => p.onClose!()}
							style={{ ...t("flex h-6 items-center px-1"), cursor: "pointer" }}
						>
							<Icon name="x" size={14} color={tok("muted-foreground")} />
						</div>
					</Show>
				</div>
				<div
					style={{
						...t("flex flex-col px-1"),
						width: "100%",
						...(p.fill
							? { flexGrow: 1, minHeight: 0, overflowY: "scroll" }
							: p.height
								? { maxHeight: p.height, overflowY: "scroll" }
								: {}),
					}}
				>
					<Show when={doc()} fallback={<text style={{ ...tx("text-xs text-muted-foreground") }}>Opening note…</text>}>
						{(d) => <NoteDocView doc={d()} onCitation={openCitation} />}
					</Show>
				</div>
			</div>
		</Show>
	);
}
