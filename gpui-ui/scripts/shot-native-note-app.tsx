// Headless check of the PROTOTYPE native note view inside the app (Settings > General > "Show notes natively"), against an
// in-process core on a library COPY that has a child note:
//   ZN_DB=<copy of library.sqlite> ZN_PORT=23163 ZN_SHOTS=<dir> bun scripts/shot-native-note-app.tsx
// Turns the setting on, opens the first child note from its parent's Notes section, checks it is drawn natively with its text,
// then that Edit hands it to the usual editor. Writes <ZN_SHOTS>/native-note-app-*.png. Exits 1 on a failure.
import "./_shell-env";
import { Database } from "bun:sqlite";
import { boot, sleep, SHOTS } from "./shell-shot-lib";
import { startCore } from "../src/core";
import { viewPaneModel } from "../src/itempane/model";
import { detachSection } from "../src/shell/sectionPanes";
import { showNote } from "../src/itempane/Notes";
import { setNativeNotes, nativeNotesSupported } from "../src/notes/native/prefs";

const dbPath = process.env.ZN_DB;
if (!dbPath) throw new Error("set ZN_DB to a COPY of library.sqlite");
const ro = new Database(dbPath, { readonly: true });
const note = ro
	.query(`SELECT key, parent_key AS parent, data FROM items WHERE item_type = 'note' AND parent_key IS NOT NULL AND deleted = 0 LIMIT 1`)
	.get() as { key: string; parent: string; data: string } | null;
ro.close();
if (!note) throw new Error("no child note in the library copy");
const noteText = ((JSON.parse(note.data) as { note?: string }).note ?? "").replace(/<[^>]+>/g, "").trim();

let fails = 0;
const check = (ok: unknown, what: string) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
	if (!ok) fails++;
};
check(nativeNotesSupported, "the native view can run here (from source)");
setNativeNotes(true);

await startCore();
const h = await boot({ prefs: { mode: "light" }, width: 1400, height: 900 });
const r = h.t.renderer;
const bounds = (testId: string) => {
	const el = r.findByTestId(testId);
	const b = el ? r.getElementBounds(el.id) : null;
	return b && b.width > 0 && b.height > 0 ? b : null;
};

h.store.selectItem(note.parent);
for (let i = 0; i < 100 && viewPaneModel().itemKey() !== note.parent; i++) await sleep(50);
await h.settle(500);
// open it as the item list does on a double-click of the note's row (read, not edit)
showNote(note.parent, note.key);
await h.settle(300);
// the Notes section in a pane of its own (headless, the item pane's long list does not scroll down to it reliably)
check(detachSection("notes"), "detach the Notes section into its own pane");
await h.settle(600);
showNote(note.parent, note.key); // again: the first request went to the item pane's Notes section, gone with the detach
for (let i = 0; i < 40 && !bounds("native-note"); i++) await h.settle(150);
check(noteText.length > 0, `the note has text ("${noteText.slice(0, 40)}…")`);
r.captureScreenshot(`${SHOTS}/native-note-app-debug.png`);
console.log(
	"debug: pane item",
	viewPaneModel().itemKey(),
	"textareas",
	r.findByType("textarea").length,
	"native pane el",
	!!r.findByTestId("native-note-pane"),
	"native el",
	!!r.findByTestId("native-note"),
);
check(!!bounds("native-note-pane") && !!bounds("native-note"), "the note opens in the native view");
const md = r.findByType("markdown").filter((e: { id: number }) => {
	const b = r.getElementBounds(e.id);
	const pane = bounds("native-note");
	return b && pane && b.y >= pane.y - 1 && b.y < pane.y + pane.height;
});
check(md.length >= 1, `it draws the note's text natively (${md.length} <markdown> elements)`);
await h.settle(300);
r.captureScreenshot(`${SHOTS}/native-note-app-view.png`);

const edit = bounds("native-note-edit");
check(!!edit, "the Edit button is there");
if (edit) await h.click(edit.x + edit.width / 2, edit.y + edit.height / 2);
await h.settle(800);
check(!bounds("native-note-pane"), "Edit leaves the native view");
check(r.findByType("textarea").length > 0 || r.findByType("input").length > 0, "the usual editor is open (the Markdown editor, headless)");
r.captureScreenshot(`${SHOTS}/native-note-app-edit.png`);

setNativeNotes(false);
console.log(fails ? `${fails} check(s) failed` : "all checks passed");
process.exit(fails ? 1 : 0);
