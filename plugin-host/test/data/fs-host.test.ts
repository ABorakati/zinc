// The `fs` host handler: make-dir modes, the data-folder quota for folders, moving granted roots, and links that point nowhere.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fsHost from "../../src/imports/fs.host";
import { addGrant, configureFs, QUOTA_BYTES } from "../../src/imports/data/fs-roots";
import { call, failure, fakeCtx } from "./core-fixture";

let root: string;
beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "zn-fs-host-test-"));
	configureFs({ dataRoot: join(root, "data"), tempRoot: join(root, "temp"), bundledDirFor: () => undefined });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const data = (path: string) => ({ root: { tag: "data" }, path });
const granted = (id: string, path = "") => ({ root: { tag: "granted", val: id }, path });
const dataDir = () => join(root, "data", "data-test@zinc.test");

describe("fs.make-dir", () => {
	test("parents: false creates one level, and refuses a missing parent or an existing folder", async () => {
		const c = fakeCtx(undefined);
		await call(fsHost, c, "make-dir", data("a"), false);
		expect((await call(fsHost, c, "stat", data("a"))).kind).toBe("directory");
		await call(fsHost, c, "make-dir", data("a/b"), false); // the parent exists
		expect((await call(fsHost, c, "stat", data("a/b"))).kind).toBe("directory");
		expect((await failure(call(fsHost, c, "make-dir", data("missing/child"), false)))?.tag).toBe("not-found");
		expect(await call(fsHost, c, "stat", data("missing"))).toBeUndefined(); // and it did not make the parent
		expect((await failure(call(fsHost, c, "make-dir", data("a/b"), false)))?.tag).toBe("conflict");
	});

	test("parents: true makes every level and accepts an existing folder", async () => {
		const c = fakeCtx(undefined);
		await call(fsHost, c, "make-dir", data("p/q/r"), true);
		await call(fsHost, c, "make-dir", data("p/q/r"), true);
		expect((await call(fsHost, c, "stat", data("p/q/r"))).kind).toBe("directory");
	});
});

describe("fs quota counts folders", () => {
	const sparse = (path: string, bytes: number) => {
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, "");
		truncateSync(path, bytes);
	};

	test("copying a folder inside the data folder cannot go over the quota", async () => {
		const c = fakeCtx(undefined);
		await call(fsHost, c, "make-dir", data("src"), true);
		sparse(join(dataDir(), "src", "1.bin"), 200 * 1024 * 1024);
		await call(fsHost, c, "copy", data("src"), data("copy1"), "fail"); // 400 MiB
		expect((await failure(call(fsHost, c, "copy", data("src"), data("copy2"), "fail")))?.tag).toBe("limit-exceeded"); // would be 600 MiB
		expect(existsSync(join(dataDir(), "copy2"))).toBe(false);
		await call(fsHost, c, "remove", data("copy1"), true);
		await call(fsHost, c, "remove", data("src"), true);
	}, 60_000);

	test("copying a granted folder in is charged, moving a folder inside the data folder is free", async () => {
		const c = fakeCtx(undefined);
		const outside = join(root, "outside-big");
		sparse(join(outside, "x.bin"), QUOTA_BYTES + 1);
		const g = addGrant(c.pluginId, { path: outside, isDirectory: true, mode: "readwrite" });
		expect((await failure(call(fsHost, c, "copy", granted(g.id), data("in"), "fail")))?.tag).toBe("limit-exceeded");
		expect(existsSync(join(dataDir(), "in"))).toBe(false);
		// a folder that is already in the data folder is not new data when it moves inside it
		await call(fsHost, c, "make-dir", data("big"), true);
		sparse(join(dataDir(), "big", "1.bin"), 300 * 1024 * 1024);
		await call(fsHost, c, "move", data("big"), data("moved"), "fail");
		expect(existsSync(join(dataDir(), "moved", "1.bin"))).toBe(true);
		await call(fsHost, c, "remove", data("moved"), true);
	}, 60_000);
});

describe("fs.move and granted roots", () => {
	test("a granted folder or file itself cannot be moved; a write-only grant cannot be read out through a move", async () => {
		const c = fakeCtx(undefined);
		const dir = join(root, "granted-dir");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "inside.txt"), "inside");
		const file = join(root, "save-target.txt");
		writeFileSync(file, "existing user data");
		const gd = addGrant(c.pluginId, { path: dir, isDirectory: true, mode: "readwrite" });
		const gf = addGrant(c.pluginId, { path: file, isDirectory: false, mode: "write" });
		expect((await failure(call(fsHost, c, "move", granted(gd.id), data("taken"), "fail")))?.tag).toBe("permission-denied");
		expect((await failure(call(fsHost, c, "move", granted(gf.id), data("taken.txt"), "fail")))?.tag).toBe("permission-denied");
		expect(existsSync(join(dataDir(), "taken"))).toBe(false);
		expect(readFileSync(file, "utf8")).toBe("existing user data");
		// a write-only folder grant: the content may not be moved out (that would be reading it)
		const gw = addGrant(c.pluginId, { path: dir, isDirectory: true, mode: "write" });
		expect((await failure(call(fsHost, c, "move", granted(gw.id, "inside.txt"), data("out.txt"), "fail")))?.tag).toBe("permission-denied");
		expect(existsSync(join(dir, "inside.txt"))).toBe(true);
		// a read-write grant still moves files inside it
		await call(fsHost, c, "move", granted(gd.id, "inside.txt"), data("out.txt"), "fail");
		expect(readFileSync(join(dataDir(), "out.txt"), "utf8")).toBe("inside");
	});
});

describe("fs links that point nowhere", () => {
	test("a link whose target is gone is refused, not followed", async () => {
		const c = fakeCtx(undefined);
		await call(fsHost, c, "make-dir", data("links"), true);
		const gone = join(root, "gone-target");
		mkdirSync(gone, { recursive: true });
		const link = join(dataDir(), "links", "dangling");
		try {
			symlinkSync(gone, link, "junction");
		} catch {
			return; // no permission to make links here
		}
		rmSync(gone, { recursive: true, force: true });
		expect((await failure(call(fsHost, c, "write-text", data("links/dangling/new.txt"), "x", { createParents: true, onConflict: "overwrite", atomic: false })))?.tag).toBe("permission-denied");
		expect((await failure(call(fsHost, c, "make-dir", data("links/dangling/sub"), true)))?.tag).toBe("permission-denied");
		expect(existsSync(gone)).toBe(false);
	});
});
