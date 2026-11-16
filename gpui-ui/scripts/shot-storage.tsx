// Headless screenshot of Settings > Files and folders (the attachment storage / ZotMoov rows) against a MOCK of /api/files/*
// (no real core, no real folders):
//   ZN_SHOTS=<dir> bun scripts/shot-storage.tsx [dark|light]
// Writes <SHOTS>/shell-settings-storage[-light].png. ZN_URL is pointed at the mock before anything loads.
export {};
const storage = {
	dir: null as string | null,
	subfolder: "",
	linked: true,
	ownDir: "C:/Users/example/zotero-next/storage",
	patternHelp: "{%a} author, {%y} year, {%c} collection path",
	auto: true,
	behavior: "move",
	allowedExt: [] as string[],
	rename: false,
	renameTitle: true,
	addTag: false,
	tag: "zotmoov",
	stripDiacritics: false,
	undefinedStr: "undefined",
	deleteFiles: false,
	pruneEmptyDirs: true,
	attachDir: null as string | null,
	attachConfirm: false,
	suggestions: ["C:/Users/example/OneDrive/Zotero Library"],
};
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(req) {
		const path = new URL(req.url).pathname;
		const json = (v: unknown, status = 200) =>
			new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
		const view = () => ({
			library: { dbPath: "C:/Users/example/zotero-next/data/library.sqlite", configPath: null, sizeBytes: 83_000_000 },
			zotero: { dataDir: "C:/Users/example/Zotero", source: "zotero", configured: null },
			baseDir: { mode: "zotero", configured: null, zotero: null, effective: null, stored: { absolute: 0, relative: 0 } },
			storage,
		});
		if (path === "/api/files/settings") return json(view());
		if (path === "/api/files/base-dir/convert") return json({ count: 0, outside: 0, sample: [] });
		if (path === "/api/files/storage/preset") {
			Object.assign(storage, {
				dir: ((await req.json()) as { dir: string }).dir,
				linked: true,
				auto: true,
				behavior: "move",
				allowedExt: ["pdf", "epub", "docx", "djvu"],
				rename: true,
				addTag: true,
			});
			return json(view());
		}
		if (path === "/api/files/storage" && req.method === "PUT") {
			Object.assign(storage, await req.json());
			return json(view());
		}
		return json({ error: "mock: not found" }, 404);
	},
});
process.env.ZN_URL = `http://127.0.0.1:${server.port}`;

const { SHOTS, boot } = await import("./shell-shot-lib");
const { Show } = await import("solid-js");
const { gotoSection, SettingsPage } = await import("../src/settings");
const { setSettingsQuery, settingsShown } = await import("../src/settings/registry");
const { openSettings } = await import("../src/shell/layout");
const { store } = await import("../src/store");
const { textStyle, tw } = await import("../src/theme");
const { TopBar } = await import("../src/TopBar");
const { OverlayHost } = await import("../src/ui");

const mode = process.argv.includes("light") ? "light" : "dark";
const suffix = mode === "light" ? "-light" : "";
const h = await boot({
	prefs: { mode },
	height: 1500,
	view: () => (
		<div style={{ ...tw("flex flex-col bg-canvas", store.mode()), width: "100%", height: "100%" }}>
			<TopBar />
			<div
				style={{
					display: "flex",
					flexDirection: "column",
					flexGrow: 1,
					minHeight: 0,
					width: "100%",
					backgroundColor: "transparent",
				}}
			>
				<Show
					when={store.activeTab() === "settings"}
					fallback={<text style={textStyle("text-foreground", store.mode())}>library tab</text>}
				>
					<SettingsPage active />
				</Show>
			</div>
			<OverlayHost />
		</div>
	),
});
openSettings();
settingsShown();
await h.settle(1500);
gotoSection("files");
setSettingsQuery("zotmoov"); // the ZotMoov rows only, so they all fit the viewport
await h.settle(600);
await h.shot(`settings-storage-off${suffix}`);

// "Use <OneDrive>\Zotero Library" from the suggestion
await h.clickText("Use C:/Users/example/OneDrive/Zotero Library");
await h.settle(800);
await h.shot(`settings-storage${suffix}`);

console.log("SHOTS", SHOTS);
h.t.unmount();
server.stop(true);
process.exit(0);
