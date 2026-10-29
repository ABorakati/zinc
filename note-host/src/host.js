// Hosts Zotero's note editor (vendor/note-editor web build, served as editor.html in an iframe).
// ?note=<key>[&api=<origin>]  -> GET /api/items/<key>, edits -> debounced PATCH {data:{note: html}}.
// Editor protocol: parent posts {action:'init', instanceID, value, readOnly, colorScheme} to the iframe;
// the editor posts {instanceID, message:{action,...}} to ITS OWN window (index.web.js), so we listen on
// iframe.contentWindow (same origin). Messages out to window.parent: {type:'note-ready'|'note-saved'|'note-error', key}.
// Messages in from parent: {type:'note-flush'} (save now), {type:'note-focus'}.
const params = new URLSearchParams(location.search);
const key = params.get('note');
const API = params.get('api') || '';
const SAVE_DELAY = 600;
const frame = document.getElementById('editor-frame');
const errBox = document.getElementById('host-error');
const instanceID = 'note-' + Math.random().toString(36).slice(2);

const tell = (msg) => { try { window.parent.postMessage(msg, '*'); } catch {} };
const fail = (text) => { errBox.textContent = text; errBox.classList.add('show'); tell({ type: 'note-error', key, error: text }); };

const media = matchMedia('(prefers-color-scheme: dark)');
const scheme = () => (media.matches ? 'dark' : 'light');

let pendingHtml = null;   // latest html not yet confirmed saved
let lastSaved = null;
let timer = null;
let inflight = Promise.resolve();

async function patch(html, keepalive = false) {
	const res = await fetch(`${API}/api/items/${encodeURIComponent(key)}`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ data: { note: html } }),
		keepalive: keepalive && html.length < 60000,
	});
	if (!res.ok) throw new Error('PATCH ' + res.status);
}

function flush(keepalive = false) {
	clearTimeout(timer); timer = null;
	if (pendingHtml == null) return inflight;
	const html = pendingHtml; pendingHtml = null;
	if (html === lastSaved) return inflight;
	inflight = inflight.then(() => patch(html, keepalive)).then(
		() => { lastSaved = html; tell({ type: 'note-saved', key }); },
		(e) => { pendingHtml = pendingHtml ?? html; console.error('note save failed', e); tell({ type: 'note-error', key, error: String(e) }); },
	);
	return inflight;
}

function onEdit(html) {
	pendingHtml = html;
	clearTimeout(timer);
	timer = setTimeout(() => flush(), SAVE_DELAY);
}

function openURL(url) {
	fetch(`${API}/api/open-url`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
	}).catch((e) => console.error('open-url failed', e));
}

function handleEditorMessage(event) {
	const d = event.data;
	if (!d || d.instanceID !== instanceID || !d.message) return;
	const m = d.message;
	switch (m.action) {
		case 'initialized': tell({ type: 'note-ready', key }); break;
		case 'update': onEdit(m.value); break;
		case 'openURL': openURL(m.url); break;
		// Not wired yet: citations, annotations, image import (images stay embedded as data: URLs).
		case 'subscribe': case 'unsubscribe': case 'importImages': case 'insertObject':
		case 'updateCitationItemsList': case 'openAnnotation': case 'openCitationPage':
		case 'showCitationItem': case 'openCitationPopup': case 'focusBack': case 'focusForward': case 'showNote':
			break;
		default: console.debug('unhandled editor message', m);
	}
}

async function start() {
	if (!key) return fail('Missing ?note=<key>');
	let item;
	try {
		const res = await fetch(`${API}/api/items/${encodeURIComponent(key)}`);
		if (!res.ok) throw new Error('HTTP ' + res.status);
		item = await res.json();
	} catch (e) { return fail('Could not load note ' + key + ': ' + e.message); }
	const html = item?.data?.note ?? '';
	lastSaved = html;

	frame.addEventListener('load', () => {
		const w = frame.contentWindow;
		w.addEventListener('message', handleEditorMessage);
		w.open = (url) => { if (url) openURL(String(url)); return null; };   // editor's onOpenURL uses window.open
		w.postMessage({ action: 'init', instanceID, value: html, readOnly: false, disableDrag: false,
			isAttachmentNote: false, colorScheme: scheme() }, '*');
	}, { once: true });
	frame.src = 'editor.html';

	media.addEventListener('change', () =>
		frame.contentWindow?.postMessage({ action: 'setColorScheme', colorScheme: scheme() }, '*'));
}

function syncFlush() {
	// Prefer the editor's current state (covers edits inside the debounce window)
	try {
		const r = frame.contentWindow?.getDataSync?.(true);
		if (r?.data?.html != null) pendingHtml = r.data.html;
	} catch {}
	flush(true);
}
addEventListener('pagehide', syncFlush);
addEventListener('beforeunload', syncFlush);
addEventListener('message', (e) => {
	if (e.source !== window.parent) return;
	if (e.data?.type === 'note-flush') syncFlush();
	if (e.data?.type === 'note-focus') frame.contentWindow?.postMessage({ action: 'focus' }, '*');
});

start();
