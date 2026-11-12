// The service worker of the sync check's test extension (web/browser-sync-check.ts). Like test-background.js (creates the offscreen
// document on {zincEnsureDb: true}) and, because an offscreen document has only chrome.runtime, it answers {zincStorage: {op, name, value}}
// from the offscreen page with chrome.storage.local, as the connector's background must (browser-db/CONTRACT.md, "zotero.org sync").
// Only the two names sync uses, only for a page of this extension that is the library's offscreen document, and only the API key is writable.
let creating = null;
async function ensureOffscreen() {
	if (await chrome.offscreen.hasDocument?.()) return;
	creating ??= chrome.offscreen
		.createDocument({ url: "library/offscreen.html", reasons: ["WORKERS"], justification: "Zinc library database" })
		.catch((e) => { if (!/single offscreen|already exists/i.test(String(e?.message ?? e))) throw e; })
		.finally(() => { creating = null; });
	await creating;
}

const NAMES = ["zincZoteroApiKey", "zincTestZoteroApiBase"];
const WRITABLE = ["zincZoteroApiKey"];

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	if (msg && msg.zincEnsureDb === true) {
		ensureOffscreen().then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
		return true;
	}
	if (msg && msg.zincStorage) {
		const { op, name, value } = msg.zincStorage;
		const fromOffscreen = sender.id === chrome.runtime.id && /^chrome-extension:\/\/[a-p]{32}\/library\/offscreen\.html(\?|#|$)/.test(sender.url || "");
		if (!fromOffscreen || !NAMES.includes(name) || (op !== "get" && !WRITABLE.includes(name))) { sendResponse({ ok: false, error: "refused" }); return false; }
		const done = op === "get" ? chrome.storage.local.get(name).then((o) => ({ ok: true, value: o[name] }))
			: op === "set" ? chrome.storage.local.set({ [name]: value }).then(() => ({ ok: true }))
			: chrome.storage.local.remove(name).then(() => ({ ok: true }));
		done.then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
		return true;
	}
	return false;
});
