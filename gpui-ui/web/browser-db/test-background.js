// The service worker of the headless checks' test extension (web/browser-library-check.ts, browser-sync-check.ts,
// browser-welcome-check.ts). It does what the connector's background does for the browser library (CONTRACT.md):
// - {zincEnsureDb: true}: create the offscreen document when something asks for the database, and answer ok. The library tab
//   (web/extension.tsx) asks, or the connector's own code.
// - {zincStorage: {op, name, value}}: an offscreen document has only chrome.runtime, so the library's database worker reads the
//   zotero.org key through here ("zotero.org sync"). Only the two names sync uses, only from this extension's library offscreen
//   page, and only the API key is writable.
// The offscreen page is library/offscreen.html, or, when the check sets self.ZINC_TEST_OFFSCREEN before this script (browser-library-check
// --iframe), the connector-style page that holds library/offscreen.html in a hidden iframe.
const OFFSCREEN = self.ZINC_TEST_OFFSCREEN ?? "library/offscreen.html";
let creating = null;
async function ensureOffscreen() {
	if (await chrome.offscreen.hasDocument?.()) return;
	creating ??= chrome.offscreen
		.createDocument({ url: OFFSCREEN, reasons: ["WORKERS"], justification: "Zinc library database" })
		.catch((e) => {
			if (!/single offscreen|already exists/i.test(String(e?.message ?? e))) throw e;
		})
		.finally(() => {
			creating = null;
		});
	await creating;
}

const NAMES = ["zincZoteroApiKey", "zincTestZoteroApiBase"];
const WRITABLE = ["zincZoteroApiKey"];

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	if (msg && msg.zincEnsureDb === true) {
		ensureOffscreen().then(
			() => sendResponse({ ok: true }),
			(e) => sendResponse({ ok: false, error: String(e?.message ?? e) }),
		);
		return true;
	}
	if (msg && msg.zincStorage) {
		const { op, name, value } = msg.zincStorage;
		const fromOffscreen =
			sender.id === chrome.runtime.id && /^chrome-extension:\/\/[a-p]{32}\/library\/offscreen\.html(\?|#|$)/.test(sender.url || "");
		if (!fromOffscreen || !NAMES.includes(name) || (op !== "get" && !WRITABLE.includes(name))) {
			sendResponse({ ok: false, error: "refused" });
			return false;
		}
		const done =
			op === "get"
				? chrome.storage.local.get(name).then((o) => ({ ok: true, value: o[name] }))
				: op === "set"
					? chrome.storage.local.set({ [name]: value }).then(() => ({ ok: true }))
					: chrome.storage.local.remove(name).then(() => ({ ok: true }));
		done.then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
		return true;
	}
	return false;
});
