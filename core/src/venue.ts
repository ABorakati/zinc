// The "venue" an item's card and the Publication column show (items.publication): the journal, book, site, proceedings…
// and for a preprint the server it is on (arXiv, medRxiv, SSRN…). One rule for every path that writes items rows (the API,
// sync, imports), so cards look the same however the item arrived.

/** Container fields in priority order (Zotero's own field names; the first non-empty one wins). */
export const VENUE_FIELDS = [
	"publicationTitle", "bookTitle", "proceedingsTitle", "websiteTitle", "blogTitle", "forumTitle", "encyclopediaTitle",
	"dictionaryTitle", "programTitle", "university", "publisher",
] as const;

// Preprint servers, recognised from the URL host, the archive ID ("arXiv:1706.03762") or the DOI prefix. Zotero's
// `repository` field is often not the server: medRxiv/bioRxiv records from Crossref carry the subject category there
// ("Transplantation"), and many preprints have no repository at all.
const SERVERS: { name: string; host?: RegExp; doi?: RegExp; id?: RegExp }[] = [
	{ name: "arXiv", host: /(^|\.)arxiv\.org$/, doi: /^10\.48550\//, id: /^arxiv:/i },
	{ name: "medRxiv", host: /(^|\.)medrxiv\.org$/, doi: /^10\.1101\/\d{4}\.\d{2}\.\d{2}\.\d{8}/ },
	{ name: "bioRxiv", host: /(^|\.)biorxiv\.org$/, doi: /^10\.1101\/(\d{4}\.\d{2}\.\d{2}\.)?\d{6}(v\d+)?$/ },
	{ name: "SSRN", host: /(^|\.)ssrn\.com$/, doi: /^10\.2139\/ssrn/ },
	{ name: "Research Square", host: /(^|\.)researchsquare\.com$/, doi: /^10\.21203\// },
	{ name: "ChemRxiv", host: /(^|\.)chemrxiv\.org$/, doi: /^10\.26434\// },
	{ name: "TechRxiv", host: /(^|\.)techrxiv\.org$/, doi: /^10\.36227\// },
	{ name: "Preprints.org", host: /(^|\.)preprints\.org$/, doi: /^10\.20944\// },
	{ name: "Authorea", host: /(^|\.)authorea\.com$/, doi: /^10\.22541\// },
	{ name: "PsyArXiv", host: /^psyarxiv\.com$/, doi: /^10\.31234\// },
	{ name: "SocArXiv", host: /^socarxiv\.org$/, doi: /^10\.31235\// },
	{ name: "OSF Preprints", host: /(^|\.)osf\.io$/, doi: /^10\.31219\// },
	{ name: "Qeios", host: /(^|\.)qeios\.com$/, doi: /^10\.32388\// },
	{ name: "SciELO Preprints", host: /^preprints\.scielo\.org$/ },
	{ name: "Zenodo", host: /(^|\.)zenodo\.org$/, doi: /^10\.5281\/zenodo/ },
];

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function hostOf(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
}

/** The preprint server an item is on, or null when it cannot be told from its URL, archive ID or DOI. */
export function preprintServer(data: Record<string, unknown>): string | null {
	const url = str(data.url);
	const host = hostOf(url);
	// no DOI field: a doi.org link stands in for it (any other URL simply matches no DOI pattern)
	const doi = (str(data.DOI) || url).replace(/^(https?:\/\/)?(dx\.)?doi\.org\//i, "").toLowerCase();
	const id = str(data.archiveID);
	for (const s of SERVERS) {
		if ((host && s.host?.test(host)) || (id && s.id?.test(id)) || (doi && s.doi?.test(doi))) return s.name;
	}
	return null;
}

/** Venue text for an item's data (Web API JSON or Zotero's raw field map), or null. */
export function venueOf(data: Record<string, unknown>, itemType?: string): string | null {
	if ((itemType ?? str(data.itemType)) === "preprint") {
		return preprintServer(data) || str(data.repository) || str(data.publisher) || null;
	}
	for (const f of VENUE_FIELDS) {
		const v = str(data[f]);
		if (v) return v;
	}
	return str(data.repository) || null;
}
