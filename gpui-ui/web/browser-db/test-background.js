// The service worker of the headless check's test extension (web/browser-library-check.ts). It does what the connector's background
// does for the browser library (CONTRACT.md, "{zincEnsureDb: true}"): create the offscreen document when something asks for the
// database, and answer ok. The page that asks is the library tab (web/extension.tsx) or the connector's own code.
let creating = null;
async function ensureOffscreen() {
	if (await chrome.offscreen.hasDocument?.()) return;
	creating ??= chrome.offscreen
		.createDocument({ url: "library/offscreen.html", reasons: ["WORKERS"], justification: "Zinc library database" })
		.catch((e) => { if (!/single offscreen|already exists/i.test(String(e?.message ?? e))) throw e; })
		.finally(() => { creating = null; });
	await creating;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	if (!msg || msg.zincEnsureDb !== true) return false;
	ensureOffscreen().then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
	return true;
});
