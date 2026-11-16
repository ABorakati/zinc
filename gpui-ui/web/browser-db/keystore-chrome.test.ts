import { expect, test } from "bun:test";
import { chromeKeyStore, KEY_STORAGE_NAME, type StorageArea } from "./keystore-chrome";

function fakeArea() {
	const data: Record<string, unknown> = {};
	const area: StorageArea = {
		async get(k) {
			return k in data ? { [k]: data[k] } : {};
		},
		async set(items) {
			Object.assign(data, items);
		},
		async remove(k) {
			delete data[k];
		},
	};
	return { data, area };
}

test("chromeKeyStore keeps the key under zincZoteroApiKey", async () => {
	const { data, area } = fakeArea();
	const ks = chromeKeyStore(area);
	expect(KEY_STORAGE_NAME).toBe("zincZoteroApiKey");
	expect(await ks.get()).toBeNull();
	await ks.set("k1");
	expect(data.zincZoteroApiKey).toBe("k1");
	expect(await ks.get()).toBe("k1");
	await ks.delete();
	expect(await ks.get()).toBeNull();
});

test("without chrome.storage it fails clearly on use, not on import", async () => {
	await expect(chromeKeyStore().get()).rejects.toThrow("chrome.storage.local");
});
