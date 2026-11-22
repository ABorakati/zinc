// Hosts Zotero's note editor (vendor/note-editor web build, served as editor.html in an iframe).
// ?note=<key>[&api=<origin>]  -> GET /api/items/<key>, edits -> debounced PATCH {data:{note: html}}.
// Editor protocol: parent posts {action:'init', instanceID, value, readOnly, colorScheme} to the iframe;
// the editor posts {instanceID, message:{action,...}} to ITS OWN window (index.web.js), so we listen on
// iframe.contentWindow (same origin). Messages out to window.parent: {type:'note-ready'|'note-saved'|'note-error', key}.
// Messages in from parent: {type:'note-flush'} (save now), {type:'note-focus'}.
// Messages go to, and are accepted from, this page's own origin only; `?api=` is this origin or a loopback http origin (origins.ts).
import { fromOwnOrigin, messageOrigin, resolveApiBase } from "./origins.ts";
import { createNoteSaver } from "./saver.ts";

const params = new URLSearchParams(location.search);
const key = params.get("note");
const apiBase = resolveApiBase(params.get("api"), location.origin);
const API = apiBase ?? "";
const SELF = messageOrigin(location.origin);
const frame = document.getElementById("editor-frame");
const errBox = document.getElementById("host-error");
const instanceID = "note-" + Math.random().toString(36).slice(2);

const tell = (msg) => {
	try {
		if (SELF && window.parent !== window) window.parent.postMessage(msg, SELF);
	} catch {}
};
const fail = (text) => {
	errBox.textContent = text;
	errBox.classList.add("show");
	tell({ type: "note-error", key, error: text });
};

const media = matchMedia("(prefers-color-scheme: dark)");
const scheme = () => (media.matches ? "dark" : "light");

const saver = createNoteSaver({
	url: `${API}/api/items/${encodeURIComponent(key)}`,
	fetchFn: (url, init) => fetch(url, init),
	onSaved: () => tell({ type: "note-saved", key }),
	onError: (error) => tell({ type: "note-error", key, error }),
});

function openURL(url) {
	fetch(`${API}/api/open-url`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ url }),
	}).catch((e) => console.error("open-url failed", e));
}

function handleEditorMessage(event) {
	if (event.origin !== location.origin) return;
	const d = event.data;
	if (!d || d.instanceID !== instanceID || !d.message) return;
	const m = d.message;
	switch (m.action) {
		case "initialized":
			tell({ type: "note-ready", key });
			break;
		case "update":
			saver.onEdit(m.value);
			break;
		case "openURL":
			openURL(m.url);
			break;
		// Not wired yet: citations, annotations, image import (images stay embedded as data: URLs).
		case "subscribe":
		case "unsubscribe":
		case "importImages":
		case "insertObject":
		case "updateCitationItemsList":
		case "openAnnotation":
		case "openCitationPage":
		case "showCitationItem":
		case "openCitationPopup":
		case "focusBack":
		case "focusForward":
		case "showNote":
			break;
		default:
			console.debug("unhandled editor message", m);
	}
}

async function start() {
	if (!key) return fail("Missing ?note=<key>");
	if (apiBase === null) return fail("The api origin is not allowed");
	let item;
	try {
		const res = await fetch(`${API}/api/items/${encodeURIComponent(key)}`);
		if (!res.ok) throw new Error("HTTP " + res.status);
		item = await res.json();
	} catch (e) {
		return fail("Could not load note " + key + ": " + e.message);
	}
	const html = item?.data?.note ?? "";
	saver.setBaseline(html);

	frame.addEventListener(
		"load",
		() => {
			const w = frame.contentWindow;
			w.addEventListener("message", handleEditorMessage);
			w.open = (url) => {
				if (url) openURL(String(url));
				return null;
			}; // editor's onOpenURL uses window.open
			w.postMessage(
				{
					action: "init",
					instanceID,
					value: html,
					readOnly: false,
					disableDrag: false,
					isAttachmentNote: false,
					colorScheme: scheme(),
				},
				location.origin,
			);
		},
		{ once: true },
	);
	frame.src = "editor.html";

	media.addEventListener("change", () => frame.contentWindow?.postMessage({ action: "setColorScheme", colorScheme: scheme() }, location.origin));
}

function syncFlush() {
	// Prefer the editor's current state (covers edits inside the debounce window)
	try {
		const r = frame.contentWindow?.getDataSync?.(true);
		if (r?.data?.html != null) saver.setPending(r.data.html);
	} catch {}
	saver.flush(true);
}
addEventListener("pagehide", syncFlush);
addEventListener("beforeunload", syncFlush);
addEventListener("message", (e) => {
	if (!fromOwnOrigin(e, window.parent, location.origin)) return;
	if (e.data?.type === "note-flush") syncFlush();
	if (e.data?.type === "note-focus") frame.contentWindow?.postMessage({ action: "focus" }, location.origin);
});

start();
