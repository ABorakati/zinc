// The zotero.org API key in the browser edition: chrome.storage.local, key "zincZoteroApiKey" (browser-db/CONTRACT.md).
//
// core's KeyStore interface is already async (get/set/delete return promises), so this backend needs no change to the websync call
// sites: chrome.storage.local is async too and each call maps one to one. The key is read only where websync runs (the offscreen
// document or its worker), never sent to a tab. chrome.storage.local is not encrypted; it is the extension's private storage,
// which web pages cannot read, and the best a browser extension has (there is no keychain API).
//
// Use, in the worker before startWebSync:
//   import { setDefaultKeyStore } from "../../../core/src/websync/keystore";
//   setDefaultKeyStore(chromeKeyStore());
// (or pass `keyStore: chromeKeyStore()` in WebSyncOptions).

import type { KeyStore } from "../../../core/src/websync/keystore";

export const KEY_STORAGE_NAME = "zincZoteroApiKey";

/** The part of chrome.storage.local this uses (a fake in tests). */
export interface StorageArea {
	get(keys: string): Promise<Record<string, unknown>>;
	set(items: Record<string, unknown>): Promise<void>;
	remove(keys: string): Promise<void>;
}

export function chromeKeyStore(area?: StorageArea): KeyStore {
	// resolved on use, so importing this file where `chrome` does not exist (a test, the demo) is harmless
	const storage = (): StorageArea => {
		const a = area ?? (globalThis as { chrome?: { storage?: { local?: StorageArea } } }).chrome?.storage?.local;
		if (!a) throw new Error("chrome.storage.local is not available here");
		return a;
	};
	return {
		async get() {
			const v = (await storage().get(KEY_STORAGE_NAME))[KEY_STORAGE_NAME];
			return typeof v === "string" && v ? v : null;
		},
		async set(key) {
			await storage().set({ [KEY_STORAGE_NAME]: key });
		},
		async delete() {
			await storage().remove(KEY_STORAGE_NAME);
		},
	};
}
