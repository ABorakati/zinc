// The item list.
import { scenario } from "../define";
import { T } from "../library";

scenario("starts on the library and selects what is clicked", async (ui) => {
	await ui.see(T.article, { area: "list" });
	await ui.click(T.authors, { area: "list" });
	await ui.expect("ZT01 is selected", () => ui.selectedTitle(), T.authors);
	await ui.see("Journal of Testing", { area: "pane" });
	await ui.click(T.article, { area: "list" });
	await ui.expect("the article is selected", () => ui.selectedTitle(), T.article);
});

scenario("the top rows still take clicks after the list refreshed", async (ui) => {
	ui.store.refreshItems(["abstractNote"]);
	await ui.settle(700);
	await ui.click(T.authors, { area: "list" });
	await ui.expect("ZT01 is selected", () => ui.selectedTitle(), T.authors);
	await ui.click(T.article, { area: "list" });
	await ui.expect("the article is selected", () => ui.selectedTitle(), T.article);
});

scenario("the rows under a header whose count changed still take clicks", async (ui) => {
	const { key } = await ui.saved("Bulk 0003");
	await ui.changeOutside(key, { date: "2025" }); // 2024 loses one, 2025 gains one: both headers show something else
	await ui.click(T.authors, { area: "list" });
	await ui.expect("the first row under the changed header is selected", () => ui.selectedTitle(), T.authors);
	await ui.click(T.article, { area: "list" });
	await ui.expect("the row above is selected", () => ui.selectedTitle(), T.article);
});

scenario("a card shows one separator between neighbouring details", async (ui) => {
	const line = await ui.see("Report", { area: "list" });
	const doubled = /·\s*·/;
	await ui.expectStill("no doubled separator", () => doubled.test(ui.painted().join(" ")) || doubled.test(line.text), false, 100);
});
