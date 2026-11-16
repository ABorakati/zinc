// Which library database opens: env override, saved setting, legacy adoption, fresh default (src/library-location.ts).
// Everything runs in a temp folder standing in for the user's profile; nothing touches the real %APPDATA% or home folder.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	defaultLibraryPath,
	freshLibraryPath,
	isRealLibrary,
	legacyLibraryPath,
	readLibrarySetting,
	resolveLibrary,
	saveLibrarySetting,
	settingsFile,
	type LocationInput,
} from "../src/library-location";

let root: string;
let loc: LocationInput & { env: Record<string, string | undefined> };

const touch = (p: string) => {
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, "");
};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "zn-libloc-"));
	loc = { env: {}, home: join(root, "home"), appData: join(root, "appdata") };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("standard locations", () => {
	test("come from the home and AppData folders, never a user name", () => {
		expect(defaultLibraryPath(loc)).toBe(join(root, "appdata", "zotero-next", "library.sqlite"));
		expect(legacyLibraryPath(loc)).toBe(join(root, "home", "zotero-next", "data", "library.sqlite"));
		expect(settingsFile(loc)).toBe(join(root, "appdata", "zotero-next-gpui", "library.json"));
	});
	test("APPDATA from the environment is honoured", () => {
		expect(defaultLibraryPath({ env: { APPDATA: "A" }, home: "H" })).toBe(join("A", "zotero-next", "library.sqlite"));
	});
});

describe("resolveLibrary", () => {
	test("a fresh profile has no library: path null, the default path to create one at", () => {
		const r = resolveLibrary(loc);
		expect(r.path).toBeNull();
		expect(r.source).toBe("none");
		expect(r.defaultPath).toBe(defaultLibraryPath(loc));
		expect(existsSync(settingsFile(loc))).toBe(false); // nothing is written on the way
	});

	test("an existing library at the default location is used", () => {
		touch(defaultLibraryPath(loc));
		const r = resolveLibrary(loc);
		expect(r).toMatchObject({ path: defaultLibraryPath(loc), source: "default", exists: true, adopted: false });
	});

	test("ZN_DB and ZN_LIBRARY override everything (ZN_DB first), even a saved setting", () => {
		saveLibrarySetting(join(root, "saved.sqlite"), loc);
		touch(legacyLibraryPath(loc));
		expect(resolveLibrary({ ...loc, env: { ZN_LIBRARY: "L.sqlite" } })).toMatchObject({ path: "L.sqlite", source: "env" });
		expect(resolveLibrary({ ...loc, env: { ZN_LIBRARY: "L.sqlite", ZN_DB: "D.sqlite" } })).toMatchObject({
			path: "D.sqlite",
			source: "env",
		});
		expect(readLibrarySetting(loc)).toBe(join(root, "saved.sqlite")); // an override never rewrites the setting
	});

	test("the saved setting wins over the legacy location and the default, and is kept when its file is missing", () => {
		touch(legacyLibraryPath(loc));
		touch(defaultLibraryPath(loc));
		const mine = join(root, "elsewhere", "my.sqlite");
		saveLibrarySetting(mine, loc);
		expect(resolveLibrary(loc)).toMatchObject({ path: mine, source: "setting", exists: false, adopted: false });
		touch(mine);
		expect(resolveLibrary(loc)).toMatchObject({ path: mine, source: "setting", exists: true });
	});

	test("a damaged setting file is ignored", () => {
		mkdirSync(dirname(settingsFile(loc)), { recursive: true });
		writeFileSync(settingsFile(loc), "{ not json");
		expect(readLibrarySetting(loc)).toBeNull();
		writeFileSync(settingsFile(loc), JSON.stringify({ path: 5 }));
		expect(readLibrarySetting(loc)).toBeNull();
		expect(resolveLibrary(loc).source).toBe("none");
	});
});

describe("legacy library migration (the first start after the upgrade)", () => {
	test("no setting + legacy library present: the legacy path is adopted and saved", () => {
		const legacy = legacyLibraryPath(loc);
		touch(legacy);
		touch(defaultLibraryPath(loc)); // a default library existing too must not change the choice

		const first = resolveLibrary(loc);
		expect(first).toMatchObject({ path: legacy, source: "legacy", exists: true, adopted: true });
		expect(JSON.parse(readFileSync(settingsFile(loc), "utf8")).path).toBe(legacy);

		// the next start reads the saved setting; same library, no further adoption
		const second = resolveLibrary(loc);
		expect(second).toMatchObject({ path: legacy, source: "setting", exists: true, adopted: false });
	});

	test("the adopted path keeps winning even if the default location is created later", () => {
		touch(legacyLibraryPath(loc));
		resolveLibrary(loc);
		touch(defaultLibraryPath(loc));
		expect(resolveLibrary(loc).path).toBe(legacyLibraryPath(loc));
	});

	test("adopt: false only looks", () => {
		touch(legacyLibraryPath(loc));
		const r = resolveLibrary({ ...loc, adopt: false });
		expect(r).toMatchObject({ path: legacyLibraryPath(loc), source: "legacy", adopted: false });
		expect(existsSync(settingsFile(loc))).toBe(false);
	});

	test("the real layout: a user whose library is C:\\Users\\<name>\\zotero-next\\data\\library.sqlite", () => {
		// the home folder is the only place the name appears
		const home = join(root, "Users", "someone");
		const legacy = join(home, "zotero-next", "data", "library.sqlite");
		touch(legacy);
		const r = resolveLibrary({ env: {}, home, appData: join(home, "AppData", "Roaming") });
		expect(r).toMatchObject({ path: legacy, source: "legacy", adopted: true });
		expect(readLibrarySetting({ env: {}, home, appData: join(home, "AppData", "Roaming") })).toBe(legacy);
	});

	test("extra legacy places (the Electrobun app's own data folder) come after the home-folder one", () => {
		const own = join(root, "electrobun", "library.sqlite");
		touch(own);
		expect(resolveLibrary({ ...loc, alsoLegacy: [own] })).toMatchObject({ path: own, source: "legacy" });
	});
});

describe("freshLibraryPath", () => {
	test("is the default path, or a numbered neighbour when that file is taken", () => {
		expect(freshLibraryPath(loc)).toBe(defaultLibraryPath(loc));
		touch(defaultLibraryPath(loc));
		expect(freshLibraryPath(loc)).toBe(join(dirname(defaultLibraryPath(loc)), "library-2.sqlite"));
		touch(join(dirname(defaultLibraryPath(loc)), "library-2.sqlite"));
		expect(freshLibraryPath(loc)).toBe(join(dirname(defaultLibraryPath(loc)), "library-3.sqlite"));
	});
});

describe("saving", () => {
	test("keeps other keys and leaves no temp file behind", () => {
		mkdirSync(dirname(settingsFile(loc)), { recursive: true });
		writeFileSync(settingsFile(loc), JSON.stringify({ other: 1 }));
		saveLibrarySetting("X:\\lib.sqlite", loc);
		expect(JSON.parse(readFileSync(settingsFile(loc), "utf8"))).toEqual({ other: 1, path: "X:\\lib.sqlite" });
		expect(existsSync(`${settingsFile(loc)}.${process.pid}.tmp`)).toBe(false);
	});
});

describe("isRealLibrary", () => {
	test("is true for the saved, legacy and default libraries (any slash style or case), false for a copy", () => {
		saveLibrarySetting(join(root, "mine.sqlite"), loc);
		expect(isRealLibrary(join(root, "mine.sqlite").replaceAll("\\", "/").toUpperCase(), loc)).toBe(true);
		expect(isRealLibrary(legacyLibraryPath(loc), loc)).toBe(true);
		expect(isRealLibrary(defaultLibraryPath(loc), loc)).toBe(true);
		expect(isRealLibrary(join(root, "copy.sqlite"), loc)).toBe(false);
	});
});
