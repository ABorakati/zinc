// PROTOTYPE: a note shown natively and read-only (NoteDocView), with an Edit button that hands it to the usual editor (Zotero's
// editor in its web view, or the Markdown editor). Used by itempane/Notes.tsx when Settings > General > "Show notes natively" is on.
import { createEffect, createResource, createSignal, on, Show, type JSX } from "solid-js";
import { Icon } from "../../icons";
import { ipApi } from "../../itempane/net";
import { fail } from "../../itempane/model";
import { locked, t, tok, tx } from "../../itempane/kit";
import { store } from "../../store";
import { loadNoteParser } from "./parse";
import { NoteDocView } from "./NoteDocView";

export interface NativeNoteProps {
	noteKey: string;
	startEditing?: boolean;
	onClose?: () => void;
	height?: number;
	fill?: boolean;
	/** the usual editor, for Edit */
	editor: () => JSX.Element;
}

export function NativeNote(p: NativeNoteProps): JSX.Element {
	const [editing, setEditing] = createSignal(!!p.startEditing && !locked());
	createEffect(
		on(
			() => p.noteKey,
			() => setEditing(!!p.startEditing && !locked()),
			{ defer: true },
		),
	);
	const [html] = createResource(
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

	/** a citation was clicked: select the first cited item when it is in this library */
	const openCitation = (c: Record<string, unknown>) => {
		const items = (c.citationItems as { uris?: string[] }[] | undefined) ?? [];
		const key = /\/items\/([A-Z0-9]{8})$/.exec(items[0]?.uris?.[0] ?? "")?.[1];
		if (key) store.selectItem(key);
	};

	return (
		<Show when={!editing()} fallback={p.editor()}>
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
