// bun test src/settings/registry.test.ts -- section-scoped refresh hooks, deduplication, lazy providers and built-in defs.
process.env.ZN_UI_STATE = "off"; // never touch the user's ui-state.json
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setDirect } from "../api";
import {
	onSectionShown,
	onSettingsShown,
	registerSection,
	registerSettings,
	registerSettingsProvider,
	resetSettingsShownState,
	sectionCount,
	sectionRows,
	setSettingsQuery,
	settingsShown,
} from "./registry";
import "./defs/appearance";
import "./defs/integrations";
import "./defs/files";
import "./defs/sync";
import "./defs/system";

const tick = () => new Promise<void>((r) => setTimeout(r, 10));

const emptyFilesView = (baseDir: { effective: string | null; absolute: number }) => ({
	library: { dbPath: null, configPath: null, sizeBytes: null },
	zotero: { dataDir: "C:\\Zotero", source: "zotero", configured: null },
	baseDir: {
		mode: baseDir.effective ? "custom" : "none",
		configured: baseDir.effective,
		zotero: null,
		effective: baseDir.effective,
		stored: { absolute: baseDir.absolute, relative: 0 },
	},
	storage: {
		dir: null,
		subfolder: "",
		linked: true,
		ownDir: null,
		patternHelp: "",
		auto: true,
		behavior: "move",
		allowedExt: [],
		rename: false,
		renameTitle: true,
		addTag: false,
		tag: "zotmoov",
		stripDiacritics: false,
		undefinedStr: "undefined",
		deleteFiles: false,
		pruneEmptyDirs: true,
		attachDir: null,
		attachConfirm: false,
		suggestions: [],
	},
});

describe("settingsShown section scoping and throttling", () => {
	const cleanups: (() => void)[] = [];
	const requests: string[] = [];
	let filesView = emptyFilesView({ effective: null, absolute: 0 });

	beforeEach(() => {
		requests.length = 0;
		filesView = emptyFilesView({ effective: null, absolute: 0 });
		setSettingsQuery("");
		resetSettingsShownState();
		setDirect((req) => {
			const url = new URL(req.url);
			requests.push(`${req.method} ${url.pathname}`);
			if (url.pathname === "/api/integrations") {
				return Response.json({
					word: { installed: false, available: true, wordRunning: false },
					chrome: {
						hostInstalled: false,
						available: true,
						extensionDir: "",
						chromeFound: false,
						edgeFound: true,
						chromeHost: false,
						edgeHost: false,
					},
				});
			}
			if (url.pathname === "/api/files/settings") return Response.json(filesView);
			if (url.pathname === "/api/files/base-dir/convert") return Response.json({ count: 0, outside: 0, sample: [] });
			if (url.pathname === "/api/sync/status") {
				return Response.json({ enabled: false, zotero: "closed", dataDir: "C:\\Zotero", pending: 0, conflicts: 0 });
			}
			if (url.pathname === "/api/websync/status") {
				return Response.json({
					mode: "off",
					account: { keySet: false },
					push: false,
					files: "off",
					pending: 0,
					conflicts: 0,
					busy: false,
				});
			}
			if (url.pathname === "/api/collections") return Response.json([]);
			return new Response("not found", { status: 404 });
		});
	});

	afterEach(() => {
		while (cleanups.length) cleanups.pop()!();
		setSettingsQuery("");
	});

	test("opening Settings on appearance fires zero backend refreshes for other sections", async () => {
		const hit: string[] = [];
		cleanups.push(onSectionShown("test-a", () => hit.push("test-a")));
		cleanups.push(onSectionShown("test-b", () => hit.push("test-b")));

		settingsShown(["appearance"], 100_000);
		await tick();

		expect(hit).toEqual([]);
		expect(requests).toEqual([]);
	});

	test("switching to a section triggers only that section's hook", async () => {
		const hit: string[] = [];
		cleanups.push(onSectionShown("test-a", () => hit.push("test-a")));
		cleanups.push(onSectionShown("test-b", () => hit.push("test-b")));
		cleanups.push(onSettingsShown(() => hit.push("global")));

		settingsShown(["test-a"], 100_000);
		expect(hit).toEqual(["test-a", "global"]);

		hit.length = 0;
		settingsShown(["test-b"], 100_100);
		expect(hit).toEqual(["test-b"]);
	});

	test("rapid re-shows are deduplicated within minIntervalMs and refresh once stale", () => {
		let count = 0;
		cleanups.push(onSectionShown("test-throttle", () => count++, { minIntervalMs: 5000 }));

		settingsShown(["test-throttle"], 10_000);
		settingsShown(["test-throttle"], 11_000);
		settingsShown(["test-throttle"], 14_999);
		expect(count).toBe(1);

		settingsShown(["test-throttle"], 15_000);
		expect(count).toBe(2);
	});

	test("built-in integrations section refreshes only when visible and deduplicates rapid revisits", async () => {
		settingsShown(["appearance"], 200_000);
		await tick();
		expect(requests).toEqual([]);

		settingsShown(["integrations"], 200_000);
		await tick();
		expect(requests).toEqual(["GET /api/integrations"]);

		// Rapid switch back to integrations within 5 s does not spawn subprocesses again
		settingsShown(["integrations"], 201_000);
		await tick();
		expect(requests).toEqual(["GET /api/integrations"]);

		// After the staleness interval it refreshes again
		settingsShown(["integrations"], 206_000);
		await tick();
		expect(requests).toEqual(["GET /api/integrations", "GET /api/integrations"]);
	});

	test("built-in files section fetches settings once (no duplicate) and skips convert preview when no baseDir or no absolute links", async () => {
		filesView = emptyFilesView({ effective: null, absolute: 5 });
		settingsShown(["files"], 300_000);
		await tick();
		expect(requests).toEqual(["GET /api/files/settings"]);

		requests.length = 0;
		filesView = emptyFilesView({ effective: "C:\\Papers", absolute: 0 });
		settingsShown(["files"], 310_000);
		await tick();
		expect(requests).toEqual(["GET /api/files/settings"]);

		requests.length = 0;
		filesView = emptyFilesView({ effective: "C:\\Papers", absolute: 3 });
		settingsShown(["files"], 320_000);
		await tick();
		expect(requests).toEqual(["GET /api/files/settings", "POST /api/files/base-dir/convert"]);
	});

	test("built-in sync section refreshes local sync once (not duplicated by start()) plus websync", async () => {
		settingsShown(["sync"], 400_000);
		await tick();
		expect(requests.filter((r) => r === "GET /api/sync/status").length).toBe(1);
		expect(requests.filter((r) => r === "GET /api/websync/status").length).toBe(1);
		expect(requests.some((r) => r.includes("integrations") || r.includes("files") || r.includes("collections"))).toBe(false);
	});

	test("built-in system section queries collections only when system is shown", async () => {
		settingsShown(["appearance"], 500_000);
		await tick();
		expect(requests).toEqual([]);

		settingsShown(["system"], 500_000);
		await tick();
		expect(requests).toEqual(["GET /api/collections"]);
	});
});

describe("section-scoped providers and memoized search", () => {
	test("reading appearance rows does not invoke providers registered for another section", () => {
		let calls = 0;
		registerSection({ id: "test-lazy", label: "Lazy Test", order: 999 });
		registerSettings([{ id: "test-lazy.static", section: "test-lazy", label: "Static option" }]);
		registerSettingsProvider(() => {
			calls++;
			return [{ id: "test-lazy.dynamic", section: "test-lazy", label: "Dynamic shortcut alpha" }];
		}, "test-lazy");

		setSettingsQuery("");
		expect(sectionRows("appearance").length).toBeGreaterThan(0);
		expect(calls).toBe(0);

		// Reading the provider's own section evaluates it once and memoizes it
		expect(sectionCount("test-lazy")).toBe(2);
		expect(sectionRows("test-lazy").length).toBe(1);
		expect(calls).toBe(1);

		// Searching reuses the memoized provider output across multiple sectionCount/sectionRows reads
		setSettingsQuery("alpha");
		expect(sectionCount("test-lazy")).toBe(1);
		expect(sectionRows("test-lazy")[0]?.rows[0]?.id).toBe("test-lazy.dynamic");
		expect(sectionCount("appearance")).toBe(0);
		expect(calls).toBe(1);
	});
});
