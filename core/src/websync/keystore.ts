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
