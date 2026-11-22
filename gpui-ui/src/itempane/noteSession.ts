// Saving one open note, shared by the Markdown editor (itempane/Notes.tsx) and the native rich-text editor (notes/native/RichTextEditor.tsx).
// The model is the rich editor's save() in webview/notes.ts:
//  - the note's key is fixed when the session opens, so a save never reads props or pane state (they are gone when an editor is torn
//    down, which is exactly when the last edit has to be written);
//  - saves of a session run one at a time; an edit made during a save is saved after it, and nothing here ever writes a saved copy back
//    into the editor;
//  - a failed save leaves the session dirty, and the next flush tries again;
//  - a session closed with unsaved text stays registered, so a note reopened at once waits for the save instead of loading stale text
//    (noteSettled) and the shutdown flush still retries it (flushNoteSessions).

export type NoteStatus = "" | "Saving…" | "Saved";

export interface NoteSessionOptions<D> {
	/** the note's key, captured now: every save of this session uses it */
	key: string;
	/** the HTML the core has for the note (the wrapper that saves are written inside) */
	base: string;
	/** the HTML to store for the editor's `draft`, or null when there is nothing to write */
	build(draft: D, base: string): string | null;
	patch(key: string, html: string): Promise<unknown>;
	/** after a save; `current` is false when the editor has been edited again since (do not replace its text with `html`) */
	onSaved?(html: string, current: boolean): void;
	onError?(e: unknown): void;
	onStatus?(s: NoteStatus): void;
	/** debounce after the last edit, ms */
	delay?: number;
}

export interface NoteSession<D> {
	readonly key: string;
	/** edits not yet saved (including a save that failed) */
	readonly dirty: boolean;
	/** the note's HTML as last loaded or saved */
	readonly base: string;
	edit(draft: D): void;
	/** Save now (after any save in flight). Resolves true when nothing unsaved remains. */
	flush(): Promise<boolean>;
	/** Flush and retire the session; with unsaved text left it stays registered for noteSettled / flushNoteSessions. */
	close(): Promise<boolean>;
}

interface Entry {
	key: string;
	flush(): Promise<boolean>;
	/** the HTML the unsaved edits would write */
	unsaved(): string | null;
	retire(): void;
	closed: boolean;
	/** resolves when the saves queued so far are done */
	settled(): Promise<unknown>;
}
const entries = new Set<Entry>();

/** Run a callback that belongs to the (possibly gone) component: whatever it throws is not the save's problem. */
const safely = (f: () => void) => {
	try {
		f();
	} catch {
		/* the component or its parent is gone */
	}
};

export function openNoteSession<D>(o: NoteSessionOptions<D>): NoteSession<D> {
	const delay = o.delay ?? 800;
	let base = o.base;
	let draft: D | undefined;
	let have = false;
	let dirty = false;
	let closed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let chain: Promise<unknown> = Promise.resolve();
	let version = 0;

	const run = async (): Promise<boolean> => {
		if (!dirty || !have) return true;
		const v = version;
		const out = o.build(draft as D, base);
		if (out === null || out === base) {
			dirty = false; // nothing to write
			return true;
		}
		dirty = false;
		safely(() => o.onStatus?.("Saving…"));
		try {
			await o.patch(o.key, out);
		} catch (e) {
			dirty = true;
			safely(() => o.onStatus?.(""));
			safely(() => o.onError?.(e));
			return false;
		}
		base = out;
		safely(() => o.onStatus?.("Saved"));
		safely(() => o.onSaved?.(out, v === version));
		return !dirty;
	};
	const flush = (): Promise<boolean> => {
		clearTimeout(timer);
		const next = chain.then(run, run);
		chain = next;
		return next;
	};
	const entry: Entry = {
		key: o.key,
		flush,
		unsaved: () => (dirty && have ? o.build(draft as D, base) : null),
		retire: () => entries.delete(entry),
		closed: false,
		settled: () => chain,
	};
	entries.add(entry);

	return {
		key: o.key,
		get dirty() {
			return dirty;
		},
		get base() {
			return base;
		},
		edit(d) {
			if (closed) return;
			draft = d;
			have = true;
			dirty = true;
			version++;
			safely(() => o.onStatus?.(""));
			clearTimeout(timer);
			timer = setTimeout(() => void flush(), delay);
		},
		flush,
		async close() {
			closed = true;
			entry.closed = true;
			const ok = await flush();
			if (ok) entries.delete(entry);
			return ok;
		},
	};
}

/**
 * Wait until the saves of `key` that are already under way have finished (a closed editor's last edit may still be on its way), and
 * return the text of edits that could not be saved: the caller shows it instead of the stored note, saves it from a new session and
 * calls `take()` once it has. Null when nothing is outstanding. Call it before loading a note.
 */
export async function noteSettled(key: string): Promise<{ html: string; take(): void } | null> {
	for (const e of [...entries]) {
		if (e.key !== key) continue;
		await e.settled();
		if (!e.closed) continue;
		await e.flush(); // a closed session that failed to save tries again
		const html = e.unsaved();
		if (html === null) e.retire();
		else return { html, take: e.retire };
	}
	return null;
}

/** Flush every open session (app shutdown). */
export async function flushNoteSessions(): Promise<void> {
	await Promise.all([...entries].map((e) => e.flush().catch(() => false)));
}
