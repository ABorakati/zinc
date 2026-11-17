// Headless check of "Open in Zinc" for an item with no file (store.revealItem): starting in a collection with a search typed, it must
// switch to My Library, clear the search, select the item and scroll its row into view.
//   ZN_URL=<core on a library COPY> bun scripts/shot-reveal.tsx [table|cards]
// Picks the item 600 rows down My Library (default sort), so it is far off screen. Prints the checks and writes
// <scratchpad>/gpui-shots/shell-reveal-<mode>.png. Preferences go to a throw-away ui-state.json (scripts/_shell-env.ts).
import { boot, sleep } from "./shell-shot-lib";

const mode = process.argv.includes("cards") ? "cards" : "table";
const base = process.env.ZN_URL!;
const get = async (p: string) => (await fetch(base + p)).json() as Promise<any>;

const h = await boot();
const store = h.store;
store.setViewMode?.(mode === "cards" ? "cards" : "table");
await sleep(1500);

const target = (await get("/api/items?limit=1&offset=600")).items[0] as { key: string; title: string };
const colls = (await get("/api/collections")) as { key: string }[];
// start somewhere the item is not on screen: a collection, with a search typed ("stay": in My Library, only far down)
if (!process.argv.includes("stay")) {
	if (colls[0]) store.selectCollection(colls[0].key);
	store.setFilter("zzzz-no-match");
	await sleep(1200);
}

const ok = await store.revealItem(target.key);
await sleep(2000);

const checks = {
	found: ok,
	view: store.view().kind,
	filter: store.filter(),
	selected: store.selectedItem() === target.key,
	focusIndex: store.focusIndex(),
	rowShown: store.peek(store.focusIndex())?.key === target.key,
};
console.log(`target ${target.key} "${target.title.slice(0, 60)}"`);
console.log(JSON.stringify(checks));
console.log(await h.shot(`reveal-${mode}`));
// where the list scrolled to: [first visible row, offset in it, viewport height]
const listEl = h.t.renderer.findByTestId(mode === "cards" ? "card-list" : "table-list");
console.log("list scroll anchor:", listEl ? JSON.stringify(h.t.renderer.getListScrollTop(listEl.id)) : "list not found");
console.log("scroll request:", JSON.stringify(store.scrollRequest()));
if (process.argv.includes("direct") && listEl) {
	h.t.renderer.scrollToItem(listEl.id, store.focusIndex(), -300);
	await h.settle(500);
	console.log("after a direct scrollToItem:", JSON.stringify(h.t.renderer.getListScrollTop(listEl.id)));
}
process.exit(0);
