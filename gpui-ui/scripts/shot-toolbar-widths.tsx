// Headless screenshot of the whole app with the newest item selected and the middle column at a chosen share of the window: the
// toolbar (search box, List/Classic toggle, Add) and the item pane's action buttons as they wrap.
//   ZN_URL=<core on a library COPY> bun scripts/shot-toolbar-widths.tsx <middle fraction, e.g. 0.38> [dark]
// The sidebar keeps 0.2 and the item pane takes the rest. Writes <scratchpad>/gpui-shots/shell-middle-<fraction>[-dark].png.
// Preferences go to a throw-away ui-state.json (scripts/_shell-env.ts), never the real one.
import { boot } from "./shell-shot-lib";
import { libraryLayout, setLibraryLayout } from "../src/shell/layout";

const args = process.argv.slice(2);
const middle = Number(args.find((a) => /^0?\.\d+$/.test(a)) ?? 0.54);
const mode = args.includes("dark") ? "dark" : "light";
setLibraryLayout({ ...libraryLayout(), sizes: [0.2, middle, +(0.8 - middle).toFixed(4)] });
const h = await boot({ prefs: { mode } });
const first = (await (await fetch(`${process.env.ZN_URL}/api/items?limit=1`)).json()) as { items: { key: string }[] };
if (first.items[0]) h.store.selectItem(first.items[0].key);
console.log(await h.shot(`middle-${middle}${mode === "dark" ? "-dark" : ""}`));
process.exit(0);
