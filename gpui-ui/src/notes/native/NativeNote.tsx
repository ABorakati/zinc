// PROTOTYPE: a note shown natively and edited block by block (NoteDocView, NoteEditView). A click on a block opens its Markdown
// (blockmd.ts) in a <textarea>; a commit replaces the block and saves the note (serializeNote -> PATCH, debounced, flushed on
// close). Blocks with no lossless Markdown form stay read-only here; the "Zotero editor" button hands the note to the usual
// editor (Zotero's editor in its web view, or the Markdown editor). Used by itempane/Notes.tsx when Settings > General >
// "Show notes natively" is on.
import { createEffect, createResource, createSignal, on, onCleanup, Show, type JSX } from "solid-js";
import { Icon } from "../../icons";
import { ipApi } from "../../itempane/net";
import { fail } from "../../itempane/model";
import { locked, t, tok, tx } from "../../itempane/kit";
import { store } from "../../store";
import { blockToMarkdown, markdownToBlocks } from "./blockmd";
import { loadNoteParser, type NoteNode } from "./parse";
import { serializeNote } from "./serialize";
import { NoteDocView, type BlockEdit } from "./NoteDocView";

const SAVE_DELAY_MS = 600;

export interface NativeNoteProps {
	noteKey: string;
	startEditing?: boolean;
	onClose?: () => void;
	onSaved?: (html: string) => void;
	height?: number;
	fill?: boolean;
	/** the usual editor, for "Zotero editor" */
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

	// The document lives in a signal; a block edit replaces one entry of doc.content, so only that block is redrawn.
	const [doc, setDoc] = createSignal<NoteNode | null>(null);
	/** index of the block being edited (doc.content.length = a new paragraph at the end) */
	const [editIdx, setEditIdx] = createSignal<number | null>(null);
	const [status, setStatus] = createSignal("");
	/** the HTML last loaded or saved: serializeNote keeps its wrapper and metadata */
	let sourceHtml = "";
	let pending: { key: string; doc: NoteNode } | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let chain: Promise<void> = Promise.resolve();

	createEffect(() => {
		const h = html(),
			ps = parser();
		if (html.loading || h === undefined || !ps) return;
		sourceHtml = h;
		pending = null;
		setDoc(ps.parse(h));
		setEditIdx(null);
		setStatus("");
	});

	const run = async () => {
		const job = pending;
		if (!job) return;
		pending = null;
		setStatus("Saving…");
		try {
			const out = serializeNote(job.doc, sourceHtml);
			await ipApi.patchItem(job.key, { note: out });
			if (job.key === p.noteKey) {
				sourceHtml = out;
				if (!pending) setStatus("Saved");
			}
			p.onSaved?.(out);
		} catch (e) {
			pending ??= job;
			setStatus("");
			fail("Could not save the note", e);
		}
	};
	/** save now (if anything is pending); resolves when the write is done */
	const flush = (): Promise<void> => {
		clearTimeout(timer);
		timer = undefined;
		chain = chain.then(run);
		return chain;
	};
	const schedule = (d: NoteNode) => {
		pending = { key: p.noteKey, doc: d };
		setStatus("Saving…");
		clearTimeout(timer);
		timer = setTimeout(() => void flush(), SAVE_DELAY_MS);
	};
	// another note opens in this view: write the old one first (pending carries its key and document)
	createEffect(
		on(
			() => p.noteKey,
			() => void flush(),
			{ defer: true },
		),
	);
	onCleanup(() => void flush());

	const edit: BlockEdit = {
		editing: editIdx,
		start: (block) => {
			const i = doc()?.content?.indexOf(block) ?? -1;
			if (i >= 0 && !locked() && blockToMarkdown(block) !== null) setEditIdx(i);
		},
		markdown: blockToMarkdown,
		commit: (text) => {
			const d = doc(),
				i = editIdx();
			if (!d || i === null) return;
			setEditIdx(null);
			const content = [...(d.content ?? [])];
			const old = content[i];
			if (old && blockToMarkdown(old) === text) return;
			content.splice(i, old ? 1 : 0, ...markdownToBlocks(text));
			const next = { ...d, content };
			setDoc(next);
			schedule(next);
		},
		cancel: () => setEditIdx(null),
		add: () => {
			if (!locked()) setEditIdx(doc()?.content?.length ?? 0);
		},
	};

	/** a citation was clicked: select the first cited item when it is in this library */
	const openCitation = (c: Record<string, unknown>) => {
		const items = (c.citationItems as { uris?: string[] }[] | undefined) ?? [];
		const key = /\/items\/([A-Z0-9]{8})$/.exec(items[0]?.uris?.[0] ?? "")?.[1];
		if (key) store.selectItem(key);
	};

	const toZotero = async () => {
		setEditIdx(null);
		await flush();
		setEditing(true);
	};

	return (
		<Show when={!editing()} fallback={p.editor()}>
			<div
				testId="native-note-pane"
				style={{ ...t("flex flex-col"), width: "100%", ...(p.fill ? { height: "100%", minHeight: 0 } : {}) }}
			>
				<div style={{ ...t("flex flex-row items-center gap-2 px-1 pb-1"), flexShrink: 0 }}>
					<Icon name="zap" size={12} color={tok("muted-foreground")} />
					<text style={{ ...tx("text-[11px] text-muted-foreground"), flexGrow: 1 }}>Native editor (preview)</text>
					<Show when={status()}>
						<text testId="native-note-status" style={{ ...tx("text-[11px] text-muted-foreground") }}>
							{status()}
						</text>
					</Show>
					<Show when={!locked()}>
						<div
							testId="native-note-edit"
							role="button"
							aria-label="Open in Zotero's editor"
							onClick={() => void toZotero()}
							style={{
								...t("flex h-6 items-center gap-1 rounded-md px-2"),
								cursor: "pointer",
								backgroundColor: tok("muted"),
							}}
						>
							<Icon name="pencil" size={12} color={tok("foreground")} />
							<text style={{ ...tx("text-[12px]") }}>Zotero editor</text>
						</div>
					</Show>
					<Show when={p.onClose}>
						<div
							role="button"
							aria-label="Close"
							onClick={() => {
								void flush();
								p.onClose!();
							}}
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
						{(d) => <NoteDocView doc={d()} onCitation={openCitation} edit={locked() ? undefined : edit} />}
					</Show>
				</div>
			</div>
		</Show>
	);
}
