// Headless screenshots of Settings > Appearance > Sidebars and of the app with a rearranged layout (shell/sidebarLayout.ts): Collections
// above Library and Saved Searches hidden on the left; Abstract first and Related hidden in the item pane.
//   ZN_URL=<core on a library COPY> bun scripts/shot-sidebar-layout.tsx [dark]
// Writes <SHOTS>/shell-layout-app[-dark].png and shell-layout-settings[-dark].png. Preferences go to a throw-away ui-state.json.
import { boot } from "./shell-shot-lib";
import { gotoSection } from "../src/settings";
import { setSettingsQuery } from "../src/settings/registry";
import { openSettings } from "../src/shell/layout";
import { leftLayout, move, rightLayout, setShown } from "../src/shell/sidebarLayout";

const mode = process.argv.includes("dark") ? "dark" : "light";
const suffix = mode === "dark" ? "-dark" : "";
let left = leftLayout.layout();
left = move(left, "collections", -1, leftLayout.parts);
left = move(left, "collections", -1, leftLayout.parts);
leftLayout.set(setShown(left, "searches", false));
let right = rightLayout.layout();
right = move(right, "abstract", -1, rightLayout.parts);
rightLayout.set(setShown(right, "related", false));

const h = await boot({ prefs: { mode } });
const first = (await (await fetch(`${process.env.ZN_URL}/api/items?limit=1`)).json()) as { items: { key: string }[] };
if (first.items[0]) h.store.selectItem(first.items[0].key);
console.log(await h.shot(`layout-app${suffix}`));
openSettings();
gotoSection("appearance");
setSettingsQuery("sidebar");
console.log(await h.shot(`layout-settings${suffix}`));
process.exit(0);
