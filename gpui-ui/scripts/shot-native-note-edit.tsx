// Headless end-to-end check of EDITING a note in the native view (click a block -> textarea of Markdown -> Ctrl+Enter / blur commits,
// Escape cancels -> debounced save through PATCH /api/items/<key>), against an in-process core on a COPY of a library with one child note:
//   ZN_DB=<copy of library.sqlite> ZN_PORT=23166 ZN_SHOTS=<dir> bun scripts/shot-native-note-edit.tsx
// The copy is edited (it is saved to); never point ZN_DB at a real library. Writes <ZN_SHOTS>/native-note-edit-*.png. Exits 1 on a failure.
import "./_shell-env";
import { Database } from "bun:sqlite";
import { boot, sleep, SHOTS } from "./shell-shot-lib";
import { startCore } from "../src/core";
import { viewPaneModel } from "../src/itempane/model";
import { detachSection } from "../src/shell/sectionPanes";
import { showNote } from "../src/itempane/Notes";
import { ipApi } from "../src/itempane/net";
import { setNativeNotes } from "../src/notes/native/prefs";

const dbPath = process.env.ZN_DB;
if (!dbPath) throw new Error("set ZN_DB to a COPY of library.sqlite");
if (/zotero-next[\\/]data|[\\/]Zotero[\\/]/i.test(dbPath)) throw new Error("ZN_DB looks like a real library; use a copy");
const ro = new Database(dbPath, { readonly: true });
const note = ro
	.query(`SELECT key, parent_key AS parent FROM items WHERE item_type = 'note' AND parent_key IS NOT NULL AND deleted = 0 LIMIT 1`)
	.get() as { key: string; parent: string } | null;
ro.close();
if (!note) throw new Error("no child note in the library copy");

let fails = 0;
const check = (ok: unknown, what: string) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
	if (!ok) fails++;
};
setNativeNotes(true);

await startCore();
const h = await boot({ prefs: { mode: "light" }, width: 1400, height: 900 });
const r = h.t.renderer;
const bounds = (testId: string) => {
	const el = r.findByTestId(testId);
	const b = el ? r.getElementBounds(el.id) : null;
	return b && b.width > 0 && b.height > 0 ? b : null;
};
const waitFor = async (testId: string, ms = 5000) => {
	for (let t = 0; t < ms && !bounds(testId); t += 150) await h.settle(150);
	return bounds(testId);
};
const gone = async (testId: string, ms = 3000) => {
	for (let t = 0; t < ms && bounds(testId); t += 150) await h.settle(150);
	return !bounds(testId);
};
const clickId = async (testId: string) => {
	const b = bounds(testId);
	if (!b) return false;
	await h.click(b.x + b.width / 2, b.y + b.height / 2);
	return true;
};
/** the Add paragraph button sits at the left of its full-width wrapper (native-note-add), so click its label */
const clickAdd = async () => {
	const el = r.findByText("Add paragraph");
	const b = el ? r.getElementBounds(el.id) : null;
	if (!b || !bounds("native-note-add")) return false;
	await h.click(b.x + b.width / 2, b.y + b.height / 2);
	return true;
};
/** typed to whatever holds focus: one GPUI keystroke per character */
const keys = (text: string) =>
	text
		.split("")
		.map((c) => (c === " " ? "space" : c === "\n" ? "enter" : c))
		.join(" ");
const press = async (k: string) => {
	r.simulateKeystrokes(k);
	await h.settle(200);
};
const type = async (text: string) => {
	for (const line of text.split("\n")) {
		if (line) await press(keys(line));
		if (text.includes("\n") && line !== text.split("\n").at(-1)) await press("enter");
	}
};
const editorValue = () => {
	const el = r.findByTestId("native-block-editor");
	if (!el) return null;
	const cp = el.customProps as Record<string, unknown> | undefined;
	return String(cp?.value ?? cp?.defaultValue ?? el.text ?? "");
};
const savedHtml = async () => ((await ipApi.item(note.key)).data.note as string | undefined) ?? "";
const waitSaved = async (pred: (html: string) => boolean, ms = 4000) => {
	let html = "";
	for (let t = 0; t < ms; t += 250) {
		html = await savedHtml();
		if (pred(html)) return html;
		await h.settle(250);
	}
	return html;
};
const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;
const status = () => {
	const el = r.findByTestId("native-note-status");
	if (!el) return "";
	const own = el.text ?? "";
	if (own) return own;
	for (const id of el.children) {
		const c = (r as unknown as { getElement?: (id: number) => { text: string | null } | undefined }).getElement?.(id);
		if (c?.text) return c.text;
	}
	return r.findByText("Saved") ? "Saved" : r.findByText("Saving…") ? "Saving…" : "";
};
const shot = async (name: string) => {
	await h.settle(300);
	r.captureScreenshot(`${SHOTS}/native-note-edit-${name}.png`);
};

h.store.selectItem(note.parent);
for (let i = 0; i < 100 && viewPaneModel().itemKey() !== note.parent; i++) await sleep(50);
await h.settle(500);
showNote(note.parent, note.key);
await h.settle(300);
detachSection("notes");
await h.settle(600);
showNote(note.parent, note.key);

// 1. opens natively with block 0
await waitFor("native-note");
check(!!bounds("native-note"), "1. the note opens natively (native-note)");
check(!!(await waitFor("native-block-0", 3000)), "1. block 0 (native-block-0) is there");
await shot("1-view");
const originalHtml = await savedHtml();
console.log("original:", originalHtml);

// 2. click block 0 -> editor holding Markdown
await clickId("native-block-0");
await waitFor("native-block-editor", 3000);
const v0 = editorValue();
check(!!bounds("native-block-editor"), "2. clicking block 0 opens native-block-editor");
check(v0?.startsWith("Core claim"), `2. the editor value starts with "Core claim" (got ${JSON.stringify(v0)})`);
await shot("2-editor");

// 3. replace the text, with **bold** Markdown, commit with Ctrl+Enter
await press("ctrl-a");
await type("Edited claim: **really bold** words");
await shot("3-typed");
console.log("editor value before commit:", JSON.stringify(editorValue()));
await press("ctrl-enter");

// 4. editor closes, note saved, status Saved
check(await gone("native-block-editor"), "4. Ctrl+Enter closes the editor");
const html4 = await waitSaved((s) => s.includes("really bold"));
console.log("saved:", html4);
check(html4.includes("Edited claim"), "4. the saved note contains the new words");
check(/<strong>\s*really bold\s*<\/strong>/.test(html4), "4. the saved note has a <strong> element around the bold text");
for (let i = 0; i < 10 && status() !== "Saved"; i++) await h.settle(200);
check(status() === "Saved", `4. the status shows "Saved" (got ${JSON.stringify(status())})`);
await shot("4-saved");

// 5. add paragraph, type, Escape -> not saved; add again, type, commit -> two <p>
const pBefore = count(await savedHtml(), /<p[ >]/g);
check(await clickAdd(), "5. the Add paragraph button (native-note-add) is there");
await waitFor("native-block-editor", 3000);
check(!!bounds("native-block-editor"), "5. Add paragraph opens an editor");
await type("A second paragraph");
await press("escape");
check(await gone("native-block-editor"), "5. Escape closes the editor");
await sleep(1500);
await h.settle(300);
const html5a = await savedHtml();
check(!html5a.includes("A second paragraph"), "5. Escape cancels: nothing saved for the cancelled paragraph");
check(
	count(html5a, /<p[ >]/g) === pBefore,
	`5. the saved paragraph count is unchanged after cancel (${count(html5a, /<p[ >]/g)} vs ${pBefore})`,
);

await clickAdd();
await waitFor("native-block-editor", 3000);
await type("A second paragraph");
await press("ctrl-enter");
const html5b = await waitSaved((s) => s.includes("A second paragraph"));
console.log("saved:", html5b);
check(html5b.includes("A second paragraph"), "5. committing saves the second paragraph");
check(count(html5b, /<p[ >]/g) === 2, `5. the saved note has two <p> elements (got ${count(html5b, /<p[ >]/g)})`);
await shot("5-two-paragraphs");

// 6. a list typed into a new paragraph
await clickAdd();
await waitFor("native-block-editor", 3000);
await type("- item one\n- item two");
console.log("editor value before commit:", JSON.stringify(editorValue()));
await press("ctrl-enter");
const html6 = await waitSaved((s) => s.includes("item two"));
console.log("saved:", html6);
check(count(html6, /<ul[ >]/g) === 1, `6. the saved note has a <ul> (got ${count(html6, /<ul[ >]/g)})`);
check(count(html6, /<li[ >]/g) === 2, `6. the <ul> has two <li> (got ${count(html6, /<li[ >]/g)})`);
await shot("6-list");

setNativeNotes(false);
console.log(fails ? `${fails} check(s) failed` : "all checks passed");
process.exit(fails ? 1 : 0);
