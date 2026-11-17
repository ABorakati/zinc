// The page preview at the top of the item pane's Attachments section: the primary PDF's pages as thumbnails in a strip that
// scrolls (Zotero 7's attachment preview), without the reader (no plugins, annotations or layout analysis). Double-click a
// page to open the PDF in its reader tab at that page.
//
// Mounted once per attachment key (<Show keyed>): a selection change unmounts it, which aborts the fetch, cancels the queued
// renders and closes the document (previewDoc.ts), so arrow-key scrubbing through the list only ever costs the item it stops on.
// It waits OPEN_DELAY ms before reading the file. Only the pages near the visible part of the strip are mounted; the rest is
// two spacers of the right height (every page's height is known from the document's page sizes).
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Switch, untrack, type Accessor, type JSX } from "solid-js";
import type { EventPayload } from "@gpuix/native";
import { withAlpha } from "../theme";
import { hiddenUntil, type ImgNode, whenMounted } from "../reader/core/pixels";
import { windowDpr } from "../reader/env";
import { openPdfAtPage } from "../webview/noteLinks";
import { Skeleton, t, TextBtn, tok, tx } from "./kit";
import {
	forcePreview,
	formatBytes,
	knownSizes,
	openPreview,
	previewStats,
	type PreviewSession,
	thumbCache,
	thumbKey,
	type ThumbPixels,
} from "./previewDoc";

/** Wait this long after a selection change before reading the file (arrow-key scrubbing passes items faster than this). */
const OPEN_DELAY = 100;
/** Widest a thumbnail gets, px. */
const MAX_W = 240;
const MIN_W = 96;
/** Right-hand strip no thumbnail covers, for the scrollbar thumb. */
const GUTTER = 10;
const LABEL_H = 16;
const ROW_GAP = 10;
/** Pages mounted beyond the visible part of the strip, as a fraction of its height on each side. */
const OVERSCAN = 0.75;
/** Render queue priority: behind every tile of an open reader, ahead of the reader's own thumbnails. */
const PRIO = 2e6;

type State = { k: "wait" } | { k: "big"; bytes: number } | { k: "ready" } | { k: "error"; msg: string };

export interface PdfPreviewProps {
	attKey: string;
	/** the parent item (for the reader tab) */
	itemKey: string;
	title: string;
}

export function PdfPreview(p: PdfPreviewProps): JSX.Element {
	const attKey = p.attKey;
	const dpr = windowDpr();
	const mounted = performance.now();
	let shown = false;
	const onShown = () => {
		if (shown) return;
		shown = true;
		previewStats.firstShownMs = performance.now() - mounted;
	};
	const [state, setState] = createSignal<State>({ k: "wait" });
	const [session, setSession] = createSignal<PreviewSession | null>(null);
	const [sizes, setSizes] = createSignal<[number, number][] | undefined>(knownSizes(attKey));
	const [avail, setAvail] = createSignal(360);
	const [top, setTop] = createSignal(0);

	let alive = true;
	let ac = new AbortController();

	const load = async () => {
		try {
			const r = await openPreview(attKey, { signal: ac.signal });
			if (!alive) {
				if (r.kind === "doc") void r.session.close();
				return;
			}
			if (r.kind === "big") return void setState({ k: "big", bytes: r.bytes });
			setSizes(r.session.sizes);
			setSession(r.session);
			setState({ k: "ready" });
		} catch (e) {
			if (!alive || (e as Error).name === "AbortError") return;
			setState({ k: "error", msg: e instanceof Error ? e.message : String(e) });
		}
	};
	const timer = setTimeout(() => void load(), OPEN_DELAY);
	onCleanup(() => {
		alive = false;
		clearTimeout(timer);
		ac.abort();
		void session()?.close();
	});
	const showAnyway = () => {
		forcePreview(attKey);
		ac = new AbortController();
		setState({ k: "wait" });
		void load();
	};

	// ---- geometry: one column of pages, each as wide as the thumbnail width, its height from the page's aspect
	const thumbW = createMemo(() => Math.max(MIN_W, Math.min(MAX_W, Math.floor((avail() - 2 * GUTTER) / 8) * 8)));
	const pageH = (i: number) => {
		const s = sizes()?.[i];
		return s ? Math.round((thumbW() * s[1]) / s[0]) : Math.round(thumbW() * 1.294);
	};
	const offsets = createMemo(() => {
		const n = sizes()?.length ?? 0;
		const out = new Array<number>(n + 1);
		out[0] = 0;
		for (let i = 0; i < n; i++) out[i + 1] = out[i]! + pageH(i) + LABEL_H + ROW_GAP;
		return out;
	});
	const total = () => offsets()[offsets().length - 1] ?? 0;
	/** about one and a half pages tall, and never taller than the pages */
	const stripH = createMemo(() => Math.min(Math.round(pageH(0) * 1.45), Math.max(total() + ROW_GAP, 80), 460));
	/** first page at or below y */
	const pageAt = (y: number) => {
		const o = offsets();
		let lo = 0,
			hi = o.length - 2;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (o[mid]! <= y) lo = mid;
			else hi = mid - 1;
		}
		return Math.max(0, lo);
	};
	const n = () => sizes()?.length ?? 0;
	const lo = createMemo(() => (n() ? pageAt(top() - OVERSCAN * stripH()) : 0));
	const hi = createMemo(() => (n() ? Math.min(n(), pageAt(top() + (1 + OVERSCAN) * stripH()) + 1) : 0));
	const idx = createMemo(() => Array.from({ length: Math.max(0, hi() - lo()) }, (_, k) => lo() + k));
	/** the page at the middle of the strip: renders nearer to it go first */
	const center = () => pageAt(top() + stripH() / 2);

	const open = (page: number) => openPdfAtPage(attKey, p.title, p.itemKey, page);

	return (
		<div
			testId="ip-preview"
			onLayout={(e: EventPayload) => {
				const w = e.width ?? 0;
				if (w > 0 && Math.abs(w - untrack(avail)) >= 1) setAvail(w);
			}}
			style={{ ...t("flex flex-col"), width: "100%", paddingBottom: 8 }}
		>
			<Switch>
				<Match when={state().k === "big"}>
					<div style={{ ...t("flex items-center gap-2 rounded-md px-2 py-2"), backgroundColor: tok("muted"), width: "100%" }}>
						<text style={{ ...tx("text-xs text-muted-foreground"), flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
							{`Large PDF (${formatBytes((state() as { bytes: number }).bytes)}): not previewed automatically`}
						</text>
						<TextBtn icon="eye" label="Show preview" onClick={showAnyway} />
					</div>
				</Match>
				<Match when={state().k === "error" && !sizes()}>
					<text style={{ ...tx("text-xs text-muted-foreground") }}>{`No preview: ${(state() as { msg: string }).msg}`}</text>
				</Match>
				<Match when={sizes()}>
					<div
						testId="ip-preview-strip"
						onScrollChange={(e: EventPayload) => setTop(Math.max(0, -((e as { scrollY?: number }).scrollY ?? 0)))}
						style={{
							width: "100%",
							height: stripH(),
							overflowY: "scroll",
							// keeps the wheel here: without it GPUIX lets the wheel through to the item pane's own scroller
							pointerEvents: "auto",
							borderRadius: 8,
							backgroundColor: tok("muted"),
							// TODO(scrollbar): GPUIX's painted thumb takes no pointer input; give the strip the drag strip the item list
							// gets (gpui-ui/src/cards/ListScrollbar.tsx, not on this branch yet). Until then: wheel / trackpad only.
							scrollbarColor: withAlpha(tok("foreground"), 0.25),
							scrollbarWidth: 6,
						}}
					>
						<div style={{ display: "flex", flexDirection: "column", width: "100%", flexShrink: 0, paddingTop: ROW_GAP }}>
							<div style={{ width: "100%", height: offsets()[lo()] ?? 0, flexShrink: 0 }} />
							<For each={idx()}>
								{(i) => (
									<PageThumb
										attKey={attKey}
										i={i}
										w={thumbW()}
										h={pageH(i)}
										dpr={dpr}
										session={session}
										prio={() => PRIO + Math.abs(i - untrack(center))}
										onOpen={open}
										onShown={onShown}
									/>
								)}
							</For>
							<div style={{ width: "100%", height: Math.max(0, total() - (offsets()[hi()] ?? 0)), flexShrink: 0 }} />
						</div>
					</div>
				</Match>
				<Match when={true}>
					<div style={{ ...t("flex justify-center"), width: "100%" }}>
						<Skeleton w={thumbW()} h={Math.round(thumbW() * 1.294)} />
					</div>
				</Match>
			</Switch>
		</div>
	);
}

function PageThumb(p: {
	attKey: string;
	i: number;
	w: number;
	h: number;
	dpr: number;
	session: Accessor<PreviewSession | null>;
	prio: () => number;
	onOpen(page: number): void;
	onShown(): void;
}): JSX.Element {
	let img: ImgNode | undefined;
	let alive = true;
	let task: { cancel(): void } | undefined;
	// created hidden, shown by the step that gives it pixels (never GPUIX's "img: no src" box); a re-render at a new width keeps the
	// old pixels until the new ones arrive
	const [ready, setReady] = createSignal(false);
	onCleanup(() => {
		alive = false;
		task?.cancel();
	});
	const show = async (px: ThumbPixels) => {
		if (
			(await whenMounted(
				() => img,
				() => alive,
			)) &&
			img
		) {
			img.setImagePixels(px.width, px.height, px.pixels, { format: "bgra" });
			setReady(true);
			p.onShown();
		}
	};
	createEffect(
		on(
			() => [p.session(), p.w] as const,
			([s, w]) => {
				task?.cancel();
				task = undefined;
				const key = thumbKey(p.attKey, p.i, p.dpr, w);
				const hit = thumbCache.get(key);
				if (hit) return void show(hit);
				if (!s) return;
				const pw = s.sizes[p.i]?.[0] ?? 612;
				const r = s.render(p.i, (w * p.dpr) / pw, p.prio(), key);
				task = r;
				void r.promise.then((px) => {
					if (px && alive) void show(px);
				});
			},
		),
	);

	return (
		<div
			style={{
				position: "relative",
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				width: "100%",
				flexShrink: 0,
				paddingRight: GUTTER, // the scrollbar's lane: the page stays centred in what is left
				paddingLeft: GUTTER,
				paddingBottom: ROW_GAP,
				cursor: "pointer",
			}}
		>
			<div
				style={{
					position: "relative",
					width: p.w,
					height: p.h,
					flexShrink: 0,
					backgroundColor: "#ffffff",
					borderWidth: 1,
					borderColor: "rgba(0,0,0,0.14)",
					hover: { borderColor: tok("primary") },
				}}
			>
				<img
					ref={(el) => {
						img = el as never;
					}}
					objectFit="fill"
					style={{ position: "absolute", left: 0, top: 0, width: p.w, height: p.h, ...hiddenUntil(ready()) }}
				/>
			</div>
			<text style={{ ...tx("text-[11px] text-muted-foreground"), height: LABEL_H, lineHeight: LABEL_H, whiteSpace: "nowrap" }}>
				{String(p.i + 1)}
			</text>
			{/* the clicks: a layer over the page (the white box under it would keep a click from reaching a wrapper; pointerEvents "none"
			    only means "does not block" in GPUIX, the layer still gets the click), as the reader's own thumbnails */}
			<div
				testId={`ip-preview-page-${p.i}`}
				onClick={(e: EventPayload) => {
					if ((e.clickCount ?? 1) >= 2) p.onOpen(p.i);
				}}
				style={{ position: "absolute", left: GUTTER, top: 0, right: GUTTER, bottom: ROW_GAP, pointerEvents: "none" }}
			/>
		</div>
	);
}
