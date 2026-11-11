// The per-user standard folders for each OS (src/platform-dirs.ts). Platform, env and home are injected, so linux and darwin resolve from Windows too.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { defaultLibraryPath, settingsFile } from "../src/library-location";
import { configDir, dataDir, homeDir, localDataDir, mendeleyDataDirs, zoteroProfilesDir } from "../src/platform-dirs";

const win = { platform: "win32" as const, env: {}, home: "H" };
const mac = { platform: "darwin" as const, env: {}, home: "H" };
const lin = { platform: "linux" as const, env: {}, home: "H" };

describe("configDir", () => {
	test("Windows: <home>\\AppData\\Roaming, as before", () => {
		expect(configDir(win)).toBe(join("H", "AppData", "Roaming"));
	});
	test("macOS: ~/Library/Application Support", () => {
		expect(configDir(mac)).toBe(join("H", "Library", "Application Support"));
	});
	test("Linux: ~/.config, or XDG_CONFIG_HOME", () => {
		expect(configDir(lin)).toBe(join("H", ".config"));
		expect(configDir({ ...lin, env: { XDG_CONFIG_HOME: "X" } })).toBe("X");
		expect(configDir({ ...lin, env: { XDG_CONFIG_HOME: "" } })).toBe(join("H", ".config"));
	});
	test("an explicit APPDATA wins on every platform, over XDG too", () => {
		for (const p of ["win32", "darwin", "linux"] as const) {
			expect(configDir({ platform: p, env: { APPDATA: "A", XDG_CONFIG_HOME: "X" }, home: "H" })).toBe("A");
		}
	});
	test("an appData override wins over the environment", () => {
		expect(configDir({ ...lin, env: { APPDATA: "A" }, appData: "O" })).toBe("O");
	});
});

describe("dataDir", () => {
	test("Windows and macOS: the same folder as the config folder", () => {
		expect(dataDir(win)).toBe(configDir(win));
		expect(dataDir(mac)).toBe(configDir(mac));
	});
	test("Linux: ~/.local/share, or XDG_DATA_HOME (XDG_CONFIG_HOME does not matter)", () => {
		expect(dataDir(lin)).toBe(join("H", ".local", "share"));
		expect(dataDir({ ...lin, env: { XDG_DATA_HOME: "D", XDG_CONFIG_HOME: "C" } })).toBe("D");
	});
	test("APPDATA wins on Linux", () => {
		expect(dataDir({ ...lin, env: { APPDATA: "A", XDG_DATA_HOME: "D" } })).toBe("A");
	});
});

describe("homeDir", () => {
	test("USERPROFILE on Windows, HOME elsewhere, an explicit home first", () => {
		expect(homeDir({ platform: "win32", env: { USERPROFILE: "U", HOME: "X" } })).toBe("U");
		expect(homeDir({ platform: "linux", env: { USERPROFILE: "U", HOME: "X" } })).toBe("X");
		expect(homeDir({ platform: "linux", env: { HOME: "X" }, home: "G" })).toBe("G");
	});
});

describe("localDataDir", () => {
	test("Windows: <home>\\AppData\\Local; LOCALAPPDATA wins everywhere", () => {
		expect(localDataDir(win)).toBe(join("H", "AppData", "Local"));
		expect(localDataDir({ ...lin, env: { LOCALAPPDATA: "L" } })).toBe("L");
	});
	test("macOS and Linux: the data folder", () => {
		expect(localDataDir(mac)).toBe(join("H", "Library", "Application Support"));
		expect(localDataDir(lin)).toBe(join("H", ".local", "share"));
		expect(localDataDir({ ...lin, env: { XDG_DATA_HOME: "D" } })).toBe("D");
	});
	test("APPDATA alone does not move it on Linux", () => {
		expect(localDataDir({ ...lin, env: { APPDATA: "A" } })).toBe(join("H", ".local", "share"));
	});
});

describe("zoteroProfilesDir", () => {
	test("Windows: %APPDATA%\\Zotero\\Zotero\\Profiles, unchanged", () => {
		expect(zoteroProfilesDir(win)).toBe(join("H", "AppData", "Roaming", "Zotero", "Zotero", "Profiles"));
		expect(zoteroProfilesDir({ ...win, env: { APPDATA: "A" } })).toBe(join("A", "Zotero", "Zotero", "Profiles"));
	});
	test("macOS: ~/Library/Application Support/Zotero/Profiles", () => {
		expect(zoteroProfilesDir(mac)).toBe(join("H", "Library", "Application Support", "Zotero", "Profiles"));
	});
	test("Linux: ~/.zotero/zotero, ignoring XDG", () => {
		expect(zoteroProfilesDir({ ...lin, env: { XDG_CONFIG_HOME: "X" } })).toBe(join("H", ".zotero", "zotero"));
	});
	test("an explicit APPDATA (a scratch profile in a test run) moves it on every platform", () => {
		expect(zoteroProfilesDir({ ...lin, env: { APPDATA: "A" } })).toBe(join("A", "Zotero", "Zotero", "Profiles"));
	});
});

describe("mendeleyDataDirs", () => {
	test("Windows: under LOCALAPPDATA, both vendor spellings, as before", () => {
		expect(mendeleyDataDirs(win)).toEqual([
			join("H", "AppData", "Local", "Mendeley Ltd", "Mendeley Desktop"),
			join("H", "AppData", "Local", "Mendeley Ltd.", "Mendeley Desktop"),
		]);
		expect(mendeleyDataDirs({ ...win, env: { LOCALAPPDATA: "L" } })[0]).toBe(join("L", "Mendeley Ltd", "Mendeley Desktop"));
	});
	test("macOS: ~/Library/Application Support/Mendeley Desktop", () => {
		expect(mendeleyDataDirs(mac)).toEqual([join("H", "Library", "Application Support", "Mendeley Desktop")]);
	});
	test("Linux: ~/.local/share/data/Mendeley Ltd./Mendeley Desktop, or under XDG_DATA_HOME", () => {
		expect(mendeleyDataDirs(lin)).toEqual([join("H", ".local", "share", "data", "Mendeley Ltd.", "Mendeley Desktop")]);
		expect(mendeleyDataDirs({ ...lin, env: { XDG_DATA_HOME: "D" } })).toEqual([join("D", "data", "Mendeley Ltd.", "Mendeley Desktop")]);
	});
});

describe("the library location follows the platform", () => {
	test("Linux: settings in ~/.config, the default library in ~/.local/share", () => {
		expect(settingsFile(lin)).toBe(join("H", ".config", "zotero-next-gpui", "library.json"));
		expect(defaultLibraryPath(lin)).toBe(join("H", ".local", "share", "zotero-next", "library.sqlite"));
	});
	test("macOS: both in ~/Library/Application Support", () => {
		expect(settingsFile(mac)).toBe(join("H", "Library", "Application Support", "zotero-next-gpui", "library.json"));
		expect(defaultLibraryPath(mac)).toBe(join("H", "Library", "Application Support", "zotero-next", "library.sqlite"));
	});
	test("Windows: both under <home>\\AppData\\Roaming, as before", () => {
		expect(settingsFile(win)).toBe(join("H", "AppData", "Roaming", "zotero-next-gpui", "library.json"));
		expect(defaultLibraryPath(win)).toBe(join("H", "AppData", "Roaming", "zotero-next", "library.sqlite"));
	});
	test("APPDATA isolates a run on Linux", () => {
		const o = { ...lin, env: { APPDATA: "S" } };
		expect(settingsFile(o)).toBe(join("S", "zotero-next-gpui", "library.json"));
		expect(defaultLibraryPath(o)).toBe(join("S", "zotero-next", "library.sqlite"));
	});
});
