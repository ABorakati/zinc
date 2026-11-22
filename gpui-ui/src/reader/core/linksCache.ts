// The reader's per-page link cache: a result is stored only while the document it was loaded for is still the open one.

/**
 * Store `links` for page `i` when `loadedFor` is still the `open` document; a late answer (or a late failure) of a document that was
 * replaced must not seed the new document's cache: its pages would then never ask for their own links. True when it was stored.
 */
export function settleLinks<D, L>(cache: Map<number, L[] | Promise<L[]>>, open: D | undefined, loadedFor: D, i: number, links: L[]): boolean {
	if (open !== loadedFor) return false;
	cache.set(i, links);
	return true;
}
