// zotero-next reader host page: wires Zotero's reader (web build) to the core HTTP API.
import { SDT_PACK_VERSION, SDT_SCHEMA_VERSION } from '../../vendor/reader/structured-document-text/src/version.js';

import { installCitationActions } from './citations.js';

const params = new URLSearchParams(location.search);
const attachment = params.get('attachment');
const API = '/api/attachments/' + encodeURIComponent(attachment || '');
const AUTHOR_NAME = params.get('author') || 'Me';
const DOCUMENT_WORKER_BASE = 'document-worker/';
const SDT_CACHE = 'zotero-next-sdt-v1';

const CONTENT_TYPES = { pdf: 'application/pdf', epub: 'application/epub+zip', snapshot: 'text/html' };

function postToParent(msg) {
	try {
		if (window.parent && window.parent !== window) window.parent.postMessage({ attachment, ...msg }, '*');
	}
	catch (e) { /* ignore */ }
}

function showError(msg) {
	let el = document.getElementById('host-error');
	el.textContent = msg;
	el.classList.add('show');
	postToParent({ type: 'reader-error', message: msg });
}

async function api(path, init) {
	let res = await fetch(path, init);
	if (!res.ok) throw new Error(`${init?.method || 'GET'} ${path} -> ${res.status}`);
	return res;
}

function typeFromContentType(ct) {
	ct = (ct || '').toLowerCase();
	if (ct.includes('application/pdf')) return 'pdf';
	if (ct.includes('epub')) return 'epub';
	if (ct.includes('text/html') || ct.includes('xhtml')) return 'snapshot';
	return null;
}

// ---------- document worker + SDT pack (Reading Mode) ----------
let documentWorker = null;
let workerFailed = false;
let lastPromiseID = 0;
const workerPromises = {};

function failAllPending(error) {
	for (let id of Object.keys(workerPromises)) {
		workerPromises[id].reject(error);
		delete workerPromises[id];
	}
}

function initDocumentWorker() {
	if (documentWorker || workerFailed) return documentWorker;
	documentWorker = new Worker(DOCUMENT_WORKER_BASE + 'worker.js');
	documentWorker.addEventListener('error', (event) => {
		console.warn('Document worker failed:', event.message || event);
		workerFailed = true;
		failAllPending(new Error('Document worker unavailable'));
		documentWorker = null;
	});
	documentWorker.addEventListener('message', async (event) => {
		let message = event.data;
		if (message.progressID) {
			workerPromises[message.progressID]?.onProgress?.(message.data.progress);
			return;
		}
		if (message.responseID) {
			let pending = workerPromises[message.responseID];
			if (!pending) return;
			delete workerPromises[message.responseID];
			if ('error' in message) pending.reject(new Error(JSON.stringify(message.error)));
			else pending.resolve(message.data);
			return;
		}
		if (message.id) {
			let respData = null;
			try {
				if (message.action === 'FetchBuiltInCMap') {
					let res = await fetch(DOCUMENT_WORKER_BASE + 'cmaps/' + message.data + '.bcmap');
					respData = { isCompressed: true, cMapData: new Uint8Array(await res.arrayBuffer()) };
				}
				else if (message.action === 'FetchStandardFontData') {
					let res = await fetch(DOCUMENT_WORKER_BASE + 'standard_fonts/' + message.data);
					respData = new Uint8Array(await res.arrayBuffer());
				}
				else if (message.action === 'FetchWasm') {
					let res = await fetch(DOCUMENT_WORKER_BASE + 'wasm/' + message.data);
					respData = new Uint8Array(await res.arrayBuffer());
				}
				else if (message.action === 'FetchData') {
					let res = await fetch(DOCUMENT_WORKER_BASE + message.data);
					respData = new Uint8Array(await res.arrayBuffer());
				}
			}
			catch (e) {
				console.warn(`Document worker ${message.action} failed:`, e);
			}
			documentWorker.postMessage({ responseID: message.id, data: respData });
		}
	});
	return documentWorker;
}

function queryDocumentWorker(action, data, transfer, onProgress) {
	let worker = initDocumentWorker();
	if (!worker) return Promise.reject(new Error('Document worker unavailable'));
	return new Promise((resolve, reject) => {
		lastPromiseID++;
		workerPromises[lastPromiseID] = { resolve, reject, onProgress };
		worker.postMessage({ id: lastPromiseID, action, data }, transfer || []);
	});
}

// The worker requires sourceHash to be a 32-char lowercase hex (MD5-shaped) string.
// Derive a stable one from the attachment key (SHA-256 truncated; FNV fallback when
// crypto.subtle is unavailable, e.g. insecure origins).
async function stableSourceHash(key) {
	if (/^[0-9a-f]{32}$/.test(key)) return key;
	try {
		let digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('zotero-next:' + key));
		return [...new Uint8Array(digest).slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('');
	}
	catch (e) {
		let out = '';
		for (let seed = 0; seed < 4; seed++) {
			let h = 0x811c9dc5 ^ seed;
			for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
			out += (h >>> 0).toString(16).padStart(8, '0');
		}
		return out;
	}
}

const SDT_CACHE_PREFIX = `https://sdt.zotero-next.invalid/${encodeURIComponent(attachment || '')}?`;
function sdtCacheURL(size) {
	return `${SDT_CACHE_PREFIX}size=${size}&pack=${SDT_PACK_VERSION}&schema=${SDT_SCHEMA_VERSION}`;
}

async function cacheGet(size) {
	try {
		let cache = await caches.open(SDT_CACHE);
		let res = await cache.match(sdtCacheURL(size));
		return res ? await res.arrayBuffer() : null;
	}
	catch (e) { return null; }
}

async function cachePut(size, bytes) {
	try {
		let cache = await caches.open(SDT_CACHE);
		// drop stale entries for this attachment (other file sizes / pack versions)
		for (let req of await cache.keys()) {
			if (req.url.startsWith(SDT_CACHE_PREFIX)) await cache.delete(req);
		}
		await cache.put(sdtCacheURL(size), new Response(bytes.slice(0)));
	}
	catch (e) { console.warn('SDT cache write failed', e); }
}

function makeGetSDTPack(type, fileBuf) {
	return async function getSDTPack({ onProgress } = {}) {
		let contentType = CONTENT_TYPES[type];
		if (!contentType) return { ok: false, reason: 'unavailable' };
		let packInfo = { packVersion: SDT_PACK_VERSION, schemaMajorVersion: Number(SDT_SCHEMA_VERSION.split('.')[0]) };
		try {
			let size = fileBuf.byteLength;
			let cached = await cacheGet(size);
			if (cached) {
				window.__sdtFromCache = true;
				return { ok: true, bytes: cached, ...packInfo };
			}
			window.__sdtFromCache = false;
			let buf = fileBuf.slice(0); // the worker transfers (detaches) its copy
			let result = await queryDocumentWorker(
				'getStructuredDocumentText',
				{ buf, contentType, sourceHash: await stableSourceHash(attachment), reportProgress: !!onProgress },
				[buf],
				onProgress
			);
			if (!result?.buf) return { ok: false, reason: 'failed' };
			await cachePut(size, result.buf);
			return { ok: true, bytes: result.buf, ...packInfo };
		}
		catch (e) {
			console.warn('Failed to generate SDT:', e);
			return { ok: false, reason: 'failed' };
		}
	};
}

// ---------- persistence ----------
const pendingSave = new Map(); // id -> annotation
let saveTimer = null;

function flushSave(keepalive = false) {
	clearTimeout(saveTimer);
	saveTimer = null;
	if (!pendingSave.size) return;
	let batch = [...pendingSave.values()];
	pendingSave.clear();
	fetch(API + '/annotations', {
		method: 'PUT', keepalive,
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(batch),
	}).then((r) => { if (!r.ok) throw new Error('status ' + r.status); })
		.catch(e => console.error('Saving annotations failed', e));
}

function queueSave(annotations) {
	for (let a of annotations) pendingSave.set(a.id, a);
	clearTimeout(saveTimer);
	saveTimer = setTimeout(() => flushSave(), 300);
}

function deleteAnnotations(ids) {
	for (let id of ids) pendingSave.delete(id);
	if (!ids.length) return;
	fetch(API + '/annotations', {
		method: 'DELETE',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ids }),
	}).catch(e => console.error('Deleting annotations failed', e));
}

let pendingViewState = null;
let viewStateTimer = null;
function flushViewState(keepalive = false) {
	clearTimeout(viewStateTimer);
	viewStateTimer = null;
	if (!pendingViewState) return;
	let state = pendingViewState;
	pendingViewState = null;
	fetch(API + '/view-state', {
		method: 'PUT', keepalive,
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(state),
	}).catch(e => console.error('Saving view state failed', e));
}
function queueViewState(state) {
	pendingViewState = state;
	clearTimeout(viewStateTimer);
	viewStateTimer = setTimeout(() => flushViewState(), 1000);
}

function flushAll() { flushSave(true); flushViewState(true); }

// The app shell asks an idle tab to persist everything before it unloads this frame; ack once both PUTs succeeded.
addEventListener('message', async (e) => {
	if (e.source !== window.parent || e.origin !== location.origin || e.data?.type !== 'zn-save-now') return;
	let ok = true;
	let batch = [], state = null;
	try {
		let jobs = [];
		if (pendingSave.size) {
			batch = [...pendingSave.values()];
			pendingSave.clear();
			jobs.push(fetch(API + '/annotations', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch) }));
		}
		if (pendingViewState) {
			state = pendingViewState;
			pendingViewState = null;
			jobs.push(fetch(API + '/view-state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state) }));
		}
		clearTimeout(saveTimer); clearTimeout(viewStateTimer);
		ok = (await Promise.all(jobs)).every((r) => r.ok);
	}
	catch { ok = false; }
	if (!ok) { for (let a of batch) if (!pendingSave.has(a.id)) pendingSave.set(a.id, a); if (state && !pendingViewState) pendingViewState = state; }
	window.parent.postMessage({ type: 'zn-saved', id: e.data.id, ok }, location.origin);
});
addEventListener('pagehide', flushAll);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAll(); });

// ---------- readiness: first rendered page (initializedPromise never resolves) ----------
function watchFirstRender(type) {
	let started = Date.now();
	let timer = setInterval(() => {
		let ready = false;
		try {
			let doc = document.querySelector('#primary-view iframe')?.contentDocument;
			if (doc) {
				if (type === 'pdf') {
					ready = !!doc.querySelector('.page .canvasWrapper canvas, .page .textLayer span');
				}
				else {
					ready = !!doc.body && doc.body.childElementCount > 0 && doc.readyState === 'complete';
				}
			}
		}
		catch (e) { /* not ready */ }
		if (ready) {
			clearInterval(timer);
			window.__readerReady = true;
			postToParent({ type: 'reader-ready' });
		}
		else if (Date.now() - started > 60000) {
			clearInterval(timer);
		}
	}, 100);
}

// ---------- main ----------
async function main() {
	if (!attachment) throw new Error('Missing ?attachment=<key>');
	if (typeof window.createReader !== 'function') throw new Error('Reader bundle failed to load');

	let [fileRes, annsRes, vsRes] = await Promise.all([
		api(API + '/file'),
		api(API + '/annotations'),
		api(API + '/view-state'),
	]);
	let type = typeFromContentType(fileRes.headers.get('Content-Type'));
	if (!type) throw new Error('Unsupported content type: ' + fileRes.headers.get('Content-Type'));
	let fileBuf = await fileRes.arrayBuffer();
	let annotations = (await annsRes.json()) || [];
	let viewState = await vsRes.json().catch(() => null);

	// title from the parent item (fallback: the attachment record itself)
	let title = '';
	try {
		let att = await (await api('/api/items/' + encodeURIComponent(attachment))).json();
		let parentKey = att?.data?.parentItem;
		title = att?.data?.title || att?.data?.filename || '';
		if (parentKey) {
			let parent = await (await api('/api/items/' + encodeURIComponent(parentKey))).json();
			title = parent?.data?.title || title;
		}
	}
	catch (e) { console.warn('Could not load item title', e); }
	if (title) document.title = title;

	window.createReader({
		type,
		readOnly: false,
		data: { buf: new Uint8Array(fileBuf.slice(0)), url: new URL('/', location).toString() },
		annotations,
		primaryViewState: viewState || undefined,
		sidebarOpen: true,
		sidebarView: 'outline',
		sidebarWidth: 240,
		bottomPlaceholderHeight: null,
		toolbarPlaceholderWidth: 0,
		authorName: AUTHOR_NAME,
		showAnnotations: true,
		title,
		loggedIn: false,
		enableReadAloud: false,
		getSDTPack: makeGetSDTPack(type, fileBuf),
		onSaveAnnotations: async anns => queueSave(anns),
		onDeleteAnnotations: ids => deleteAnnotations(ids),
		onChangeViewState: (state, primary) => { if (primary) queueViewState(state); },
		onOpenLink: url => postToParent({ type: 'open-link', url }),
		onConfirm: (t, text) => window.confirm(text),
		onClosePopup() {},
		onToggleSidebar() {},
		onChangeSidebarWidth() {},
		onChangeSidebarView() {},
	});
	watchFirstRender(type);
	installCitationActions({ attachment, postToParent });
}

main().catch((e) => {
	console.error(e);
	showError(String(e?.message || e));
});
