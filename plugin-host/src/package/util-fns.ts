// The pure helpers behind the `util` import (lifecycle.wit). They follow Zotero.Utilities where the WIT names it.
import { semverCompare } from "./semver";

export { semverCompare };

export function cleanDOI(text: string): string | undefined {
	const m = /10(?:\.[0-9]{4,})?\/[^\s]*[^\s.,]/.exec(text);
	return m ? m[0] : undefined;
}

const isbn10Ok = (s: string) => {
	let sum = 0;
	for (let i = 0; i < 10; i++) {
		const c = s[i];
		const d = c === "X" || c === "x" ? 10 : Number(c);
		sum += d * (10 - i);
	}
	return sum % 11 === 0;
};
const isbn13Check = (s12: string) => {
	let sum = 0;
	for (let i = 0; i < 12; i++) sum += Number(s12[i]) * (i % 2 ? 3 : 1);
	return String((10 - (sum % 10)) % 10);
};

export function cleanISBN(text: string, toIsbn13: boolean): string | undefined {
	const t = text.replace(/[‐-―−]/g, "-").replace(/[-\s]/g, "");
	const m = /(?:^|[^0-9])(97[89][0-9]{10}|[0-9]{9}[0-9Xx])(?![0-9Xx])/.exec(t);
	if (!m) return undefined;
	const isbn = m[1].toUpperCase();
	if (isbn.length === 10) {
		if (!isbn10Ok(isbn)) return undefined;
		if (!toIsbn13) return isbn;
		const s12 = "978" + isbn.slice(0, 9);
		return s12 + isbn13Check(s12);
	}
	if (isbn13Check(isbn.slice(0, 12)) !== isbn[12]) return undefined;
	return isbn;
}

export function cleanISSN(text: string): string | undefined {
	const m = /(?:^|[^0-9])(\d{4}-?\d{3}[\dxX])(?![0-9xX])/.exec(text);
	if (!m) return undefined;
	const raw = m[1].replace("-", "").toUpperCase();
	let sum = 0;
	for (let i = 0; i < 7; i++) sum += Number(raw[i]) * (8 - i);
	const check = (11 - (sum % 11)) % 11;
	const want = check === 10 ? "X" : String(check);
	return raw[7] === want ? `${raw.slice(0, 4)}-${raw.slice(4)}` : undefined;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", copy: "©" };

export function htmlToText(html: string): string {
	const s = html
		.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre|ul|ol|table)>/gi, "\n")
		.replace(/<(li)[^>]*>/gi, "")
		.replace(/<[^>]*>/g, "")
		.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
			if (e[0] === "#") {
				const cp = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
				return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
			}
			return ENTITIES[e.toLowerCase()] ?? m;
		});
	return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** `singleNewline`: true makes every line break a new paragraph; false splits paragraphs on blank lines and turns a single break into <br />. (Zotero.Utilities.text2html's `singleNewlineIsParagraph`.) */
export function textToHtml(text: string, singleNewline: boolean): string {
	const s = escapeHtml(text.replace(/\r\n?/g, "\n").trim());
	if (!s) return "";
	const paras = singleNewline ? s.split(/\n+/) : s.split(/\n{2,}/).map((p) => p.replace(/\n/g, "<br />"));
	return paras.map((p) => `<p>${p}</p>`).join("");
}

const SKIP = new Set("a an and as at but by down for from in into nor of on onto or over so the till to up via with yet".split(" "));

export function capitalizeTitle(title: string, force: boolean): string {
	void force; // Zotero's `force` skips a user pref that Zinc does not have: titles are always capitalised here
	const words = title.trim().replace(/\s+/g, " ").split(/([  –—-]+)/);
	const allUpper = title.toUpperCase() === title;
	const last = words.length - 1;
	let prev = -1;
	for (let i = 0; i <= last; i++) {
		const w = words[i];
		if (w.length === 0 || /^[  –—-]+$/.test(w)) continue;
		const lower = w.toLowerCase();
		if (allUpper || w === lower) {
			const afterColon = prev !== -1 && words[prev].endsWith(":");
			if (SKIP.has(lower.replace(/[^a-z]+/, "")) && i !== 0 && i !== last && !afterColon) words[i] = lower;
			else words[i] = w.slice(0, 1).toUpperCase() + lower.slice(1);
		}
		prev = i;
	}
	return words.join("");
}

export type HashAlgorithm = "md5" | "sha1" | "sha256" | "sha512";
export function hashBytes(alg: HashAlgorithm, data: Uint8Array): Uint8Array {
	return new Uint8Array(new Bun.CryptoHasher(alg).update(data).digest() as Uint8Array);
}

export function randomBytes(count: number): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(count));
}
