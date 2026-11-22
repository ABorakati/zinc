// Editing in the item pane, as a user does it: click, type, click elsewhere.
import { scenario } from "../define";
import { T } from "../library";

scenario("Enter saves a field", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await ui.clickField("Volume");
	await ui.replace("42");
	await ui.press("enter");
	await ui.expect("the saved volume", async () => (await ui.saved(T.authors)).volume, "42");
});

scenario("a field left for another item is saved to its own item", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await ui.clickField("Volume");
	await ui.replace("77");
	await ui.click(T.neighbour, { area: "list" });
	await ui.expect("the saved volume", async () => (await ui.saved(T.authors)).volume, "77");
	await ui.expectStill("the neighbour's volume", async () => (await ui.saved(T.neighbour)).volume ?? "", "");
	await ui.expect("the neighbour is selected", () => ui.selectedTitle(), T.neighbour);
});

scenario("an author left for another item keeps every author and the edit", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await ui.click("Bravo", { area: "pane", exact: true });
	await ui.replace("Edited");
	await ui.click(T.neighbour, { area: "list" });
	await ui.expect("the saved authors", async () => (await ui.saved(T.authors)).creators, ["Alpha, Ann", "Edited, Ben", "Charlie, Cat"]);
	await ui.expectStill("the neighbour's authors", async () => (await ui.saved(T.neighbour)).creators, ["Delta, Dee"]);
});

scenario("Escape leaves a field without saving", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await ui.clickField("Volume");
	await ui.replace("99");
	await ui.press("escape");
	await ui.expectStill("the saved volume", async () => (await ui.saved(T.authors)).volume, "1");
});

// The selection can also move with no click and so no blur: "Open in Zinc" from Word or the browser, a search result.
scenario("an author being typed survives a selection that moves without a click", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await ui.click("Bravo", { area: "pane", exact: true });
	await ui.replace("Edited");
	await ui.store.revealItem((await ui.saved(T.neighbour)).key);
	await ui.expect("the saved authors", async () => (await ui.saved(T.authors)).creators, ["Alpha, Ann", "Edited, Ben", "Charlie, Cat"]);
	await ui.expectStill("the neighbour's authors", async () => (await ui.saved(T.neighbour)).creators, ["Delta, Dee"]);
});

scenario("a year being typed survives a selection that moves without a click", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await ui.clickField("Date");
	await ui.replace("2021");
	await ui.store.revealItem((await ui.saved(T.neighbour)).key);
	await ui.expect("the saved date", async () => (await ui.saved(T.authors)).date, "2021-03-04");
});
