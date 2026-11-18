// Note editor registrations (`register-head`) and `note-events`. The events come from webview/notes.ts: `onNoteShown` (a changed note key is
// editor-closed then editor-opened) and `onNoteSaved` (note-saved, after the editor's own save 600 ms after typing).
import { createSignal } from "solid-js";
import { callPlugin } from "./link";
import { changed, noteSubscribers, regsFor, regsOf } from "./registry";
import type { EditorInfo, NoteEvent, NoteEventKind } from "./types";

export type NotesModule = typeof import("../../webview/notes");
let mod: Promise<NotesModule> | undefined;
/** webview/notes.ts is loaded on first use: importing it starts the shared editor view as a side effect. */
export const notesModule = (): Promise<NotesModule> => (mod ??= import("../../webview/notes"));

const [headRev, setHeadRev] = createSignal(0);
/** Reactive list of `[plugin, id]` of every registered note head. */
export function noteHeads(): [string, string][] {
	headRev();
	const out: [string, string][] = [];
	for (const p of [...heads]) for (const id of regsOf(p)?.heads ?? []) out.push([p, id]);
	return out;
}
const heads = new Set<string>();

export const noteHeadRegistry = {
	add(plugin: string, id: string): void {
		regsFor(plugin).heads.add(id);
		heads.add(plugin);
		setHeadRev((n) => n + 1);
	},
	remove(plugin: string, id: string): void {
		regsFor(plugin).heads.delete(id);
		setHeadRev((n) => n + 1);
	},
	invalidate(_plugin: string, _id: string): void {
		setHeadRev((n) => n + 1);
	},
	subscribe(plugin: string, kinds: string[]): void {
		regsFor(plugin).noteEvents = new Set(kinds as NoteEventKind[]);
		ensurePolling();
	},
	clear(plugin?: string): void {
		if (plugin === undefined) heads.clear();
		else heads.delete(plugin);
		setHeadRev((n) => n + 1);
		changed();
	},
};

const chains = new Map<string, Promise<unknown>>();
export function emitNoteEvent(kind: NoteEventKind, make: (plugin: string) => NoteEvent): void {
	for (const plugin of noteSubscribers(kind)) {
		const k = `${plugin}\u0000${kind}`;
		chains.set(
			k,
			(chains.get(k) ?? Promise.resolve())
				.then(() => callPlugin(plugin, "note-events", "on-note-event", [make(plugin)]))
				.catch((e) => console.error(`[wasm-reader] ${plugin} on-note-event ${kind}:`, e instanceof Error ? e.message : e)),
		);
	}
}

// ---- the editor's events (webview/notes.ts onNoteShown / onNoteSaved) ----
let unsubscribe: Array<() => void> = [];
let subscribing = false;
let shownNow: string | null = null;
/** Plugin-made saves (apply-update, save-now): the next save of this note is theirs. */
const ownSave = new Map<string, string>();
export const markOwnNoteSave = (key: string, plugin: string): void => void ownSave.set(key, plugin);

const info = (key: string): EditorInfo => ({
	id: `note:${key}`,
	note: { library: 1, key },
	placement: "item-pane",
	readOnly: false,
	tabId: undefined,
	window: undefined,
	reader: undefined,
});

function ensurePolling(): void {
	if (unsubscribe.length || subscribing) return;
	subscribing = true;
	void notesModule()
		.then((m) => {
			unsubscribe = [
				m.onNoteShown((key) => {
					if (key === shownNow) return;
					const left = shownNow;
					shownNow = key;
					if (left) emitNoteEvent("editor-closed", () => ({ tag: "editor-closed", val: info(left) }));
					if (key) emitNoteEvent("editor-opened", () => ({ tag: "editor-opened", val: info(key) }));
				}),
				m.onNoteSaved((key) => {
					const by = ownSave.get(key);
					ownSave.delete(key);
					emitNoteEvent("note-saved", (plugin) => ({ tag: "note-saved", val: { editor: `note:${key}`, note: { library: 1, key }, byThisPlugin: plugin === by } }));
				}),
			];
		})
		.finally(() => (subscribing = false));
}
export function stopNoteEvents(): void {
	for (const u of unsubscribe) u();
	unsubscribe = [];
	shownNow = null;
}
