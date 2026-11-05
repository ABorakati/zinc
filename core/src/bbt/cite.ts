// Citation text for Quick Copy ("Copy citation key") and for the CAYW (cite-as-you-write) endpoint.
// Formats and their options follow https://retorque.re/zotero-better-bibtex/citing/cayw/ (BBT, MIT; see NOTICE).
import type { Database } from "bun:sqlite";
import type { ZoteroItemData } from "../api-types";
import { citeService } from "../cite/api";
import { HttpError } from "../db";
import { creatorLast } from "../io/common";
import { exportBetterFormat, isBbtFormat } from "./export";
import { getKeyInfos } from "./keys";
import type { BbtExportFormat } from "./types";

export interface Pick {
	/** Zotero item key */
	itemKey: string;
	citationKey: string;
	locator?: string;
	/** locator label: page, chapter, ... (default page) */
	label?: string;
	prefix?: string;
	suffix?: string;
	suppressAuthor?: boolean;
}

/** CAYW/Quick Copy options: format, command, brackets, plus the other query parameters (page=, translator=, style=...). */
export type CawyParams = Record<string, string | undefined>;

const LABELS: Record<string, string> = {
	article: "art.", chapter: "ch.", subchapter: "subch.", column: "col.", figure: "fig.", line: "l.", note: "n.", issue: "no.", opus: "op.",
	page: "p.", paragraph: "para.", subparagraph: "subpara.", part: "pt.", rule: "r.", section: "sec.", subsection: "subsec.", Section: "Sec.",
	"sub verbo": "sv.", schedule: "sch.", title: "tit.", verse: "vrs.", volume: "vol.",
};

function locatorText(p: Pick, params: CawyParams): string {
	if (!p.locator) return "";
	const label = p.label || "page";
	const abbr = Object.hasOwn(params, label) ? (params[label] ?? "") : (LABELS[label] ?? label);
	return `${abbr ? `${abbr} ` : ""}${p.locator}`;
}

const plain = (p: Pick) => !p.prefix && !p.suffix && !p.locator;
const unique = (ks: string[]) => [...new Set(ks)];
const postText = (p: Pick, params: CawyParams) => [locatorText(p, params), p.suffix].filter(Boolean).join(" ");

/** The CAYW/Quick Copy output for picked items in a text format (not the data formats: json, translate, formatted-*). */
export function formatPicks(picks: Pick[], params: CawyParams): string {
	const format = (params.format || "cite").toLowerCase();
	const keys = picks.map((p) => p.citationKey);
	switch (format) {
		case "key":
			return unique(keys).join(",");
		case "cite": case "latex": case "natbib": case "citep": case "citet": {
			const base = format === "citep" || format === "citet" ? format : params.command || "cite";
			const noAuthor = picks.filter((p) => p.suppressAuthor).length;
			if (picks.every(plain) && (noAuthor === 0 || noAuthor === picks.length)) {
				return `\\${noAuthor ? "citeyear" : base}{${unique(keys).join(",")}}`;
			}
			return picks
				.map((p) => {
					const post = postText(p, params);
					const opts = p.prefix || post ? (p.prefix ? `[${p.prefix}][${post}]` : `[${post}]`) : "";
					return `\\${p.suppressAuthor ? "citeyear" : base}${opts}{${p.citationKey}}`;
				})
				.join("");
		}
		case "biblatex": {
			const cmd = params.command || "autocite";
			const extras = picks.some((p) => !plain(p));
			const noAuthor = picks.some((p) => p.suppressAuthor);
			if (!extras) {
				if (noAuthor && picks.length === 1 && ["cite", "autocite", "parencite"].includes(cmd)) return `\\${cmd}*{${keys[0]}}`;
				return `\\${cmd}{${unique(keys).join(",")}}`;
			}
			const one = (p: Pick) => {
				const post = postText(p, params);
				return `${p.prefix || post ? `[${p.prefix ?? ""}][${post}]` : ""}{${p.citationKey}}`;
			};
			if (picks.length === 1) return `\\${cmd}${one(picks[0]!)}`;
			return `\\${cmd}s${picks.map(one).join("")}`;
		}
		case "mmd":
			return picks.map((p) => `${locatorText(p, params) ? `[${locatorText(p, params)}]` : ""}[#${p.citationKey}][]`).join("");
		case "pandoc": {
			const parts = picks.map((p) => {
				const post = postText(p, params);
				return `${p.prefix ? `${p.prefix} ` : ""}${p.suppressAuthor ? "-" : ""}@${p.citationKey}${post ? `, ${post}` : ""}`;
			});
			const text = parts.join("; ");
			return params.brackets ? `[${text}]` : text;
		}
		case "textcite":
			return picks.map((p) => `@${p.citationKey}`).join(", ");
		case "asciidoctor-bibtex":
			return `cite:[${picks.map((p) => `${p.citationKey}${p.locator ? `(${locatorText(p, params)})` : ""}`).join(", ")}]`;
		case "typst":
			return picks.map((p) => `@${p.citationKey}${p.locator ? `[${locatorText(p, params)}]` : ""}`).join(" ");
		case "org-mode":
			return `[cite:${picks.map((p) => `@${p.citationKey}`).join(";")}]`;
		case "jupyter":
			return `<cite data-cite="${unique(keys).join(", ")}"></cite>`;
		default:
			throw new HttpError(400, `unsupported CAYW format "${format}"`);
	}
}

/** `{ prefix | Author, Year | locator | suffix | zotero://select/... }` scannable cites for the ODF scanner. */
export function scannableCites(db: Database, picks: Pick[], params: CawyParams): string {
	return picks
		.map((p) => {
			const row = db.query("SELECT data FROM items WHERE key = ?").get(p.itemKey) as { data: string } | null;
			const d = row ? (JSON.parse(row.data) as ZoteroItemData) : null;
			const authors = ((d?.creators ?? []) as { creatorType: string; lastName?: string; name?: string }[]).filter((c) => c.creatorType === "author").map(creatorLast);
			const year = String(d?.date ?? "").match(/\d{4}/)?.[0] ?? "";
			const short = [authors.join(", "), year].filter(Boolean).join(", ");
			return `{ ${p.prefix ?? ""} | ${p.suppressAuthor ? `-${short}` : short} | ${locatorText(p, params)} | ${p.suffix ?? ""} | zotero://select/library/items/${p.itemKey} }`;
		})
		.join("");
}

/** BBT translator names / ids / extensions -> our export format. */
export function translatorFormat(name: string): BbtExportFormat | null {
	const compact = name.toLowerCase().replace(/[^a-z]/g, "");
	if (isBbtFormat(compact)) return compact;
	switch (compact.replace(/^better/, "")) {
		case "bib": case "biblatex": return "betterbiblatex";
		case "bibtex": return "betterbibtex";
		case "json": case "csljson": return "bettercsljson";
		case "yaml": case "yml": case "cslyaml": return "bettercslyaml";
		default: return null;
	}
}

/** Full CAYW output for picks, including the formats that need the library (formatted-*, translate, json). */
export async function cawyOutput(db: Database, picks: Pick[], params: CawyParams): Promise<{ body: string; contentType: string }> {
	const format = (params.format || "cite").toLowerCase();
	const text = (body: string) => ({ body, contentType: "text/plain; charset=utf-8" });
	switch (format) {
		case "json": {
			const out = picks.map((p) => {
				const row = db.query("SELECT data FROM items WHERE key = ?").get(p.itemKey) as { data: string } | null;
				return {
					citationKey: p.citationKey,
					itemKey: p.itemKey,
					id: `http://zotero.org/users/local/items/${p.itemKey}`,
					locator: p.locator ?? "",
					label: p.label ?? "page",
					prefix: p.prefix ?? "",
					suffix: p.suffix ?? "",
					suppressAuthor: !!p.suppressAuthor,
					itemData: row ? JSON.parse(row.data) : null,
				};
			});
			return { body: JSON.stringify(out), contentType: "application/json; charset=utf-8" };
		}
		case "scannable-cite":
			return text(scannableCites(db, picks, params));
		case "formatted-citation":
		case "formatted-bibliography": {
			const mode = format === "formatted-citation" ? "citation" : "bibliography";
			const r = await citeService(db).format(db, { keys: picks.map((p) => p.itemKey), style: params.style || undefined, locale: params.locale || undefined, mode, format: "text" });
			return text(r.text ?? "");
		}
		case "translate": {
			const translator = translatorFormat(params.translator || "biblatex");
			if (!translator) throw new HttpError(400, `unknown translator ${params.translator}`);
			const { gatherItems } = await import("../io/export");
			const includeNotes = params.exportNotes === "true";
			const items = gatherItems(db, { format: "bibtex", keys: picks.map((p) => p.itemKey), includeNotes });
			return text(exportBetterFormat(db, translator, items, { includeNotes }));
		}
		case "eta":
			throw new HttpError(400, "the eta CAYW format is not supported by zotero-next (use json and format it yourself)");
		default:
			return text(formatPicks(picks, params));
	}
}

/** Quick Copy text for items: their citation keys in the chosen format (items without a citation key are skipped). */
export function quickCopyText(db: Database, itemKeys: string[], format: string, command?: string): string {
	const infos = getKeyInfos(db, itemKeys);
	const picks: Pick[] = itemKeys.filter((k) => infos[k]).map((k) => ({ itemKey: k, citationKey: infos[k]!.key }));
	if (!picks.length) throw new HttpError(404, "none of these items has a citation key");
	// Quick Copy: pandoc is the bracketed form [@key]; the plain form is the "textcite" format (@key)
	return formatPicks(picks, { format, command, brackets: format === "pandoc" ? "1" : undefined });
}
