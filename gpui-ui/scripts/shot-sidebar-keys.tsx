// Headless check of the sidebar's arrow keys (sidebar/nav.ts) against the core at ZN_URL (a library COPY).
//   ZN_URL=<core> bun scripts/shot-sidebar-keys.tsx
// Clicks "My Library" (the pane must take focus from the click), then presses Down / Up / End / Home / Left / Right and prints the
// view after each, plus PASS / FAIL lines. Nothing is written: ui-state.json writes are off, the expand state is restored.
import { createTestRoot } from "@gpuix/solid/testing";
import { Sidebar } from "../src/Sidebar";
import { registerFonts } from "../src/fonts";
import { expandedKeys, setExpandedKeys } from "../src/sidebar/state";
import { store, uiState } from "../src/store";
import { tw } from "../src/theme";
import { OverlayHost } from "../src/ui";

uiState.disableWrites();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t = createTestRoot({ width: 900, height: 880 });
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
const savedExpanded = [...expandedKeys()];
setExpandedKeys([]);
await sleep(400);

const settle = async (ms = 150) => {
	for (let i = 0; i < 3; i++) {
		t.renderer.flush();
		t.renderer.dispatchNativeEvents();
		await sleep(ms / 3);
	}
	t.renderer.flush();
};
const viewName = () => {
	const v = store.view();
	if (v.kind !== "collection") return v.kind;
	const find = (l: typeof store.collections extends () => infer C ? C : never): string | undefined => {
		for (const c of l) {
			if (c.key === v.key) return c.name;
			const n = c.children && find(c.children);
			if (n) return n;
		}
	};
	return `collection "${find(store.collections()) ?? v.key}"`;
};
const key = async (k: string) => {
	t.renderer.simulateKeystrokes(k);
	await settle();
	console.log(`${k.padEnd(6)} -> ${viewName()}`);
	return viewName();
};
let fails = 0;
const check = (what: string, ok: boolean) => {
	if (!ok) fails++;
	console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
};

await settle(300);
const el = t.renderer.findByText("Unfiled");
const b = el ? t.renderer.getElementBounds(el.id) : null;
if (!b) throw new Error("no Unfiled row");
t.renderer.nativeSimulateClick(b.x + b.width / 2, b.y + b.height / 2, 0);
await settle(300);
check("a click on Unfiled shows it", viewName() === "unfiled");
await key("up");
const pane = t.renderer.findByTestId("sidebar-pane");
const focused = (t.renderer as { getFocusedElementId?: () => number | null }).getFocusedElementId?.();
check("the click gives the sidebar pane keyboard focus", !!pane && focused === pane.id);

check("Down moves to Unfiled", (await key("down")) === "unfiled");
check("Down moves to My Publications", (await key("down")) === "publications");
check("Up moves back", (await key("up")) === "unfiled");
check("Home goes to My Library", (await key("home")) === "library");
const last = await key("end");
check("End goes to a later row", last !== "library");

// the first collection with children: select it, Right expands it, Right again moves to its first child, Left back to it, Left closes
const parent = store.collections().find((c) => c.children?.length);
if (parent) {
	store.setView({ kind: "collection", key: parent.key });
	await settle(300);
	console.log("select ->", viewName());
	await key("right");
	check("Right expands a closed collection", expandedKeys().includes(parent.key));
	const child = await key("right");
	check(
		"Right on an open collection moves to its first child",
		child !== `collection "${parent.name}"` && child.startsWith("collection"),
	);
	check("Left on a child moves to the parent", (await key("left")) === `collection "${parent.name}"`);
	await key("left");
	check("Left on an open collection closes it", !expandedKeys().includes(parent.key));
} else console.log("(no collection with subcollections: tree keys not checked)");

// Ctrl+Shift+L (window-level shortcut) focuses the pane from anywhere
const { blur } = t.renderer as { blur?: () => void };
blur?.call(t.renderer);
await settle();
const { handleWindowKeyDown } = await import("../src/shell/shortcuts");
handleWindowKeyDown({ key: "l", modifiers: { ctrl: true, shift: true }, preventDefault() {} } as never);
await settle();
const f2 = (t.renderer as { getFocusedElementId?: () => number | null }).getFocusedElementId?.();
check("Ctrl+Shift+L focuses the sidebar pane", !!pane && f2 === pane.id);

setExpandedKeys(savedExpanded);
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
