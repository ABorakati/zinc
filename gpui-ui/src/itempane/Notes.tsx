// Notes: the child-note list and the note editor. Like the web UI (which embeds Zotero's note-editor in an iframe), a note opens in
// Zotero's own rich-text editor, here a WebView2 popup over a placeholder (RichNote.tsx, webview/notes.ts). Where that is unavailable
// (no WebView2, no note-host build, the headless renderer) the fallback is the Markdown editor below: the note is shown through the
// native <markdown> element (note HTML -> Markdown with turndown) and edited as Markdown text in a <textarea> (back to HTML with marked
// on save, keeping Zotero's <div data-schema-version> wrapper). Notes that use formatting Markdown cannot hold (annotation highlights
// and citations with attributes, tables, images, super/subscripts, styles) are edited as raw HTML there.
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, type JSX } from "solid-js";
import { Icon } from "../icons";
import { openLink } from "./actions";
import { Empty, IconBtn, locked, Section, TextBtn, goToSection, inputTheme, t, tok, tx } from "./kit";
import { fail, usePane } from "./model";
import { htmlToMarkdown, isSimpleNoteHtml, markdownToHtml, noteWrapper } from "./noteHtml";
import { ipApi } from "./net";
import { firstLine } from "./util";
import { RichNoteEditor } from "./RichNote";
import { richNotesAvailable } from "../webview/notes";
import { NativeNote } from "../notes/native/NativeNote";
import { nativeNotes, nativeNotesSupported } from "../notes/native/prefs";

// A note the item list asked to open (double-click on a child note row); applied once that parent's notes are shown.
const [pendingNote, setPendingNote] = createSignal<{ parentKey: string; noteKey: string } | null>(null);
/** Ask the pane to open a child note in its editor (the item list calls this on a note row's double-click). */
export const showNote = (parentKey: string, noteKey: string) => setPendingNote({ parentKey, noteKey });

/** Theme for the native <markdown> element: the app colours, 13 px text. */
export function markdownTheme() {
	return {
		...inputTheme(),
		bg: "transparent",
		border: tok("border"),
		codeText: tok("foreground"),
		codeWash: tok("muted"),
		metrics: { mdTextSize: 13, mdLineHeight: 19, mdBlockGap: 8, mdHeadingSizes: [20, 17, 15, 13.5] },
	};
}

/** Rendered note (read-only). */
export function NotePreview(p: { markdown: string }): JSX.Element {
	return (
		<markdown
			source={p.markdown || "*Empty note*"}
			theme={markdownTheme()}
			onLinkClick={(e) => void openLink(String((e as { value?: string }).value ?? ""))}
			style={{ width: "100%" }}
		/>
	);
}

function Segmented(p: { value: "edit" | "preview"; onChange: (v: "edit" | "preview") => void }): JSX.Element {
	const opt = (v: "edit" | "preview", label: string, icon: string) => (
		<div
			role="button"
			aria-label={label}
			onClick={() => p.onChange(v)}
			style={{
				...t("flex h-5 items-center gap-1 rounded px-2"),
				cursor: "pointer",
				backgroundColor: p.value === v ? tok("background") : "transparent",
			}}
		>
			<Icon name={icon} size={12} color={tok(p.value === v ? "foreground" : "muted-foreground")} />
			<text style={{ ...tx("text-[11px]"), color: tok(p.value === v ? "foreground" : "muted-foreground") }}>{label}</text>
		</div>
	);
	return (
		<div style={{ ...t("flex rounded-md bg-muted p-[2px]") }}>
			{opt("edit", "Edit", "pencil")}
			{opt("preview", "Preview", "eye")}
		</div>
	);
}

type NoteEditorProps = {
	noteKey: string;
	startEditing?: boolean;
	onClose?: () => void;
	onSaved?: (html: string) => void;
	height?: number;
	fill?: boolean;
};

/** One note: Zotero's editor when it is available, else the Markdown editor. `fill` (top-level notes) fills the parent's height.
 *  With Settings > General > "Show notes natively" (a prototype, from source only) the note opens read-only in the native view first. */
export function NoteEditor(p: NoteEditorProps): JSX.Element {
	return (
		<Show when={nativeNotes() && nativeNotesSupported} fallback={<UsualNoteEditor {...p} />}>
			<NativeNote {...p} editor={() => <UsualNoteEditor {...p} startEditing />} />
		</Show>
	);
}

function UsualNoteEditor(p: NoteEditorProps): JSX.Element {
	return (
		<Show
			when={richNotesAvailable() !== undefined}
			fallback={<text style={{ ...tx("text-xs text-muted-foreground"), padding: 8 }}>Loading…</text>}
		>
			<Show when={richNotesAvailable()} fallback={<MarkdownNoteEditor {...p} />}>
				<RichNoteEditor {...p} />
			</Show>
		</Show>
	);
}

/**
 * One note in the Markdown editor: Edit / Preview toggle over the text. `startEditing` opens in the editor. Saves 800 ms after the last keystroke, when
 * switching to Preview and when closed.
 */
export function MarkdownNoteEditor(p: NoteEditorProps): JSX.Element {
	const pane = usePane();
	const [html, setHtml] = createSignal<string | null>(null);
	const [modeSig, setMode] = createSignal<"edit" | "preview">(p.startEditing && !locked() ? "edit" : "preview");
	const mode = () => (locked() ? "preview" : modeSig()); // a read-only library: the note can be read, not edited
	const [status, setStatus] = createSignal<"" | "Saving…" | "Saved">("");
	let draft = "";
	let dirty = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const simple = createMemo(() => (html() === null ? true : isSimpleNoteHtml(html()!)));
	const markdown = createMemo(() => (html() === null ? "" : htmlToMarkdown(html()!)));
	const source = () => (simple() ? markdown() : (html() ?? ""));

	createEffect(
		on(
			() => p.noteKey,
			(k) => {
				setHtml(null);
				void ipApi.item(k).then(
					(d) => {
						setHtml((d.data.note as string | undefined) ?? "");
						draft = source();
					},
					(e) => fail("Could not load the note", e),
				);
			},
		),
	);

	const toHtml = (text: string) => {
		if (!simple()) return text;
		const w = noteWrapper(html() ?? "");
		return w.open + markdownToHtml(text) + w.close;
	};
	async function flush() {
		clearTimeout(timer);
		if (!dirty) return;
		dirty = false;
		const out = toHtml(draft);
		setStatus("Saving…");
		try {
			await ipApi.patchItem(p.noteKey, { note: out });
			setHtml(out);
			setStatus("Saved");
			p.onSaved?.(out);
			pane.refreshList();
		} catch (e) {
			dirty = true;
			setStatus("");
			fail("Could not save the note", e);
		}
	}
	onCleanup(() => {
		clearTimeout(timer);
		void flush();
	});

	const edit = (v: string) => {
		draft = v;
		dirty = true;
		setStatus("");
		clearTimeout(timer);
		timer = setTimeout(() => void flush(), 800);
	};
	const switchTo = async (m: "edit" | "preview") => {
		if (m === "preview") await flush();
		else draft = source();
		setMode(m);
	};

	return (
		<div
			style={{
				...t("flex flex-col w-full overflow-hidden rounded-md border"),
				backgroundColor: tok("background"),
				borderColor: tok("border"),
			}}
		>
			<div style={{ ...t("flex h-8 items-center gap-2 border-b px-2"), backgroundColor: withMuted(), borderColor: tok("border") }}>
				<Show when={!locked()}>
					<Segmented value={mode()} onChange={(m) => void switchTo(m)} />
				</Show>
				<Show when={locked()}>
					<text style={{ ...tx("text-[11px] text-muted-foreground"), whiteSpace: "nowrap" }}>Read-only</text>
				</Show>
				<Show when={!simple()}>
					<text style={{ ...tx("text-[11px] text-muted-foreground"), whiteSpace: "nowrap" }}>HTML</text>
				</Show>
				<div style={{ flexGrow: 1 }} />
				<Show when={status()}>
					<text style={{ ...tx("text-[11px] text-muted-foreground") }}>{status()}</text>
				</Show>
				<Show when={p.onClose}>
					<div
						role="button"
						aria-label="Close"
						onClick={() => {
							void flush();
							p.onClose!();
						}}
						style={{
							...t("flex items-center gap-0.5 rounded px-1"),
							cursor: "pointer",
							hover: { backgroundColor: tok("accent") },
						}}
					>
						<Icon name="x" size={12} color={tok("muted-foreground")} />
						<text style={{ ...tx("text-[11px] text-muted-foreground") }}>Close</text>
					</div>
				</Show>
			</div>
			<div style={{ ...t("flex flex-col w-full p-3 gap-2") }}>
				<Show when={html() !== null} fallback={<text style={{ ...tx("text-xs text-muted-foreground") }}>Loading…</text>}>
					<Show when={mode() === "edit"} fallback={<NotePreview markdown={markdown()} />}>
						<Show when={!simple()}>
							<text style={{ ...tx("text-[11px] text-muted-foreground"), lineHeight: 15 }}>
								This note has formatting Markdown cannot keep (highlights, citations, tables, images or styles), so it is
								edited as HTML.
							</text>
						</Show>
						<textarea
							autoFocus
							value={source()}
							minRows={6}
							maxRows={p.height ? Math.round(p.height / 18) : 16}
							placeholder="Write a note…  Markdown: # heading, **bold**, *italic*, - list, [text](url)"
							onChange={(e) => edit((e as { value?: string }).value ?? "")}
							onBlur={() => void flush()}
							style={{
								width: "100%",
								padding: 0,
								fontSize: 13,
								lineHeight: 18,
								fontFamily: simple() ? "Inter" : "Consolas",
								color: tok("foreground"),
								backgroundColor: "transparent",
							}}
							theme={inputTheme()}
						/>
					</Show>
				</Show>
			</div>
		</div>
	);
}
const withMuted = () => tok("muted");

export function NotesSection(): JSX.Element {
	const pane = usePane();
	const d = () => pane.detail()!;
	const notes = () => d().children.filter((c) => c.itemType === "note");
	// keyed by note key so a reload after a save does not rebuild (and defocus) the open editor
	const noteKeys = createMemo(() => notes().map((n) => n.key), [] as string[], {
		equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]),
	});
	const [openKey, setOpenKey] = createSignal<string | null>(null);
	const [editing, setEditing] = createSignal(false);
	const [adding, setAdding] = createSignal(false);
	const [hover, setHover] = createSignal<string | null>(null);
	createEffect(on(pane.itemKey, () => setOpenKey(null), { defer: true }));
	createEffect(() => {
		const q = pendingNote();
		if (!q || q.parentKey !== d().data.key || !notes().some((n) => n.key === q.noteKey)) return;
		setPendingNote(null);
		setEditing(false);
		setOpenKey(q.noteKey);
		goToSection("notes"); // like the web UI's scrollIntoView: the editor only shows where its placeholder is on screen
	});

	async function addNote() {
		if (adding()) return;
		setAdding(true);
		try {
			const r = await ipApi.createChild({ itemType: "note", parentItem: d().data.key, note: "<p></p>" });
			await pane.reload();
			pane.refreshList();
			setEditing(true);
			setOpenKey(r.data.key);
		} catch (e) {
			fail("Could not add note", e);
		} finally {
			setAdding(false);
		}
	}
	async function trash(key: string) {
		try {
			await ipApi.setDeleted(key, true);
			if (openKey() === key) setOpenKey(null);
			await pane.reload();
			pane.refreshList();
		} catch (e) {
			fail("Could not delete note", e);
		}
	}

	return (
		<Section
			id="notes"
			title="Notes"
			icon="sticky-note"
			count={notes().length}
			actions={
				<Show when={!locked()}>
					<IconBtn icon="plus" title="Add Note" disabled={adding()} onClick={() => void addNote()} />
				</Show>
			}
		>
			<Show
				when={notes().length}
				fallback={
					<Empty text="No notes">
						<Show when={!locked()}>
							<TextBtn icon="plus" label="Add Note" disabled={adding()} onClick={() => void addNote()} />
						</Show>
					</Empty>
				}
			>
				<For each={noteKeys()}>
					{(nk) => {
						const n = {
							get key() {
								return nk;
							},
							get title() {
								return notes().find((x) => x.key === nk)?.title ?? "";
							},
						};
						return (
							<div style={{ ...t("flex flex-col w-full") }}>
								<div
									onMouseEnter={() => setHover(n.key)}
									onMouseLeave={() => setHover((h) => (h === n.key ? null : h))}
									onClick={() => {
										setEditing(false);
										setOpenKey(openKey() === n.key ? null : n.key);
									}}
									style={{
										...t("flex items-center gap-1.5 rounded px-1.5 py-[3px]"),
										cursor: "pointer",
										backgroundColor: openKey() === n.key || hover() === n.key ? tok("accent") : "transparent",
									}}
								>
									<Icon name="sticky-note" size={16} color="#f59e0b" />
									<text
										style={{
											...tx("text-[13px]"),
											flexGrow: 1,
											flexShrink: 1,
											minWidth: 0,
											whiteSpace: "nowrap",
											overflow: "hidden",
											textOverflow: "ellipsis",
										}}
									>
										{n.title || "Untitled note"}
									</text>
									<Show when={hover() === n.key}>
										<div
											onClick={(e) => (e as { stopPropagation?: () => void }).stopPropagation?.()}
											style={{ ...t("flex flex-none items-center") }}
										>
											<Show when={!locked()}>
												<IconBtn
													icon="pencil"
													title="Edit note"
													onClick={() => {
														setEditing(true);
														setOpenKey(n.key);
													}}
												/>
												<IconBtn icon="trash-2" title="Move note to Trash" onClick={() => void trash(n.key)} />
											</Show>
										</div>
									</Show>
								</div>
								<Show when={openKey() === n.key}>
									<div style={{ marginTop: 4, marginBottom: 6, width: "100%" }}>
										<NoteEditor
											noteKey={n.key}
											startEditing={editing() && !locked()}
											onClose={() => setOpenKey(null)}
											onSaved={() => void pane.reload()}
										/>
									</div>
								</Show>
							</div>
						);
					}}
				</For>
			</Show>
		</Section>
	);
}

export { firstLine };
