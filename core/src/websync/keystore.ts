// Where the zotero.org API key lives: the OS keychain through Bun.secrets, never SQLite, logs or API responses.

export interface KeyStore {
	get(): Promise<string | null>;
	set(key: string): Promise<void>;
	delete(): Promise<void>;
}

const SERVICE = "zotero-next";
const NAME = "zotero-api-key";

export const bunKeyStore: KeyStore = {
	async get() {
		return (await Bun.secrets.get({ service: SERVICE, name: NAME })) ?? null;
	},
	async set(key) {
		await Bun.secrets.set({ service: SERVICE, name: NAME, value: key });
	},
	async delete() {
		await Bun.secrets.delete({ service: SERVICE, name: NAME });
	},
};

let defaultStore: KeyStore = bunKeyStore;

/**
 * The key store a WebSyncService uses when WebSyncOptions.keyStore is not given. Desktop: the OS keychain (bunKeyStore).
 * A browser worker, where Bun.secrets does not exist, installs its own (gpui-ui/web/browser-db/keystore-chrome.ts) before
 * startWebSync. The interface is already async, so any backend fits and no call site needed changing.
 */
export function setDefaultKeyStore(ks: KeyStore): void {
	defaultStore = ks;
}

export function getDefaultKeyStore(): KeyStore {
	return defaultStore;
}

/** Test double: keeps the key in memory so tests never touch the real keychain. */
export class MemoryKeyStore implements KeyStore {
	value: string | null;
	constructor(value: string | null = null) {
		this.value = value;
	}
	async get() {
		return this.value;
	}
	async set(key: string) {
		this.value = key;
	}
	async delete() {
		this.value = null;
	}
}
