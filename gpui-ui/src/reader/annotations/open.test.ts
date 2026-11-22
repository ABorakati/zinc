// bun test src/reader/annotations/open.test.ts -- opening a document loads its annotations once.
import { afterEach, describe, expect, test } from "bun:test";
import { setBaseUrl, setDirect } from "../../api";
import type { ReaderContext } from "../plugins";
import { annotationsPlugin } from "./index";

afterEach(() => setBaseUrl("http://127.0.0.1:23160")); // (also drops the direct handler)

const ctxOf = (attachmentKey: string) =>
	({
		attachmentKey,
		itemKey: "",
		pageCount: () => 1,
		pageSize: () => ({ w: 600, h: 800 }),
		textLayer: async () => ({ words: [] }),
		pdfBytes: async () => new Uint8Array(),
		currentPage: () => 0,
		zoom: () => 1,
		scrollTo: () => {},
		selection: () => null,
		clearSelection: () => {},
		altView: () => null,
		setAltView: () => {},
		mode: () => "light",
	}) as unknown as ReaderContext;

describe("annotations plugin onOpen", () => {
	test("one GET of the annotations, not two", async () => {
		const seen: string[] = [];
		setDirect(async (req) => {
			seen.push(`${req.method} ${new URL(req.url).pathname}`);
			return Response.json([]);
		});
		const close = annotationsPlugin.onOpen!(ctxOf("OPENONCE")) as () => void;
		await new Promise((r) => setTimeout(r, 50));
		close();
		expect(seen.filter((s) => s.startsWith("GET "))).toEqual(["GET /api/attachments/OPENONCE/annotations"]);
	});
});
