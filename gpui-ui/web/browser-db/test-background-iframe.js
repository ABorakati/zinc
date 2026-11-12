// Like test-background.js, but the way the real connector does it: the extension's one offscreen document is the connector's own page
// (here test-offscreen.html), and library/offscreen.html is a hidden iframe inside it (browser-library-check.ts --iframe).
let creating = null;
async function ensureOffscreen() {
	if (await chrome.offscreen.hasDocument?.()) return;
	creating ??= chrome.offscreen
		.createDocument({ url: "test-offscreen.html", reasons: ["WORKERS"], justification: "Zinc library database" })
		.catch((e) => { if (!/single offscreen|already exists/i.test(String(e?.message ?? e))) throw e; })
		.finally(() => { creating = null; });
	await creating;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	if (!msg || msg.zincEnsureDb !== true) return false;
	ensureOffscreen().then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
	return true;
});
