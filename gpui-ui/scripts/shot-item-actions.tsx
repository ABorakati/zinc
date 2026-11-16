// Headless screenshots + checks of the two item actions (no window opens):
//   ZN_URL=http://127.0.0.1:<port> bun scripts/shot-item-actions.tsx
// Writes <SHOTS>/item-actions-{menu,duplicated,menu-attachment,create-parent-dialog,parent-created,create-parent-manual,parent-manual,menu-table}.png
// and exits non-zero when a check fails. Needs a core on a library COPY (scripts/README.md): the run duplicates an item, gives a
// standalone PDF a parent by DOI and another one by hand, so it changes that copy.
import { mkdirSync } from "node:fs";
import { boot, SHOTS, sleep } from "./shell-shot-lib";
import { register } from "../src/features/index";

const BASE = (process.env.ZN_URL ?? "http://127.0.0.1:23160").replace(/\/+$/, "");
register(); // the item actions live in the features (main.tsx registers them; <App/> alone does not)
mkdirSync(SHOTS, { recursive: true });

type Row = { key: string; itemType: string; title: string };
type Page = { total: number; items: Row[] };
const api = async <T,>(path: string): Promise<T> => {
	const res = await fetch(`${BASE}/api${path}`);
	if (!res.ok) throw new Error(`${path}: ${res.status}`);
	return (await res.json()) as T;
};
interface Attachment {
	key: string;
	title: string;
	collections: string[];
}
/** A standalone PDF attachment (every row of the item list is a top-level item), preferably one that is in a collection. */
async function findStandalonePdf(skip: string[] = [], wantCollection = false): Promise<Attachment> {
	const found: Attachment[] = [];
	for (let page = 0; page < 20 && !(wantCollection && found.some((f) => f.collections.length)); page++) {
		const p = await api<Page>(`/items?limit=100&offset=${page * 100}&sort=dateAdded&dir=asc`);
		for (const row of p.items) {
			if (row.itemType !== "attachment" || skip.includes(row.key)) continue;
			const d = await api<{ data: { contentType?: string; filename?: string; title?: string }; collections: string[] }>(
				`/items/${row.key}`,
			);
			if (/pdf/i.test(String(d.data.contentType ?? d.data.filename ?? "")))
				found.push({ key: row.key, title: String(d.data.title ?? row.title), collections: d.collections });
		}
		if (p.items.length < 100) break;
	}
	const pick = (wantCollection && found.find((f) => f.collections.length)) || found[0];
	if (!pick) throw new Error("no standalone PDF attachment in the library");
	return pick;
}
/** The sidebar tree's item count for a collection (walked like the sidebar does). */
const treeCount = (key: string): number | undefined => {
	const walk = (list: { key: string; itemCount: number; children?: unknown[] }[]): number | undefined => {
		for (const c of list) {
			if (c.key === key) return c.itemCount;
			const r = c.children ? walk(c.children as { key: string; itemCount: number; children?: unknown[] }[]) : undefined;
			if (r !== undefined) return r;
		}
		return undefined;
	};
	return walk(store.collections() as unknown as { key: string; itemCount: number; children?: unknown[] }[]);
};
/** A DOI of an item that is already in the library (so the lookup needs no network). */
async function findKnownDoi(): Promise<string> {
	const p = await api<Page>("/items?limit=60&sort=dateAdded&dir=asc");
	for (const row of p.items) {
		if (row.itemType === "attachment" || row.itemType === "note") continue;
		const d = await api<{ data: { DOI?: string } }>(`/items/${row.key}`);
		if (d.data.DOI) return d.data.DOI;
	}
	throw new Error("no item with a DOI in the library");
}

const { t, store, settle } = await boot({ width: 1440, height: 900 });
const r = t.renderer;
const text = () => r.getAllText();
const has = (s: string) => text().some((x) => x.includes(s));
let failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
	if (!ok) failed++;
};
const waitFor = async (cond: () => boolean, ms = 8000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		await settle(120);
		if (cond()) return true;
	}
	return false;
};
/** Bounds of the first <text> whose content is `s` (or contains it); retried so a just-rendered overlay is laid out. */
const boundsOf = async (s: string, exact = false) => {
	for (let i = 0; i < 12; i++) {
		const all = r.findByType("text");
		const el = all.find((x) => (exact ? (x.text ?? "") === s : (x.text ?? "").includes(s)));
		const b = el ? r.getElementBounds(el.id) : null;
		if (b) return { x: b.x + Math.min(24, b.width / 2), y: b.y + b.height / 2 };
		await settle(150);
	}
	console.log(
		`!! no text "${s}"; texts with that word:`,
		text()
			.filter((x) => x.includes(s.split(" ")[0]!))
			.slice(0, 6),
	);
	return null;
};
const press = async (s: string, exact = false) => {
	const p = await boundsOf(s, exact);
	if (!p) throw new Error(`no text "${s}"`);
	r.nativeSimulateClick(p.x, p.y);
	await settle(250);
};
const rightClick = async (s: string) => {
	const p = await boundsOf(s);
	if (!p) throw new Error(`no row "${s}"`);
	r.nativeSimulateClick(p.x, p.y, 2);
	await sleep(300); // openItemMenu waits for the item's detail before showing the menu
	await settle(300);
};
const shot = async (name: string) => {
	await settle(400);
	const file = `${SHOTS}/item-actions-${name}.png`;
	r.captureScreenshot(file);
	console.log("wrote", file);
};

// ---------------------------------------------------------------- the menu of an item
let src: Row | undefined;
for (let i = 0; i < 20 && !src; i++) {
	const it = store.itemAt(i);
	if (it && it.itemType !== "attachment" && it.itemType !== "note") src = { key: it.key, itemType: it.itemType, title: it.title };
	if (!it) await settle(150);
}
if (!src) throw new Error("no regular item in the list");
const srcTitle = src.title;
const totalBefore = store.total();
console.log("item:", src.key, src.itemType, JSON.stringify(srcTitle), "selected before:", [...store.selected()].join(","));
await rightClick(srcTitle.slice(0, 24));
console.log("selected after the right click:", [...store.selected()].join(","));
check("the item menu lists Duplicate Item", has("Duplicate Item"));
check("the item menu still lists Move to Trash", has("Move to Trash"));
check("a regular item has no Create Parent Item", !has("Create Parent Item"));
await shot("menu");

// ---------------------------------------------------------------- Duplicate Item
await press("Duplicate Item", true);
check(
	"a copy is selected",
	await waitFor(() => store.selected().size === 1 && store.selectedItem() !== src!.key),
	String(store.selectedItem()),
);
check("the list has one more item", await waitFor(() => store.total() === totalBefore + 1), `${totalBefore} -> ${store.total()}`);
await settle(800);
const copyKey = store.selectedItem();
check("the copy has its own key", !!copyKey && copyKey !== src.key, String(copyKey));
type Detail = {
	data: { title?: string; creators?: unknown[]; itemType?: string };
	tags: { tag: string }[];
	collections: string[];
	children: unknown[];
};
const srcDetail = await api<Detail>(`/items/${src.key}`);
const copyDetail = await api<Detail>(`/items/${copyKey}`);
const sortedTags = (d: Detail) =>
	d.tags
		.map((t) => t.tag)
		.sort()
		.join(",");
check("the copy keeps the item type", copyDetail.data.itemType === srcDetail.data.itemType, String(copyDetail.data.itemType));
check("the copy keeps the title", copyDetail.data.title === srcTitle, JSON.stringify(copyDetail.data.title));
check("the copy keeps the creators", JSON.stringify(copyDetail.data.creators) === JSON.stringify(srcDetail.data.creators));
check("the copy keeps the tags", sortedTags(copyDetail) === sortedTags(srcDetail), `${copyDetail.tags.length} of ${srcDetail.tags.length}`);
check(
	"the copy keeps the collections",
	[...copyDetail.collections].sort().join(",") === [...srcDetail.collections].sort().join(","),
	copyDetail.collections.join(","),
);
check("the copy has no children", copyDetail.children.length === 0);
// the pane shows the copy, with the title open in the editor (an input in the right-hand column)
check("the item pane shows the copy", await waitFor(() => has(srcTitle.slice(0, 24))));
const paneInput = () =>
	r.findByType("input").find((e) => {
		const b = r.getElementBounds(e.id);
		return !!b && b.x > 900;
	});
check("the copy's title opens in the editor", await waitFor(() => !!paneInput()), paneInput() ? "input focused" : "no input");
await shot("duplicated");

// ---------------------------------------------------------------- Create Parent Item: by DOI
const pdf = await findStandalonePdf([], true);
const treeBefore = pdf.collections.length ? treeCount(pdf.collections[0]!) : undefined;
store.setFilter(pdf.title.replace(/\.pdf$/i, "").slice(0, 18));
check(
	"the standalone PDF is in the list",
	await waitFor(() => store.itemAt(0)?.key === pdf.key),
	`${pdf.key} ${JSON.stringify(pdf.title)}`,
);
await rightClick(pdf.title.slice(0, 18));
check("the menu keeps Retrieve Metadata for PDF", has("Retrieve Metadata for PDF"));
check("the menu lists Create Parent Item", has("Create Parent Item"));
await shot("menu-attachment");

await press("Create Parent Item");
check("the dialog opens", await waitFor(() => has("Enter a DOI") && has("Create Parent Item")));
check("the dialog offers manual entry", has("Or create an empty parent"));
await shot("create-parent-dialog");

const doi = await findKnownDoi();
console.log("typing the DOI:", doi);
r.simulateKeystrokes(doi.split("").join(" "));
await settle(300);
await press("Create", true);
check(
	"the parent item is selected",
	await waitFor(() => !!store.selectedItem() && store.selectedItem() !== pdf.key),
	String(store.selectedItem()),
);
const parentKey = store.selectedItem()!;
check("the PDF left the list (it is a child now)", await waitFor(() => store.itemAt(0)?.key !== pdf.key), String(store.itemAt(0)?.key));
const parentDetail = await api<{ data: { DOI?: string }; children: { key: string }[]; collections: string[] }>(`/items/${parentKey}`);
check(
	"the parent is the library's item for the DOI",
	String(parentDetail.data.DOI ?? "").toLowerCase() === doi.toLowerCase(),
	String(parentDetail.data.DOI),
);
check(
	"the parent lists the PDF as a child",
	parentDetail.children.some((c) => c.key === pdf.key),
);
if (pdf.collections.length) {
	const collKey = pdf.collections[0]!;
	check("the parent took the PDF's collection", parentDetail.collections.includes(collKey), parentDetail.collections.join(","));
	check(
		"the sidebar tree still counts the item in that collection",
		await waitFor(() => treeCount(collKey) === treeBefore),
		`${collKey}: ${treeBefore} -> ${treeCount(collKey)}`,
	);
}
check("the item pane shows the parent", await waitFor(() => has("Journal Article")));
check("the parent's title opens in the editor", await waitFor(() => !!paneInput()));
await shot("parent-created");

// ---------------------------------------------------------------- Create Parent Item: manual entry
store.setFilter("");
await settle(400);
const other = await findStandalonePdf([pdf.key]);
store.setFilter(other.title.replace(/\.pdf$/i, "").slice(0, 18));
check("the second standalone PDF is in the list", await waitFor(() => store.itemAt(0)?.key === other.key), other.key);
await rightClick(other.title.slice(0, 18));
await press("Create Parent Item");
check("the dialog opens again", await waitFor(() => has("Enter a DOI")));
await press("Book", true);
await shot("create-parent-manual");
await press("Create", true);
check(
	"the manual parent is selected",
	await waitFor(() => !!store.selectedItem() && store.selectedItem() !== other.key),
	String(store.selectedItem()),
);
const manualKey = store.selectedItem()!;
const manualDetail = await api<{ data: { itemType: string }; children: { key: string }[] }>(`/items/${manualKey}`);
check(
	"the manual parent is an empty book",
	manualDetail.data.itemType === "book" && manualDetail.children.length === 1,
	`${manualDetail.data.itemType}, ${manualDetail.children.length} child`,
);
await settle(600);
check("the item pane shows Book as the item type", has("Book"));
await shot("parent-manual");

// ---------------------------------------------------------------- the Classic table shows the same menu
store.setFilter("");
store.setViewMode("table");
await settle(900);
const row = store.itemAt(0);
if (!row) throw new Error("the table has no rows");
await rightClick(row.title.slice(0, 20));
check("the table's item menu lists Duplicate Item", has("Duplicate Item"));
check("the table's item menu has the built-in entries too", has("Move to Trash"));
await shot("menu-table");

console.log(failed ? `${failed} check(s) failed` : "all checks passed");
t.unmount();
process.exit(failed ? 1 : 0);
