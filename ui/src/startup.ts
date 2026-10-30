// The server answers one request at a time, so the slow tag list (about half a second on a big library) must not get
// in front of the item list when the Tags section was left open. It waits for the list to show.
let shown = () => {};
const listShown = new Promise<void>((resolve) => {
	shown = resolve;
	setTimeout(resolve, 4000); // a reader tab was restored or the list failed: don't hold it back for good
});

/** Called when the first page of items has arrived. */
export const markListShown = () => shown();

/** Resolves when the item list first showed (at once from then on, so later refetches are not delayed). */
export const afterListShown = () => listShown;
