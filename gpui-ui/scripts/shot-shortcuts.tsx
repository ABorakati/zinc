// Headless check of Zotero's keyboard shortcuts in the whole app and of rebinding them in Settings > Shortcuts, against the core at
// ZN_URL (a library COPY: the Delete and coloured-tag checks change items there, and put them back).
//   ZN_URL=<core> bun scripts/shot-shortcuts.tsx
// Prints PASS / FAIL lines; exits 1 on a failure. Preferences go to a throw-away ui-state.json (scripts/_shell-env.ts).
import { boot, sleep } from "./shell-shot-lib";

const h = await boot();
const { t, store, settle } = h;
await import("../src/features");
await settle(800);
const r = t.renderer;
const base = process.env.ZN_URL!.replace(/\/+$/, "");
const api = async (method: string, path: string, body?: unknown) => {
	const res = await fetch(base + "/api" + path, {
		method,
		headers: body ? { "content-type": "application/json" } : undefined,
		body: body ? JSON.stringify(body) : undefined,
	});
	return res.status === 204 ? null : res.json();
};

let fails = 0;
const check = (what: string, ok: boolean, extra = "") => {
	if (!ok) fails++;
	console.log(`${ok ? "PASS" : "FAIL"} ${what}${extra ? `  (${extra})` : ""}`);
};
/** Keys to the focused element (lists, the Settings recorder). */
const keys = async (k: string, ms = 250) => {
	r.simulateKeystrokes(k);
	await settle(ms);
};
const { handleWindowKeyDown } = await import("../src/shell/shortcuts");
/** A key stroke to the window's handler, as main.tsx's render() delivers one nothing focused took ("ctrl-shift-t"). The test
    root installs no window handler of its own. */
const win = async (k: string, ms = 250) => {
	const parts = k.split("-");
	const key = parts.pop()!;
	const mods = { ctrl: parts.includes("ctrl"), shift: parts.includes("shift"), alt: parts.includes("alt") };
	handleWindowKeyDown({ key, modifiers: mods, defaultPrevented: false, preventDefault() {} } as never);
	await settle(ms);
};
/** Centre of the button labelled `label` inside the element with this test id. */
const buttonIn = (testId: string, label: string) => {
	const box = r.findByTestId(testId);
	const b = box ? r.getElementBounds(box.id) : null;
	if (!b) return null;
	for (const el of r.findByType("text")) {
		if (el.text !== label) continue;
		const e = r.getElementBounds(el.id);
		if (e && e.x >= b.x && e.x + e.width <= b.x + b.width + 1 && e.y >= b.y && e.y + e.height <= b.y + b.height + 1)
			return { x: e.x + e.width / 2, y: e.y + e.height / 2 };
	}
	return null;
};

const { appActions } = await import("../src/registry");
const { actionShortcut, canonicalChord } = await import("../src/shell/shortcuts");
const { effectiveShortcut, resetAllShortcuts } = await import("../src/shell/bindings");
const { openSettings, closeSettings } = await import("../src/shell/layout");
const { tagsOpen } = await import("../src/sidebar/state");

// ---- 1. every default key is used once
const byChord = new Map<string, string[]>();
for (const a of appActions()) {
	const c = canonicalChord(actionShortcut(a) ?? "");
	if (c) byChord.set(c, [...(byChord.get(c) ?? []), a.id]);
}
const clashes = [...byChord].filter(([, ids]) => ids.length > 1);
check("no two commands share a default key", clashes.length === 0, clashes.map(([c, ids]) => `${c}: ${ids.join(", ")}`).join("; "));
for (const [id, want] of [
	["add.newItem", "Ctrl+Shift+N"],
	["add.note", "Ctrl+Shift+O"],
	["io.import", "Ctrl+Shift+I"],
	["io.importClipboard", "Ctrl+Alt+Shift+I"],
	["sidebar-focus", "Ctrl+Shift+L"],
	["search.quick", "Ctrl+Shift+K"],
	["cite.shortcut-citation", "Ctrl+Shift+A"],
	["cite.shortcut-bibliography", "Ctrl+Shift+C"],
	["tags-toggle", "Ctrl+Shift+T"],
] as const) {
	const a = appActions().find((x) => x.id === id);
	check(`${want} is bound to ${id}`, !!a && actionShortcut(a) === want, a ? String(actionShortcut(a)) : "not registered");
}

// ---- 2. Ctrl+Shift+T opens and closes the tag selector
const tags0 = tagsOpen();
await win("ctrl-shift-t");
check("Ctrl+Shift+T toggles the tag selector", tagsOpen() === !tags0);
await win("ctrl-shift-t");

// ---- 3. tab keys, with the Settings tab open beside Library
openSettings();
await settle();
await win("ctrl-1");
check("Ctrl+1 goes to the Library tab", store.activeTab() === "library", store.activeTab());
await win("ctrl-tab");
check("Ctrl+Tab goes to the next tab", store.activeTab() === "settings", store.activeTab());
await win("ctrl-tab");
check("Ctrl+Tab wraps round to the first", store.activeTab() === "library", store.activeTab());
await win("ctrl-shift-tab");
check("Ctrl+Shift+Tab goes back", store.activeTab() === "settings", store.activeTab());
await win("ctrl-pageup");
check("Ctrl+PageUp goes back", store.activeTab() === "library", store.activeTab());
await win("ctrl-9");
check("Ctrl+9 goes to the last tab", store.activeTab() === "settings", store.activeTab());

// ---- 4. rebinding in Settings > Shortcuts: Change, press the keys
const { setSettingsQuery } = await import("../src/settings/registry");
setSettingsQuery("Quick Search");
await settle(500);
const cb = buttonIn("shortcut-search.quick", "Change");
check("Settings lists Quick Search with a Change button", !!cb);
if (cb) {
	await h.click(cb.x, cb.y);
	check("Change shows the key recorder", !!r.findByTestId("shortcut-recorder-search.quick"));
	await keys("k"); // a plain letter is refused
	check("a plain letter is refused", effectiveShortcut("search.quick", "Ctrl+Shift+K") === "Ctrl+Shift+K");
	await h.shot("shortcuts-recording");
	await keys("ctrl-alt-q");
	check("Ctrl+Alt+Q is recorded", effectiveShortcut("search.quick", "Ctrl+Shift+K") === "Ctrl+Alt+Q");
	await h.shot("shortcuts-settings");
}
// taking a key another command has: it moves over
setSettingsQuery("Next tab");
await settle(500);
const cb2 = buttonIn("shortcut-tab-next", "Change");
if (cb2) {
	await h.click(cb2.x, cb2.y);
	await keys("ctrl-alt-q");
	check(
		"a key taken from another command moves",
		effectiveShortcut("tab-next", "Ctrl+Tab") === "Ctrl+Alt+Q" && !effectiveShortcut("search.quick", "Ctrl+Shift+K"),
	);
} else check("Settings lists Next tab", false);
await win("ctrl-alt-q");
check("the moved key runs its new command", store.activeTab() === "library", store.activeTab());
setSettingsQuery("");
resetAllShortcuts();
check("Reset all puts the defaults back", effectiveShortcut("tab-next", "Ctrl+Tab") === "Ctrl+Tab");
closeSettings();
await settle();

// ---- 5. Delete in a collection removes the item from it (not to the Trash); the item is put back afterwards
const listEl = () => r.findByTestId("table-container") ?? r.findByTestId("card-list-container");
/** Click the first row (by its title text), as a user would: it selects the item and gives the list the keys. */
const clickFirstRow = async (): Promise<string | undefined> => {
	const it = store.peek(0);
	if (!it) return undefined;
	const head = it.title.slice(0, 12);
	const el = r.findByType("text").find((e) => (e.text ?? "").startsWith(head));
	const b = el ? r.getElementBounds(el.id) : null;
	if (!b) return undefined;
	await h.click(b.x + Math.min(20, b.width / 2), b.y + b.height / 2);
	return it.key;
};
const colls = (await api("GET", "/collections")) as { key: string; name: string }[];
let coll: { key: string; name: string } | undefined;
for (const c of colls) {
	const page = (await api("GET", `/items?collection=${c.key}&limit=1`)) as { items: { key: string }[] };
	if (page.items[0]) {
		coll = c;
		break;
	}
}
let item: string | undefined;
if (coll) {
	store.setView({ kind: "collection", key: coll.key });
	await sleep(1500);
	item = await clickFirstRow();
}
if (coll && item) {
	const focusedId = (r as { getFocusedElementId?: () => number | null }).getFocusedElementId?.();
	check("a click on a row gives the list the keys", focusedId === listEl()?.id, `focused ${focusedId}, list ${listEl()?.id}`);
	console.log(`canEdit ${store.canEdit()} selected ${store.selectedItem()} item ${item}`);
	await keys("delete", 600);
	// the dialog's "Remove" button: the one just below its title (other "Remove" texts exist elsewhere in the app)
	const title = r.findByType("text").find((e) => (e.text ?? "").startsWith("Remove 1 item from this collection"));
	const tb = title ? r.getElementBounds(title.id) : null;
	const yb = tb
		? (r
				.findByType("text")
				.filter((e) => e.text === "Remove")
				.map((e) => r.getElementBounds(e.id))
				.find((b) => !!b && b.y > tb.y && b.y < tb.y + 150) ?? null)
		: null;
	check("Delete in a collection asks to remove from it", !!yb);
	if (yb) await h.click(yb.x + yb.width / 2, yb.y + yb.height / 2);
	await sleep(1000);
	const d = (await api("GET", `/items/${item}`)) as { collections: string[]; data: { deleted?: number } };
	check("the item left the collection", !d.collections.includes(coll.key), JSON.stringify(d.collections));
	check("the item is not in the Trash", !d.data.deleted);
	await api("POST", `/collections/${coll.key}/items`, { keys: [item] }); // put it back
} else console.log("(no collection with items: Delete not checked)");

// ---- 6. 1–9 toggle the coloured tags
const colors = (await api("GET", "/tag-colors")) as { name: string; color: string; position: number }[];
let added: { name: string } | null = null;
if (!colors.length) {
	added = { name: "zz-shortcut-test" };
	await api("PUT", "/tag-colors", [{ name: added.name, color: "#FF6666", position: 0 }]);
}
const tag = colors.sort((a, b) => a.position - b.position)[0]?.name ?? added!.name;
store.setView({ kind: "library" });
await sleep(1500);
const first = await clickFirstRow();
if (first) {
	await keys("down");
	check("after a click, Down moves to the next item", store.focusIndex() === 1, `focus ${store.focusIndex()}`);
	await keys("up");
	check("and Up back", store.focusIndex() === 0 && store.selectedItem() === first);
	const before = ((await api("GET", `/items/${first}`)) as { tags: { tag: string }[] }).tags.some((x) => x.tag === tag);
	await keys("1", 1500);
	const after = ((await api("GET", `/items/${first}`)) as { tags: { tag: string }[] }).tags.some((x) => x.tag === tag);
	check(`1 toggles the coloured tag "${tag}"`, after === !before);
	await keys("1", 1500);
	const back = ((await api("GET", `/items/${first}`)) as { tags: { tag: string }[] }).tags.some((x) => x.tag === tag);
	check("1 again toggles it back", back === before);
}
if (added) await api("PUT", "/tag-colors", []);

console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
