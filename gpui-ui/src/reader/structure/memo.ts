// What loadStructure remembers: the structure of the document an attachment holds NOW. Shared by the desktop loader (load.ts) and the
// browser one (load.docworker.web.ts); pure, no I/O, so it is unit-testable.

/**
 * The identity of a PDF's content: its size and a hash of all of it. Not a sample: a rotated page can change two bytes in the middle
 * and nothing else. It is taken word by word (FNV-1a over 32-bit words), which takes milliseconds for a large file.
 */
export function fingerprint(bytes: Uint8Array): string {
	const n = bytes.byteLength;
	const words = n >>> 2;
	let h = 0x811c9dc5;
	if (bytes.byteOffset % 4 === 0) {
		const u32 = new Uint32Array(bytes.buffer, bytes.byteOffset, words);
		for (let i = 0; i < words; i++) h = Math.imul(h ^ u32[i]!, 0x01000193);
	} else {
		const view = new DataView(bytes.buffer, bytes.byteOffset, n);
		for (let i = 0; i < words; i++) h = Math.imul(h ^ view.getUint32(i * 4, true), 0x01000193);
	}
	for (let i = words * 4; i < n; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193);
	return `${n}-${(h >>> 0).toString(36)}`;
}

/**
 * Remember the promise `make()` returns for (attachment, content id), for the attachments used last (`max`). The same attachment with
 * other content (the file was rotated or had pages deleted: same key, new bytes) replaces the old entry instead of answering with it.
 * A rejected promise is forgotten, so a retry can run.
 */
export function latestPerAttachment<V>(max = 6): (attachmentKey: string, id: string, make: () => Promise<V>) => Promise<V> {
	const kept = new Map<string, { id: string; p: Promise<V> }>();
	return (attachmentKey, id, make) => {
		const hit = kept.get(attachmentKey);
		kept.delete(attachmentKey); // re-inserted below: the map's order is the order of last use
		if (hit && hit.id === id) {
			kept.set(attachmentKey, hit);
			return hit.p;
		}
		const entry = { id, p: make() };
		kept.set(attachmentKey, entry);
		entry.p.catch(() => {
			if (kept.get(attachmentKey) === entry) kept.delete(attachmentKey);
		});
		while (kept.size > max) kept.delete(kept.keys().next().value!);
		return entry.p;
	};
}
