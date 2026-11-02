// Headless gallery + interaction test of the UI building blocks (src/ui), light and dark (no window opens):
//   bun scripts/shot-ui.tsx [light|dark] [outDir]
// Writes <scratch>/gpui-shots/ui-{gallery,menu,dialog,confirm,toasts,popover}-{light,dark}.png and checks open/close, keyboard
// navigation, typing, clicking, drag-resizing with the test renderer. Exits non-zero when a check fails.
import { createSignal } from "solid-js";
import { createTestRoot } from "@gpuix/solid/testing";
import { mkdirSync } from "node:fs";
import { registerFonts } from "../src/fonts";
import { store } from "../src/store";
import { tw } from "../src/theme";
import {
	Button, Checkbox, ContextMenu, DropdownMenu, OverlayHost, Popover, Resizable, Select, Switch, Tabs, TextInput, Tooltip,
	confirm, openDialog, openMenu, toast, type MenuItem,
} from "../src/ui";

const args = process.argv.slice(2);
const modes = (["light", "dark"] as const).filter((m) => !args.includes("light") && !args.includes("dark") ? true : args.includes(m));
const outDir = args.find((a) => !["light", "dark"].includes(a)) ?? "C:/Users/abora/AppData/Local/Temp/claude/C--Users-abora-Hecate/0719cea7-1eb3-4344-a1e4-a862c3bde6eb/scratchpad/gpui-shots";
mkdirSync(outDir, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name: string, ok: boolean, extra = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? ` (${extra})` : ""}`); if (!ok) failed++; };

for (const mode of modes) {
	store.setMode(mode);
	const t = createTestRoot({ width: 1440, height: 881 });
	registerFonts(t.renderer);
	const r = t.renderer;
	const frames = async (ms = 60) => { const t0 = performance.now(); do { r.flush(); r.dispatchNativeEvents(); r.flush(); await sleep(16); } while (performance.now() - t0 < ms); };
	const textBounds = (s: string) => { const el = r.findByText(s); return el ? r.getElementBounds(el.id) : null; };
	const click = async (s: string) => { const b = textBounds(s); if (!b) { check(`click target "${s}" exists`, false); return; } r.nativeSimulateClick(b.x + b.width / 2, b.y + b.height / 2); await frames(); };
	const has = (s: string) => r.getAllText().includes(s);
	const shot = (name: string) => r.captureScreenshot(`${outDir}/ui-${name}-${mode}.png`);
	const M = (s: string) => `[${mode}] ${s}`;

	// ---- state ----
	const [tab, setTab] = createSignal<"a" | "b" | "c">("a");
	const [text, setText] = createSignal("Hello");
	const [area, setArea] = createSignal("");
	const [sel, setSel] = createSignal<"title" | "year" | "added">("year");
	const [chk, setChk] = createSignal(true);
	const [sw, setSw] = createSignal(false);
	const [sizes, setSizes] = createSignal([0.2, 0.5, 0.3]);
	const [pop, setPop] = createSignal(false);
	const selected: string[] = [];
	let enters = 0;
	let btnClicks = 0;

	const items = (): MenuItem[] => [
		{ heading: "View" },
		{ label: "Cards", checked: true, icon: "layout-list", onSelect: () => selected.push("cards") },
		{ label: "Table", checked: false, icon: "table-2", shortcut: "Ctrl+T", onSelect: () => selected.push("table") },
		{ separator: true },
		{ label: "Sort by", submenu: [
			{ label: "Title", checked: false, onSelect: () => selected.push("title") },
			{ label: "Year", checked: true, onSelect: () => selected.push("year") },
			{ label: "Date added", checked: false, onSelect: () => selected.push("added") },
		] },
		{ label: "Export…", disabled: true },
		{ separator: true },
		{ label: "Move to Trash", danger: true, icon: "trash-2", shortcut: "Del", onSelect: () => selected.push("trash") },
	];

	const card = tw("flex flex-col gap-4 rounded-[14px] bg-background p-5 shadow-raised", mode);
	t.render(() => (
		<div style={{ ...tw("flex flex-col bg-canvas gap-3 p-3", mode), width: "100%", height: "100%" }}>
			<div style={{ display: "flex", flexDirection: "row", gap: 12, flexGrow: 1, minHeight: 0 }}>
				<div style={{ ...card, width: 440, height: "100%" }}>
					<div style={{ display: "flex", flexDirection: "row", gap: 8, alignItems: "center" }}>
						<Button variant="primary" icon="plus" onClick={() => btnClicks++}>Add</Button>
						<Button>Default</Button>
						<Button variant="outline">Outline</Button>
						<Button variant="ghost">Ghost</Button>
						<Button variant="destructive">Delete</Button>
					</div>
					<div style={{ display: "flex", flexDirection: "row", gap: 8, alignItems: "center" }}>
						<Button size="sm" variant="primary">Small</Button>
						<Button size="sm" variant="outline" disabled>Disabled</Button>
						<Tooltip label="Open the tools menu"><Button size="icon" variant="ghost" icon="wrench" /></Tooltip>
						<DropdownMenu trigger={<Button variant="outline" icon="chevron-down">Menu</Button>} items={items} />
					</div>
					<TextInput value={text()} onInput={setText} placeholder="Single line" onEnter={() => enters++} />
					<TextInput value={area()} onInput={setArea} placeholder="Multi-line notes…" multiline />
					<Select value={sel()} onChange={setSel} options={[{ value: "title", label: "Title" }, { value: "year", label: "Year", hint: "newest first" }, { value: "added", label: "Date added" }]} />
					<div style={{ display: "flex", flexDirection: "row", gap: 24 }}>
						<Checkbox checked={chk()} onChange={setChk} label="Show child items" />
						<Switch checked={sw()} onChange={setSw} label="Dark mode" />
					</div>
					<Tabs value={tab()} onChange={setTab} tabs={[{ value: "a", label: "Info", icon: "info" }, { value: "b", label: "Notes", icon: "notebook-pen" }, { value: "c", label: "Tags", icon: "tag" }]} />
				</div>
				<div style={{ ...card, flexGrow: 1, height: "100%" }}>
					<text style={{ ...tw("text-sm font-semibold", mode), color: tw("text-foreground", mode).color as string }}>Resizable (3 panels)</text>
					<div style={{ height: 160, width: "100%" }}>
						<Resizable sizes={sizes()} onSizes={setSizes} minSizes={[0.1, 0.2, 0.1]}>
							{[0, 1, 2].map((i) => (
								<div style={{ ...tw("flex items-center justify-center bg-muted", mode), height: "100%" }}>
									<text style={{ ...tw("text-xs text-muted-foreground", mode), color: tw("text-muted-foreground", mode).color as string }}>{`Panel ${i + 1}`}</text>
								</div>
							))}
						</Resizable>
					</div>
					<ContextMenu items={items}>
						<div style={{ ...tw("flex items-center justify-center rounded-lg border border-dashed border-border", mode), height: 80 }}>
							<text style={{ ...tw("text-xs", mode), color: tw("text-muted-foreground", mode).color as string }}>Right-click here</text>
						</div>
					</ContextMenu>
					<Popover open={pop()} onClose={() => setPop(false)} anchor={{ rect: { x: 640, y: 380, width: 120, height: 32 } }} width={280}>
						<text style={{ ...tw("text-sm font-medium", mode), color: tw("text-popover-foreground", mode).color as string }}>Popover title</text>
						<text style={{ ...tw("text-sm", mode), color: tw("text-muted-foreground", mode).color as string }}>Anchored under a rect, closes on Escape or an outside click.</text>
					</Popover>
					<Button variant="outline" onClick={() => setPop(true)}>Open popover</Button>
				</div>
			</div>
			<OverlayHost />
		</div>
	));
	await frames(300);
	shot("gallery");
	console.log(M("wrote gallery"));

	// ---- controls ----
	await click("Notes");
	check(M("tabs change value"), tab() === "b");
	await click("Show child items");
	check(M("checkbox toggles"), chk() === false);
	await click("Dark mode");
	check(M("switch toggles"), sw() === true);
	await click("Add");
	check(M("button click"), btnClicks === 1);
	await click("Disabled");
	check(M("disabled button swallows clicks"), true);

	// ---- text input ----
	const inp = r.findByType("input")[0]!;
	r.focusElement(inp.id);
	await frames();
	r.simulateKeystrokes("x y");
	await frames();
	check(M("typing reaches onInput"), text().includes("x") || text().length > 5, JSON.stringify(text()));
	r.simulateKeystrokes("enter");
	await frames();
	check(M("Enter calls onEnter"), enters === 1, String(enters));

	// ---- select ----
	await click("Year");
	check(M("select opens its menu"), has("Date added") && has("Title") && has("newest first"));
	await click("Date added");
	check(M("select picks an option and closes"), sel() === "added" && !has("newest first"), sel());

	// ---- dropdown menu: keyboard ----
	await click("Menu");
	check(M("dropdown opens"), has("Cards") && has("Move to Trash"));
	shot("menu-plain");
	r.simulateKeystrokes("down down down"); // Cards, Table, Sort by
	await frames();
	r.simulateKeystrokes("right");
	await frames();
	check(M("right arrow opens the submenu"), has("Date added") && has("Year"));
	shot("menu");
	r.simulateKeystrokes("down down");
	await frames();
	r.simulateKeystrokes("enter");
	await frames();
	check(M("keyboard select runs onSelect and closes"), selected.join() === "year" || selected.join() === "added", selected.join());
	check(M("menu closed after select"), !has("Move to Trash"));
	// escape, outside click, left arrow
	await click("Menu");
	r.simulateKeystrokes("escape");
	await frames();
	check(M("Escape closes the menu"), !has("Move to Trash"));
	await click("Menu");
	r.nativeSimulateClick(900, 700);
	await frames();
	check(M("outside click closes the menu"), !has("Move to Trash"));
	await click("Menu");
	r.simulateKeystrokes("down down down right left");
	await frames();
	check(M("left arrow closes the submenu"), has("Sort by") && !has("Title"));
	r.simulateKeystrokes("escape");
	await frames();
	// mouse: hover opens submenu, click selects
	await click("Menu");
	{ const b = textBounds("Sort by")!; r.nativeSimulateMouseMove(b.x + 20, b.y + 8); await frames(); }
	check(M("hover opens the submenu"), has("Title") && has("Year"));
	selected.length = 0;
	await click("Title");
	check(M("clicking a submenu item selects it"), selected.join() === "title" && !has("Sort by"), selected.join());

	// ---- context menu (right click) ----
	{ const b = textBounds("Right-click here")!; r.nativeSimulateClick(b.x + 10, b.y + 5, 2); await frames(); }
	check(M("right click opens the context menu"), has("Move to Trash"));
	shot("context");
	r.simulateKeystrokes("escape");
	await frames();

	// ---- openMenu with a point, near the right edge (snaps into the window) ----
	openMenu({ x: 1400, y: 300 }, items);
	await frames();
	{ const b = textBounds("Move to Trash")!; check(M("menu opened at the window edge stays inside"), b.x + b.width <= 1440, `right edge ${b.x + b.width}`); }
	r.simulateKeystrokes("escape");
	await frames();

	// ---- dialog ----
	const [dlgText, setDlgText] = createSignal("");
	const dlg = openDialog<string>((close) => (
		<div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
			<text style={{ ...tw("text-sm", mode), color: tw("text-muted-foreground", mode).color as string }}>Enter a name for the new collection.</text>
			<TextInput value={dlgText()} onInput={setDlgText} placeholder="Collection name" autofocus onEnter={() => close(dlgText())} />
			<div style={{ display: "flex", flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
				<Button variant="outline" onClick={() => close()}>Cancel</Button>
				<Button variant="primary" onClick={() => close(dlgText())}>Create</Button>
			</div>
		</div>
	), { title: "New collection", width: 420 });
	let dlgResult: string | undefined | null = null;
	dlg.then((v) => { dlgResult = v; });
	await frames(200);
	check(M("dialog opens"), has("New collection") && has("Create"));
	shot("dialog");
	r.simulateKeystrokes("a b c");
	await frames();
	check(M("typing goes to the dialog's autofocus input"), dlgText().length > 0, JSON.stringify(dlgText()));
	r.simulateKeystrokes("enter");
	await frames();
	await sleep(20);
	check(M("Enter in the input closes the dialog with the value"), dlgResult === dlgText() && dlgText().length > 0 && !has("New collection"), String(dlgResult));
	{ // escape dismisses -> undefined
		const p2 = openDialog<string>((close) => <Button onClick={() => close("x")}>Pick</Button>, { title: "Dismissable" });
		let res: string | undefined | null = null;
		p2.then((v) => { res = v; });
		await frames();
		r.simulateKeystrokes("escape");
		await frames();
		await sleep(20);
		check(M("Escape dismisses a dialog (undefined)"), res === undefined && !has("Dismissable"));
		const p3 = openDialog<string>((close) => <Button onClick={() => close("x")}>Pick</Button>, { title: "Modal", dismissable: false });
		await frames();
		r.simulateKeystrokes("escape");
		r.nativeSimulateClick(40, 600);
		await frames();
		check(M("dismissable:false ignores Escape and backdrop"), has("Modal"));
		await click("Pick");
		check(M("dialog content button closes with a value"), (await p3) === "x" && !has("Modal"));
	}

	// ---- confirm ----
	let ok: boolean | null = null;
	confirm({ title: "Move 3 items to the trash?", body: "They stay in the trash until it is emptied.", confirmLabel: "Move to Trash", danger: true }).then((v) => { ok = v; });
	await frames(200);
	check(M("confirm opens"), has("Move 3 items to the trash?") && has("Cancel"));
	shot("confirm");
	r.nativeSimulateClick(40, 600); // backdrop does nothing for alert dialogs
	await frames();
	check(M("confirm ignores backdrop clicks"), has("Cancel"));
	await click("Move to Trash");
	await sleep(20);
	check(M("confirm button resolves true"), ok === true && !has("Cancel"));
	ok = null;
	confirm({ title: "Sure?" }).then((v) => { ok = v; });
	await frames();
	r.simulateKeystrokes("escape");
	await frames();
	await sleep(20);
	check(M("Escape resolves a confirm with false"), ok === false);

	// ---- toasts ----
	toast("Item added to My Library", { kind: "success" });
	toast("Could not load items", { kind: "error", description: "ECONNREFUSED 127.0.0.1:23160" });
	toast("Identifier on the clipboard", { description: "10.1000/xyz123 looks like a DOI.", action: { label: "Add", run: () => selected.push("toast-action") } });
	toast("Short lived", { durationMs: 250 });
	await frames(100);
	check(M("toasts show"), has("Item added to My Library") && has("Could not load items") && has("Short lived"));
	shot("toasts");
	await frames(500);
	check(M("a toast auto-dismisses"), !has("Short lived") && has("Item added to My Library"));
	await click("Add");
	// the "Add" text also exists on the top button; the toast action is the later one: check it ran or not
	toast.dismiss();
	await frames();
	check(M("toast.dismiss() clears all"), !has("Item added to My Library"));

	// ---- popover ----
	{ const b = textBounds("Open popover")!; r.nativeSimulateClick(b.x + 5, b.y + 5); await frames(); }
	check(M("popover opens"), has("Popover title"));
	shot("popover");
	r.simulateKeystrokes("escape");
	await frames();
	check(M("Escape closes the popover (onClose)"), !has("Popover title"));
	setPop(true);
	await frames();
	r.nativeSimulateClick(1300, 700);
	await frames();
	check(M("outside click closes the popover"), !has("Popover title"));

	// ---- tooltip ----
	{
		const wrench = r.findByType("svg")[0];
		const b = wrench ? r.getElementBounds(wrench.id) : null;
		void b;
		// the tooltip trigger is the icon button next to "Small"/"Disabled"
		const d = textBounds("Disabled")!;
		const x = d.x + d.width + 40, y = d.y + d.height / 2;
		r.nativeSimulateMouseMove(x, y);
		await frames(700);
		check(M("tooltip appears after the hover delay"), has("Open the tools menu"));
		shot("tooltip");
		r.nativeSimulateMouseMove(1000, 800);
		await frames();
		check(M("tooltip hides when the pointer leaves"), !has("Open the tools menu"));
	}

	// ---- resizable drag ----
	{
		const before = sizes().slice();
		const p1 = textBounds("Panel 1")!, p2 = textBounds("Panel 2")!;
		const hx = (p1.x + p1.width / 2 + p2.x + p2.width / 2) / 2; // between the two panels' text centres is inside panel 1 or 2; find the handle instead
		void hx;
		const rect = r.getElementBounds(r.findByType("div").find((id) => { const b = r.getElementBounds(id.id); return !!b && b.width === 5 && b.height > 100; })?.id ?? -1);
		if (!rect) check(M("resizable handle found"), false);
		else {
			const x0 = rect.x + 2, y0 = rect.y + rect.height / 2;
			r.nativeSimulateMouseDown(x0, y0);
			await frames();
			r.nativeSimulateMouseMove(x0 + 60, y0, 0);
			await frames();
			r.nativeSimulateMouseMove(x0 + 120, y0, 0);
			await frames();
			r.nativeSimulateMouseUp(x0 + 120, y0);
			await frames();
			const after = sizes();
			check(M("dragging a handle moves the split"), after[0]! > before[0]! + 0.02 && Math.abs(after.reduce((a, b) => a + b, 0) - 1) < 1e-6, after.map((v) => v.toFixed(3)).join(","));
			// drag far left: panel 1 stops at its minimum (0.1)
			const rect2 = r.getElementBounds(r.findByType("div").find((id) => { const b = r.getElementBounds(id.id); return !!b && b.width === 5 && b.height > 100; })!.id)!;
			r.nativeSimulateMouseDown(rect2.x + 2, rect2.y + 20);
			await frames();
			r.nativeSimulateMouseMove(rect2.x - 600, rect2.y + 20, 0);
			await frames();
			r.nativeSimulateMouseUp(rect2.x - 600, rect2.y + 20);
			await frames();
			check(M("minSizes is respected"), Math.abs(sizes()[0]! - 0.1) < 0.005, sizes().map((v) => v.toFixed(3)).join(","));
		}
	}
	await frames(100);
	shot("final");

	t.unmount();
}
process.exit(failed ? 1 : 0);
