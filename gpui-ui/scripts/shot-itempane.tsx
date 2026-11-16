// Headless screenshots of the item pane against the core at ZN_URL (a library COPY; the note-editing step writes to that copy).
//   bun scripts/shot-itempane.tsx [dark|light] [--only article|book|note|multi|empty|edit]
// Writes <scratch>/gpui-shots/itempane-*.png: article (journal article with PDF, tags, 25 creators), article-info (scrolled),
// book (hundreds of creators), note (note editor open, then Edit), multi (multi-selection), empty.
import { mkdirSync } from "node:fs";
import { Show } from "solid-js";
import { boot, sleep, SHOTS } from "./shell-shot-lib";
import { ItemPane } from "../src/itempane";
import { OverlayHost } from "../src/ui";
import { store } from "../src/store";
import { tw } from "../src/theme";

const args = process.argv.slice(2);
const mode = args.includes("light") ? "light" : "dark";
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
const suffix = mode === "light" ? "-light" : "";
mkdirSync(SHOTS, { recursive: true });

const ARTICLE = "9EYM2GG5"; // TRIPOD-LLM: journal article, PDF, 25 creators
const BOOK = "NLR6JA5Q"; // "book" with 924 creators
const WITH_NOTE = "W8ZWUFIP"; // journal article with a note and 64 tags

const { t, settle, click, clickText } = await boot({
	prefs: { mode },
	width: 1440,
	height: 881,
	view: () => (
		<div style={{ ...tw("flex bg-canvas", store.mode()), width: "100%", height: "100%" }}>
			<div style={{ flexGrow: 1 }} />
			<div
				style={{
					...tw("rounded-[14px] bg-background shadow-raised overflow-hidden", store.mode()),
					width: 403,
					height: "100%",
					flexShrink: 0,
				}}
			>
				<ItemPane />
			</div>
			<OverlayHost />
		</div>
	),
});
store.setMode(mode);

const shot = async (name: string) => {
	await settle(500);
	const file = `${SHOTS}/itempane-${name}${suffix}.png`;
	t.renderer.captureScreenshot(file);
	console.log("wrote", file);
};
const select = async (key: string, ms = 1500) => {
	store.selectItem(key);
	await sleep(ms);
	await settle(600);
};
const tab = async (id: string) => {
	const el = t.renderer.findByTestId("ip-nav-" + id);
	const b = el && t.renderer.getElementBounds(el.id);
	if (!b) throw new Error("no tab " + id);
	await click(b.x + b.width / 2, b.y + b.height / 2);
	await sleep(300);
	await settle(500);
};
const text = () => t.renderer.getAllText();
const want = (s: string) => {
	if (!text().some((x) => x.includes(s))) console.log(`!! missing text "${s}"`);
};
const scrollSections = (y: number) => {
	// the pane's body is a <virtual-list> (testId ip-list): scroll to the entry about y px down (entries are ~30 px)
	const el = t.renderer.findByTestId("ip-list");
	if (el) t.renderer.scrollToItem(el.id, Math.floor(y / 30));
	else console.log("!! no scroller");
};
const run = (n: string) => !only || only === n;

if (run("empty")) {
	await settle();
	await shot("empty");
}

if (run("article")) {
	await select(ARTICLE);
	want("Info".toUpperCase());
	await shot("article");
	scrollSections(520);
	await settle(500);
	await shot("article-info");
	scrollSections(1500);
	await settle(500);
	await shot("article-lower");
	scrollSections(0);
}

if (run("book")) {
	await select(BOOK, 2500);
	await shot("book");
	// expand the creators list
	try {
		await clickText(`50 more… (${Math.max(0, 924 - 5 - 50)} hidden)`);
	} catch {
		/* label differs */
	}
	await shot("book-more");
}

if (run("edit")) {
	await select(ARTICLE);
	// click the title field, type, escape (cancel): proves the native input path
	const title = t.renderer.findByText("The TRIPOD-LLM reporting guideline for studies using large language models");
	if (title) {
		const b = t.renderer.getElementBounds(title.id)!;
		await click(b.x + 20, b.y + 6);
		console.log("focused:", t.renderer.getFocusedElementId());
		await shot("title-edit");
		t.renderer.simulateKeystrokes("escape");
		await settle();
	} else console.log("!! no title text");
}

if (run("note")) {
	await select(WITH_NOTE, 2000);
	scrollSections(0);
	const detail = (await (await fetch(`http://127.0.0.1:23160/api/items/${WITH_NOTE}`)).json()) as {
		children: { itemType: string; title: string; key: string }[];
	};
	const note = detail.children.find((c) => c.itemType === "note");
	console.log("note child:", note?.key, JSON.stringify(note?.title));
	try {
		await tab("notes");
	} catch (e) {
		console.log("!! notes tab:", String(e));
	} // the tab scrolls to the section
	await settle(800);
	await shot("note-list");
	if (note) {
		try {
			await clickText(note.title || "Untitled note"); // open the note (preview: rendered Markdown)
			await sleep(800);
			await settle(600);
			await shot("note-preview");
			await clickText("Edit");
			await sleep(500);
			await settle();
			console.log("focused:", t.renderer.getFocusedElementId());
			t.renderer.simulateKeystrokes("ctrl-end");
			await settle(200);
			await shot("note-edit");
			// type into the editor, wait for the autosave, read the note back through the API, then restore it (the copy only)
			const before = ((await (await fetch(`http://127.0.0.1:23160/api/items/${note.key}`)).json()) as { data: { note: string } }).data
				.note;
			t.renderer.simulateKeystrokes("enter enter # space T e s t");
			await settle(300);
			console.log("open before:", text().includes("Preview"));
			await sleep(1600);
			console.log(
				"open after:",
				text().includes("Preview"),
				text().filter((x) => x.includes("Test")),
			);
			await settle(300);
			const after = ((await (await fetch(`http://127.0.0.1:23160/api/items/${note.key}`)).json()) as { data: { note: string } }).data
				.note;
			console.log("note saved:", after !== before, "| before:", before.slice(0, 80), "| after:", after.slice(0, 160));
			await shot("note-edit-typed");
			await fetch(`http://127.0.0.1:23160/api/items/${note.key}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ data: { note: before } }),
			});
		} catch (e) {
			console.log("!! note flow:", String(e));
		}
	}
}

if (run("tags")) {
	// add a tag through the Tags picker (writes to the library COPY), check it through the API, then remove it again
	await select(ARTICLE);
	try {
		await tab("tags");
	} catch (e) {
		console.log("!! tags tab:", String(e));
	}
	await settle(800);
	const inputs = t.renderer.findByType("input");
	const box = t.renderer.getElementBounds(inputs[inputs.length - 1]!.id);
	if (!box) console.log("!! no tag input bounds");
	else {
		await click(box.x + 20, box.y + 8);
		t.renderer.simulateKeystrokes("z z t e s t");
		await settle(400);
		await sleep(600);
		await shot("tags-typing");
		t.renderer.simulateKeystrokes("enter");
		await sleep(800);
		await settle(400);
		const tags = ((await (await fetch(`http://127.0.0.1:23160/api/items/${ARTICLE}`)).json()) as { tags: { tag: string }[] }).tags.map(
			(x) => x.tag,
		);
		console.log("tag added:", tags.includes("zztest"));
		await shot("tags-added");
		await fetch(`http://127.0.0.1:23160/api/items/${ARTICLE}/tags`, {
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ tags: ["zztest"] }),
		});
	}
}

if (run("multi")) {
	const set = (store as unknown as { setSelected?: (s: Set<string>) => void }).setSelected;
	if (set) {
		set(new Set([ARTICLE, WITH_NOTE, BOOK]));
		await sleep(500);
		await shot("multi");
	} else console.log("!! store.setSelected not available yet: multi-select shot skipped");
}

t.unmount();
process.exit(0);
