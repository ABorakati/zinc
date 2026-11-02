// The reflowed reading view: DocStructure as a clean article with the user's typography (reader-next/src/reflow/ReflowView.tsx).
// Text is drawn with GPUIX: paragraphs and lists through <markdown> (inline emphasis, links, sup/subscripts), headings through
// <text>; figures, tables and equations are crops of the PDF page. Citation links open the same reference popover as the page view.
import { useGpuix } from "@gpuix/solid";
import { createMemo, createResource, createSignal, For, Match, onCleanup, onMount, Show, Switch, type Accessor, type JSX } from "solid-js";
import { Icon } from "../../icons";
import { Popover } from "../../ui";
import { CiteContent } from "../academic/PageOverlay";
import { CitedByCard } from "../academic/Cards";
import { markerOf, parseCitationNumbers } from "../academic/citations";
import { academicFor } from "../academic/session";
import type { ReaderContext } from "../plugins";
import { kit, RegionImage } from "../structure/kit";
import { renderRegion, type Crop } from "../structure/regions";
import type { Block, DocStructure, PdfRect } from "../structure/types";
import { bestTarget, buildItems, firstItemOnPage, tocEntries, type ReflowItem } from "./build";
import { htmlToMarkdown, htmlToPlain } from "./html";
import { FONTS, fontFamilyOf, LIMITS, palette, type Palette, type ReadingSettings, type ThemeKind } from "./settings";

export type LoadState =
	| { phase: "loading"; pct: number }
	| { phase: "error"; message: string }
	| { phase: "ready"; doc: DocStructure };

export interface ReflowProps {
	ctx: ReaderContext;
	state: Accessor<LoadState>;
	retry(): void;
	settings: Accessor<ReadingSettings>;
	setSettings(patch: Partial<ReadingSettings>): void;
	resetSettings(): void;
}

const MONO = "Cascadia Mono";
const pad = (r: PdfRect, d: number): PdfRect => [r[0] - d, r[1] - d, r[2] + d, r[3] + d];

/** The <markdown> theme for a reading palette + settings; `scale` shrinks it for captions and notes. */
function mdTheme(st: ReadingSettings, pal: Palette, scale = 1) {
	const size = st.size * scale;
	return {
		appearance: (pal.dark ? "dark" : "light") as "dark" | "light", bg: pal.bg, border: pal.rule, text: pal.fg, textMuted: pal.muted, textFaint: pal.muted, textDim: pal.muted,
		accent: pal.cite, fontSans: fontFamilyOf(st), fontMono: MONO, codeText: pal.fg, codeWash: pal.panel,
		metrics: {
			mdTextSize: size, mdLineHeight: Math.round(size * st.lineHeight * 10) / 10, mdBlockGap: Math.round(size * 0.55),
			mdHeadingSizes: [size * 1.5, size * 1.3, size * 1.15, size * 1.05], mdHeadingLineHeights: [size * 1.9, size * 1.7, size * 1.55, size * 1.45],
		},
	};
}

export function ReflowView(p: ReflowProps): JSX.Element {
	const gpuix = useGpuix();
	const s = academicFor(p.ctx);
	const k = kit(p.ctx.mode);
	const st = p.settings;
	const pal = createMemo(() => palette(st()));
	const items = createMemo<ReflowItem[]>(() => { const x = p.state(); return x.phase === "ready" ? buildItems(x.doc) : []; });
	const blockById = createMemo(() => { const x = p.state(); return new Map<string, Block>(x.phase === "ready" ? x.doc.blocks.map((b) => [b.id, b]) : []); });
	const toc = createMemo(() => tocEntries(items()));
	const indexOf = createMemo(() => new Map(items().map((it, i) => [it.id, i])));

	const [settingsOpen, setSettingsOpen] = createSignal(false);
	const [tocOpen, setTocOpen] = createSignal(true);
	const [top, setTop] = createSignal(0);
	const [flash, setFlash] = createSignal<string | null>(null);
	const [back, setBack] = createSignal<number[]>([]);
	let list: { id: number } | undefined;
	let flashTimer: ReturnType<typeof setTimeout> | undefined;
	const pointer = { x: 0, y: 0 };

	// ---- scrolling / position
	const scrollToIndex = (i: number, offset = 0) => { if (list) gpuix?.renderer.scrollToItem?.(list.id, i, offset); };
	function goToIndex(i: number, remember = true) {
		if (remember) setBack((b) => [...b.slice(-29), top()]);
		scrollToIndex(i);
		const it = items()[i];
		if (it) {
			setFlash(it.id);
			clearTimeout(flashTimer);
			flashTimer = setTimeout(() => setFlash(null), 1800);
		}
	}
	/** Scroll to the item (or bibliography entry) holding PDF location (page, top). */
	function goTo(page: number, y?: number): boolean {
		const map = blockById();
		const its = items();
		const i = bestTarget(its.map((it) => ({ blocks: it.blockIds.flatMap((id) => map.get(id) ?? []) })), page, y);
		const idx = i >= 0 ? i : firstItemOnPage(its, page);
		if (idx < 0 || !its.length) return false;
		goToIndex(idx);
		return true;
	}
	const goBack = () => {
		const b = back();
		const i = b[b.length - 1];
		if (i === undefined) return;
		setBack(b.slice(0, -1));
		scrollToIndex(i);
	};

	let entered = false;
	function onListRef(el: { id: number }) {
		list = el;
		if (entered || !items().length) return;
		entered = true;
		setTimeout(() => scrollToIndex(firstItemOnPage(items(), p.ctx.currentPage())), 30);
	}
	const topPage = () => items()[Math.min(top(), items().length - 1)]?.page;
	onCleanup(() => {
		clearTimeout(flashTimer);
		const page = topPage();
		if (page !== undefined) setTimeout(() => p.ctx.scrollTo(page, 0), 40);
	});

	// ---- popups for citation links
	const [pop, setPop] = createSignal<{ anchor: { x: number; y: number }; content: () => JSX.Element } | null>(null);
	function onLink(url: string) {
		if (url.startsWith("zn-cite:")) {
			const [, kind, pageS, topS, textS] = url.split(":");
			const page = Number(pageS), y = topS ? Number(topS) : undefined;
			const text = decodeURIComponent(textS ?? "");
			const nums = kind === "ref" ? parseCitationNumbers(text) : [];
			if (nums.length) {
				setPop({
					anchor: { x: pointer.x, y: pointer.y },
					content: () => <CiteContent s={s} k={k} spec={{ nums, groupText: text, dest: { page, top: y } }} jump={(pg, r) => { setPop(null); goTo(pg, r[3]); }} />,
				});
			} else if (Number.isFinite(page)) goTo(page, y);
			return;
		}
		if (/^https?:/i.test(url)) { if (!p.ctx.openUrl?.(url)) void s.api.openUrl(url).catch(() => {}); }
	}

	/** Click on a bibliography entry: where the paper cites it (the reading-view counterpart of hovering an entry in the PDF). */
	function showCitedBy(blockId: string, position: number) {
		const n = markerOf(blockById().get(blockId)?.text ?? "") ?? position;
		setPop({
			anchor: { x: pointer.x, y: pointer.y },
			content: () => {
				const [sites] = createResource(() => s.citeIndex().then((m) => m.get(n) ?? []));
				return (
					<Show when={sites()} fallback={<text style={k.tx("text-[12px] text-muted-foreground")}>Looking for the citations...</text>}>
						{(ss) => <CitedByCard s={s} k={k} n={n} sites={ss()} onJump={(site) => { setPop(null); goTo(site.page, site.rect[3]); }} />}
					</Show>
				);
			},
		});
	}

	// ---- rendering of the items
	const family = () => fontFamilyOf(st());
	const base = () => ({ color: pal().fg, fontFamily: family(), fontSize: st().size, lineHeight: Math.round(st().size * st().lineHeight * 10) / 10 });

	function Row(r: { id: string; gap?: number; children: JSX.Element }): JSX.Element {
		return (
			<div
				style={{
					display: "flex", flexDirection: "row", justifyContent: "center", width: "100%", paddingBottom: Math.round(st().size * (r.gap ?? 0.8)),
					backgroundColor: flash() === r.id ? pal().panel : "transparent",
				}}
			>
				<div style={{ display: "flex", flexDirection: "column", width: "100%", maxWidth: st().width, minWidth: 0, paddingLeft: 28, paddingRight: 28 }}>{r.children}</div>
			</div>
		);
	}
	const md = (html: string, scale = 1) => <markdown source={htmlToMarkdown(html)} theme={mdTheme(st(), pal(), scale)} onLinkClick={(e) => onLink((e as { value?: string }).value ?? "")} />;

	function Region(r: { page: number; rect: PdfRect; maxW?: number; maxH?: number; zoom?: number }): JSX.Element {
		const [crop, setCrop] = createSignal<Crop | null>(null);
		const w = () => Math.min(st().width - 56, r.maxW ?? 9999, Math.round((r.rect[2] - r.rect[0]) * (r.zoom ?? 1.4)));
		onMount(() => void renderRegion(p.ctx, r.page, pad(r.rect, 3), 1100).then(setCrop));
		return <RegionImage k={k} crop={crop} width={Math.max(60, w())} maxHeight={r.maxH ?? 520} fallbackHeight={Math.round(w() * 0.5)} />;
	}

	function ItemView(q: { it: ReflowItem }): JSX.Element {
		const it = q.it;
		return (
			<Switch>
				<Match when={it.kind === "title"}>
					<Row id={it.id} gap={1.2}>
						<text style={{ ...base(), fontSize: Math.round(st().size * 1.75), lineHeight: Math.round(st().size * 2.2), fontWeight: 700 }}>{htmlToPlain((it as { html: string }).html)}</text>
					</Row>
				</Match>
				<Match when={it.kind === "heading"}>
					<Row id={it.id} gap={0.5}>
						<div style={{ height: Math.round(st().size * 0.9) }} />
						<text
							style={{
								...base(), fontWeight: 650,
								fontSize: Math.round(st().size * ([1.45, 1.3, 1.15, 1.05, 1][(it as { level: number }).level - 1] ?? 1)),
								lineHeight: Math.round(st().size * ([1.9, 1.7, 1.55, 1.45, 1.4][(it as { level: number }).level - 1] ?? 1.4)),
							}}
						>
							{htmlToPlain((it as { html: string }).html)}
						</text>
					</Row>
				</Match>
				<Match when={it.kind === "para" || it.kind === "list"}>
					<Row id={it.id}>{md((it as { html: string }).html)}</Row>
				</Match>
				<Match when={it.kind === "code"}>
					<Row id={it.id}>
						<div style={{ display: "flex", flexDirection: "column", padding: 10, borderRadius: 6, backgroundColor: pal().panel }}>
							<text style={{ ...base(), fontFamily: MONO, fontSize: Math.round(st().size * 0.82), lineHeight: Math.round(st().size * 1.25) }}>{(it as { text: string }).text}</text>
						</div>
					</Row>
				</Match>
				<Match when={it.kind === "equation"}>
					<Row id={it.id}><Region page={it.page} rect={(it as { rect: PdfRect }).rect} zoom={1.7} maxH={160} /></Row>
				</Match>
				<Match when={it.kind === "figure"}>
					<Row id={it.id} gap={1}>
						<Region page={it.page} rect={(it as { rect: PdfRect }).rect} zoom={(it as { wide: boolean }).wide ? 2 : 1.5} />
						<Show when={(it as { captionHtml: string }).captionHtml}>
							<div style={{ height: Math.round(st().size * 0.4) }} />
							{md((it as { captionHtml: string }).captionHtml, 0.86)}
						</Show>
					</Row>
				</Match>
				<Match when={it.kind === "notes"}>
					<Row id={it.id} gap={1}>
						<div style={{ height: 1, backgroundColor: pal().rule, marginBottom: 8 }} />
						<For each={(it as { html: string[] }).html}>{(h) => <div style={{ paddingBottom: 4 }}>{md(h, 0.82)}</div>}</For>
					</Row>
				</Match>
				<Match when={it.kind === "refs"}>
					<Row id={it.id} gap={1.2}>
						<For each={(it as { entries: { id: string; html: string }[] }).entries}>
							{(e, i) => (
								<div onClick={() => showCitedBy(e.id, i() + 1)} style={{ paddingBottom: Math.round(st().size * 0.35), cursor: "pointer" }}>{md(e.html, 0.84)}</div>
							)}
						</For>
					</Row>
				</Match>
			</Switch>
		);
	}

	// ---- chrome
	function Chip(c: { label?: string; icon?: string; on?: boolean; onClick: () => void; w?: number; disabled?: boolean }): JSX.Element {
		return (
			<div
				onClick={() => { if (!c.disabled) c.onClick(); }}
				style={{
					display: "flex", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, height: 26, paddingLeft: 9, paddingRight: 9, borderRadius: 6, flexShrink: 0,
					borderWidth: 1, borderColor: c.on ? pal().fg : pal().rule, backgroundColor: c.on ? pal().panel : "transparent", cursor: c.disabled ? "default" : "pointer",
					opacity: c.disabled ? 0.45 : 1, ...(c.w ? { width: c.w } : {}),
				}}
			>
				<Show when={c.icon}><Icon name={c.icon!} size={13} color={pal().fg} /></Show>
				<Show when={c.label}><text style={{ color: pal().fg, fontFamily: "Inter", fontSize: 12, whiteSpace: "nowrap" }}>{c.label!}</text></Show>
			</div>
		);
	}
	const label = (t: string): JSX.Element => <text style={{ color: pal().muted, fontFamily: "Inter", fontSize: 11, width: 74, flexShrink: 0 }}>{t}</text>;
	function Stepper(c: { name: string; value: string; dec(): void; inc(): void }): JSX.Element {
		return (
			<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 6 }}>
				{label(c.name)}
				<Chip icon="minus" onClick={c.dec} />
				<div style={{ width: 52, display: "flex", justifyContent: "center" }}><text style={{ color: pal().fg, fontFamily: "Inter", fontSize: 12 }}>{c.value}</text></div>
				<Chip icon="plus" onClick={c.inc} />
			</div>
		);
	}
	const step = (v: number, d: number, [lo, hi]: readonly [number, number], dp = 0) => Math.min(hi, Math.max(lo, Math.round((v + d) * 10 ** dp) / 10 ** dp));
	const THEMES: { id: ThemeKind; label: string }[] = [{ id: "light", label: "Light" }, { id: "sepia", label: "Sepia" }, { id: "dark", label: "Dark" }];

	const settingsPanel = (): JSX.Element => (
		<div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, borderBottomWidth: 1, borderColor: pal().rule, backgroundColor: pal().panel, flexShrink: 0 }}>
			<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
				{label("Font")}
				<For each={FONTS}>{(f) => <Chip label={f.label} on={st().font === f.id} onClick={() => p.setSettings({ font: f.id })} />}</For>
			</div>
			<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 24, flexWrap: "wrap" }}>
				<Stepper name="Size" value={`${st().size}px`} dec={() => p.setSettings({ size: step(st().size, -1, LIMITS.size) })} inc={() => p.setSettings({ size: step(st().size, 1, LIMITS.size) })} />
				<Stepper name="Line spacing" value={st().lineHeight.toFixed(2)} dec={() => p.setSettings({ lineHeight: step(st().lineHeight, -0.05, LIMITS.lineHeight, 2) })} inc={() => p.setSettings({ lineHeight: step(st().lineHeight, 0.05, LIMITS.lineHeight, 2) })} />
				<Stepper name="Text width" value={`${st().width}px`} dec={() => p.setSettings({ width: step(st().width, -40, LIMITS.width) })} inc={() => p.setSettings({ width: step(st().width, 40, LIMITS.width) })} />
			</div>
			<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 6 }}>
				{label("Theme")}
				<For each={THEMES}>{(th) => <Chip label={th.label} on={st().theme === th.id} onClick={() => p.setSettings({ theme: th.id })} />}</For>
				<div style={{ flexGrow: 1 }} />
				<Chip label="Reset" onClick={p.resetSettings} />
			</div>
		</div>
	);

	const tocPanel = (): JSX.Element => {
		const cur = createMemo(() => {
			let c: string | null = null;
			for (const e of toc()) { if ((indexOf().get(e.id) ?? 0) <= top()) c = e.id; else break; }
			return c;
		});
		return (
			<div style={{ display: "flex", flexDirection: "column", width: 250, flexShrink: 0, height: "100%", borderRightWidth: 1, borderColor: pal().rule, minHeight: 0 }}>
				<div style={{ display: "flex", alignItems: "center", height: 34, paddingLeft: 14, flexShrink: 0 }}>
					<text style={{ color: pal().muted, fontFamily: "Inter", fontSize: 11, fontWeight: 600 }}>CONTENTS</text>
				</div>
				<div style={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0, overflowY: "scroll", scrollbarColor: "rgba(128, 128, 128, 0.4)", scrollbarWidth: 5, paddingBottom: 12 }}>
					<For each={toc()}>
						{(e) => (
							<div
								onClick={() => { const i = indexOf().get(e.id); if (i !== undefined) goToIndex(i); }}
								style={{
									display: "flex", paddingTop: 4, paddingBottom: 4, paddingRight: 10, paddingLeft: 14 + (e.level - 1) * 12, cursor: "pointer",
									backgroundColor: cur() === e.id ? pal().panel : "transparent", hover: { backgroundColor: pal().panel },
								}}
							>
								<text style={{ color: cur() === e.id ? pal().fg : pal().muted, fontFamily: "Inter", fontSize: 12, fontWeight: cur() === e.id ? 600 : 400, lineClamp: 2 }}>{e.text}</text>
							</div>
						)}
					</For>
				</div>
			</div>
		);
	};

	const bar = (): JSX.Element => (
		<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 6, height: 42, paddingLeft: 10, paddingRight: 10, flexShrink: 0, borderBottomWidth: 1, borderColor: pal().rule }}>
			<Chip icon="arrow-left" label="PDF" onClick={() => p.ctx.setAltView(null)} />
			<Chip icon="list" label="Contents" on={tocOpen()} onClick={() => setTocOpen(!tocOpen())} disabled={toc().length === 0} />
			<Show when={back().length > 0}><Chip icon="undo-2" label="Back" onClick={goBack} /></Show>
			<div style={{ flexGrow: 1 }} />
			<text style={{ color: pal().muted, fontFamily: "Inter", fontSize: 11.5, whiteSpace: "nowrap" }}>Reading view</text>
			<Chip icon="a-large-small" label="Aa" on={settingsOpen()} onClick={() => setSettingsOpen(!settingsOpen())} />
		</div>
	);

	const message = (icon: string, text: string, retry?: boolean, pct?: number): JSX.Element => (
		<div style={{ display: "flex", flexDirection: "column", flexGrow: 1, alignItems: "center", justifyContent: "center", gap: 12 }}>
			<Icon name={icon} size={26} color={pal().muted} />
			<div style={{ maxWidth: 440, display: "flex", justifyContent: "center" }}>
				<text style={{ color: pal().muted, fontFamily: "Inter", fontSize: 13, textAlign: "center" }}>{text}</text>
			</div>
			<Show when={pct !== undefined}>
				<div style={{ width: 240, height: 4, borderRadius: 2, backgroundColor: pal().rule }}>
					<div style={{ width: Math.round((240 * (pct ?? 0)) / 100), height: 4, borderRadius: 2, backgroundColor: pal().fg }} />
				</div>
			</Show>
			<Show when={retry}><Chip label="Retry" onClick={p.retry} /></Show>
		</div>
	);

	return (
		<div
			onMouseMove={(e) => { pointer.x = e.x ?? pointer.x; pointer.y = e.y ?? pointer.y; }}
			style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", minHeight: 0, minWidth: 0, backgroundColor: pal().bg }}
		>
			{bar()}
			<Show when={settingsOpen()}>{settingsPanel()}</Show>
			<Switch>
				<Match when={p.state().phase === "loading"}>
					{message("loader-circle", "Analysing the document layout...", false, (p.state() as { pct: number }).pct)}
				</Match>
				<Match when={p.state().phase === "error"}>
					{message("file-warning", (p.state() as { message: string }).message, true)}
				</Match>
				<Match when={p.state().phase === "ready"}>
					<div style={{ display: "flex", flexDirection: "row", flexGrow: 1, minHeight: 0 }}>
						<Show when={tocOpen() && toc().length > 0}>{tocPanel()}</Show>
						<Show when={items().length > 0} fallback={message("file-text", "No readable text was found in this PDF.")}>
							<virtual-list
								ref={onListRef}
								estimatedItemHeight={Math.round(st().size * 5)}
								overdraw={600}
								onVisibleRange={(e) => setTop(Math.max(0, Math.floor(e.startIndex ?? 0)))}
								style={{ flexGrow: 1, minWidth: 0, height: "100%", paddingTop: 28, paddingBottom: 80 }}
							>
								<For each={items()}>{(it) => <ItemView it={it} />}</For>
							</virtual-list>
						</Show>
					</div>
				</Match>
			</Switch>
			<Popover open={pop() !== null} onClose={() => setPop(null)} anchor={pop()?.anchor ?? { x: 0, y: 0 }} width={380}>
				<div style={{ display: "flex", flexDirection: "column", width: "100%", padding: 2 }}>{pop()?.content()}</div>
			</Popover>
		</div>
	);
}
