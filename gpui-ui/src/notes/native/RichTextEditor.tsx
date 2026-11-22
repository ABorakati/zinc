// The native note editor: the GPUIX fork's <richtext> element (a ProseMirror JSON document in Zotero's note schema, edited in place)
// under Toolbar.tsx. The note is read with parse.ts, and every edit is serialized back with serialize.ts inside the note's own
// <div data-schema-version data-citation-items> wrapper and saved 800 ms after the last change, when the editor closes and on Done,
// like the Markdown editor (itempane/Notes.tsx). Citations and annotation highlights keep their raw attributes.
import { createComputed, createMemo, createResource, createSignal, onCleanup, Show, type JSX } from "solid-js";
import type { EventPayload } from "@gpuix/native";
import type { KeyEvent } from "@gpuix/native/host";
import { openLink } from "../../itempane/actions";
import { locked, t, tok, tx, TextBtn } from "../../itempane/kit";
import { fail, usePane } from "../../itempane/model";
import { ipApi } from "../../itempane/net";
import { noteSettled, openNoteSession, type NoteSession } from "../../itempane/noteSession";
import { store } from "../../store";
import { withAlpha } from "../../theme";
import { loadNoteParser, type NoteNode } from "./parse";
import { serializeNote } from "./serialize";
import { Toolbar, type Panel, type SelectionState } from "./Toolbar";

export interface RichTextEditorProps {
	noteKey: string;
	/** Done: back to the read-only view (the pending save is flushed first) */
	onClose?: () => void;
	/** `key` is the note that was saved (an editor can outlive the note it was opened on by one save) */
	onSaved?: (html: string, key: string) => void;
	height?: number;
	fill?: boolean;
}

/** A citation was clicked: select the first cited item when it is in this library. */
export function openCitation(c: Record<string, unknown>): void {
	const items = (c.citationItems as { uris?: string[] }[] | undefined) ?? [];
	const key = /\/items\/([A-Z0-9]{8})$/.exec(items[0]?.uris?.[0] ?? "")?.[1];
	if (key) store.selectItem(key);
}

const parseJson = <T,>(s: string | undefined): T | null => {
	try {
		return s ? (JSON.parse(s) as T) : null;
	} catch {
		return null;
	}
};

export function RichTextEditor(p: RichTextEditorProps): JSX.Element {
	const refreshList = usePane().refreshList; // saves can land after the pane is gone: nothing in them reads props or pane state
	// the note as stored (its wrapper's metadata is what saves are written inside) and as a document for the element
	const noteKey = createMemo(() => p.noteKey);
	const [loaded] = createResource(
		noteKey,
		async (k) => {
			try {
				const settled = await noteSettled(k); // an editor just closed on this note may still be saving: its text, not the stored one
				const [d, parser] = await Promise.all([ipApi.item(k), loadNoteParser()]);
				const html = (d.data.note as string | undefined) ?? "";
				const shown = settled?.html ?? html;
				return { key: k, html, doc: parser ? JSON.stringify(parser.parse(shown)) : null, settled: parser ? settled : null };
			} catch (e) {
				fail("Could not load the note", e);
				return { key: k, html: "", doc: null, settled: null };
			}
		},
	);
	// a note whose load has not finished (or is of the note an earlier key named) is not shown: its text is never saved under this key
	// a memo: a pane reload of the same note must not restart the session (it would save from the text as first loaded)
	const ready = createMemo(() => {
		const l = loaded();
		return l && !loaded.loading && l.key === noteKey() ? l : undefined;
	});
	let session: NoteSession<string> | undefined; // one per loaded note; its edits are the element's latest document (JSON)
	const retire = () => {
		const s = session;
		session = undefined;
		void s?.close(); // saves the last edit on the session's own key
	};
	const [status, setStatus] = createSignal<"" | "Saving…" | "Saved">("");
	createComputed(() => {
		const l = ready();
		retire();
		setStatus("");
		if (!l?.doc) return;
		const s: NoteSession<string> = openNoteSession<string>({
			key: l.key,
			base: l.html,
			// the display-only citation text is dropped by serializeNote; an unchanged note is not written
			build: (draft, base) => {
				const doc = parseJson<NoteNode>(draft);
				return doc ? serializeNote(doc, base) : null;
			},
			patch: (key, out) => ipApi.patchItem(key, { note: out }),
			onStatus: (v) => {
				if (session === s) setStatus(v);
			},
			onSaved: (out) => {
				refreshList();
				p.onSaved?.(out, l.key);
			},
			onError: (e) => fail("Could not save the note", e),
		});
		session = s;
		if (l.settled) {
			l.settled.take();
			s.edit(l.doc); // the unsaved text of the editor closed just before is saved by this one
		}
	});
	onCleanup(retire);
	const [sel, setSel] = createSignal<SelectionState | null>(null);
	const [panel, setPanel] = createSignal<Panel>(null);
	const [command, setCommand] = createSignal<{ seq: number; name: string; args?: Record<string, unknown> }>({ seq: 1, name: "focus" });
	let seq = 1;
	const run = (name: string, args?: Record<string, unknown>) => setCommand({ seq: ++seq, name, args });

	const flush = (): Promise<boolean> => session?.flush() ?? Promise.resolve(true);
	const onChange = (e: EventPayload) => {
		if (e.value != null) session?.edit(e.value);
	};
	const onKeyDown = (e: KeyEvent) => {
		// Ctrl/Cmd+K arrives here from the element: open the toolbar's link field
		const m = e.modifiers;
		if ((e.key ?? "").toLowerCase() === "k" && (m?.ctrl || m?.cmd)) setPanel("link");
	};
	const theme = () => ({
		text: tok("foreground"),
		muted: tok("muted-foreground"),
		accent: tok("primary"),
		selection: withAlpha(tok("primary"), 0.28),
		codeBg: tok("muted"),
		link: tok("primary"),
	});

	return (
		<div
			testId="native-note-editor"
			style={{ ...t("flex flex-col gap-1"), width: "100%", ...(p.fill ? { height: "100%", minHeight: 0 } : {}) }}
		>
			<Show when={ready()} fallback={<text style={{ ...tx("text-xs text-muted-foreground"), padding: 8 }}>Opening note…</text>}>
				{(n) => {
					return (
						<Show
							when={n().doc}
							fallback={
								<text style={{ ...tx("text-xs text-muted-foreground"), padding: 8 }}>
									This note could not be opened in the editor.
								</text>
							}
						>
							{(doc) => (
								<>
									<div style={{ ...t("flex flex-row items-start gap-2 px-1"), flexShrink: 0 }}>
										<div style={{ flexGrow: 1, minWidth: 0 }}>
											<Toolbar state={sel} run={run} panel={panel} setPanel={setPanel} disabled={locked()} />
										</div>
										<text style={{ ...tx("text-[11px] text-muted-foreground"), flexShrink: 0, paddingTop: 5 }}>
											{status()}
										</text>
										<Show when={p.onClose}>
											<TextBtn
												label="Done"
												onClick={() => {
													void flush().then((saved) => saved && p.onClose!());
												}}
											/>
										</Show>
									</div>
									<div
										style={{
											...t("flex flex-col px-1"),
											width: "100%",
											...(p.fill ? { flexGrow: 1, minHeight: 0 } : {}),
										}}
									>
										{/* <richtext> scrolls itself (it owns caret reveal), so this box only sizes it. */}
										<richtext
											testId="rt-editor"
											doc={doc()}
											readOnly={locked()}
											placeholder="Write a note"
											theme={theme()}
											command={command()}
											onChange={onChange}
											onSelectionChange={(e) => setSel(parseJson<SelectionState>(e.value))}
											onLinkClick={(e) => void openLink(String(e.value ?? ""))}
											onCitationClick={(e) => {
												const c = parseJson<Record<string, unknown>>(e.value);
												if (c) openCitation(c);
											}}
											onKeyDown={onKeyDown}
											style={
												p.fill
													? { width: "100%", flexGrow: 1, minHeight: 0 }
													: { width: "100%", height: p.height ?? 320 }
											}
										/>
									</div>
								</>
							)}
						</Show>
					);
				}}
			</Show>
		</div>
	);
}
