// bun test src/reader/annotations/noteOverlay.test.tsx -- a note annotation without a position box does not break the page it is on.
import { afterEach, describe, expect, test } from "bun:test";
import { createRoot } from "@gpuix/solid";
import { setBaseUrl, setDirect } from "../../api";
import type { ReaderContext } from "../plugins";
import { PageAnnotations } from "./PageOverlay";
import { closeSession, sessionFor } from "./session";

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

/** A renderer that accepts everything: only the components' own code is under test. */
const renderer = { applyBatch: () => [] as number[], setWindowKeyEvents() {}, setWindowSelectionChange() {}, getWindowSize: () => ({ width: 800, height: 900 }) };

const base = { color: "#ffd400", sortIndex: "00000|000000|00000", dateModified: "2026-11-21T00:00:00.000Z" };

describe("PageAnnotations", () => {
	test("a note with no rects (a foreign record) is skipped instead of throwing while the page renders", async () => {
		setDirect(async () => Response.json([])); // no network: the annotations are added by hand
		const key = "NOTEBOX1";
		const ctx = ctxOf(key);
		const s = sessionFor(ctx);
		await new Promise((r) => setTimeout(r, 20));
		s.store.add({ id: "N1", type: "note", position: { pageIndex: 0 }, ...base });
		s.store.add({ id: "N2", type: "note", position: { pageIndex: 0, rects: [[10, 10, 30, 30]] }, ...base });
		const root = createRoot(renderer as never);
		try {
			expect(() => {
				root.render(() => <PageAnnotations ctx={ctx} page={0} box={() => ({ width: 600, height: 800 })} />);
				root.flush();
			}).not.toThrow();
		} finally {
			root.unmount();
			closeSession(key);
		}
	});
});
