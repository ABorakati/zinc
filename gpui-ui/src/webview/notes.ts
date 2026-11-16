// Zotero's note editor (vendor/note-editor web build, served by the core at /note-host/editor.html) in ONE shared WebView2 popup, placed
// over whichever note placeholder (itempane/RichNote.tsx) was claimed last: a child note opened in the item pane, or a top-level note.
//
// The bridge is note-host/src/host.js (what the Electrobun UI's iframe runs), moved to this side: the page is the editor itself, and
// this module is its host.
//   load   GET /api/items/<key>, then {action:'init', instanceID, value: html, colorScheme} into the page; switching notes re-inits the
//          same page (index.web.js replaces its EditorInstance), so the WebView2 and the page load once.
//   edit   {action:'update', value: html} from the editor (plus a 250 ms nudge from NOTE_BRIDGE on input, as the editor's own update
//          waits a second); saved 600 ms after the last one with PATCH /api/items/<key> {data:{note}}, as host.js does.
//   save   before switching to another note, when the placeholder goes (closed, item deselected, pane hidden), when the view goes
//          and at shutdown, the page's current HTML (getDataSync) is fetched and saved first.
//   links  openURL, zotero:// links, citations (showCitationItem / openCitationPage) and annotation links (openAnnotation): noteLinks.ts.
//          Images stored as attachments (data-attachment-key) are answered with the core's file URL (the 'image' subscription).
// The popup hides while the Library tab is not active, while a menu / dialog / popover is open, while the window is minimised and
// while the placeholder is scrolled out of its scroller; toasts and tooltips cut holes in it. It never takes focus unless asked to
// (a new note or "Edit note"). The view is destroyed after IDLE_MS without a placeholder.
import { createEffect, createMemo, createRoot, createSignal, on, untrack, type Accessor } from "solid-js";
import type { HostElement } from "@gpuix/solid";
import { ipApi } from "../itempane/net";
import { onShutdown } from "../services";
import { store } from "../store";
import { tokens } from "../theme";
import { boundsOf, native, overlayLayers } from "../ui/core";
import { floatingRects, toast } from "../ui/overlay";
import { noteBase, noteEditorUrl } from "./config";
import { WebHost, webViewHeadless, type PageMessage, type Placement } from "./host";
import { handleNoteAction } from "./noteLinks";
import { focusMain, mainWindow } from "./popup";

const SAVE_DELAY = 600; // note-host/src/host.js
const IDLE_MS = 3 * 60_000;

/** A placeholder that wants the editor over it. The last one claimed wins. */
export interface NoteClaim {
	key: Accessor<string>;
	el: () => HostElement | undefined;
	/** the scroller the placeholder sits in (the editor is cut to it) */
	clip?: () => HostElement | undefined;
	/** scroll that scroller (the wheel reached the end of the note's own scrolling) */
	scrollBy?: (dy: number) => void;
	/** give the editor keyboard focus once the note is shown */
	focus?: boolean;
	onSaved?: (html: string) => void;
}
export type NoteStatus = "" | "Saving…" | "Saved";

/** Runs in every page before its own scripts; active only on the note editor page. */
const NOTE_BRIDGE = `(() => {
	if (window.top !== window || !/\\/note-host\\/editor\\.html$/.test(location.pathname)) return;
	const send = (m) => { try { window.znMsg(JSON.stringify(m)); } catch (e) {} };
	let instanceID = null, sent = null, t = 0;
	// the editor's onOpenURL uses window.open
	window.open = (url) => { if (url) send({ type: "editor", instanceID, message: { action: "openURL", url: String(url) } }); return null; };
	// the editor posts {instanceID, message} to its own window
	window.addEventListener("message", (e) => {
		const d = e.data;
		if (!d || typeof d !== "object" || !d.message || !d.instanceID || d.instanceID !== instanceID) return;
		if (d.message.action === "update") sent = d.message.value;
		send({ type: "editor", instanceID: d.instanceID, message: d.message });
	});
	const html = () => {
		try { const r = window.getDataSync && window.getDataSync(true); return r && r.instanceID === instanceID && r.data ? r.data.html : null; } catch (e) { return null; }
	};
	const changed = () => {
		clearTimeout(t);
		t = setTimeout(() => { const h = html(); if (h != null && h !== sent) { sent = h; send({ type: "editor", instanceID, message: { action: "update", value: h } }); } }, 250);
	};
	for (const ev of ["input", "keyup", "paste", "cut", "drop", "mouseup"]) document.addEventListener(ev, changed, true);
	// the wheel at the end of the note's own scrolling goes on to the scroller the placeholder sits in (as it would from an iframe)
	window.addEventListener("wheel", (e) => {
		let el = e.target instanceof Element ? e.target : null;
		while (el && el !== document.body && el !== document.documentElement) {
			const oy = getComputedStyle(el).overflowY;
			if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1) break;
			el = el.parentElement;
		}
		const sc = el && el !== document.body && el !== document.documentElement ? el : document.scrollingElement;
		const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
		if (!sc || !dy) return;
		if ((dy < 0 && sc.scrollTop <= 0) || (dy > 0 && sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 1)) send({ type: "wheel", dy });
	}, { passive: true });
	// a file dropped where the editor does not take it would navigate the view away
	window.addEventListener("dragover", (e) => e.preventDefault());
	window.addEventListener("drop", (e) => { if (!e.defaultPrevented) e.preventDefault(); });
	window.__zn = {
		open(o) { clearTimeout(t); instanceID = o.instanceID; sent = o.value; window.postMessage(Object.assign({ action: "init" }, o), "*"); },
		post(m) { window.postMessage(m, "*"); },
		flush(req) { clearTimeout(t); const h = html(); if (h != null) sent = h; send({ type: "flushed", req, instanceID, html: h }); },
		focus() { window.postMessage({ action: "focus" }, "*"); },
	};
	document.addEventListener("DOMContentLoaded", () => send({ type: "page-ready" }));
})();`;

interface Current {
	key: string;
	instanceID: string;
	/** the HTML the core has */
	saved: string;
	/** edited HTML not saved yet */
	pending: string | null;
	timer?: ReturnType<typeof setTimeout>;
	saving: Promise<void>;
}

const host = new WebHost({
	init: NOTE_BRIDGE,
	onMessage,
	follow: true,
	onGone: () => {
		setPageReady(false);
		setShownKey(null);
	},
});
const [claims, setClaims] = createSignal<{ id: number; c: NoteClaim }[]>([]);
const [pageReady, setPageReady] = createSignal(false);
/** the note the page has finished initialising */
const [shownKey, setShownKey] = createSignal<string | null>(null);
const [statusSig, setStatusSig] = createSignal<{ key: string; text: NoteStatus }>({ key: "", text: "" });
let cur: Current | null = null;
let seq = 0;
let focusWanted = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let shutdownHooked = false;
const waiters = new Map<number, () => void>();
let lastProbe: unknown;

const js = (v: unknown) => JSON.stringify(v);
const active = () => claims().at(-1);
const setStatus = (key: string, text: NoteStatus) => setStatusSig({ key, text });

/** Whether notes use Zotero's editor: true / false (the Markdown editor), undefined while that is not known yet. */
export function richNotesAvailable(): boolean | undefined {
	if (host.state() === "error") return false;
	const b = noteBase();
	if (b === undefined) return undefined;
	if (!b) return false;
	if (webViewHeadless()) return true;
	// the headless test renderer's window is never on screen: a popup placed over it would be
	if (typeof (native() as { advanceTime?: unknown } | undefined)?.advanceTime === "function") return false;
	return mainWindow() != null;
}
/** Why the editor could not start (shown with the Markdown fallback). */
export const richNotesError = (): string => host.error();
/** "Saving…" / "Saved" for this note. */
export const noteStatus = (key: string): NoteStatus => (statusSig().key === key ? statusSig().text : "");
/** The editor is showing this note (its page is initialised with it). */
export const noteShown = (key: string): boolean => shownKey() === key;

/** Put the editor over a placeholder; returns the release (call it when the placeholder goes). */
export function claimNote(c: NoteClaim): () => void {
	const id = ++seq;
	if (c.focus) focusWanted = id;
	if (idleTimer) {
		clearTimeout(idleTimer);
		idleTimer = undefined;
	}
	if (!shutdownHooked) {
		shutdownHooked = true;
		onShutdown("notes", () => flush(400));
	}
	setClaims((l) => [...l, { id, c }]);
	return () => setClaims((l) => l.filter((x) => x.id !== id));
}

/** Ask for keyboard focus in the editor (the placeholder's "Edit" action). */
export function focusNote(): void {
	const a = active();
	if (!a) return;
	focusWanted = a.id;
	tryFocus();
}

function onMessage(m: PageMessage): void {
	if (m.type === "page-ready") {
		setPageReady(true);
		if (cur) openInPage(cur); // first load, or the page reloaded behind our back: show the note again
		return;
	}
	if (m.type === "flushed") {
		const c = cur;
		if (c && m.instanceID === c.instanceID && typeof m.html === "string" && m.html !== c.saved) c.pending = m.html;
		const w = waiters.get(Number(m.req));
		if (w) {
			waiters.delete(Number(m.req));
			w();
		}
		return;
	}
	if (m.type === "probe") {
		lastProbe = m.value;
		return;
	} // tests: noteEval("window.znMsg(JSON.stringify({type:'probe', value: ...}))")
	if (m.type === "wheel") {
		if (typeof m.dy === "number") active()?.c.scrollBy?.(m.dy);
		return;
	}
	if (m.type !== "editor") return;
	const msg = (m.message ?? {}) as { action?: string; [k: string]: unknown };
	const c = cur;
	if (!c || m.instanceID !== c.instanceID) return;
	switch (msg.action) {
		case "initialized":
			setShownKey(c.key);
			tryFocus();
			return;
		case "update":
			if (typeof msg.value !== "string") return;
			c.pending = msg.value;
			clearTimeout(c.timer);
			c.timer = setTimeout(() => void save(c), SAVE_DELAY);
			return;
		case "subscribe": {
			// images stored as attachments of the note: the core serves their files
			const s = msg.subscription as { id?: string; type?: string; data?: { attachmentKey?: string } } | undefined;
			const b = noteBase();
			if (s?.type === "image" && s.id && s.data?.attachmentKey && b) {
				host.eval(
					`window.__zn&&__zn.post(${js({ action: "notifySubscription", id: s.id, data: { src: `${b}/api/attachments/${encodeURIComponent(s.data.attachmentKey)}/file` } })})`,
				);
			}
			return;
		}
		case "focusBack":
		case "focusForward":
			focusMain();
			return;
		default:
			void handleNoteAction(msg);
	}
}

function openInPage(c: Current): void {
	if (!pageReady()) return;
	setShownKey(null);
	host.eval(
		`window.__zn&&__zn.open(${js({ instanceID: c.instanceID, value: c.pending ?? c.saved, readOnly: !store.canEdit(), disableDrag: false, isAttachmentNote: false, colorScheme: store.mode() })})`,
	);
}

/** Save the note's pending HTML (one save at a time per note). */
function save(c: Current): Promise<void> {
	clearTimeout(c.timer);
	c.saving = c.saving.then(async () => {
		const html = c.pending;
		c.pending = null;
		if (html == null || html === c.saved) return;
		setStatus(c.key, "Saving…");
		try {
			await ipApi.patchItem(c.key, { note: html });
			c.saved = html;
			setStatus(c.key, "Saved");
			untrack(claims)
				.filter((x) => x.c.key() === c.key)
				.at(-1)
				?.c.onSaved?.(html);
		} catch (e) {
			c.pending ??= html;
			setStatus(c.key, "");
			toast("Could not save the note", { kind: "error", description: e instanceof Error ? e.message : String(e) });
		}
	});
	return c.saving;
}

/** Take the page's current HTML (edits still inside the editor's debounce), then save. */
async function flush(timeoutMs = 1500): Promise<void> {
	const c = cur;
	if (!c) return;
	if (host.alive && pageReady()) {
		const req = ++seq;
		await new Promise<void>((res) => {
			waiters.set(req, res);
			host.eval(`window.__zn&&__zn.flush(${req})`);
			setTimeout(() => {
				if (waiters.delete(req)) res();
			}, timeoutMs);
		});
	}
	await save(c);
}

// ---- following the claims: one serialized queue of note switches ----
let queue: Promise<void> = Promise.resolve();
let gen = 0;

async function switchTo(key: string | null, my: number): Promise<void> {
	if (cur) await flush(); // the note being left (or re-opened) is saved first
	if (my !== gen || key === null) return;
	const url = noteEditorUrl();
	if (!url) return;
	let html: string;
	try {
		const d = await ipApi.item(key);
		html = String((d.data as { note?: unknown }).note ?? "");
	} catch (e) {
		if (my === gen) toast("Could not load the note", { kind: "error", description: e instanceof Error ? e.message : String(e) });
		return;
	}
	if (my !== gen) return;
	// the same note, unchanged and still in the page: keep it (cursor, scroll, undo history)
	if (cur && cur.key === key && cur.saved === html && cur.pending == null && untrack(shownKey) === key && host.alive) return;
	cur = { key, instanceID: `zn-note-${key}-${Date.now().toString(36)}`, saved: html, pending: null, saving: Promise.resolve() };
	setShownKey(null);
	host.load(url);
	openInPage(cur);
}

function tryFocus(): void {
	const a = active();
	if (!a || focusWanted !== a.id) return;
	let n = 0;
	const attempt = () => {
		const b = active();
		if (!b || focusWanted !== b.id) return;
		if (host.onScreen && shownKey() === b.c.key()) {
			focusWanted = 0;
			host.focus();
			host.eval("window.__zn&&__zn.focus()");
			return;
		}
		if (++n < 40) setTimeout(attempt, 50);
	};
	attempt();
}

const placement = (c: NoteClaim) => (): Placement | null => {
	const rect = boundsOf(c.el());
	if (!rect) return null;
	let clip = null;
	if (c.clip) {
		clip = boundsOf(c.clip());
		if (!clip) return null;
	}
	return { rect, clip, holes: floatingRects() };
};

createRoot(() => {
	// which note the page should hold
	const wanted = createMemo(() => active()?.c.key() ?? null);
	createEffect(
		on(wanted, (key) => {
			const my = ++gen;
			queue = queue.then(() => switchTo(key, my)).catch((e) => console.error("[notes]", e));
			if (key === null) {
				if (idleTimer) clearTimeout(idleTimer);
				idleTimer = setTimeout(() => {
					idleTimer = undefined;
					if (active()) return;
					queue = queue.then(async () => {
						if (active()) return;
						await flush();
						cur = null;
						host.release();
					});
				}, IDLE_MS);
			}
		}),
	);
	// where the popup is
	createEffect(() => {
		const a = active();
		const url = noteEditorUrl();
		const visible = !!a && !!url && shownKey() === a.c.key() && store.activeTab() === "library" && overlayLayers().length === 0;
		if (!visible) return host.hide();
		host.setBackground(tokens[store.mode()]["background"] ?? "#ffffff");
		host.show(url!, placement(a!.c));
		tryFocus();
	});
	// light / dark
	createEffect(
		on(
			() => store.mode(),
			(mode) => {
				if (pageReady()) host.eval(`window.__zn&&__zn.post(${js({ action: "setColorScheme", colorScheme: mode })})`);
			},
			{ defer: true },
		),
	);
});

/** Tests: the page's current note and HTML state, and the last {type:"probe"} value the page sent. */
export const noteDebug = () => ({
	key: cur?.key ?? null,
	instanceID: cur?.instanceID ?? null,
	saved: cur?.saved ?? null,
	pending: cur?.pending ?? null,
	pageReady: pageReady(),
	shown: shownKey(),
	state: host.state(),
	error: host.error(),
	onScreen: host.onScreen,
	alive: host.alive,
	focused: host.hasFocus(),
	probe: lastProbe,
});
/** Tests: run a script in the editor page. */
export const noteEval = (code: string): void => host.eval(code);
/** Tests: save now (as before a switch). */
export const flushNote = (): Promise<void> => flush();
