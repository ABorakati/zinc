// The packaged app, as it ships, checked on a background desktop: `bun test/ui/real/smoke.ts --app <zotero-next-gpui.exe> [--out <dir>]`.
// It starts the executable with ZN_AUTOMATION=stdio (src/automation.ts) on a throwaway library, drives it with GPUIX's automation
// protocol and checks what a person looks at first: the top rows, the library, the item pane and its section tabs, Settings. Each step
// leaves a screenshot in --out for a person to look at before a release. Never on the user's screen, never on the user's data.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch } from "@gpuix/native/automation";
import { makeLibrary, T } from "../library";

type Box = { x: number; y: number; width: number; height: number };
type N = { id: number; type: string; testId?: string; text?: string; bounds?: Box | null; children?: N[] };

const argv = process.argv.slice(2);
const arg = (name: string) => {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
};
const exe = arg("--app");
if (!exe) {
	console.error("usage: bun test/ui/real/smoke.ts --app <path to zotero-next-gpui.exe> [--out <dir>]");
	process.exit(2);
}
const out = resolve(arg("--out") ?? "out/ui-real");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// a throwaway home: the app's settings, logs and caches go here, and the library is a fresh synthetic one
const home = mkdtempSync(join(tmpdir(), "zn-real-"));
for (const d of ["AppData/Roaming", "AppData/Local", "tmp"]) mkdirSync(join(home, d), { recursive: true });
mkdirSync(join(home, "lib", "library"), { recursive: true });
const db = makeLibrary(join(home, "lib"), 130);

const app = await launch({
	command: resolve(exe),
	env: {
		ZN_AUTOMATION: "stdio",
		ZN_AUTOMATION_DESKTOP: "zinc-ui-tests",
		ZN_DB: db,
		ZN_PORT: "0",
		ZN_SYNC: "0",
		ZN_ZPORT: "0",
		USERPROFILE: home,
		HOME: home,
		APPDATA: join(home, "AppData/Roaming"),
		LOCALAPPDATA: join(home, "AppData/Local"),
		TEMP: join(home, "tmp"),
		TMP: join(home, "tmp"),
	},
});

const results: { step: string; ok: boolean; detail?: string }[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tree = async (): Promise<N[]> => {
	const { tree } = (await app.call("getTree", {})) as { tree: N | null };
	const all: N[] = [];
	const walk = (n: N) => {
		all.push(n);
		for (const c of n.children ?? []) walk(c);
	};
	if (tree) walk(tree);
	return all;
};
const boxOf = async (n: N): Promise<Box | null> => n.bounds ?? ((await app.call("getBounds", { elementId: n.id })) as { bounds: Box | null }).bounds;
const find = async (pred: (n: N) => boolean): Promise<{ n: N; b: Box } | undefined> => {
	for (const n of await tree()) {
		if (!pred(n)) continue;
		const b = await boxOf(n);
		if (b && b.width > 0 && b.height > 0) return { n, b };
	}
	return undefined;
};
const waitFor = async <T>(what: string, get: () => Promise<T | undefined | false>, ms = 15000): Promise<T> => {
	const until = Date.now() + ms;
	for (;;) {
		const v = await get();
		if (v) return v;
		if (Date.now() > until) throw new Error(`waited ${ms} ms for ${what}`);
		await sleep(150);
	}
};
const shot = async (name: string) => {
	await app.call("screenshot", { path: join(out, `${name}.png`) });
};
const click = async (b: Box) => {
	await app.call("click", { x: b.x + b.width / 2, y: b.y + b.height / 2 });
	await sleep(400);
};
async function step(name: string, run: () => Promise<void>) {
	try {
		await run();
		results.push({ step: name, ok: true });
		console.log(`ok    ${name}`);
	} catch (e) {
		results.push({ step: name, ok: false, detail: (e as Error).message });
		console.log(`FAIL  ${name}\n      ${(e as Error).message}`);
	}
	await shot(name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()).catch(() => {});
}
/** Every match that is laid out, in tree order. */
const findAll = async (pred: (n: N) => boolean): Promise<{ n: N; b: Box }[]> => {
	const hits: { n: N; b: Box }[] = [];
	for (const n of await tree()) {
		if (!pred(n)) continue;
		const b = await boxOf(n);
		if (b && b.width > 0 && b.height > 0) hits.push({ n, b });
	}
	return hits;
};
const byText = (text: string) => (n: N) => n.text?.trim() === text;
const byTestId = (id: string) => (n: N) => n.testId === id;

try {
	await step("the library opens with its items", async () => {
		await waitFor(`"${T.article}" in the list`, () => find(byText(T.article)));
		await waitFor(`"My Library" in the sidebar`, () => find(byText("My Library")));
	});

	await step("the menu bar and the tab row sit above the panes", async () => {
		const file = await waitFor(`"File" in the menu bar`, () => find(byText("File")));
		const library = await waitFor(`the Library tab`, () => find((n) => n.text?.trim() === "Library"));
		const list = await waitFor(`"${T.article}"`, () => find(byText(T.article)));
		if (file.b.y > 20) throw new Error(`the menu bar is at y=${file.b.y}, not at the top`);
		if (library.b.y < file.b.y + file.b.height) throw new Error(`the tab row (y=${library.b.y}) overlaps the menu bar`);
		if (list.b.y < library.b.y + library.b.height) throw new Error(`the list (y=${list.b.y}) is drawn over the tab row (y=${library.b.y})`);
	});

	await step("a click on an item shows it in the item pane", async () => {
		const row = await waitFor(`"${T.authors}"`, () => find(byText(T.authors)));
		await click(row.b);
		await waitFor("the Details section", () => find(byText("Item Type")));
	});

	for (const [tab, heading] of [
		["notes", "NOTES"],
		["tags", "TAGS"],
		["related", "RELATED"],
	] as const) {
		await step(`the ${tab} tab of the item pane brings its section into view`, async () => {
			const nav = await waitFor(`the ${tab} tab`, () => find(byTestId(`ip-nav-${tab}`)));
			const paneLeft = ((await find(byTestId("ip-nav-info")))?.b.x ?? nav.b.x) - 40;
			await click(nav.b);
			const seen = async () => JSON.stringify({ nav: nav.b, hits: (await findAll((n) => n.text?.trim().toUpperCase() === heading)).map((h) => h.b) });
			const h = await waitFor(`"${heading}" in view`, async () => {
				// in view: below the tab row and inside the pane (a section near the end cannot reach the top: the pane stops scrolling)
				const hits = await findAll((n) => n.text?.trim().toUpperCase() === heading);
				// in the item pane (right of its first tab), below the tab row, above the window's bottom
				return hits.find((f) => f.b.x > paneLeft && f.b.y > nav.b.y + nav.b.height && f.b.y + f.b.height < 860);
			}, 5000).catch(async (e) => {
				throw new Error(`${(e as Error).message}: ${await seen()}`);
			});
		});
	}

	await step("Settings opens from the gear", async () => {
		const gear = await waitFor("the Settings button", () => find((n) => n.text === undefined && n.testId === "topbar-settings"), 2000).catch(
			() => undefined,
		);
		if (gear) await click(gear.b);
		else await app.call("keystrokes", { keys: "ctrl-," });
		await waitFor('"SETTINGS"', () => find(byText("SETTINGS")));
	});
} finally {
	writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
	await app.close().catch(() => {});
	await sleep(1500); // the app lets go of its library and logs as it exits
	try {
		rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
	} catch {
		console.warn(`could not remove ${home}`);
	}
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed. Screenshots: ${out}`);
process.exitCode = failed ? 1 : 0;
