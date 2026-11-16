import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDb } from "../../src/db";
import { call, insertAttachment, insertItem, tempDir } from "../fixture";

let dir: string;
let db: Database;

beforeEach(() => {
	dir = tempDir();
	db = openDb(join(dir, "dup.sqlite"));
});

afterEach(() => {
	db.close(true);
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {}
});

const j = async (r: Response) => (await r.json()) as any;

describe("duplicate detection", () => {
	test("matches identical DOI (normalised) with similar titles across journalArticle, preprint and conferencePaper, but not book", async () => {
		insertItem(db, {
			key: "ITEM0001",
			itemType: "journalArticle",
			title: "Highly accurate protein structure prediction with AlphaFold",
			DOI: "10.1038/s41586-021-03819-2",
			dateAdded: "2024-01-01T00:00:00Z",
		});
		insertItem(db, {
			key: "ITEM0002",
			itemType: "preprint",
			title: "Highly accurate protein structure prediction with AlphaFold: preprint",
			DOI: "https://doi.org/10.1038/S41586-021-03819-2",
			dateAdded: "2024-02-01T00:00:00Z",
		});
		insertItem(db, {
			key: "ITEM0003",
			itemType: "conferencePaper",
			title: "Highly Accurate Protein Structure Prediction with AlphaFold",
			extra: "PMID: 12345\nDOI: doi:10.1038/s41586-021-03819-2",
			dateAdded: "2024-03-01T00:00:00Z",
		});
		// A book with the same DOI and title must NOT match journalArticle/preprint/conferencePaper
		insertItem(db, {
			key: "BOOK0001",
			itemType: "book",
			title: "Highly accurate protein structure prediction with AlphaFold",
			DOI: "10.1038/s41586-021-03819-2",
			dateAdded: "2024-04-01T00:00:00Z",
		});

		const res = await j(await call(db, "GET", "/api/duplicates"));
		expect(res.total).toBe(1);
		expect(res.sets).toEqual([
			{
				keys: ["ITEM0001", "ITEM0002", "ITEM0003"],
				reason: "doi",
			},
		]);
	});

	test("supplement DOI shared by different conference abstracts produces no duplicate set, while true duplicates within a shared DOI are clustered", async () => {
		const supplementDoi = "10.1097/01.tp.0000580472.17422.db";
		const distinctTitles = [
			"Poor long-term outcome in liver transplant recipients with steatosis",
			"Temporal improvements in graft survival following pediatric transplantation",
			"TOAD: Transplant Outcomes in Anesthesia Database registry analysis",
			"Novel biomarkers of acute cellular rejection in renal allografts",
			"Machine perfusion reduces ischemic cholangiopathy in DCD livers",
			"Donor age and cold ischemia time interaction in kidney allocation",
			"Cytomegalovirus prophylaxis strategies in high-risk thoracic recipients",
		];
		distinctTitles.forEach((title, idx) => {
			insertItem(db, {
				key: `SUPP000${idx + 1}`,
				itemType: "journalArticle",
				title,
				DOI: supplementDoi,
				dateAdded: `2024-01-0${idx + 1}T00:00:00Z`,
			});
		});

		const res = await j(await call(db, "GET", "/api/duplicates"));
		expect(res.total).toBe(0);
		expect(res.sets).toEqual([]);
	});

	test("matches true DOI duplicate with subtitle, punctuation or case differences, and truncated titles", async () => {
		// Subtitle / punctuation / case difference on same DOI
		insertItem(db, {
			key: "SUBT0001",
			itemType: "journalArticle",
			title: "Normothermic machine perfusion in liver transplantation",
			DOI: "10.1038/nature26123",
			dateAdded: "2024-01-01T00:00:00Z",
		});
		insertItem(db, {
			key: "SUBT0002",
			itemType: "journalArticle",
			title: "Normothermic Machine Perfusion in Liver Transplantation: A Randomized Trial!",
			DOI: "10.1038/nature26123",
			dateAdded: "2024-02-01T00:00:00Z",
		});

		// Truncated title on same DOI
		insertItem(db, {
			key: "TRUN0001",
			itemType: "journalArticle",
			title: "Poor long-term outcome in liver transplant recipients with severe macrovesicular steatosis",
			DOI: "10.1111/ajt.99999",
			dateAdded: "2024-03-01T00:00:00Z",
		});
		insertItem(db, {
			key: "TRUN0002",
			itemType: "journalArticle",
			title: "Poor long-term outcome in liver transplant recipie…",
			DOI: "10.1111/ajt.99999",
			dateAdded: "2024-04-01T00:00:00Z",
		});

		const res = await j(await call(db, "GET", "/api/duplicates"));
		expect(res.total).toBe(2);
		expect(res.sets).toEqual([
			{ keys: ["SUBT0001", "SUBT0002"], reason: "doi" },
			{ keys: ["TRUN0001", "TRUN0002"], reason: "doi" },
		]);
	});

	test("matches identical ISBN (including ISBN-10 vs ISBN-13 and hyphenation) with similar titles only within the same itemType", async () => {
		insertItem(db, {
			key: "BOOKAAA1",
			itemType: "book",
			title: "Principles of Surgical Oncology",
			ISBN: "0-306-40615-2",
			dateAdded: "2024-01-01T00:00:00Z",
		});
		insertItem(db, {
			key: "BOOKAAA2",
			itemType: "book",
			title: "Principles of Surgical Oncology: Second Edition",
			ISBN: "978-0-306-40615-7",
			dateAdded: "2024-02-01T00:00:00Z",
		});
		// bookSection with the same ISBN must not match book
		insertItem(db, {
			key: "CHAPAAA1",
			itemType: "bookSection",
			title: "Principles of Surgical Oncology",
			ISBN: "9780306406157",
			dateAdded: "2024-03-01T00:00:00Z",
		});

		const res = await j(await call(db, "GET", "/api/duplicates"));
		expect(res.total).toBe(1);
		expect(res.sets).toEqual([
			{
				keys: ["BOOKAAA1", "BOOKAAA2"],
				reason: "isbn",
			},
		]);
	});

	test("matches normalised title variants (case, punctuation, diacritics, HTML) with matching author and years within 1 or missing", async () => {
		insertItem(db, {
			key: "TITL0001",
			itemType: "journalArticle",
			title: "<i>Étude</i> sur l'apprentissage profond: une revue!",
			creators: [
				{ creatorType: "author", firstName: "Jean", lastName: "Dupont" },
				{ creatorType: "author", firstName: "Marie", lastName: "Curie" },
			],
			date: "2021-12-15",
			dateAdded: "2024-01-01T00:00:00Z",
		});
		insertItem(db, {
			key: "TITL0002",
			itemType: "journalArticle",
			title: "Etude sur l’apprentissage profond — une revue",
			creators: [{ creatorType: "author", firstName: "J.", lastName: "Dupont" }],
			date: "2022-01-05", // within 1 year (2021 vs 2022)
			dateAdded: "2024-02-01T00:00:00Z",
		});
		insertItem(db, {
			key: "TITL0003",
			itemType: "journalArticle",
			title: "ETUDE SUR L'APPRENTISSAGE PROFOND: UNE REVUE",
			creators: [{ creatorType: "author", firstName: "Jean", lastName: "Dupont" }],
			// missing year -> still matches
			dateAdded: "2024-03-01T00:00:00Z",
		});

		// Both creatorless with same normalised title and compatible years also match
		insertItem(db, {
			key: "ANON0001",
			itemType: "webpage",
			title: "WHO Guidelines &amp; Recommendations",
			date: "2020",
			dateAdded: "2024-01-01T00:00:00Z",
		});
		insertItem(db, {
			key: "ANON0002",
			itemType: "webpage",
			title: "who guidelines recommendations",
			date: "2020",
			dateAdded: "2024-02-01T00:00:00Z",
		});

		const res = await j(await call(db, "GET", "/api/duplicates"));
		expect(res.total).toBe(2);
		expect(res.sets).toEqual([
			{ keys: ["TITL0001", "TITL0002", "TITL0003"], reason: "title" },
			{ keys: ["ANON0001", "ANON0002"], reason: "title" },
		]);
	});

	test("does not match title candidates with different years (> 1 apart), different authors, different item types, or trashed items", async () => {
		insertItem(db, {
			key: "BASE0001",
			itemType: "journalArticle",
			title: "Clinical Outcomes in Liver Transplantation",
			creators: [{ creatorType: "author", firstName: "Alice", lastName: "Smith" }],
			date: "2020",
			dateAdded: "2024-01-01T00:00:00Z",
		});
		// Different year (2020 vs 2023 -> diff 3 > 1)
		insertItem(db, {
			key: "DIFFYEAR",
			itemType: "journalArticle",
			title: "Clinical Outcomes in Liver Transplantation",
			creators: [{ creatorType: "author", firstName: "Alice", lastName: "Smith" }],
			date: "2023",
			dateAdded: "2024-02-01T00:00:00Z",
		});
		// Different first-author last name
		insertItem(db, {
			key: "DIFFAUTH",
			itemType: "journalArticle",
			title: "Clinical Outcomes in Liver Transplantation",
			creators: [{ creatorType: "author", firstName: "Alice", lastName: "Jones" }],
			date: "2020",
			dateAdded: "2024-03-01T00:00:00Z",
		});
		// Creatorless vs having creator
		insertItem(db, {
			key: "NOAUTHOR",
			itemType: "journalArticle",
			title: "Clinical Outcomes in Liver Transplantation",
			date: "2020",
			dateAdded: "2024-04-01T00:00:00Z",
		});
		// Different itemType (preprint without shared DOI)
		insertItem(db, {
			key: "DIFFTYPE",
			itemType: "preprint",
			title: "Clinical Outcomes in Liver Transplantation",
			creators: [{ creatorType: "author", firstName: "Alice", lastName: "Smith" }],
			date: "2020",
			dateAdded: "2024-05-01T00:00:00Z",
		});
		// Trashed exact duplicate
		insertItem(
			db,
			{
				key: "TRASHED1",
				itemType: "journalArticle",
				title: "Clinical Outcomes in Liver Transplantation",
				creators: [{ creatorType: "author", firstName: "Alice", lastName: "Smith" }],
				date: "2020",
				DOI: "10.1000/trashed",
				dateAdded: "2024-06-01T00:00:00Z",
			},
			undefined,
			1,
		);

		const res = await j(await call(db, "GET", "/api/duplicates"));
		expect(res.total).toBe(0);
		expect(res.sets).toEqual([]);
	});

	test("not-duplicates exclusion remembers pairs and prevents grouping", async () => {
		insertItem(db, {
			key: "EXCL0001",
			itemType: "journalArticle",
			title: "Duplicate Paper",
			DOI: "10.1000/dup1",
			dateAdded: "2024-01-01T00:00:00Z",
		});
		insertItem(db, {
			key: "EXCL0002",
			itemType: "journalArticle",
			title: "Duplicate Paper",
			DOI: "10.1000/dup1",
			dateAdded: "2024-02-01T00:00:00Z",
		});

		expect((await j(await call(db, "GET", "/api/duplicates"))).total).toBe(1);

		const markRes = await call(db, "POST", "/api/duplicates/not-duplicates", {
			keys: ["EXCL0001", "EXCL0002"],
		});
		expect(markRes.status).toBe(200);
		expect(await j(markRes)).toEqual({ ok: true });

		const after = await j(await call(db, "GET", "/api/duplicates"));
		expect(after.total).toBe(0);
		expect(after.sets).toEqual([]);
	});
});

describe("duplicate set details and merge", () => {
	test("GET /api/duplicates/set returns side-by-side details, defaultMasterKey and differingFields", async () => {
		insertItem(db, {
			key: "NEWER001",
			itemType: "journalArticle",
			title: "Machine Learning in Surgery",
			DOI: "10.1000/mlsurg",
			abstractNote: "Full abstract here.",
			dateAdded: "2024-05-01T00:00:00Z",
		});
		insertItem(db, {
			key: "OLDER001",
			itemType: "journalArticle",
			title: "Machine learning in surgery",
			DOI: "10.1000/mlsurg",
			volume: "12",
			dateAdded: "2024-01-01T00:00:00Z",
		});

		const res = await call(db, "GET", "/api/duplicates/set?keys=NEWER001,OLDER001");
		expect(res.status).toBe(200);
		const body = await j(res);
		expect(body.defaultMasterKey).toBe("OLDER001");
		expect(body.items.map((i: any) => i.data.key)).toEqual(["OLDER001", "NEWER001"]);
		expect(body.differingFields).toContain("title");
		expect(body.differingFields).toContain("abstractNote");
		expect(body.differingFields).toContain("volume");
	});

	test("POST /api/duplicates/merge merges fields, tags, collections, related, moves children, adds dc:replaces, trashes others, and writes sync_outbox", async () => {
		db.query("INSERT INTO collections(key, name) VALUES('COLL0001', 'Surgery')").run();
		db.query("INSERT INTO collections(key, name) VALUES('COLL0002', 'AI')").run();

		insertItem(db, {
			key: "RELITEM1",
			itemType: "book",
			title: "Related Book",
			dateAdded: "2023-01-01T00:00:00Z",
		});

		// Master item (older)
		insertItem(db, {
			key: "MAST0001",
			itemType: "journalArticle",
			title: "Short title",
			creators: [{ creatorType: "author", firstName: "A.", lastName: "Borakati" }],
			date: "2024",
			DOI: "10.1000/merge-test",
			volume: "10",
			tags: [{ tag: "surgery" }],
			collections: ["COLL0001"],
			dateAdded: "2024-01-01T00:00:00Z",
		});
		db.query("INSERT INTO collection_items(collection_key, item_key) VALUES('COLL0001', 'MAST0001')").run();
		insertAttachment(db, "ATTM0001", "MAST0001", "application/pdf", null, "2024-01-02T00:00:00Z");

		// Duplicate 2 (has better title, abstract, tag, collection, child note & attachment, and a related item)
		insertItem(db, {
			key: "DUPL0002",
			itemType: "journalArticle",
			title: "Comprehensive Title for Machine Learning in Surgery",
			creators: [{ creatorType: "author", firstName: "Aditya", lastName: "Borakati" }],
			date: "2024-03-15",
			DOI: "10.1000/merge-test",
			abstractNote: "Detailed abstract from second duplicate.",
			pages: "100-112",
			tags: [{ tag: "ml" }, { tag: "surgery" }],
			collections: ["COLL0002"],
			dateAdded: "2024-02-01T00:00:00Z",
		});
		db.query("INSERT INTO collection_items(collection_key, item_key) VALUES('COLL0002', 'DUPL0002')").run();
		insertItem(db, { key: "NOTEDUP2", itemType: "note", note: "<p>Important clinical note</p>", parentItem: "DUPL0002" }, "DUPL0002");
		insertAttachment(db, "ATTDUP02", "DUPL0002", "text/html", null, "2024-02-02T00:00:00Z");

		// Link DUPL0002 to RELITEM1
		await call(db, "POST", "/api/items/DUPL0002/related", { keys: ["RELITEM1"] });

		// Duplicate 3
		insertItem(db, {
			key: "DUPL0003",
			itemType: "preprint",
			title: "Preprint Title",
			creators: [{ creatorType: "author", firstName: "Aditya", lastName: "Borakati" }],
			DOI: "10.1000/merge-test",
			tags: [{ tag: "preprint-tag" }],
			dateAdded: "2024-03-01T00:00:00Z",
		});

		// Clear sync_outbox before merge to verify exact sync rows emitted by merge
		db.query("DELETE FROM sync_outbox").run();

		const mergeRes = await call(db, "POST", "/api/duplicates/merge", {
			masterKey: "MAST0001",
			otherKeys: ["DUPL0002", "DUPL0003"],
			fieldChoices: {
				title: "DUPL0002",
				creators: "DUPL0002",
				date: "DUPL0002",
			},
		});
		expect(mergeRes.status).toBe(200);
		const merged = await j(mergeRes);

		// 1. Master kept, chosen fields applied, empty master fields filled from others
		expect(merged.data.key).toBe("MAST0001");
		expect(merged.data.title).toBe("Comprehensive Title for Machine Learning in Surgery");
		expect(merged.data.creators).toEqual([{ creatorType: "author", firstName: "Aditya", lastName: "Borakati" }]);
		expect(merged.data.date).toBe("2024-03-15");
		expect(merged.data.volume).toBe("10"); // kept from master
		expect(merged.data.abstractNote).toBe("Detailed abstract from second duplicate."); // filled from DUPL0002
		expect(merged.data.pages).toBe("100-112"); // filled from DUPL0002

		// 2. Union tags
		expect(merged.tags.map((t: any) => t.tag).sort()).toEqual(["ml", "preprint-tag", "surgery"]);

		// 3. Union collections
		expect(merged.collections.sort()).toEqual(["COLL0001", "COLL0002"]);

		// 4. Union related items
		expect(merged.related?.map((r: any) => r.key)).toEqual(["RELITEM1"]);

		// 5. Children of others moved under master
		expect(merged.children.map((c: any) => c.key).sort()).toEqual(["ATTDUP02", "ATTM0001", "NOTEDUP2"]);
		const movedNote = await j(await call(db, "GET", "/api/items/NOTEDUP2"));
		expect(movedNote.data.parentItem).toBe("MAST0001");

		// 6. dc:replaces relation on master pointing at merged items' URIs
		const replaces = merged.data.relations["dc:replaces"] as string[];
		expect(Array.isArray(replaces)).toBe(true);
		expect(replaces).toHaveLength(2);
		expect(replaces.some((u) => /^http:\/\/zotero\.org\/users\/local\/[2-9A-Z]{8}\/items\/DUPL0002$/.test(u))).toBe(true);
		expect(replaces.some((u) => /^http:\/\/zotero\.org\/users\/local\/[2-9A-Z]{8}\/items\/DUPL0003$/.test(u))).toBe(true);

		// 7. Others moved to trash (deleted = 1)
		const dup2 = await j(await call(db, "GET", "/api/items/DUPL0002"));
		const dup3 = await j(await call(db, "GET", "/api/items/DUPL0003"));
		expect(dup2.data.deleted).toBe(1);
		expect(dup3.data.deleted).toBe(1);

		// Duplicate list is now empty
		expect((await j(await call(db, "GET", "/api/duplicates"))).total).toBe(0);

		// 8. Sync outbox rows written via SQLite triggers (sync_flags untouched)
		const outbox = db.query("SELECT type, key, op FROM sync_outbox").all() as {
			type: string;
			key: string;
			op: string;
		}[];
		expect(outbox).toContainEqual({ type: "item", key: "MAST0001", op: "upsert" });
		expect(outbox).toContainEqual({ type: "item", key: "NOTEDUP2", op: "upsert" });
		expect(outbox).toContainEqual({ type: "item", key: "ATTDUP02", op: "upsert" });
		expect(outbox).toContainEqual({ type: "item", key: "DUPL0002", op: "trash" });
		expect(outbox).toContainEqual({ type: "item", key: "DUPL0003", op: "trash" });
		const flags = db.query("SELECT * FROM sync_flags").all();
		expect(flags).toEqual([]);
	});
});
