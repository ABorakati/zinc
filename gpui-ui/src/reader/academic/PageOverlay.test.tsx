// bun test src/reader/academic/PageOverlay.test.tsx -- hoisted hover cards & annotation popups (never clipped under adjacent pages).
import { describe, expect, test } from "bun:test";
import { createRoot } from "@gpuix/solid";
import { createSignal } from "solid-js";
import type { ReaderContext } from "../plugins";
import { placeFloatingCard } from "../structure/kit";
import { AcademicPage, AcademicPopupHost, CARD_EST_H, CARD_W } from "./PageOverlay";
import { academicFor, closeAcademic } from "./session";
import { AnnotationPopupHost, PageAnnotations } from "../annotations/PageOverlay";
import { closeSession, sessionFor } from "../annotations/session";

const tick = (ms = 20) => new Promise<void>((r) => setTimeout(r, ms));

interface FakeNode {
	id: number;
	type: string;
	parent: number | null;
	children: number[];
	props: Record<string, unknown>;
	events: Set<string>;
}

/** Minimal fake GPUIX native renderer that records the full element tree, custom props and event listeners. */
function makeTreeRenderer() {
	const nodes = new Map<number, FakeNode>();
	const handlers = new Map<number, Map<string, (e: unknown) => void>>();

	const destroySubtree = (id: number, out: number[]) => {
		const n = nodes.get(id);
		if (!n) return;
		for (const c of [...n.children]) destroySubtree(c, out);
		if (n.parent != null) {
			const p = nodes.get(n.parent);
			if (p) p.children = p.children.filter((x) => x !== id);
		}
		nodes.delete(id);
		out.push(id);
	};

	const renderer = {
		applyBatch(raw: string): number[] {
			const ops = JSON.parse(raw) as unknown[][];
			const destroyed: number[] = [];
			for (const op of ops) {
				const kind = op[0];
				if (kind === "createElement") {
					const id = op[1] as number;
					nodes.set(id, { id, type: op[2] as string, parent: null, children: [], props: {}, events: new Set() });
				} else if (kind === "appendChild") {
					const parent = nodes.get(op[1] as number);
					const child = nodes.get(op[2] as number);
					if (parent && child) {
						child.parent = parent.id;
						parent.children.push(child.id);
					}
				} else if (kind === "insertBefore") {
					const parent = nodes.get(op[1] as number);
					const child = nodes.get(op[2] as number);
					const beforeId = op[3] as number;
					if (parent && child) {
						child.parent = parent.id;
						const i = parent.children.indexOf(beforeId);
						if (i >= 0) parent.children.splice(i, 0, child.id);
						else parent.children.push(child.id);
					}
				} else if (kind === "destroyElement") {
					destroySubtree(op[1] as number, destroyed);
				} else if (kind === "setCustomProp") {
					const n = nodes.get(op[1] as number);
					if (n) n.props[op[2] as string] = op[3];
				} else if (kind === "setEventListener") {
					const n = nodes.get(op[1] as number);
					if (n) {
						if (op[3]) n.events.add(op[2] as string);
						else n.events.delete(op[2] as string);
					}
				}
			}
			return destroyed;
		},
		setWindowKeyEvents() {},
		setWindowSelectionChange() {},
		getWindowSize() {
			return { width: 1440, height: 881 };
		},
	};

	const findBy = (pred: (n: FakeNode) => boolean) => [...nodes.values()].filter(pred);
	return { renderer, nodes, handlers, findBy };
}

function makeCtx(
	attachmentKey: string,
	opts: {
		rect?: () => { x: number; y: number; width: number; height: number } | null;
		pane?: () => { x: number; y: number; width: number; height: number } | null;
		viewTick?: () => number;
		altView?: () => string | null;
	} = {},
): ReaderContext {
	return {
		attachmentKey,
		itemKey: "",
		pageCount: () => 2,
		pageSize: () => ({ w: 600, h: 800 }),
		textLayer: async () => ({ words: [] }),
		pdfBytes: async () => new Uint8Array(),
		currentPage: () => 0,
		zoom: () => 1,
		scrollTo: () => {},
		selection: () => null,
		clearSelection: () => {},
		altView: opts.altView ?? (() => null),
		setAltView: () => {},
		mode: () => "dark",
		rectToWindow: () => (opts.rect ? opts.rect() : { x: 400, y: 380, width: 32, height: 14 }),
		paneBounds: () => (opts.pane ? opts.pane() : { x: 240, y: 100, width: 1200, height: 780 }),
		viewTick: opts.viewTick ?? (() => 0),
	};
}

describe("placeFloatingCard", () => {
	const win = { width: 1440, height: 900 };
	const pane = { x: 240, y: 100, width: 1200, height: 800 };

	test("near bottom of page N in upper viewport: places below so deferred layer extends over page N+1", () => {
		const pos = placeFloatingCard({ x: 500, y: 380, width: 30, height: 14 }, win, {
			width: CARD_W,
			estHeight: CARD_EST_H,
			gap: 6,
			margin: 8,
			pane,
		});
		expect(pos).toEqual({ x: 500, y: 400, anchor: "topLeft", below: true });
	});

	test("near bottom edge of viewport: flips above anchor with bottomLeft anchor", () => {
		const pos = placeFloatingCard({ x: 500, y: 840, width: 30, height: 14 }, win, {
			width: CARD_W,
			estHeight: CARD_EST_H,
			gap: 6,
			margin: 8,
			pane,
		});
		expect(pos).toEqual({ x: 500, y: 834, anchor: "bottomLeft", below: false });
	});

	test("near top edge of pane (under toolbar): places below anchor and never clips into toolbar", () => {
		const pos = placeFloatingCard({ x: 500, y: 108, width: 30, height: 14 }, win, {
			width: CARD_W,
			estHeight: CARD_EST_H,
			gap: 6,
			margin: 8,
			pane,
		});
		expect(pos).toEqual({ x: 500, y: 128, anchor: "topLeft", below: true });
	});

	test("clamps horizontally inside right and left pane edges", () => {
		const right = placeFloatingCard({ x: 1380, y: 300, width: 30, height: 14 }, win, {
			width: CARD_W,
			estHeight: CARD_EST_H,
			gap: 6,
			margin: 8,
			pane,
		});
		expect(right?.x).toBe(1440 - CARD_W - 8);

		const left = placeFloatingCard({ x: 242, y: 300, width: 30, height: 14 }, win, {
			width: CARD_W,
			estHeight: CARD_EST_H,
			gap: 6,
			margin: 8,
			pane,
		});
		expect(left?.x).toBe(248);
	});

	test("centers horizontally when align is center and clamps within pane", () => {
		const mid = placeFloatingCard({ x: 700, y: 300, width: 100, height: 20 }, win, {
			width: 300,
			estHeight: 200,
			align: "center",
			gap: 8,
			margin: 8,
			pane,
		});
		expect(mid).toEqual({ x: 600, y: 328, anchor: "topLeft", below: true });
	});

	test("returns null when anchor scrolled completely outside the visible pane", () => {
		expect(placeFloatingCard({ x: 500, y: 70, width: 30, height: 14 }, win, { width: CARD_W, estHeight: CARD_EST_H, pane })).toBeNull();
		expect(
			placeFloatingCard({ x: 500, y: 920, width: 30, height: 14 }, win, { width: CARD_W, estHeight: CARD_EST_H, pane }),
		).toBeNull();
	});
});

describe("AcademicPopupHost hoisting", () => {
	test("hover card is never rendered inside AcademicPage; mounts in deferred <anchored> host and repositions on scroll without remounting content", async () => {
		const key = "test-hoist-academic";
		const [rect, setRect] = createSignal<{ x: number; y: number; width: number; height: number } | null>({
			x: 500,
			y: 380,
			width: 32,
			height: 14,
		});
		const [viewTick, setViewTick] = createSignal(0);
		const ctx = makeCtx(key, { rect, viewTick });
		const s = academicFor(ctx);
		let contentBuilds = 0;

		const { renderer, findBy } = makeTreeRenderer();
		const root = createRoot(renderer as never);

		try {
			// Mount page 0 overlay (inside a page box) and hoisted pane overlay separately
			root.render(() => (
				<div testId="reader-root">
					<div testId="page-0-box">
						<AcademicPage ctx={ctx} page={0} box={() => ({ width: 600, height: 800 })} />
					</div>
					<div testId="page-1-box">
						<AcademicPage ctx={ctx} page={1} box={() => ({ width: 600, height: 800 })} />
					</div>
					<div testId="pane-overlays">
						<AcademicPopupHost ctx={ctx} />
					</div>
				</div>
			));
			root.flush();

			// Open a hover card anchored near the bottom edge of page 0
			s.showPopup({
				key: "cite:0:bottom",
				page: 0,
				rect: [100, 12, 130, 26],
				pinned: false,
				content: () => {
					contentBuilds++;
					return <text>Reference preview</text>;
				},
			});
			root.flush();

			const cards = findBy((n) => n.props.testId === "academic-hover-card");
			expect(cards).toHaveLength(1);
			const cardNode = cards[0]!;

			// Parent of the card must be an <anchored> element inside pane-overlays, NOT inside page-0-box!
			const anchoredNodes = findBy((n) => n.type === "anchored");
			expect(anchoredNodes).toHaveLength(1);
			const anc = anchoredNodes[0]!;
			expect(cardNode.parent).toBe(anc.id);
			expect(anc.props.fit).toBe("snap");
			expect(Number(anc.props.priority)).toBeGreaterThan(0);
			expect(anc.props.position).toEqual({ x: 500, y: 400 });
			expect(anc.props.anchor).toBe("topLeft");

			const page0Box = findBy((n) => n.props.testId === "page-0-box")[0]!;
			expect(page0Box.children).not.toContain(anc.id);
			expect(contentBuilds).toBe(1);

			// Scroll down so anchor moves near the bottom edge of the viewport: card flips above WITHOUT remounting content
			setRect({ x: 500, y: 820, width: 32, height: 14 });
			setViewTick((n) => n + 1);
			root.flush();

			expect(contentBuilds).toBe(1);
			expect(anc.props.position).toEqual({ x: 500, y: 814 });
			expect(anc.props.anchor).toBe("bottomLeft");

			// Hover transition: scheduleHide followed by cancelHide keeps the card open without flickering
			s.scheduleHide(30);
			await tick(10);
			s.cancelHide();
			await tick(40);
			expect(s.popup()?.key).toBe("cite:0:bottom");
			expect(findBy((n) => n.props.testId === "academic-hover-card")).toHaveLength(1);

			// Scroll citation off-screen above the pane: card hides cleanly
			setRect({ x: 500, y: 50, width: 32, height: 14 });
			setViewTick((n) => n + 1);
			root.flush();
			expect(findBy((n) => n.props.testId === "academic-hover-card")).toHaveLength(0);
		} finally {
			root.unmount();
			closeAcademic(key);
		}
	});
});

describe("AnnotationPopupHost hoisting", () => {
	test("selected annotation popup renders in deferred <anchored> host above pages, never inside PageAnnotations", () => {
		const key = "test-hoist-annotation";
		const [rect, setRect] = createSignal<{ x: number; y: number; width: number; height: number } | null>({
			x: 600,
			y: 820,
			width: 100,
			height: 16,
		});
		const [viewTick, setViewTick] = createSignal(0);
		const ctx = makeCtx(key, { rect, viewTick });
		const s = sessionFor(ctx);
		s.store.add({
			id: "ANN1",
			type: "highlight",
			color: "#ffd400",
			text: "Near bottom of page 1",
			comment: "",
			tags: [],
			pageLabel: "1",
			sortIndex: "00000|000000|00000",
			dateModified: "2026-11-21T00:00:00.000Z",
			position: { pageIndex: 0, rects: [[100, 10, 200, 26]] },
		});

		const { renderer, findBy } = makeTreeRenderer();
		const root = createRoot(renderer as never);

		try {
			root.render(() => (
				<div testId="reader-root">
					<div testId="page-0-box">
						<PageAnnotations ctx={ctx} page={0} box={() => ({ width: 600, height: 800 })} />
					</div>
					<div testId="pane-overlays">
						<AnnotationPopupHost ctx={ctx} />
					</div>
				</div>
			));
			root.flush();

			s.ui.select("ANN1");
			root.flush();

			const popups = findBy((n) => n.props.testId === "annotation-popup");
			expect(popups).toHaveLength(1);
			const anchoredNodes = findBy((n) => n.type === "anchored");
			expect(anchoredNodes).toHaveLength(1);
			expect(popups[0]!.parent).toBe(anchoredNodes[0]!.id);
			// Near bottom edge of viewport: flipped above
			expect(anchoredNodes[0]!.props.anchor).toBe("bottomLeft");
			expect(anchoredNodes[0]!.props.fit).toBe("snap");

			// Reposition on scroll
			setRect({ x: 600, y: 200, width: 100, height: 16 });
			setViewTick((n) => n + 1);
			root.flush();
			expect(anchoredNodes[0]!.props.anchor).toBe("topLeft");
			expect(anchoredNodes[0]!.props.position).toEqual({ x: 500, y: 224 });
		} finally {
			root.unmount();
			closeSession(key);
		}
	});
});
