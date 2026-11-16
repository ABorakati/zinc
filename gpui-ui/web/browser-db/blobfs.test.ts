// The durable node:fs shim: web/shims/fs.ts with browser-db/blobfs.ts on bun:sqlite. Imports the shim module itself, not node:fs.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "../shims/fs";
import * as fsp from "../shims/fs-promises";
import { createBlobBackend, type BlobDb } from "./blobfs";

const scratch = mkdtempSync(join(tmpdir(), "zinc-blobfs-"));
afterAll(() => {
	fs.installDurableFs(null);
	try {
		db.close();
	} catch {}
	try {
		rmSync(scratch, { recursive: true, force: true });
	} catch {}
});

let db: Database;
function fresh(file = ":memory:") {
	db = new Database(file);
	fs.installDurableFs(createBlobBackend(db as unknown as BlobDb));
}
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const bytes = (n: number, seed = 1) => {
	const b = new Uint8Array(n);
	for (let i = 0; i < n; i++) b[i] = (i * 31 + seed + (i >> 8)) & 255;
	return b;
};

beforeEach(() => fresh());

describe("durable files", () => {
	test("text and binary round trips", () => {
		fs.writeFileSync("/opfs/zinc/storage/AB12/Paper.txt", "héllo wörld");
		expect(fs.readFileSync("/opfs/zinc/storage/AB12/Paper.txt", "utf8")).toBe("héllo wörld");
		expect(fs.readFileSync("/opfs/zinc/storage/AB12/Paper.txt", { encoding: "utf8" })).toBe("héllo wörld");
		const bin = bytes(1000);
		fs.writeFileSync("/opfs/zinc/storage/AB12/x.bin", bin);
		const back = fs.readFileSync("/opfs/zinc/storage/AB12/x.bin") as Uint8Array & { toString(e?: string): string };
		expect(back.length).toBe(1000);
		expect([...back]).toEqual([...bin]);
		expect(back.toString()).toBe(new TextDecoder().decode(bin));
		expect(btoa(String.fromCharCode(...bin))).toBe(back.toString("base64"));
	});
	test("empty files, overwrite, and missing files", () => {
		fs.writeFileSync("/opfs/e", "");
		expect(fs.statSync("/opfs/e").size).toBe(0);
		expect((fs.readFileSync("/opfs/e") as Uint8Array).length).toBe(0);
		fs.writeFileSync("/opfs/e", "abc");
		fs.writeFileSync("/opfs/e", "z");
		expect(fs.readFileSync("/opfs/e", "utf8")).toBe("z");
		expect(() => fs.readFileSync("/opfs/none")).toThrow(/ENOENT/);
		expect(fs.existsSync("/opfs/none")).toBe(false);
		expect(fs.existsSync("/opfs/e")).toBe(true);
	});
	test("the prefix is matched after lower-casing", () => {
		fs.writeFileSync("/OPFS/Mixed/Case.TXT", "a");
		expect(fs.readFileSync("/opfs/mixed/case.txt", "utf8")).toBe("a");
		expect(db.query("SELECT path FROM files").all()).toEqual([{ path: "/opfs/mixed/case.txt" }]);
	});
	test("names keep their case, lookups do not care about it", () => {
		fs.writeFileSync("/opfs/zinc/storage/ABCD1234/My Paper.PDF", "pdf");
		fs.writeFileSync("/opfs/zinc/storage/ABCD1234/Notes/Sub.TXT", "t");
		expect(fs.readFileSync("/opfs/zinc/storage/abcd1234/my paper.pdf", "utf8")).toBe("pdf");
		expect(fs.readFileSync("/OPFS/ZINC/STORAGE/ABCD1234/MY PAPER.PDF", "utf8")).toBe("pdf");
		expect(fs.existsSync("/opfs/zinc/storage/abcd1234")).toBe(true);
		expect(fs.readdirSync("/opfs/zinc/storage")).toEqual(["ABCD1234"]);
		expect(fs.readdirSync("/opfs/zinc/storage/abcd1234")).toEqual(["My Paper.PDF", "Notes"]);
		const t = fs.readdirSync("/opfs/zinc/storage/Abcd1234", { withFileTypes: true });
		expect(t.map((e: any) => [e.name, e.isFile(), e.isDirectory()])).toEqual([
			["My Paper.PDF", true, false],
			["Notes", false, true],
		]);
		expect(fs.readdirSync("/opfs/zinc/storage/abcd1234/NOTES")).toEqual(["Sub.TXT"]);
		// stat through either case
		expect(fs.statSync("/opfs/zinc/storage/ABCD1234/My Paper.PDF").size).toBe(3);
		expect(fs.statSync("/opfs/zinc/storage/abcd1234/my paper.pdf").size).toBe(3);
		expect(fs.statSync("/opfs/zinc/storage/abcd1234").isDirectory()).toBe(true);
		// the first spelling wins: an overwrite or a write through another case keeps the name, and no second row appears
		fs.writeFileSync("/opfs/zinc/storage/abcd1234/MY PAPER.PDF", "pdf2");
		fs.appendFileSync("/opfs/zinc/storage/abcd1234/my paper.pdf", "!");
		expect(fs.readdirSync("/opfs/zinc/storage/ABCD1234")).toEqual(["My Paper.PDF", "Notes"]);
		expect(fs.readFileSync("/opfs/zinc/storage/ABCD1234/My Paper.PDF", "utf8")).toBe("pdf2!");
		// copy takes the case of its destination, cpSync keeps the names
		fs.copyFileSync("/opfs/zinc/storage/abcd1234/my paper.pdf", "/opfs/zinc/storage/EFGH9999/Copy.PDF");
		fs.cpSync("/opfs/zinc/storage/ABCD1234", "/opfs/zinc/storage/IJKL0000", { recursive: true });
		expect(fs.readdirSync("/opfs/zinc/storage/efgh9999")).toEqual(["Copy.PDF"]);
		expect(fs.readdirSync("/opfs/zinc/storage")).toEqual(["ABCD1234", "EFGH9999", "IJKL0000"]);
		expect(fs.readdirSync("/opfs/zinc/storage/ijkl0000")).toEqual(["My Paper.PDF", "Notes"]);
		expect(fs.readdirSync("/opfs/zinc/storage/ijkl0000/notes")).toEqual(["Sub.TXT"]);
		// a descriptor opened by a name creates a file with that name
		const fd = fs.openSync("/opfs/zinc/storage/ABCD1234/Log.TXT", "a");
		fs.writeSync(fd, "x");
		fs.closeSync(fd);
		expect(fs.readdirSync("/opfs/zinc/storage/abcd1234")).toEqual(["Log.TXT", "My Paper.PDF", "Notes"]);
		fs.rmSync("/opfs/zinc/storage/abcd1234/NOTES", { recursive: true });
		expect(fs.readdirSync("/opfs/zinc/storage/abcd1234")).toEqual(["Log.TXT", "My Paper.PDF"]);
	});
	test("a rename that only changes case, for a file and for a directory", () => {
		fs.writeFileSync("/opfs/r/a.pdf", "A");
		fs.renameSync("/opfs/r/a.pdf", "/opfs/r/A.pdf");
		expect(fs.readdirSync("/opfs/r")).toEqual(["A.pdf"]);
		expect(fs.readFileSync("/opfs/r/a.pdf", "utf8")).toBe("A");
		expect(fs.statSync("/opfs/r/A.PDF").size).toBe(1);
		fs.writeFileSync("/opfs/r/dir/x/inner.txt", "i");
		fs.writeFileSync("/opfs/r/dir/File.txt", "f");
		fs.renameSync("/opfs/r/dir", "/opfs/r/DIR");
		expect(fs.readdirSync("/opfs/r")).toEqual(["A.pdf", "DIR"]);
		expect(fs.readdirSync("/opfs/r/dir")).toEqual(["File.txt", "x"]);
		expect(fs.readFileSync("/opfs/r/dir/x/inner.txt", "utf8")).toBe("i");
		expect(() => fs.renameSync("/opfs/r/none", "/opfs/r/NONE")).toThrow(/ENOENT/);
		// renaming a directory to another name carries the original-case names of what is inside
		fs.renameSync("/opfs/r/DIR", "/opfs/r/Moved");
		expect(fs.readdirSync("/opfs/r")).toEqual(["A.pdf", "Moved"]);
		expect(fs.readdirSync("/opfs/r/moved")).toEqual(["File.txt", "x"]);
		expect(db.query("SELECT path, name FROM files ORDER BY path").all()).toEqual([
			{ path: "/opfs/r/a.pdf", name: "/opfs/r/A.pdf" },
			{ path: "/opfs/r/moved/file.txt", name: "/opfs/r/Moved/File.txt" },
			{ path: "/opfs/r/moved/x/inner.txt", name: "/opfs/r/Moved/x/inner.txt" },
		]);
	});
	test("directories: mkdir recursive, parents implied, readdir with types", () => {
		fs.mkdirSync("/opfs/a/b/c", { recursive: true });
		expect(fs.statSync("/opfs/a/b").isDirectory()).toBe(true);
		expect(fs.existsSync("/opfs/a")).toBe(true);
		fs.writeFileSync("/opfs/a/f.txt", "1");
		fs.writeFileSync("/opfs/a/b/g.txt", "2");
		fs.writeFileSync("/opfs/deep/er/h.txt", "3"); // no mkdir: parents implied
		expect(fs.readdirSync("/opfs/a")).toEqual(["b", "f.txt"]);
		expect(fs.readdirSync("/opfs/deep")).toEqual(["er"]);
		const t = fs.readdirSync("/opfs/a", { withFileTypes: true });
		expect(t.map((e: any) => [e.name, e.isFile(), e.isDirectory()])).toEqual([
			["b", false, true],
			["f.txt", true, false],
		]);
		expect(fs.readdirSync("/opfs")).toEqual(["a", "deep"]);
		expect(() => fs.readdirSync("/opfs/nope")).toThrow(/ENOENT/);
		expect(() => fs.readdirSync("/opfs/a/f.txt")).toThrow(/ENOTDIR/);
		expect(() => fs.readFileSync("/opfs/a")).toThrow(/EISDIR/);
		// a sibling with a similar prefix is not a child
		fs.writeFileSync("/opfs/a2/x", "x");
		expect(fs.readdirSync("/opfs/a")).toEqual(["b", "f.txt"]);
	});
	test("rmdirSync only removes an empty directory", () => {
		fs.mkdirSync("/opfs/d/e", { recursive: true });
		expect(() => fs.rmdirSync("/opfs/d")).toThrow(/ENOTEMPTY/);
		fs.rmdirSync("/opfs/d/e");
		fs.rmdirSync("/opfs/d");
		expect(fs.existsSync("/opfs/d")).toBe(false);
	});
	test("rename a file, rename a directory, recursive rm", () => {
		fs.writeFileSync("/opfs/s/K1/a.pdf", "A");
		fs.writeFileSync("/opfs/s/K1/sub/b.pdf", "B");
		fs.mkdirSync("/opfs/s/K1/empty", { recursive: true });
		fs.renameSync("/opfs/s/K1/a.pdf", "/opfs/s/K1/renamed.pdf");
		expect(fs.existsSync("/opfs/s/K1/a.pdf")).toBe(false);
		expect(fs.readFileSync("/opfs/s/K1/renamed.pdf", "utf8")).toBe("A");
		fs.renameSync("/opfs/s/K1", "/opfs/s/K2");
		expect(fs.existsSync("/opfs/s/K1")).toBe(false);
		expect(fs.readdirSync("/opfs/s")).toEqual(["K2"]);
		expect(fs.readdirSync("/opfs/s/K2")).toEqual(["empty", "renamed.pdf", "sub"]);
		expect(fs.readFileSync("/opfs/s/K2/sub/b.pdf", "utf8")).toBe("B");
		// replace an existing file
		fs.writeFileSync("/opfs/s/K2/old.pdf", "old");
		fs.renameSync("/opfs/s/K2/renamed.pdf", "/opfs/s/K2/old.pdf");
		expect(fs.readFileSync("/opfs/s/K2/old.pdf", "utf8")).toBe("A");
		expect(() => fs.renameSync("/opfs/s/none", "/opfs/s/x")).toThrow(/ENOENT/);
		fs.rmSync("/opfs/s/K2", { recursive: true, force: true });
		expect(fs.existsSync("/opfs/s/K2")).toBe(false);
		expect(fs.existsSync("/opfs/s")).toBe(true);
		expect(db.query("SELECT count(*) AS n FROM files").get()).toEqual({ n: 0 });
		fs.rmSync("/opfs/s/none", { force: true }); // missing is fine
		fs.writeFileSync("/opfs/one", "1");
		fs.rmSync("/opfs/one");
		expect(fs.existsSync("/opfs/one")).toBe(false);
	});
	test("copyFile and cpSync (file and directory)", () => {
		fs.writeFileSync("/opfs/c/a.txt", "AAA");
		fs.writeFileSync("/opfs/c/d/b.txt", "BBB");
		fs.copyFileSync("/opfs/c/a.txt", "/opfs/c2/a-copy.txt");
		expect(fs.readFileSync("/opfs/c2/a-copy.txt", "utf8")).toBe("AAA");
		expect(() => fs.copyFileSync("/opfs/c/none", "/opfs/c2/x")).toThrow(/ENOENT/);
		fs.cpSync("/opfs/c", "/opfs/c3", { recursive: true });
		expect(fs.readFileSync("/opfs/c3/d/b.txt", "utf8")).toBe("BBB");
		fs.cpSync("/opfs/c/a.txt", "/opfs/c3/single.txt");
		expect(fs.readFileSync("/opfs/c3/single.txt", "utf8")).toBe("AAA");
		expect(() => fs.cpSync("/opfs/c", "/opfs/c4")).toThrow();
	});
	test("append", () => {
		fs.appendFileSync("/opfs/log/a.log", "one\n");
		fs.appendFileSync("/opfs/log/a.log", "two\n");
		fs.appendFileSync("/opfs/log/a.log", new Uint8Array([51, 10]));
		expect(fs.readFileSync("/opfs/log/a.log", "utf8")).toBe("one\ntwo\n3\n");
		expect(fs.statSync("/opfs/log/a.log").size).toBe(10);
		fs.writeFileSync("/opfs/log/a.log", "x", { flag: "a" });
		expect(fs.readFileSync("/opfs/log/a.log", "utf8")).toBe("one\ntwo\n3\nx");
	});
	test("stat: real size, mtime, types and throwIfNoEntry", () => {
		const t0 = Date.now();
		fs.writeFileSync("/opfs/st/f.bin", bytes(12345));
		const t1 = Date.now();
		const st = fs.statSync("/opfs/st/f.bin");
		expect(st.size).toBe(12345);
		expect(st.isFile()).toBe(true);
		expect(st.isDirectory()).toBe(false);
		expect(st.mtimeMs).toBeGreaterThanOrEqual(t0);
		expect(st.mtimeMs).toBeLessThanOrEqual(t1);
		expect(st.mtime.getTime()).toBe(st.mtimeMs);
		expect(fs.lstatSync("/opfs/st/f.bin").size).toBe(12345);
		expect(fs.statSync("/opfs/st").isDirectory()).toBe(true);
		expect(fs.statSync("/opfs/st/none", { throwIfNoEntry: false })).toBeUndefined();
		expect(() => fs.statSync("/opfs/st/none")).toThrow(/ENOENT/);
		fs.appendFileSync("/opfs/st/f.bin", "tail");
		expect(fs.statSync("/opfs/st/f.bin").size).toBe(12349);
		fs.utimesSync("/opfs/st/f.bin", new Date(5000), new Date(5000));
		expect(fs.statSync("/opfs/st/f.bin").mtimeMs).toBe(5000);
	});
	test("file descriptors: open, write, read, close", () => {
		const fd = fs.openSync("/opfs/fd/log.txt", "a");
		fs.writeSync(fd, "abc");
		fs.writeSync(fd, new TextEncoder().encode("defgh"), 2, 3);
		fs.closeSync(fd);
		expect(fs.readFileSync("/opfs/fd/log.txt", "utf8")).toBe("abcfgh");
		const r = fs.openSync("/opfs/fd/log.txt", "r");
		const buf = new Uint8Array(4);
		expect(fs.readSync(r, buf, 0, 4, null)).toBe(4);
		expect(text(buf)).toBe("abcf");
		expect(fs.readSync(r, buf, 0, 4, null)).toBe(2); // sequential
		expect(text(buf.subarray(0, 2))).toBe("gh");
		expect(fs.readSync(r, buf, 0, 4, null)).toBe(0);
		expect(fs.readSync(r, buf, 0, 3, 1)).toBe(3); // positional
		expect(text(buf.subarray(0, 3))).toBe("bcf");
		fs.closeSync(r);
		expect(() => fs.openSync("/opfs/fd/none", "r")).toThrow(/ENOENT/);
		const w = fs.openSync("/opfs/fd/new.tmp", "wx");
		fs.writeSync(w, "q");
		fs.closeSync(w);
		expect(() => fs.openSync("/opfs/fd/new.tmp", "wx")).toThrow(/EEXIST/);
		const w2 = fs.openSync("/opfs/fd/new.tmp", "w"); // truncates
		fs.closeSync(w2);
		expect(fs.statSync("/opfs/fd/new.tmp").size).toBe(0);
	});
	test("truncateSync and createWriteStream and createReadStream", async () => {
		fs.writeFileSync("/opfs/t/f", "0123456789");
		fs.truncateSync("/opfs/t/f", 4);
		expect(fs.readFileSync("/opfs/t/f", "utf8")).toBe("0123");
		fs.truncateSync("/opfs/t/f", 6);
		expect([...(fs.readFileSync("/opfs/t/f") as Uint8Array)]).toEqual([48, 49, 50, 51, 0, 0]);
		fs.truncateSync("/opfs/t/f");
		expect(fs.statSync("/opfs/t/f").size).toBe(0);

		const ws = fs.createWriteStream("/opfs/t/stream.bin");
		const done = new Promise<void>((res, rej) => {
			ws.on("error", rej);
			ws.on("finish", () => res());
		});
		ws.write(new Uint8Array([1, 2, 3]));
		ws.write("ab");
		ws.end();
		await done;
		expect([...(fs.readFileSync("/opfs/t/stream.bin") as Uint8Array)]).toEqual([1, 2, 3, 97, 98]);

		const chunks: Uint8Array[] = [];
		await new Promise<void>((res, rej) =>
			fs
				.createReadStream("/opfs/t/stream.bin", { highWaterMark: 2 })
				.on("data", (c: any) => chunks.push(c))
				.on("error", rej)
				.on("end", () => res()),
		);
		expect(chunks.map((c) => c.length)).toEqual([2, 2, 1]);
		await expect(new Promise((res, rej) => fs.createReadStream("/opfs/t/none").on("error", rej).on("end", res))).rejects.toThrow(
			/ENOENT/,
		);
	});
	test("a 20 MB file: write, read, stat, and range reads at the start, middle and end", async () => {
		const n = 20 * 1024 * 1024;
		const big = bytes(n, 7);
		fs.writeFileSync("/opfs/big/20.bin", big);
		expect(fs.statSync("/opfs/big/20.bin").size).toBe(n);
		const h = await fsp.open("/opfs/big/20.bin", "r");
		const check = async (pos: number, len: number) => {
			const buf = new Uint8Array(len);
			const r = await h.read(buf, 0, len, pos);
			expect(r.bytesRead).toBe(Math.min(len, n - pos));
			expect([...buf.subarray(0, r.bytesRead)]).toEqual([...big.subarray(pos, pos + len)]);
		};
		await check(0, 1000);
		await check(n >> 1, 1024 * 1024);
		await check(n - 500, 500);
		await check(n - 100, 1000); // short at the end
		const none = new Uint8Array(10);
		expect((await h.read(none, 0, 10, n + 5)).bytesRead).toBe(0);
		expect((await h.stat()).size).toBe(n);
		await h.close();
		const all = fs.readFileSync("/opfs/big/20.bin") as Uint8Array;
		expect(all.length).toBe(n);
		expect(all[n - 1]).toBe(big[n - 1]);
		expect(all[n >> 1]).toBe(big[n >> 1]);
	});
	test("promises.*", async () => {
		await fsp.mkdir("/opfs/p/q", { recursive: true });
		await fsp.writeFile("/opfs/p/q/a.txt", "hi");
		await fsp.appendFile("/opfs/p/q/a.txt", "!");
		expect(await fsp.readFile("/opfs/p/q/a.txt", "utf8")).toBe("hi!");
		expect((await fsp.stat("/opfs/p/q/a.txt")).size).toBe(3);
		await expect(fsp.stat("/opfs/p/q/none")).rejects.toThrow(/ENOENT/);
		expect(await fsp.stat("/opfs/p/q/none", { throwIfNoEntry: false })).toBeUndefined();
		await fsp.copyFile("/opfs/p/q/a.txt", "/opfs/p/b.txt");
		await fsp.rename("/opfs/p/b.txt", "/opfs/p/c.txt");
		expect(await fsp.readdir("/opfs/p")).toEqual(["c.txt", "q"]);
		expect((await fsp.readdir("/opfs/p", { withFileTypes: true })).map((e: any) => e.isDirectory())).toEqual([false, true]);
		await fsp.access("/opfs/p/c.txt");
		await expect(fsp.access("/opfs/p/none")).rejects.toThrow();
		await fsp.truncate("/opfs/p/c.txt", 1);
		expect(await fsp.readFile("/opfs/p/c.txt", "utf8")).toBe("h");
		const w = await fsp.open("/opfs/p/w.txt", "w");
		await w.write("abc");
		await w.write("def");
		await w.close();
		expect(await fsp.readFile("/opfs/p/w.txt", "utf8")).toBe("abcdef");
		await fsp.rm("/opfs/p", { recursive: true, force: true });
		expect(fs.existsSync("/opfs/p")).toBe(false);
		await expect(fsp.open("/opfs/p/none", "r")).rejects.toThrow(/ENOENT/);
	});
	test("callback style reaches the durable store", async () => {
		await new Promise<void>((res, rej) => fs.writeFile("/opfs/cb/a", "v", (e: unknown) => (e ? rej(e) : res())));
		const v = await new Promise((res, rej) => fs.readFile("/opfs/cb/a", "utf8", (e: unknown, d: unknown) => (e ? rej(e) : res(d))));
		expect(v).toBe("v");
	});
	test("a move between memory and durable paths", () => {
		fs.writeFileSync("/tmp/zz/mem.txt", "M");
		fs.renameSync("/tmp/zz/mem.txt", "/opfs/moved/mem.txt");
		expect(fs.existsSync("/tmp/zz/mem.txt")).toBe(false);
		expect(fs.readFileSync("/opfs/moved/mem.txt", "utf8")).toBe("M");
		fs.copyFileSync("/opfs/moved/mem.txt", "/tmp/zz/back.txt");
		expect(fs.readFileSync("/tmp/zz/back.txt", "utf8")).toBe("M");
		fs.rmSync("/tmp/zz", { recursive: true });
	});
});

describe("persistence", () => {
	test("files, directories and mtimes survive closing and reopening the database", () => {
		const file = join(scratch, "files.sqlite");
		fresh(file);
		fs.writeFileSync("/opfs/zinc/storage/K/a.pdf", bytes(5000, 3));
		fs.appendFileSync("/opfs/zinc/storage/K/a.pdf", "end");
		fs.mkdirSync("/opfs/zinc/storage/EMPTY", { recursive: true });
		const mtime = fs.statSync("/opfs/zinc/storage/K/a.pdf").mtimeMs;
		db.close();
		fresh(file);
		const back = fs.readFileSync("/opfs/zinc/storage/K/a.pdf") as Uint8Array;
		expect(back.length).toBe(5003);
		expect([...back.subarray(0, 5000)]).toEqual([...bytes(5000, 3)]);
		expect(fs.statSync("/opfs/zinc/storage/K/a.pdf").mtimeMs).toBe(mtime);
		expect(fs.readdirSync("/opfs/zinc/storage")).toEqual(["EMPTY", "K"]);
		db.close();
	});
	test("the tables are the contract's schema, and creating them twice is harmless", () => {
		createBlobBackend(db as unknown as BlobDb);
		const cols = (t: string) => (db.query(`PRAGMA table_info(${t})`).all() as any[]).map((c) => `${c.name}:${c.type}`);
		expect(cols("files")).toEqual(["path:TEXT", "data:BLOB", "mtime:INTEGER", "name:TEXT"]);
		expect(cols("dirs")).toEqual(["path:TEXT", "name:TEXT"]);
	});
	test("a database made by the schema without `name` is migrated and keeps working", () => {
		const file = join(scratch, "old.sqlite");
		const old = new Database(file);
		old.exec(
			"CREATE TABLE files (path TEXT PRIMARY KEY, data BLOB NOT NULL, mtime INTEGER NOT NULL); CREATE TABLE dirs (path TEXT PRIMARY KEY);",
		);
		old.query("INSERT INTO files(path, data, mtime) VALUES (?, ?, ?)").run(
			"/opfs/zinc/storage/abcd1234/old paper.pdf",
			new TextEncoder().encode("OLD"),
			42,
		);
		old.query("INSERT INTO dirs(path) VALUES (?)").run("/opfs/zinc/storage");
		old.query("INSERT INTO dirs(path) VALUES (?)").run("/opfs/zinc/storage/abcd1234");
		old.query("INSERT INTO dirs(path) VALUES (?)").run("/opfs/zinc");
		old.query("INSERT INTO dirs(path) VALUES (?)").run("/opfs");
		old.close();
		fresh(file);
		// old rows: lower-case names (all that was kept), still readable by any case
		expect(fs.readdirSync("/opfs/zinc/storage/ABCD1234")).toEqual(["old paper.pdf"]);
		expect(fs.readFileSync("/opfs/zinc/storage/ABCD1234/Old Paper.PDF", "utf8")).toBe("OLD");
		expect(fs.statSync("/opfs/zinc/storage/abcd1234/old paper.pdf").mtimeMs).toBe(42);
		// new rows next to them keep their case
		fs.writeFileSync("/opfs/zinc/storage/WXYZ5678/New Paper.PDF", "NEW");
		expect(fs.readdirSync("/opfs/zinc/storage")).toEqual(["WXYZ5678", "abcd1234"]);
		expect(fs.readdirSync("/opfs/zinc/storage/wxyz5678")).toEqual(["New Paper.PDF"]);
		// opening it again does not touch the migrated column
		db.close();
		fresh(file);
		expect(fs.readdirSync("/opfs/zinc/storage/WXYZ5678")).toEqual(["New Paper.PDF"]);
		db.close();
	});
});

describe("memory paths", () => {
	test("paths outside the prefix stay in memory and never reach the database", () => {
		fs.writeFileSync("/settings/app.json", "{}");
		fs.mkdirSync("/other/dir", { recursive: true });
		fs.appendFileSync("/other/dir/log", "a");
		expect(fs.readFileSync("/settings/app.json", "utf8")).toBe("{}");
		expect(fs.readdirSync("/other/dir")).toEqual(["log"]);
		expect(fs.statSync("/other/dir/log").size).toBe(1);
		expect(db.query("SELECT count(*) AS n FROM files").get()).toEqual({ n: 0 });
		expect(db.query("SELECT count(*) AS n FROM dirs").get()).toEqual({ n: 0 });
		// "/opfsx" is not under "/opfs/"
		fs.writeFileSync("/opfsx/f", "m");
		expect(db.query("SELECT count(*) AS n FROM files").get()).toEqual({ n: 0 });
	});
	test("seeded files are found by full path and by name, as before", () => {
		fs.seedFile("/assets/fonts/Inter.ttf", new Uint8Array([1, 2, 3]), true);
		fs.seedFile("/styles/apa.csl", "<style/>");
		expect(fs.existsSync("/assets/fonts/inter.ttf")).toBe(true);
		expect((fs.readFileSync("/anywhere/Inter.ttf") as Uint8Array).length).toBe(3);
		expect(fs.readFileSync("/styles/apa.csl", "utf8")).toBe("<style/>");
		expect(() => fs.readFileSync("/anywhere/apa.csl")).toThrow(/ENOENT/); // not seeded by name
		expect(fs.readdirSync("/assets")).toEqual(["fonts"]);
		expect(fs.statSync("/styles/apa.csl").size).toBe(8);
		expect(fs.statSync("/styles").isDirectory()).toBe(true);
		const fd = fs.openSync("/assets/fonts/Inter.ttf", "r");
		const b = new Uint8Array(3);
		expect(fs.readSync(fd, b, 0, 3, 0)).toBe(3);
		fs.closeSync(fd);
		expect([...b]).toEqual([1, 2, 3]);
		fs.writeFileSync("/styles/own.csl", "x");
		fs.renameSync("/styles/own.csl", "/styles/own2.csl");
		expect(fs.readdirSync("/styles")).toEqual(["apa.csl", "own2.csl"]);
	});
	test("without a backend, everything is memory, and a custom prefix works", () => {
		fs.installDurableFs(null);
		fs.writeFileSync("/opfs/in-memory", "m");
		expect(fs.readFileSync("/opfs/in-memory", "utf8")).toBe("m");
		fs.installDurableFs(createBlobBackend(db as unknown as BlobDb), "/durable");
		fs.writeFileSync("/durable/a", "d");
		fs.writeFileSync("/opfs/other", "m2");
		expect(db.query("SELECT path FROM files").all()).toEqual([{ path: "/durable/a" }]);
		expect(fs.readFileSync("/opfs/in-memory", "utf8")).toBe("m");
	});
});

describe("timings", () => {
	test("20 MB and 50 MB writes, reads, a range read, and append", async () => {
		const file = join(scratch, "timings.sqlite");
		fresh(file);
		const ms = async (f: () => unknown) => {
			const t = performance.now();
			await f();
			return +(performance.now() - t).toFixed(1);
		};
		const rows: Record<string, number> = {};
		for (const mb of [20, 50]) {
			const data = bytes(mb * 1024 * 1024, mb);
			const p = `/opfs/perf/${mb}.bin`;
			rows[`write ${mb} MB`] = await ms(() => fs.writeFileSync(p, data));
			rows[`read ${mb} MB`] = await ms(() => fs.readFileSync(p));
			const h = await fsp.open(p, "r");
			const buf = new Uint8Array(256 * 1024);
			rows[`range read 256 KB at middle of ${mb} MB`] = await ms(() => h.read(buf, 0, buf.length, (mb * 1024 * 1024) >> 1));
			expect(buf[0]).toBe(data[(mb * 1024 * 1024) >> 1]!);
			await h.close();
			rows[`append 1 KB to ${mb} MB`] = await ms(() => fs.appendFileSync(p, bytes(1024)));
			rows[`copy ${mb} MB`] = await ms(() => fs.copyFileSync(p, `${p}.copy`));
			rows[`rename ${mb} MB`] = await ms(() => fs.renameSync(`${p}.copy`, `${p}.moved`));
			expect(fs.statSync(p).size).toBe(mb * 1024 * 1024 + 1024);
		}
		// many small appends to a growing file, versus rewriting it each time from JS
		const small = bytes(100);
		rows["1000 x 100 B appends (SQL concat)"] = await ms(() => {
			for (let i = 0; i < 1000; i++) fs.appendFileSync("/opfs/perf/small.log", small);
		});
		expect(fs.statSync("/opfs/perf/small.log").size).toBe(100_000);
		console.log("blobfs timings (ms):", JSON.stringify(rows, null, 1));
		db.close();
	}, 120_000);
});
