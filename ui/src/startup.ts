// The server answers one request at a time, so the slow startup requests (tag list, duplicate detection: about half a
// second each on a big library) must not get in front of the item list. They wait for it to show.
let shown = () => {};
const listShown = new Promise<void>((resolve) => {
	shown = resolve;
	setTimeout(resolve, 4000); // a reader tab was restored or the list failed: don't hold them back for good
});

/** Called when the first page of items has arrived. */
export const markListShown = () => shown();

const waits = new Map<number, Promise<void>>();
/** Resolves `ms` after the item list first showed (at once from then on, so later refetches are not delayed). */
export function afterListShown(ms = 0): Promise<void> {
	let w = waits.get(ms);
	if (!w) waits.set(ms, (w = listShown.then(() => new Promise((r) => setTimeout(r, ms)))));
	return w;
}
