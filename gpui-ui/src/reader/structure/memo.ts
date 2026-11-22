// What loadStructure remembers: the structure of the document an attachment holds NOW. Shared by the desktop loader (load.ts) and the
// browser one (load.docworker.web.ts); pure, no I/O, so it is unit-testable.

/** A cheap identity of a PDF's content: its size and a hash of its ends and of bytes spread over the rest (a page edit rewrites the file). */
export function fingerprint(bytes: Uint8Array): string {
	const n = bytes.byteLength;
	let h = 0x811c9dc5; // FNV-1a
	const mix = (i: number) => {
		h = Math.imul(h ^ bytes[i]!, 0x01000193) >>> 0;
	};
	const edge = Math.min(n, 1 << 16);
	for (let i = 0; i < edge; i++) mix(i);
	for (let i = Math.max(edge, n - edge); i < n; i++) mix(i);
	const step = Math.max(1, Math.floor(n / 4096));
	for (let i = edge; i < n - edge; i += step) mix(i);
	return `${n}-${h.toString(36)}`;
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
