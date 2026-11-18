// Headless section panes on the library copy at ZN_URL. No library writes.
// ZN_URL=http://127.0.0.1:23165 ZN_SHOTS=<scratch>/sections bun scripts/shot-sections.tsx
import { strict as assert } from "node:assert";
import { boot, SHOTS, sleep } from "./shell-shot-lib";
import { detachSection, isDetached, returnSection } from "../src/shell/sectionPanes";
import { hideLibraryPane, libraryLayout, moveLibraryPane, setLibraryLayout, undoLayout } from "../src/shell/layout";
import { rightLayout } from "../src/shell/sidebarLayout";
import { paneDef } from "../src/shell/panes";
import { viewPaneModel } from "../src/itempane/model";
import { gotoSection } from "../src/settings";
import { openSettings } from "../src/shell/layout";

const mode = process.argv.includes("light") ? "light" : "dark";
let checks = 0;
const check = (condition: unknown, message: string) => { assert.ok(condition, message); checks++; };
// Set the initial placement before Frame mounts. Live reparenting belongs to the stacks agent.
check(moveLibraryPane("item", { kind: "split", column: "centre", at: 1 }), "place item pane below items");
const layout = libraryLayout();
setLibraryLayout({ ...layout, sizes: [0.15, 0.5, 0.35], centre: { ...layout.centre, sizes: [0.4, 0.6] } });
const h = await boot({ prefs: { mode }, width: 1440, height: 1100 });
const renderer = h.t.renderer;
const tabs = (detached: string[]) => {
	for (const section of rightLayout.parts) {
		const expected = !detached.includes(section.id) && !rightLayout.layout().hidden.includes(section.id);
		check(!!renderer.findByTestId(`ip-nav-${section.id}`) === expected, `item pane tab ${section.id}: ${expected}`);
	}
};
const shown = (id: string) => {
	const el = renderer.findByTestId(id);
	const bounds = el && renderer.getElementBounds(el.id);
	return bounds && bounds.width > 0 && bounds.height > 0;
};
const shot = async (name: string) => {
	await h.settle(600);
	const file = `${SHOTS}/sections-${name}-${mode}.png`;
	renderer.captureScreenshot(file);
	console.log("wrote", file);
};
const select = async (key: string) => {
	h.store.selectItem(key);
	for (let i = 0; i < 100 && viewPaneModel().itemKey() !== key; i++) await sleep(50);
	await h.settle(500);
	check(viewPaneModel().itemKey() === key, `shared item model follows ${key}`);
};

try {
	await select("9EYM2GG5");
	tabs([]);
	await shot("attached");

	check(detachSection("tags"), "detach Tags");
	check(detachSection("abstract"), "detach Abstract");
	await h.settle(700);
	check(isDetached("tags") && isDetached("abstract"), "both sections detach");
	check(shown("section-content-tags") && shown("section-content-abstract"), "detached sections have visible content");
	const tagContent = renderer.findByTestId("section-content-tags")!;
	const tagBounds = renderer.getElementBounds(tagContent.id)!;
	check(renderer.findByType("input").some((input) => {
		const b = renderer.getElementBounds(input.id);
		return b && b.width > 0 && b.x >= tagBounds.x && b.y >= tagBounds.y && b.y < tagBounds.y + tagBounds.height;
	}), "detached Tags renders its real picker");
	tabs(["tags", "abstract"]);
	await shot("detached");

	hideLibraryPane("item", true);
	await select("W8ZWUFIP");
	check(isDetached("tags") && shown("section-content-tags"), "Tags stays visible while item is hidden");
	check(renderer.getAllText().includes(viewPaneModel().detail()!.tags[0]!.tag), "Tags shows the newly selected item's tags");
	await shot("item-hidden");
	hideLibraryPane("item", false);
	await h.settle(500);
	tabs(["tags", "abstract"]);

	check(returnSection("tags", "abstract"), "return Tags before Abstract");
	await h.settle(700);
	check(!isDetached("tags") && isDetached("abstract"), "only Abstract remains detached");
	check(rightLayout.layout().order.indexOf("tags") + 1 === rightLayout.layout().order.indexOf("abstract"), "return places Tags before Abstract");
	tabs(["abstract"]);
	await shot("returned-tags");
	check(undoLayout(), "undo section return");
	await h.settle(600);
	check(isDetached("tags"), "undo restores detached Tags");
	tabs(["tags", "abstract"]);

	check(returnSection("tags", null), "return Tags at end");
	check(rightLayout.layout().order.at(-1) === "tags", "Tags returns last");
	check(returnSection("abstract"), "return Abstract in stored position");
	await h.settle(600);
	tabs([]);
	check(returnSection("tags", "info"), "reorder an attached section through a gap");
	check(rightLayout.layout().order[0] === "tags", "attached Tags moves first");
	await h.settle(500);
	await shot("all-returned");

	// Info has several list entries, not a nonvirtual copy of all its fields.
	check(detachSection("info"), "detach Info");
	await h.settle(700);
	check(shown("section-content-info") && !!renderer.findByTestId("section-list-info"), "Info owns a visible virtual list");
	check(!!paneDef("section:info"), "Info pane registers at startup");
	tabs(["info"]);
	await shot("detached-info");
	openSettings();
	gotoSection("appearance");
	await h.settle(300);
	renderer.nativeSimulateScrollWheel(800, 700, 0, -5000);
	await h.settle(600);
	check(!!renderer.findByTestId("sidebar-detached-info"), "Settings marks detached Info");
	await shot("settings");
	const returnButton = renderer.findByTestId("sidebar-return-info")!;
	const returnBounds = renderer.getElementBounds(returnButton.id)!;
	await h.click(returnBounds.x + returnBounds.width / 2, returnBounds.y + returnBounds.height / 2);
	check(!isDetached("info"), "Settings returns Info through its button");
	h.store.setActiveTab("library");
	await h.settle(500);
	tabs([]);
	// the menu of a header the item pane shows without scrolling (a click after the headless renderer scrolls the item pane's
	// virtual list does not reach its buttons; see docs/developer-guide/layouts-phase2.md, open issues)
	await select("9EYM2GG5"); // a fresh selection starts the item pane at its top
	const sectionMenu = renderer.findByTestId("ip-section-menu-info");
	const menuBounds = sectionMenu ? renderer.getElementBounds(sectionMenu.id) : null;
	if (!menuBounds || menuBounds.height === 0) console.log("SKIP section header menu: the Info header is not on screen");
	else {
		await h.click(menuBounds.x + menuBounds.width / 2, menuBounds.y + menuBounds.height / 2);
		await h.clickText("Open in its own pane");
		check(isDetached("info"), "section header menu detaches Info");
		tabs(["info"]);
		await shot("header-menu");
	}
	console.log(`sections: ${checks} checks passed`);
} finally {
	h.t.unmount();
}
process.exit(0);
