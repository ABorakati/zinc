// Whether the app is the browser library: the Zinc Connector's library.html?mode=browser, whose library and API key live in this
// browser (the extension's storage), not on a desktop computer. web/extension.tsx sets it once, before the app renders. It stays
// false on the desktop app and in the in-memory browser demo, so desktop-only settings keep their text there.
let browser = false;

/** Called by web/extension.tsx with its ?mode=browser flag. */
export function setBrowserLibrary(on: boolean): void {
	browser = on;
}

/** True only on the browser library page. */
export function isBrowserLibrary(): boolean {
	return browser;
}
