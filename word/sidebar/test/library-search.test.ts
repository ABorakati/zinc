// Tests the C# Word add-in library search (word/addin/Library.cs + Sqlite.cs) directly against real SQLite databases,
// covering both FTS5 search and the non-FTS5 LIKE fallback used when winsqlite3.dll lacks FTS5 (GitHub issue #3).
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rebuildSearchIndex } from "../../../core/src/search";
import { buildSearchArgs } from "../src/app";

const REPO = join(import.meta.dir, "..", "..", "..");
const ADDIN = join(REPO, "word", "addin");
const SCHEMA = join(REPO, "core", "schema.sql");

function findRoslynCsc(): { csc: string; net48: string } | null {
	if (process.platform !== "win32") return null;
	const net48 = join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319");
	if (!existsSync(join(net48, "mscorlib.dll"))) return null;
	const r = Bun.spawnSync(["dotnet", "--list-sdks"]);
	if (r.exitCode !== 0) return null;
	const lines = new TextDecoder().decode(r.stdout).trim().split(/\r?\n/).filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i--) {
		const m = /^(\S+)\s+\[(.+)\]$/.exec(lines[i]!.trim());
		if (!m) continue;
		const csc = join(m[2]!, m[1]!, "Roslyn", "bincore", "csc.dll");
		if (existsSync(csc)) return { csc, net48 };
	}
	return null;
}

const TOOLCHAIN = findRoslynCsc();
const d = TOOLCHAIN ? describe : describe.skip;

const DRIVER_CS = `
using System;
using System.Collections.Generic;
using ZoteroNext.Word;

internal static class Driver
{
    static object Exec(Dictionary<string, object> req)
    {
        var cmd = Json.Str(req, "cmd");
        if (cmd == "terms") return Library.ExtractSearchTerms(Json.Str(req, "match"));
        if (cmd == "fts5err") return Library.IsFts5Unavailable(new SqliteException(Json.Str(req, "msg")));
        if (cmd == "search")
        {
            using (var db = new SqliteReader(Json.Str(req, "db")))
                return Library.SearchWith(db, Json.Obj(Json.Get(req, "p")) ?? new Dictionary<string, object>(), Json.Bool(req, "allowFts5"));
        }
        if (cmd == "search-env")
        {
            Environment.SetEnvironmentVariable("ZN_DB", Json.Str(req, "db"));
            return Library.Search(Json.Obj(Json.Get(req, "p")) ?? new Dictionary<string, object>());
        }
        throw new ArgumentException("unknown cmd: " + cmd);
    }

    static int Main()
    {
        var input = Console.In.ReadToEnd();
        var batch = Json.Arr(Json.Parse(input));
        var results = new List<object>();
        foreach (var item in batch) results.Add(Exec(Json.Obj(item)));
        Console.WriteLine(Json.Dump(results));
        return 0;
    }
}
`;

function seedDb(path: string, withFts: boolean): void {
	const db = new Database(path, { create: true });
	try {
		db.exec(readFileSync(SCHEMA, "utf8"));
		const ins = db.query(
			`INSERT INTO items(key, item_type, parent_key, title, creators_summary, year, publication, data, date_added, date_modified, deleted)
			 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		const add = (row: {
			key: string;
			itemType: string;
			parentKey?: string | null;
			title: string;
			creatorsSummary: string;
			year: number | null;
			publication: string;
			data: Record<string, unknown>;
			dateAdded: string;
			deleted?: number;
			tags?: string[];
		}) => {
			ins.run(
				row.key,
				row.itemType,
				row.parentKey ?? null,
				row.title,
				row.creatorsSummary,
				row.year,
				row.publication,
				JSON.stringify(row.data),
				row.dateAdded,
				row.dateAdded,
				row.deleted ?? 0,
			);
			for (const tag of row.tags ?? []) db.query("INSERT INTO item_tags(item_key, tag) VALUES(?, ?)").run(row.key, tag);
		};

		add({
			key: "AAAA1111",
			itemType: "journalArticle",
			title: "Outcomes after liver transplantation in the United Kingdom",
			creatorsSummary: "Smith and Haddad",
			year: 2021,
			publication: "Transplantation",
			dateAdded: "2024-01-01T00:00:00Z",
			tags: ["hepatology", "registry"],
			data: {
				key: "AAAA1111",
				itemType: "journalArticle",
				title: "Outcomes after liver transplantation in the United Kingdom",
				creators: [
					{ creatorType: "author", firstName: "Jane", lastName: "Smith" },
					{ creatorType: "author", firstName: "Omar", lastName: "Haddad" },
				],
				publicationTitle: "Transplantation",
				date: "2021-03-04",
				DOI: "10.1000/tx.2021.001",
				abstractNote: "We analysed registry data for 12,000 recipients. Five-year graft survival was 82%.",
			},
		});
		add({
			key: "BBBB2222",
			itemType: "journalArticle",
			title: "Machine perfusion for donor liver preservation",
			creatorsSummary: "Chen et al.",
			year: 2019,
			publication: "Journal of Hepatology",
			dateAdded: "2024-01-02T00:00:00Z",
			data: {
				key: "BBBB2222",
				itemType: "journalArticle",
				title: "Machine perfusion for donor liver preservation",
				creators: [
					{ creatorType: "author", firstName: "Li", lastName: "Chen" },
					{ creatorType: "author", firstName: "Sarah", lastName: "Patel" },
					{ creatorType: "author", firstName: "Aditya", lastName: "Borakati" },
				],
				publicationTitle: "Journal of Hepatology",
				date: "2019",
				DOI: "10.1000/jh.2019.044",
				abstractNote: "Systematic review comparing Smith criteria across 34 trials.",
			},
		});
		add({
			key: "CCCC3333",
			itemType: "journalArticle",
			title: "First-line therapy in acute rejection",
			creatorsSummary: "Al-Mansoor and O'Brien",
			year: 2022,
			publication: "Lancet",
			dateAdded: "2024-01-03T00:00:00Z",
			data: {
				key: "CCCC3333",
				itemType: "journalArticle",
				title: "First-line therapy in acute rejection",
				creators: [
					{ creatorType: "author", firstName: "Nadia", lastName: "Al-Mansoor" },
					{ creatorType: "author", firstName: "Seamus", lastName: "O'Brien" },
				],
				publicationTitle: "Lancet",
				date: "2022",
			},
		});
		add({
			key: "DDDD4444",
			itemType: "report",
			title: "Global transplant guidelines",
			creatorsSummary: "WHO",
			year: 2020,
			publication: "",
			dateAdded: "2024-01-04T00:00:00Z",
			data: {
				key: "DDDD4444",
				itemType: "report",
				title: "Global transplant guidelines",
				creators: [{ creatorType: "author", name: "WHO" }],
				date: "2020",
			},
		});
		add({
			key: "EEEE5555",
			itemType: "journalArticle",
			title: "Deleted Smith paper",
			creatorsSummary: "Smith",
			year: 2021,
			publication: "Transplantation",
			dateAdded: "2024-01-05T00:00:00Z",
			deleted: 1,
			data: {
				key: "EEEE5555",
				itemType: "journalArticle",
				title: "Deleted Smith paper",
				creators: [{ creatorType: "author", firstName: "Jane", lastName: "Smith" }],
				date: "2021",
			},
		});
		add({
			key: "FFFF6666",
			itemType: "attachment",
			parentKey: "AAAA1111",
			title: "Smith PDF attachment",
			creatorsSummary: "",
			year: null,
			publication: "",
			dateAdded: "2024-01-06T00:00:00Z",
			data: { key: "FFFF6666", itemType: "attachment", title: "Smith PDF attachment" },
		});
		add({
			key: "GGGG7777",
			itemType: "journalArticle",
			title: "100% survival_rate audit",
			creatorsSummary: "Lee",
			year: 2023,
			publication: "Annals",
			dateAdded: "2024-01-07T00:00:00Z",
			data: {
				key: "GGGG7777",
				itemType: "journalArticle",
				title: "100% survival_rate audit",
				creators: [{ creatorType: "author", firstName: "Min", lastName: "Lee" }],
				date: "2023",
			},
		});

		if (withFts) {
			rebuildSearchIndex(db);
		} else {
			db.exec("DROP TABLE search");
		}
	} finally {
		db.close();
	}
}

d("Word add-in Library.Search (C# + winsqlite3.dll)", () => {
	let tmp = "";
	let exe = "";
	let dbWithFts = "";
	let dbWithoutFts = "";

	function runBatch(requests: Record<string, unknown>[]): any[] {
		const r = Bun.spawnSync([exe], { stdin: new TextEncoder().encode(JSON.stringify(requests)) });
		if (r.exitCode !== 0) {
			throw new Error(`driver failed (${r.exitCode}): ${new TextDecoder().decode(r.stderr)}\n${new TextDecoder().decode(r.stdout)}`);
		}
		return JSON.parse(new TextDecoder().decode(r.stdout).trim()) as any[];
	}

	beforeAll(() => {
		tmp = mkdtempSync(join(tmpdir(), "zn-word-lib-"));
		const driverPath = join(tmp, "Driver.cs");
		writeFileSync(driverPath, DRIVER_CS, "utf8");
		exe = join(tmp, "Driver.exe");
		const { csc, net48 } = TOOLCHAIN!;
		const r = Bun.spawnSync([
			"dotnet",
			"exec",
			csc,
			"/nologo",
			"/nostdlib",
			"/target:exe",
			"/langversion:latest",
			`/out:${exe}`,
			`/r:${join(net48, "mscorlib.dll")}`,
			`/r:${join(net48, "System.dll")}`,
			`/r:${join(net48, "System.Core.dll")}`,
			`/r:${join(net48, "System.Web.Extensions.dll")}`,
			join(ADDIN, "Library.cs"),
			join(ADDIN, "Sqlite.cs"),
			join(ADDIN, "Json.cs"),
			join(ADDIN, "Settings.cs"),
			join(ADDIN, "Log.cs"),
			driverPath,
		]);
		if (r.exitCode !== 0) {
			throw new Error(`Roslyn compile failed:\n${new TextDecoder().decode(r.stdout)}\n${new TextDecoder().decode(r.stderr)}`);
		}
		dbWithFts = join(tmp, "with-fts.sqlite");
		dbWithoutFts = join(tmp, "without-fts.sqlite");
		seedDb(dbWithFts, true);
		seedDb(dbWithoutFts, false);
	}, 30_000);

	afterAll(() => {
		if (tmp) rmSync(tmp, { recursive: true, force: true });
	});

	test("ExtractSearchTerms parses FTS5 expressions, phrases, hyphenated/apostrophe tokens, and raw strings", () => {
		const res = runBatch([
			{ cmd: "terms", match: '{title creators abstract publication tags} : ("liver" "trans"*)' },
			{ cmd: "terms", match: '{title creators abstract publication tags} : ("O Brien"*)' },
			{ cmd: "terms", match: '{title creators abstract publication tags} : ("Al Mansoor"*)' },
			{ cmd: "terms", match: '{title creators abstract publication tags} : ("graft survival")' },
			{ cmd: "terms", match: '{title creators abstract publication tags} : ("Smith" "smith"*)' },
			{ cmd: "terms", match: "smith liver*" },
			{ cmd: "terms", match: "{title} : ()" },
		]);
		expect(res).toEqual([
			["liver", "trans"],
			["O", "Brien"],
			["Al", "Mansoor"],
			["graft", "survival"],
			["Smith"],
			["smith", "liver"],
			[],
		]);
	});

	test("IsFts5Unavailable recognizes FTS5/search-table errors without swallowing unrelated SQLite errors", () => {
		const res = runBatch([
			{
				cmd: "fts5err",
				msg: "no such module: fts5 in: SELECT i.key, i.title, i.creators_summary, i.year, i.publication, i.item_type, json_extract(i.data,'$.DOI') FROM search s JOIN items i ON i.rowid = s.rowid WHERE search MATCH ? AND i.deleted = 0 ORDER BY bm25(search, 10.0, 5.0, 3.0, 2.0, 2.0, 1.0, 1.0) LIMIT ?",
			},
			{ cmd: "fts5err", msg: "no such table: search in: SELECT ..." },
			{ cmd: "fts5err", msg: "no such tokenizer: porter in: SELECT ..." },
			{ cmd: "fts5err", msg: "no such function: bm25 in: SELECT ..." },
			{ cmd: "fts5err", msg: "database disk image is malformed" },
			{ cmd: "fts5err", msg: "no such column: bogus" },
		]);
		expect(res).toEqual([true, true, true, true, false, false]);
	});

	test("non-FTS5 fallback searches by author (first, co-author behind et al., institutional, hyphenated, apostrophe), title, year, publication, abstract, and tags", () => {
		const queries: Record<string, unknown>[] = [
			buildSearchArgs("Smith"),
			buildSearchArgs("Jane Smith"),
			buildSearchArgs("Borakati"),
			buildSearchArgs("WHO"),
			buildSearchArgs("Al-Mansoor"),
			buildSearchArgs("O'Brien"),
			buildSearchArgs("liver trans"),
			buildSearchArgs("liver"),
			buildSearchArgs("Smith 2021"),
			buildSearchArgs("Smith 2019"),
			buildSearchArgs("Smith 2022"),
			buildSearchArgs("Journal of Hepatology"),
			buildSearchArgs('"graft survival"'),
			buildSearchArgs("registry"),
			buildSearchArgs("first"),
			buildSearchArgs("last"),
			buildSearchArgs("10.1000/tx.2021.001"),
			buildSearchArgs("2022"),
			buildSearchArgs(""),
			{ match: '"100%"', limit: 30 },
			{ match: '"survival_rate"', limit: 30 },
		];
		const all = runBatch(queries.map((p) => ({ cmd: "search", db: dbWithFts, allowFts5: false, p }))) as { key: string }[][];
		const keys = (i: number) => all[i]!.map((r) => r.key);

		// First author ranks ahead of abstract-only mention; deleted item and attachment are excluded
		expect(keys(0)).toEqual(["AAAA1111", "BBBB2222"]);
		expect(keys(1)).toEqual(["AAAA1111"]);
		// 3rd author hidden behind "Chen et al." in creators_summary
		expect(keys(2)).toEqual(["BBBB2222"]);
		// Institutional single-field creator name
		expect(keys(3)).toEqual(["DDDD4444"]);
		// Hyphenated and apostrophe author names
		expect(keys(4)).toEqual(["CCCC3333"]);
		expect(keys(5)).toEqual(["CCCC3333"]);
		// Title prefix & multi-word
		expect(keys(6)).toEqual(["AAAA1111"]);
		expect(keys(7)).toEqual(["AAAA1111", "BBBB2222"]);
		// Author + year filter
		expect(keys(8)).toEqual(["AAAA1111"]);
		expect(keys(9)).toEqual(["BBBB2222"]);
		expect(keys(10)).toEqual([]);
		// Publication, abstract phrase, tags
		expect(keys(11)).toEqual(["BBBB2222"]);
		expect(keys(12)).toEqual(["AAAA1111"]);
		expect(keys(13)).toEqual(["AAAA1111"]);
		// JSON key names ("firstName", "lastName", "creatorType") must not produce false matches
		expect(keys(14)).toEqual(["CCCC3333"]);
		expect(keys(15)).toEqual([]);
		// DOI, year-only, and empty queries still work
		expect(keys(16)).toEqual(["AAAA1111"]);
		expect(keys(17)).toEqual(["CCCC3333"]);
		expect(keys(18).length).toBe(5);
		// LIKE wildcards (% and _) are escaped literally
		expect(keys(19)).toEqual(["GGGG7777"]);
		expect(keys(20)).toEqual(["GGGG7777"]);
	});

	test("Library.Search automatically falls back when FTS5 search table is unavailable", () => {
		const res = runBatch([
			{ cmd: "search-env", db: dbWithoutFts, p: buildSearchArgs("Borakati") },
			{ cmd: "search-env", db: dbWithoutFts, p: buildSearchArgs("liver transplantation") },
		]) as { key: string }[][];
		expect(res[0]!.map((r) => r.key)).toEqual(["BBBB2222"]);
		expect(res[1]!.map((r) => r.key)).toEqual(["AAAA1111"]);
	});

	test("Library.Search works with FTS5 enabled on a standard library database", () => {
		const res = runBatch([
			{ cmd: "search", db: dbWithFts, allowFts5: true, p: buildSearchArgs("Borakati") },
			{ cmd: "search", db: dbWithFts, allowFts5: true, p: buildSearchArgs("Smith") },
			{ cmd: "search", db: dbWithFts, allowFts5: true, p: buildSearchArgs("liver 2021") },
		]) as { key: string }[][];
		expect(res[0]!.map((r) => r.key)).toEqual(["BBBB2222"]);
		expect(res[1]![0]?.key).toBe("AAAA1111");
		expect(res[2]!.map((r) => r.key)).toEqual(["AAAA1111"]);
	});
});
