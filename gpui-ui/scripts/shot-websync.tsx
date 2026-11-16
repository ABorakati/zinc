// Headless screenshots of Settings > Sync (the zotero.org part) against a MOCK of /api/websync/* (no real core, no network beyond loopback):
//   bun scripts/shot-websync.tsx [dark|light]
// Writes <SHOTS>/shell-settings-websync-{key,connected,checked}[-light].png. ZN_URL is pointed at the mock before anything loads.
export {};
const mock = { port: 0 };
const state = {
	mode: "zotero-org",
	keySet: true,
	push: false,
	files: "download",
	jobDone: -1,
};
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(req) {
		const path = new URL(req.url).pathname;
		const json = (v: unknown, status = 200) =>
			new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
		const status = () => ({
			mode: state.mode,
			push: state.push,
			files: state.files,
			pending: 3,
			conflicts: 0,
			busy: false,
			account: state.keySet
				? { keySet: true, userId: 1234567, username: "aborakati", canWrite: true, filesAccess: false }
				: { keySet: false },
			libraryVersion: 8123,
			lastPullAt: new Date(Date.now() - 4 * 60_000).toISOString(),
			...(state.jobDone >= 0
				? { fileJob: { done: state.jobDone, total: 42, failed: 1, bytes: 83_000_000, running: state.jobDone < 42 } }
				: {}),
		});
		if (path === "/api/websync/status") return json(status());
		if (path === "/api/websync/key") {
			if (req.method === "POST") {
				const b = (await req.json()) as { apiKey: string };
				if (b.apiKey !== "good") return json({ error: "zotero.org rejected the API key (403 Forbidden)" }, 400);
				state.keySet = true;
			} else state.keySet = false;
			return json(status());
		}
		if (path === "/api/websync/mode") {
			state.mode = ((await req.json()) as { mode: string }).mode;
			return json(status());
		}
		if (path === "/api/websync/options") {
			Object.assign(state, await req.json());
			return json(status());
		}
		if (path === "/api/websync/now") return json(status());
		if (path === "/api/websync/files/check") {
			return json({
				imported: 310,
				missingLocally: 42,
				onServer: 38,
				notOnServer: 3,
				unknown: 1,
				sample: [
					{ key: "AAAA1111", title: "Prevention of acute kidney injury after cardiac surgery", onServer: true },
					{ key: "BBBB2222", title: "Machine perfusion in liver transplantation", onServer: true },
					{ key: "CCCC3333", title: "Untitled attachment", onServer: false },
				],
			});
		}
		if (path === "/api/websync/files/download-missing") {
			state.jobDone = 17;
			return json(status());
		}
		if (path === "/api/sync/status")
			return json({ enabled: false, zotero: "closed", dataDir: "C:/Users/abora/Zotero", pending: 0, conflicts: 0 });
		return json({ error: "mock: not found" }, 404);
	},
});
mock.port = server.port ?? 0;
process.env.ZN_URL = `http://127.0.0.1:${mock.port}`;

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
	height: 1300,
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
gotoSection("sync");
setSettingsQuery("zotero.org"); // only the zotero.org rows, so they all fit the viewport
await h.settle(600);
await h.shot(`settings-websync-connected${suffix}`);

await h.clickText("Check online-only files");
await h.settle(800);
await h.shot(`settings-websync-checked${suffix}`);
await h.clickText("Download missing files");
await h.settle(800);
await h.shot(`settings-websync-job${suffix}`);

console.log("SHOTS", SHOTS);
h.t.unmount();
server.stop(true);
process.exit(0);
