// The card's venue line (items.publication): preprint servers, the repository fallback and the one-time refresh on open.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { preprintServer, venueOf } from "../src/venue";

describe("venueOf", () => {
	test("preprints show their server, recognised from the URL, archive ID or DOI", () => {
		// shapes from the user's library
		expect(venueOf({ itemType: "preprint", repository: "arXiv", archiveID: "arXiv:1706.03762", url: "http://arxiv.org/abs/1706.03762" })).toBe("arXiv");
		expect(venueOf({ itemType: "preprint", archiveID: "arXiv:2311.08526", DOI: "10.48550/arXiv.2311.08526" })).toBe("arXiv");
		expect(venueOf({ itemType: "preprint", repository: "Transplantation", url: "http://medrxiv.org/lookup/doi/10.1101/2024.11.01.24316601" })).toBe("medRxiv");
		expect(venueOf({ itemType: "preprint", url: "https://doi.org/10.1101/2023.08.31.23294924", DOI: "10.1101/2023.08.31.23294924" })).toBe("medRxiv");
		expect(venueOf({ itemType: "preprint", repository: "Bioinformatics", url: "http://biorxiv.org/lookup/doi/10.1101/2022.08.31.506101" })).toBe("bioRxiv");
		expect(venueOf({ itemType: "preprint", DOI: "10.1101/2022.08.31.506101" })).toBe("bioRxiv");
		expect(venueOf({ itemType: "preprint", repository: "SSRN", url: "https://www.ssrn.com/abstract=4605366" })).toBe("SSRN");
		expect(venueOf({ itemType: "preprint", repository: "In Review", DOI: "10.21203/rs.3.rs-4611820/v1" })).toBe("Research Square");
	});
	test("an unknown server falls back to the repository field", () => {
		expect(venueOf({ itemType: "preprint", repository: "Some Archive", url: "https://example.org/p/1" })).toBe("Some Archive");
		expect(venueOf({ itemType: "preprint" })).toBeNull();
		expect(preprintServer({ url: "not a url" })).toBeNull();
	});
	test("other items keep the container order", () => {
		expect(venueOf({ itemType: "journalArticle", publicationTitle: "Nature" })).toBe("Nature");
		expect(venueOf({ itemType: "bookSection", bookTitle: "Textbook" })).toBe("Textbook");
		expect(venueOf({ itemType: "thesis", university: "KCL" })).toBe("KCL");
		// a journal article on arXiv's site is still the journal's
		expect(venueOf({ itemType: "journalArticle", publicationTitle: "Nature", url: "https://arxiv.org/abs/1" })).toBe("Nature");
	});
});

test("openDb recomputes stored venues once, without queueing sync writes", () => {
	const dir = mkdtempSync(join(tmpdir(), "zn-venue-"));
	try {
		const path = join(dir, "lib.sqlite");
		openDb(path).close();
		const raw = new Database(path);
		const data = { key: "PREPRNT1", itemType: "preprint", title: "Attention", repository: "arXiv", archiveID: "arXiv:1706.03762" };
		raw.run("INSERT INTO items(key, item_type, title, creators_summary, publication, data, date_added, date_modified, deleted) VALUES(?, 'preprint', 'Attention', '', NULL, ?, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', 0)", ["PREPRNT1", JSON.stringify(data)]);
		raw.run("DELETE FROM sync_outbox");
		raw.run("DELETE FROM meta WHERE name = 'venue_version'"); // as a library written before this rule
		raw.run("UPDATE meta SET value = '1' WHERE name = 'schema_version'"); // the venue refresh is migration 2
		raw.close();

		const db = openDb(path);
		expect((db.query("SELECT publication FROM items WHERE key = 'PREPRNT1'").get() as { publication: string }).publication).toBe("arXiv");
		expect((db.query("SELECT count(*) n FROM sync_outbox").get() as { n: number }).n).toBe(0);
		expect(db.query("SELECT 1 FROM sync_flags WHERE name = 'suppress'").get()).toBeNull();
		db.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
