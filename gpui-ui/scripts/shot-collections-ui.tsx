// Headless screenshots of the sidebar's collection sort / group / colour / icon / pin features, against MOCK data (no core, no library):
//   bun scripts/shot-collections-ui.tsx [dark|light] [--out DIR]
// Writes <DIR>/collections-{items-colour,sections,menu-view,menu-collection,menu-colour}[-light].png (DIR defaults to
// C:/Users/abora/zn-ws/_tmp/collections-ui). The sidecar and ui-state live in a temp dir that is deleted at the end.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const mode = args.includes("light") ? "light" : "dark";
const outIdx = args.indexOf("--out");
const OUT = outIdx >= 0 ? args[outIdx + 1]! : "C:/Users/abora/zn-ws/_tmp/collections-ui";
mkdirSync(OUT, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "zn-collections-shot-"));
process.env.ZN_COLLECTION_STYLE = join(tmp, "collection-style.json");
process.env.ZN_UI_STATE = join(tmp, "ui-state.json");
process.env.ZN_READ_STATE = "off";

// mock core: the flat collection list, empty answers for everything else
const mk = (key: string, name: string, itemCount: number, parentKey: string | null = null) => ({ key, name, parentKey, itemCount });
const MOCK = [
	mk("AAAA0001", "Liver transplantation", 142), mk("AAAA0002", "Machine perfusion", 38, "AAAA0001"), mk("AAAA0003", "Allocation policy", 21, "AAAA0001"),
	mk("AAAA0004", "Thesis", 64), mk("AAAA0005", "Chapter 1 background", 12, "AAAA0004"), mk("AAAA0006", "Chapter 2 methods", 9, "AAAA0004"),
	mk("AAAA0007", "Machine learning", 97), mk("AAAA0008", "Clinical trials", 55), mk("AAAA0009", "To read", 210),
	mk("AAAA0010", "Statistics", 31), mk("AAAA0011", "Grant ideas", 7), mk("AAAA0012", "Teaching", 18), mk("AAAA0013", "A very long collection name that has to be clipped", 3),
];
const { setDirect } = await import("../src/api");
setDirect(async (req) => {
	const path = new URL(req.url).pathname.replace(/^\/api/, "");
	if (req.method === "GET" && path === "/collections") return Response.json(MOCK);
	if (path.startsWith("/items")) return Response.json({ total: 0, items: [] });
	return Response.json([]);
});

const { createTestRoot } = await import("@gpuix/solid/testing");
const { Sidebar } = await import("../src/Sidebar");
const { registerFonts } = await import("../src/fonts");
const { store, uiState } = await import("../src/store");
const { tw } = await import("../src/theme");
const { OverlayHost } = await import("../src/ui");
const { collectionStyle } = await import("../src/sidebar/collectionStyle");

uiState.disableWrites();
store.setMode(mode);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t = createTestRoot({ width: 700, height: 880 });
registerFonts(t.renderer);
t.render(() => (
	<div style={{ ...tw("bg-canvas", store.mode()), display: "flex", flexDirection: "row", width: "100%", height: "100%" }}>
		<div style={{ width: 260, height: 880, flexShrink: 0, display: "flex" }}>
			<Sidebar />
		</div>
		<OverlayHost />
	</div>
));
for (let i = 0; i < 100 && store.collections().length === 0; i++) await sleep(50);
console.log("collections loaded:", store.collections().length);
await sleep(300);

const settle = async (ms = 400) => {
	for (let i = 0; i < 3; i++) { t.renderer.flush(); t.renderer.dispatchNativeEvents(); await sleep(ms / 3); }
	t.renderer.flush();
};
const file = (scene: string) => `${OUT}/collections-${scene}${mode === "light" ? "-light" : ""}.png`;
const shot = async (scene: string) => { await settle(500); t.renderer.captureScreenshot(file(scene)); console.log("wrote", file(scene)); };
const at = (label: string) => {
	const el = t.renderer.findByText(label);
	const b = el ? t.renderer.getElementBounds(el.id) : null;
	if (!b) throw new Error(`no element with text "${label}"`);
	return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
const click = async (x: number, y: number, button = 0) => { t.renderer.nativeSimulateClick(x, y, button); await settle(); };

// ---- state 1: sorted by items, grouped by colour, a pinned collection ----
const cs = collectionStyle;
cs.setColor("AAAA0001", "rose"); cs.setIcon("AAAA0001", "heart");
cs.setColor("AAAA0002", "sky");
cs.setColor("AAAA0004", "blue"); cs.setIcon("AAAA0004", "graduation-cap");
cs.setColor("AAAA0007", "violet"); cs.setIcon("AAAA0007", "brain");
cs.setColor("AAAA0008", "green"); cs.setIcon("AAAA0008", "flask-conical");
cs.setColor("AAAA0009", "amber"); cs.setIcon("AAAA0009", "bookmark");
cs.setColor("AAAA0010", "blue");
cs.pin("AAAA0009"); cs.pin("AAAA0002");
cs.setSort("items"); cs.setGroup("colour");
await shot("items-colour");

// ---- the header menu and a collection's menu (colour submenu) ----
const head = at("COLLECTIONS");
await click(197, head.y);
await shot("menu-view");
t.renderer.simulateKeystrokes("escape"); await settle();
await click(at("Statistics").x, at("Statistics").y, 2);
await shot("menu-collection");
await click(at("Colour").x, at("Colour").y);
await shot("menu-colour");
t.renderer.simulateKeystrokes("escape"); await settle();

// ---- state 2: grouped by section, name order ----
cs.setSort("name-asc"); cs.setGroup("section");
for (const s of ["Reading list", "Thesis work", "Archive"]) cs.addSection(s);
cs.setSection("AAAA0009", "Reading list"); cs.setSection("AAAA0011", "Reading list");
cs.setSection("AAAA0004", "Thesis work"); cs.setSection("AAAA0010", "Thesis work");
cs.toggleCollapsed("sec:Archive");
await shot("sections");

cs.flush();
t.unmount();
rmSync(tmp, { recursive: true, force: true });
process.exit(0);
