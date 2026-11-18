// `util` (lifecycle.wit): helpers that must agree with Zinc. Pure, no permission, runs in the plugin host process.
import { defineHandler } from "./registry";
import { capitalizeTitle, cleanDOI, cleanISBN, cleanISSN, hashBytes, htmlToText, randomBytes, semverCompare, textToHtml, type HashAlgorithm } from "../package/util-fns";

const MAX_RANDOM = 64 * 1024;

export default defineHandler({
	interface: "zinc:plugin/util",
	where: "host",
	functions: {
		"random-bytes"(_ctx, count: number) {
			if (!Number.isInteger(count) || count < 0) throw new RangeError("count must be a non-negative integer");
			if (count > MAX_RANDOM) throw new RangeError(`random-bytes: at most ${MAX_RANDOM} bytes per call`); // the function has no result: a trap
			return randomBytes(count);
		},
		"uuid-v4"() {
			return crypto.randomUUID();
		},
		hash(_ctx, algorithm: HashAlgorithm, data: Uint8Array) {
			if (!["md5", "sha1", "sha256", "sha512"].includes(algorithm)) throw new RangeError(`unknown hash algorithm ${algorithm}`);
			return hashBytes(algorithm, data);
		},
		"semver-compare"(_ctx, a: string, b: string) {
			return semverCompare(a, b);
		},
		"clean-doi"(_ctx, text: string) {
			return cleanDOI(text);
		},
		"clean-isbn"(_ctx, text: string, toIsbn13: boolean) {
			return cleanISBN(text, toIsbn13);
		},
		"clean-issn"(_ctx, text: string) {
			return cleanISSN(text);
		},
		"html-to-text"(_ctx, html: string) {
			return htmlToText(html);
		},
		"text-to-html"(_ctx, text: string, singleParagraph: boolean) {
			return textToHtml(text, singleParagraph);
		},
		"capitalize-title"(_ctx, title: string, force: boolean) {
			return capitalizeTitle(title, force);
		},
	},
});
