// Headless screenshots of Settings > General > Locate (the engine list) against a MOCK core on loopback; nothing real is read or written:
//   ZN_SHOTS=<dir> bun scripts/shot-locate-settings.tsx [dark|light]
// Writes <SHOTS>/shell-settings-locate{,-added}[-light].png. The OpenSearch description is served by the mock (no network).
export {};
const OPENSEARCH = `<?xml version="1.0"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/" xmlns:z="http://www.zotero.org/namespaces/openSearch#">
<ShortName>PubMed</ShortName><LongName>PubMed Search</LongName>
<Url type="text/html" method="get" template="https://pubmed.ncbi.nlm.nih.gov/?term={searchTerms}"/>
</OpenSearchDescription>`;
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch(req) {
		const path = new URL(req.url).pathname;
		if (path === "/os.xml") return new Response(OPENSEARCH, { headers: { "Content-Type": "application/opensearchdescription+xml" } });
		return new Response(JSON.stringify({ error: "mock: not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
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
const { addEngine, setEngineEnabled } = await import("../src/locate/engines-store");
const { parseOpenSearch } = await import("../src/locate/engines");

const mode = process.argv.includes("light") ? "light" : "dark";
const suffix = mode === "light" ? "-light" : "";
// a second engine, disabled, so the list shows both states
addEngine({ ...parseOpenSearch(OPENSEARCH.replace("PubMed Search", "WorldCat")), name: "WorldCat" });
setEngineEnabled(1, false);

const h = await boot({
	prefs: { mode },
	height: 900,
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
await h.settle(800);
gotoSection("general");
setSettingsQuery("locate");
await h.settle(600);
await h.shot(`settings-locate${suffix}`);

console.log("SHOTS", SHOTS);
h.t.unmount();
server.stop(true);
process.exit(0);
