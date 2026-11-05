// Small text helpers shared by the features.
export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const stripExt = (name: string) => name.replace(/\.[^./\\]+$/, "");
export const baseName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p;
export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”" };

/** HTML (citeproc output, notes) to plain text: block tags become line breaks, entities are decoded, tags dropped. */
export function htmlToText(html: string): string {
	return html
		.replace(/<div class="csl-left-margin">([\s\S]*?)<\/div>\s*<div class="csl-right-inline">/g, "$1 ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(div|p|li|tr|h[1-6])>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(+d))
		.replace(/&([a-z]+);/gi, (m, n: string) => ENT[n.toLowerCase()] ?? m)
		.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).filter(Boolean).join("\n");
}

/** True when the text is only DOIs / PMIDs / arXiv IDs / ISBNs (cheap client-side screen; additems/client.ts of the web UI). */
export function looksLikeIdentifiers(text: string): boolean {
	const glued = text.replace(/\b(pmid|pubmed|isbn(?:-1[03])?|arxiv|doi|pmcid)\s*:?\s+(?=\S)/gi, (_m, l) => `${String(l).toLowerCase()}:`);
	const toks = glued.trim().split(/[\s,;]+/).filter(Boolean);
	if (!toks.length || toks.length > 50) return false;
	return toks.every((t) =>
		/^(doi:)?(https?:\/\/(dx\.)?doi\.org\/)?10\.\d{4,9}\/\S+$/i.test(t) ||
		/^(pmid:?)?\d{6,8}$/i.test(t) ||
		/^pmc\d+$/i.test(t) ||
		/^(arxiv:)?\d{4}\.\d{4,5}(v\d+)?$/i.test(t) ||
		/^(isbn:?)?[\d-]{10,17}x?$/i.test(t) ||
		/^https?:\/\/(arxiv\.org\/abs\/|pubmed\.ncbi\.nlm\.nih\.gov\/)\S+$/i.test(t),
	);
}
