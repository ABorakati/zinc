// The `note-editor` import and `note-events` (reader.wit), within what note-host can do today.
//
// Zinc has ONE note editor: a shared WebView2 popup over whichever note placeholder was claimed last (webview/notes.ts). So there is at
// most one editor instance (id `note:<key>`); a note that is not open is read and changed through the core. What note-host offers a
// plugin: current HTML (after a save), the selected text, insert at the cursor (the editor's own `insertHTML` message), replace the
// document (`init` again with the new HTML), save now. `open-note` selects the note in the library's item pane (no note tabs or windows).
// Not available (answers `unavailable`): embedded images (the core has no embedded-image attachments). The head strip over the editor
// (`NoteEditorHead`) is drawn by itempane/RichNote.tsx while plugins are on.
import { apiRequest } from "../../api";
import { findReader } from "./host";
import { markOwnNoteSave, noteHeadRegistry, notesModule, type NotesModule } from "./noteevents";
import { readerMode } from "../../reader/env";
import { fail, type EditorInfo, type ItemRef, type PluginCtx, type WitAnnotation } from "./types";
import { createAnnotationsApi } from "./annotations";


const editorId = (key: string) => `note:${key}`;
const keyOfEditor = (editor: string): string => (editor.startsWith("note:") ? editor.slice(5) : fail("not-found", `editor ${editor}`));

async function currentEditor(): Promise<EditorInfo | undefined> {
	const d = (await notesModule()).noteDebug();
	if (!d.key || !d.pageReady) return undefined;
	return { id: editorId(d.key), note: { library: 1, key: d.key }, placement: "item-pane", readOnly: false, tabId: undefined, window: undefined, reader: undefined };
}
async function requireEditor(editor: string): Promise<{ key: string; m: NotesModule }> {
	const key = keyOfEditor(editor);
	const m = await notesModule();
	if (m.noteDebug().key !== key) fail("not-found", `editor ${editor} is not open`);
	return { key, m };
}

async function noteHtml(key: string): Promise<string> {
	try {
		const d = await apiRequest<{ data?: { note?: unknown; itemType?: unknown } }>("GET", `/items/${encodeURIComponent(key)}`);
		if (d.data?.itemType !== "note") return fail("not-found", `${key} is not a note`);
		return String(d.data.note ?? "");
	} catch (e) {
		if (e instanceof Error && e.name === "WitFailure") throw e;
		return fail("not-found", `note ${key}`);
	}
}

// ---------------------------------------------------------------- annotations as note HTML (Zotero's default templates)

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const DEFAULT_TEMPLATES = {
	highlight: "<p>{{highlight}} {{citation}} {{comment}}</p>",
	note: "<p>{{citation}} {{comment}}</p>",
	image: "<p>{{image}} {{citation}} {{comment}}</p>",
};

/** One annotation as note HTML. `template` uses {{highlight}} {{comment}} {{citation}} {{image}} {{tags}} {{color}}; others are left empty. */
export function annotationHtml(a: WitAnnotation, template?: string): string {
	const kind = a.kind === "highlight" || a.kind === "underline" ? "highlight" : a.kind === "image" ? "image" : "note";
	if (kind === "highlight" && !a.text) return "";
	if (kind === "note" && !a.comment && a.kind !== "text") return "";
	if (a.kind === "ink") return "";
	const payload = encodeURIComponent(
		JSON.stringify({
			attachmentURI: `zotero://select/library/items/${a.attachment}`,
			annotationKey: a.key,
			color: a.color,
			pageLabel: a.pageLabel,
			position: { pageIndex: a.position.pageIndex, rects: a.position.rects },
		}),
	);
	const values: Record<string, string> = {
		highlight: a.text ? `<span class="${a.kind === "underline" ? "underline" : "highlight"}" data-annotation="${payload}">“${esc(a.text)}”</span>` : "",
		comment: a.comment ? esc(a.comment).replace(/\n/g, "<br/>") : "",
		citation: a.pageLabel ? `<span>(p. ${esc(a.pageLabel)})</span>` : "",
		image: a.kind === "image" ? `<span data-annotation="${payload}">[image, p. ${esc(a.pageLabel ?? "?")}]</span>` : "",
		tags: a.tags.map((t) => esc(t.name)).join(", "),
		color: esc(a.color),
	};
	const t = template ?? DEFAULT_TEMPLATES[kind];
	return t.replace(/\{\{\s*(\w+)[^}]*\}\}/g, (_m, k: string) => values[k] ?? "").replace(/\s+(<\/p>)/g, "$1");
}

export function annotationsHtml(list: WitAnnotation[], template?: string): string {
	return list
		.map((a) => annotationHtml(a, template))
		.filter(Boolean)
		.join("\n");
}

/** Put `html` inside the note's wrapper div, at its start or end. */
export function spliceNote(note: string, html: string, at: "start" | "end"): string {
	const open = /^\s*<div[^>]*>/.exec(note);
	if (!open) return at === "start" ? html + note : note + html;
	if (at === "start") return open[0] + html + note.slice(open[0].length);
	const close = note.lastIndexOf("</div>");
	return close < 0 ? note + html : note.slice(0, close) + html + note.slice(close);
}

// ---------------------------------------------------------------- the interface

export function createNoteApi() {
	const annotationsApi = createAnnotationsApi();
	const refsToWit = async (ctx: PluginCtx, refs: ItemRef[]) => {
		const got = await annotationsApi.getAnnotations(ctx, refs);
		return got.filter((a): a is WitAnnotation => !!a);
	};
	const insertHtml = async (ctx: PluginCtx, editor: string, html: string, at: string) => {
		ctx.require("note-editor.write");
		const { key, m } = await requireEditor(editor);
		if (at === "cursor") {
			m.noteEval(`window.__zn&&__zn.post(${JSON.stringify({ action: "insertHTML", pos: null, html })})`);
			return;
		}
		await m.flushNote();
		const next = spliceNote(await noteHtml(key), html, at === "start" ? "start" : "end");
		await replace(m, key, next, ctx.pluginId);
	};
	const replace = async (m: NotesModule, key: string, html: string, plugin?: string) => {
		if (plugin) markOwnNoteSave(key, plugin);
		await apiRequest("PATCH", `/items/${encodeURIComponent(key)}`, { data: { note: html } }).catch((e: Error) => fail("internal", e.message));
		const d = m.noteDebug();
		m.noteEval(
			`window.__zn&&__zn.open(${JSON.stringify({ instanceID: d.instanceID, value: html, readOnly: false, disableDrag: false, isAttachmentNote: false, colorScheme: readerMode()() })})`,
		);
	};

	return {
		async listEditors(ctx: PluginCtx): Promise<EditorInfo[]> {
			ctx.require("note-editor.read");
			const e = await currentEditor();
			return e ? [e] : [];
		},
		async activeEditor(ctx: PluginCtx): Promise<EditorInfo | undefined> {
			ctx.require("note-editor.read");
			return currentEditor();
		},
		/** Zinc has no note tabs or windows: the note is selected in the library's item pane, where the one editor lives (so no editor-info yet). */
		async openNote(ctx: PluginCtx, req: { note: { key: string } }): Promise<undefined> {
			ctx.require("note-editor.control");
			const opened = await (await notesModule()).openNote(req.note.key);
			if (!opened) fail("not-found", `note ${req.note.key}`);
			return undefined;
		},
		async focus(ctx: PluginCtx, editor: string): Promise<void> {
			ctx.require("note-editor.control");
			const { m } = await requireEditor(editor);
			m.focusNote();
		},
		async getContent(ctx: PluginCtx, editor: string): Promise<{ html: string; state?: string }> {
			ctx.require("note-editor.read");
			const key = keyOfEditor(editor);
			const m = await notesModule();
			if (m.noteDebug().key === key) {
				await m.flushNote();
				const d = m.noteDebug();
				if (d.saved !== null) return { html: d.saved, state: undefined };
			}
			return { html: await noteHtml(key), state: undefined };
		},
		async getSelection(ctx: PluginCtx, editor: string): Promise<{ text: string; html: string } | undefined> {
			ctx.require("note-editor.read");
			const { m } = await requireEditor(editor);
			const nonce = Math.random().toString(36).slice(2);
			m.noteEval(
				`(function(){var s=getSelection(),t=s?String(s):"",h="";try{if(s&&s.rangeCount){var d=document.createElement("div");d.appendChild(s.getRangeAt(0).cloneContents());h=d.innerHTML}}catch(e){}window.znMsg(JSON.stringify({type:"probe",value:{nonce:${JSON.stringify(nonce)},text:t,html:h}}))})()`,
			);
			for (let i = 0; i < 20; i++) {
				await Bun.sleep(25);
				const v = m.noteDebug().probe as { nonce?: string; text?: string; html?: string } | undefined;
				if (v?.nonce === nonce) return v.text ? { text: v.text, html: v.html || esc(v.text) } : undefined;
			}
			return undefined;
		},
		insertHtml,
		async insertAnnotations(ctx: PluginCtx, editor: string, refs: ItemRef[]): Promise<void> {
			ctx.require("note-editor.write");
			const list = await refsToWit(ctx, refs);
			if (!list.length) return fail("not-found", "none of the annotations was found");
			await insertHtml(ctx, editor, annotationsHtml(list), "cursor");
		},
		async applyUpdate(ctx: PluginCtx, editor: string, content: { html: string }): Promise<void> {
			ctx.require("note-editor.write");
			const { key, m } = await requireEditor(editor);
			await replace(m, key, content.html, ctx.pluginId);
		},
		async saveNow(ctx: PluginCtx, editor: string): Promise<void> {
			ctx.require("note-editor.write");
			const { m } = await requireEditor(editor);
			markOwnNoteSave(editor.slice(5), ctx.pluginId);
			await m.flushNote();
		},
		async serializeAnnotations(ctx: PluginCtx, refs: ItemRef[], options: { template?: string }) {
			ctx.require("annotations.read");
			const list = await refsToWit(ctx, refs);
			return { html: annotationsHtml(list, options?.template), citationItems: "[]" };
		},
		async createNoteFromAnnotations(
			ctx: PluginCtx,
			req: { attachment: ItemRef; annotations: string[]; parent?: string; template?: string },
		): Promise<string> {
			ctx.require("annotations.read");
			ctx.require("library.write");
			let list = await annotationsApi.listAnnotations(ctx, req.attachment);
			if (req.annotations.length) list = list.filter((a) => req.annotations.includes(a.key));
			const html = annotationsHtml(list, req.template);
			if (!html) return fail("not-found", "no annotation with text or a comment to put in a note");
			let parent = req.parent ?? findReader(req.attachment.key)?.itemKey;
			if (!parent) {
				const d = await apiRequest<{ data?: { parentItem?: unknown } }>("GET", `/items/${encodeURIComponent(req.attachment.key)}`).catch(() => undefined);
				parent = typeof d?.data?.parentItem === "string" ? d.data.parentItem : undefined;
			}
			const body = `<div class="zotero-note znv1">${html}</div>`;
			const r = await apiRequest<{ key?: string; data?: { key?: string } }>("POST", "/items", {
				data: { itemType: "note", ...(parent ? { parentItem: parent } : {}), note: body },
			}).catch((e: Error) => fail("internal", e.message));
			return r.key ?? r.data?.key ?? fail("internal", "the core did not return the new note's key");
		},
		async exportableHtml(ctx: PluginCtx, note: ItemRef): Promise<string> {
			ctx.require("library.read");
			return noteHtml(note.key);
		},
		addEmbeddedImage(ctx: PluginCtx): never {
			ctx.require("library.write");
			return fail("unavailable", "embedded note images are not supported by Zinc's core yet");
		},
		copyEmbeddedImages(ctx: PluginCtx): never {
			ctx.require("library.write");
			return fail("unavailable", "embedded note images are not supported by Zinc's core yet");
		},
		embeddedImagesAvailable(): boolean {
			return true; // Zinc keeps images inline (data: URLs), so none can be missing
		},
		deleteUnusedEmbeddedImages(ctx: PluginCtx): number {
			ctx.require("library.write");
			return 0;
		},
		registerHead(ctx: PluginCtx, id: string): void {
			ctx.require("note-editor.ui");
			if (!id) fail("invalid-argument", "head id is empty");
			noteHeadRegistry.add(ctx.pluginId, id);
		},
		unregisterHead(ctx: PluginCtx, id: string): void {
			noteHeadRegistry.remove(ctx.pluginId, id);
		},
		invalidateHead(ctx: PluginCtx, id: string): void {
			noteHeadRegistry.invalidate(ctx.pluginId, id);
		},
		subscribeNoteEvents(ctx: PluginCtx, kinds: string[]): void {
			ctx.require("note-editor.read");
			noteHeadRegistry.subscribe(ctx.pluginId, kinds);
		},
	};
}
export type NoteApi = ReturnType<typeof createNoteApi>;

