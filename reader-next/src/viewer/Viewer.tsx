import {
	RotateCcw, RotateCw, BookOpen, ChevronDown, ChevronUp, Columns2, FileText, Image, LayoutGrid, List, Maximize2, MoveHorizontal, Palette, PanelLeft,
	Paperclip, Quote, Search, Table2, X, ZoomIn, ZoomOut, type LucideProps,
} from "lucide-solid";
import { createEffect, createMemo, createSignal, For, type JSX, type Component, on, onCleanup, onMount, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { appearance, hasReadingColours, pageLook, setAppearance, type AppearanceMode } from "./appearance";
import { GAP, type ViewerController, type ZoomMode } from "./controller";
import { PageView } from "./PageView";
import { OutlineTree, PluginTab, Thumbnails } from "./Sidebar";
import type { OutlineNode } from "./pdf";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { cn } from "./ui/utils";

const ICONS: Record<string, Component<LucideProps>> = {
	image: Image, figure: Image, figures: Image, table: Table2, tables: Table2, "book-open": BookOpen, book: BookOpen, reading: BookOpen,
	quote: Quote, quotes: Quote, citation: Quote, "file-text": FileText, list: List, grid: LayoutGrid, columns: Columns2, search: Search,
	paperclip: Paperclip, attachment: Paperclip, supplementary: Paperclip,
};
function PluginIcon(props: { icon?: string; title: string }) {
	const C = () => (props.icon ? ICONS[props.icon.toLowerCase()] : undefined);
	return (
		<Show when={C()} fallback={<span class="text-[11px] font-semibold">{props.icon && props.icon.length <= 2 ? props.icon : props.title.slice(0, 2)}</span>}>
			<Dynamic component={C()!} class="size-4" />
		</Show>
	);
}

const iconBtn = "h-8 w-8 p-0 text-muted-foreground hover:text-foreground";


// ------------------------------------------------------------------ appearance popover

function AppearanceMenu() {
	const modes: { id: AppearanceMode; label: string; swatch: string }[] = [
		{ id: "normal", label: "Normal", swatch: "#ffffff" },
		{ id: "dark", label: "Dark", swatch: "#111111" },
		{ id: "sepia", label: "Sepia", swatch: "#f4ecd8" },
		{ id: "custom", label: "Custom", swatch: appearance().custom },
	];
	return (
		<Popover>
			<PopoverTrigger as={Button} variant="ghost" class={iconBtn} title="Page appearance"><Palette class="size-4" /></PopoverTrigger>
			<PopoverContent class="w-60 p-3">
				<div class="mb-2 text-xs font-medium text-muted-foreground">Page appearance</div>
				<div class="grid grid-cols-4 gap-2">
					<For each={modes}>{(m) => (
						<button
							class={cn("flex flex-col items-center gap-1 rounded-md p-1.5 text-[11px] hover:bg-accent", appearance().mode === m.id && "bg-accent ring-1 ring-primary")}
							onClick={() => setAppearance({ ...appearance(), mode: m.id })}
						>
							<span class="size-7 rounded-full border" style={{ "background-color": m.id === "custom" ? appearance().custom : m.swatch }} />
							{m.label}
						</button>
					)}</For>
				</div>
				<label class="mt-3 flex items-center justify-between gap-2 text-xs">
					<span>Background colour</span>
					<input
						type="color" value={appearance().custom} class="h-6 w-10 cursor-pointer rounded border bg-transparent p-0"
						onInput={(e) => setAppearance({ mode: "custom", custom: e.currentTarget.value })}
					/>
				</label>
				<button
					class={cn("mt-3 w-full rounded-md border px-2 py-1.5 text-left text-xs hover:bg-accent disabled:opacity-50", appearance().mode === "reading" && "bg-accent ring-1 ring-primary")}
					disabled={!hasReadingColours()}
					title={hasReadingColours() ? "" : "Open the reading view once to publish its colours"}
					onClick={() => setAppearance({ ...appearance(), mode: "reading" })}
				>Use reading view colours</button>
			</PopoverContent>
		</Popover>
	);
}

// ------------------------------------------------------------------ find bar

function FindBar(props: { ctl: ViewerController }) {
	const ctl = props.ctl;
	let input!: HTMLInputElement;
	let timer = 0;
	const trigger = () => { clearTimeout(timer); timer = window.setTimeout(() => void ctl.runFind(), 220); };
	createEffect(() => { if (ctl.findOpen[0]()) queueMicrotask(() => { input.focus(); input.select(); }); });
	const count = () => {
		const n = ctl.findHits[0]().length;
		if (ctl.findBusy[0]()) return "…";
		if (!ctl.findQuery[0]().trim()) return "";
		return n ? `${ctl.findIndex[0]() + 1} / ${n}` : "No results";
	};
	return (
		<Show when={ctl.findOpen[0]()}>
			<div class="absolute right-4 top-3 z-20 flex items-center gap-1 rounded-md border bg-popover p-1.5 shadow-md" data-find-bar>
				<input
					ref={input} value={ctl.findQuery[0]()} placeholder="Find in document"
					class="h-7 w-52 rounded border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
					onInput={(e) => { ctl.findQuery[1](e.currentTarget.value); trigger(); }}
					onKeyDown={(e) => {
						if (e.key === "Enter") { e.preventDefault(); clearTimeout(timer); if (ctl.findHits[0]().length && !e.isComposing) ctl.findStep(e.shiftKey ? -1 : 1); else void ctl.runFind(); }
						else if (e.key === "Escape") { e.preventDefault(); ctl.closeFind(); ctl.scroller?.focus(); }
					}}
				/>
				<span class="w-16 text-center text-[11px] tabular-nums text-muted-foreground">{count()}</span>
				<button class={cn("rounded px-1 text-[11px] font-semibold hover:bg-accent", ctl.findCase[0]() && "bg-accent text-primary")} title="Match case" onClick={() => { ctl.findCase[1](!ctl.findCase[0]()); void ctl.runFind(); }}>Aa</button>
				<button class={cn("rounded px-1 text-[11px] font-semibold hover:bg-accent", ctl.findWord[0]() && "bg-accent text-primary")} title="Whole word" onClick={() => { ctl.findWord[1](!ctl.findWord[0]()); void ctl.runFind(); }}>W</button>
				<Button variant="ghost" class="size-7 p-0" title="Previous (Shift+Enter)" onClick={() => ctl.findStep(-1)}><ChevronUp class="size-4" /></Button>
				<Button variant="ghost" class="size-7 p-0" title="Next (Enter)" onClick={() => ctl.findStep(1)}><ChevronDown class="size-4" /></Button>
				<Button variant="ghost" class="size-7 p-0" title="Close (Esc)" onClick={() => { ctl.closeFind(); ctl.scroller?.focus(); }}><X class="size-4" /></Button>
			</div>
		</Show>
	);
}

// ------------------------------------------------------------------ copy: rebuild text from the invisible text layer

function selectionText(): string | null {
	const sel = window.getSelection();
	if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
	const range = sel.getRangeAt(0);
	const spans = [...document.querySelectorAll<HTMLElement>(".rn-text .rn-run")].filter((s) => range.intersectsNode(s));
	if (!spans.length) return null;
	let out = "";
	let prev: HTMLElement | null = null;
	for (const s of spans) {
		// a span is the word's text node plus a separate trailing-space node
		const node = s.firstChild;
		let t = node?.textContent ?? "";
		if (node) {
			const a = range.startContainer === node ? range.startOffset : 0;
			const b = range.endContainer === node ? range.endOffset : t.length;
			t = t.slice(a, b);
		}
		if (!t.trim()) continue;
		if (prev) {
			const h = Number(s.dataset.h), py = Number(prev.dataset.y), cy = Number(s.dataset.y);
			if (prev.dataset.p !== s.dataset.p) out += "\n\n";
			else if (Math.abs(py - cy) < h * 0.5) out += Number(s.dataset.x1) - Number(prev.dataset.x2) > h * 0.15 ? " " : "";
			else if (py - cy > h * 1.75 || cy > py + h) out += "\n";
			else if (/[a-z]-$/.test(out) && /^[a-z]/.test(t)) out = out.slice(0, -1);
			else out += " ";
		}
		out += t;
		prev = s;
	}
	return out;
}

// ------------------------------------------------------------------ main

type SideTab = string;

export function Viewer(props: { ctl: ViewerController; outline: OutlineNode[] }) {
	const ctl = props.ctl;
	const sideDefault = (): SideTab => {
		try { return localStorage.getItem("rn.sideTab") || (props.outline.length ? "outline" : "thumbs"); } catch { return "outline"; }
	};
	const [sideOpen, setSideOpen] = createSignal((() => { try { return localStorage.getItem("rn.sideOpen") === "1"; } catch { return false; } })());
	const [sideTab, setSideTab] = createSignal<SideTab>(sideDefault());
	const [pageInput, setPageInput] = createSignal<string | null>(null);
	let scroller!: HTMLDivElement;
	const look = createMemo(() => pageLook(appearance()));

	createEffect(() => { try { localStorage.setItem("rn.sideOpen", sideOpen() ? "1" : "0"); localStorage.setItem("rn.sideTab", sideTab()); } catch { /* ignore */ } });

	const visible = createMemo(() => {
		const [a, b] = ctl.range();
		return Array.from({ length: b - a + 1 }, (_, k) => a + k);
	});

	onMount(() => {
		ctl.scroller = scroller;
		ctl.copyText = selectionText;
		const ro = new ResizeObserver(() => ctl.onResize(scroller.clientWidth, scroller.clientHeight));
		ro.observe(scroller);
		ctl.onResize(scroller.clientWidth, scroller.clientHeight);
		let raf = 0;
		const onScroll = () => {
			if (raf) return;
			raf = requestAnimationFrame(() => { raf = 0; ctl.scrollTop[1](scroller.scrollTop); ctl.scrollLeft[1](scroller.scrollLeft); ctl.scheduleSave(); });
		};
		scroller.addEventListener("scroll", onScroll, { passive: true });
		const onWheel = (e: WheelEvent) => {
			if (!e.ctrlKey) return;
			e.preventDefault();
			const r = scroller.getBoundingClientRect();
			ctl.zoomBy(Math.exp(-e.deltaY * 0.0022), { x: e.clientX - r.left, y: e.clientY - r.top });
		};
		scroller.addEventListener("wheel", onWheel, { passive: false });
		const onKey = (e: KeyboardEvent) => {
			const mod = e.ctrlKey || e.metaKey;
			const typing = (e.target as HTMLElement | null)?.closest("input,textarea,select,[contenteditable]");
			if (mod && e.key.toLowerCase() === "f") { e.preventDefault(); ctl.findOpen[1](true); return; }
			if (mod && (e.key === "=" || e.key === "+")) { e.preventDefault(); ctl.zoomBy(1.1); return; }
			if (mod && (e.key === "-" || e.key === "_")) { e.preventDefault(); ctl.zoomBy(1 / 1.1); return; }
			if (mod && e.key === "0") { e.preventDefault(); ctl.setMode("width"); return; }
			if (mod && e.key === "]") { e.preventDefault(); ctl.rotateDoc(90); return; }
			if (mod && e.key === "[") { e.preventDefault(); ctl.rotateDoc(-90); return; }
			if (e.key === "Escape" && ctl.menu[0]()) { ctl.menu[1](null); return; }
			if (mod && e.key.toLowerCase() === "g") { e.preventDefault(); ctl.findStep(e.shiftKey ? -1 : 1); return; }
			if (e.key === "F3") { e.preventDefault(); ctl.findStep(e.shiftKey ? -1 : 1); return; }
			if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); ctl.goBack(); return; }
			if (typing || ctl.alternate[0]()) return;
			if (mod) return;
			const h = scroller.clientHeight;
			switch (e.key) {
				case "PageDown": case " ": if (e.key === " " && e.shiftKey) { scroller.scrollBy({ top: -h * 0.9 }); } else scroller.scrollBy({ top: h * 0.9 }); e.preventDefault(); break;
				case "PageUp": scroller.scrollBy({ top: -h * 0.9 }); e.preventDefault(); break;
				case "Home": ctl.goToPage(0); e.preventDefault(); break;
				case "End": scroller.scrollTop = scroller.scrollHeight; e.preventDefault(); break;
				case "ArrowDown": scroller.scrollBy({ top: 48 }); e.preventDefault(); break;
				case "ArrowUp": scroller.scrollBy({ top: -48 }); e.preventDefault(); break;
				case "ArrowRight": if (scroller.scrollWidth > scroller.clientWidth) scroller.scrollBy({ left: 48 }); else ctl.goToPage(ctl.curPage() + 1); e.preventDefault(); break;
				case "ArrowLeft": if (scroller.scrollWidth > scroller.clientWidth) scroller.scrollBy({ left: -48 }); else ctl.goToPage(ctl.curPage() - 1); e.preventDefault(); break;
			}
		};
		window.addEventListener("keydown", onKey);
		const onCopy = (e: ClipboardEvent) => {
			const t = selectionText();
			if (t === null) return;
			e.clipboardData?.setData("text/plain", t);
			e.preventDefault();
		};
		document.addEventListener("copy", onCopy);
		const flush = () => ctl.saveNow(true);
		window.addEventListener("pagehide", flush);
		document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
		scroller.focus({ preventScroll: true });
		// restore position once the scroller exists
		queueMicrotask(() => {
			const s = (window as unknown as { __rnState?: Parameters<ViewerController["restoreState"]>[0] }).__rnState;
			ctl.restoreState(s ?? null);
			ctl.ready[1](true);
		});
		onCleanup(() => {
			ro.disconnect(); scroller.removeEventListener("scroll", onScroll); scroller.removeEventListener("wheel", onWheel);
			window.removeEventListener("keydown", onKey); document.removeEventListener("copy", onCopy); window.removeEventListener("pagehide", flush);
		});
	});

	// tab selection falls back if a plugin tab disappears
	createEffect(() => {
		const id = sideTab();
		if (id !== "outline" && id !== "thumbs" && !ctl.sidebarTabs[0]().some((t) => t.id === id)) setSideTab("thumbs");
	});

	// a plugin asked to show one of its tabs (e.g. "Show in References" from a citation card)
	createEffect(on(ctl.sidebarRequest[0], (req) => {
		if (!req) return;
		setSideTab(req.id as SideTab);
		setSideOpen(true);
	}, { defer: true }));

	// alternate view mount
	let altEl!: HTMLDivElement;
	createEffect(on(ctl.alternate[0], (render) => {
		altEl.replaceChildren();
		if (!render) return;
		const cleanup = render(altEl);
		onCleanup(() => { if (typeof cleanup === "function") cleanup(); altEl.replaceChildren(); });
	}));

	const zoomValue = () => {
		const m = ctl.zoomMode[0]();
		if (m === "width") return "width";
		if (m === "page") return "page";
		return "custom";
	};
	const presets = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

	const commitPage = (v: string) => {
		setPageInput(null);
		const n = parseInt(v, 10);
		if (Number.isFinite(n)) ctl.goToPage(n - 1);
	};

	const tabBtn = (id: string, title: string, icon: JSX.Element) => (
		<button
			class={cn("flex h-8 flex-1 items-center justify-center text-muted-foreground hover:text-foreground", sideTab() === id && "border-b-2 border-primary text-foreground")}
			title={title} onClick={() => setSideTab(id)}
		>{icon}</button>
	);

	return (
		<div class="flex h-full flex-col bg-background">
			{/* svg duotone filter for "reading view colours" */}
			<svg width="0" height="0" class="absolute" aria-hidden="true">
				<Show when={look().duotone} keyed>{(d) => (
					<filter id={d.id} color-interpolation-filters="sRGB">
						<feColorMatrix type="matrix" values="0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0 0 0 1 0" />
						<feComponentTransfer>
							<feFuncR type="table" tableValues={`${d.fg[0] / 255} ${d.bg[0] / 255}`} />
							<feFuncG type="table" tableValues={`${d.fg[1] / 255} ${d.bg[1] / 255}`} />
							<feFuncB type="table" tableValues={`${d.fg[2] / 255} ${d.bg[2] / 255}`} />
						</feComponentTransfer>
					</filter>
				)}</Show>
			</svg>

			<header class="flex h-10 shrink-0 items-center gap-1 border-b bg-card px-2">
				<Button variant="ghost" class={cn(iconBtn, sideOpen() && "bg-accent text-foreground")} title="Sidebar" onClick={() => setSideOpen(!sideOpen())}><PanelLeft class="size-4" /></Button>
				<div class="mx-2 min-w-0 flex-1 truncate text-[13px] font-medium" title={ctl.title}>{ctl.title}</div>

				<input
					class="h-7 w-11 rounded border bg-background px-1 text-center text-xs tabular-nums outline-none focus:ring-2 focus:ring-ring" aria-label="Page number"
					value={pageInput() ?? String(ctl.curPage() + 1)}
					onFocus={(e) => { setPageInput(String(ctl.curPage() + 1)); e.currentTarget.select(); }}
					onInput={(e) => setPageInput(e.currentTarget.value)}
					onBlur={() => setPageInput(null)}
					onKeyDown={(e) => { if (e.key === "Enter") { commitPage(e.currentTarget.value); scroller.focus(); } else if (e.key === "Escape") { setPageInput(null); scroller.focus(); } }}
				/>
				<span class="mr-2 text-xs tabular-nums text-muted-foreground">/ {ctl.pages.length}</span>

				<Button variant="ghost" class={iconBtn} title="Zoom out (Ctrl+-)" onClick={() => ctl.zoomBy(1 / 1.15)}><ZoomOut class="size-4" /></Button>
				<select
					class="h-7 rounded border bg-background px-1 text-xs outline-none focus:ring-2 focus:ring-ring" aria-label="Zoom"
					value={zoomValue()}
					onChange={(e) => {
						const v = e.currentTarget.value;
						if (v === "width" || v === "page") ctl.setMode(v as ZoomMode);
						else if (v !== "custom") ctl.setZoom(Number(v));
						scroller.focus();
					}}
				>
					<option value="width">Fit width</option>
					<option value="page">Fit page</option>
					<option value="custom" hidden>{Math.round(ctl.zoomVal[0]() * 100)}%</option>
					<For each={presets}>{(p) => <option value={p}>{Math.round(p * 100)}%</option>}</For>
				</select>
				<span class="w-10 text-right text-[11px] tabular-nums text-muted-foreground">{Math.round(ctl.zoomVal[0]() * 100)}%</span>
				<Button variant="ghost" class={iconBtn} title="Zoom in (Ctrl+=)" onClick={() => ctl.zoomBy(1.15)}><ZoomIn class="size-4" /></Button>
				<Button variant="ghost" class={cn(iconBtn, ctl.zoomMode[0]() === "width" && "bg-accent text-foreground")} title="Fit width (Ctrl+0)" onClick={() => ctl.setMode("width")}><MoveHorizontal class="size-4" /></Button>
				<Button variant="ghost" class={cn(iconBtn, ctl.zoomMode[0]() === "page" && "bg-accent text-foreground")} title="Fit page" onClick={() => ctl.setMode("page")}><Maximize2 class="size-4" /></Button>

				<div class="mx-1 h-5 w-px bg-border" />
				<Button variant="ghost" class={iconBtn} title="Rotate left (Ctrl+[)" onClick={() => ctl.rotateDoc(-90)}><RotateCcw class="size-4" /></Button>
				<Button variant="ghost" class={iconBtn} title="Rotate right (Ctrl+])" onClick={() => ctl.rotateDoc(90)}><RotateCw class="size-4" /></Button>
				<Button variant="ghost" class={cn(iconBtn, ctl.findOpen[0]() && "bg-accent text-foreground")} title="Find (Ctrl+F)" onClick={() => ctl.findOpen[1](!ctl.findOpen[0]())}><Search class="size-4" /></Button>
				<AppearanceMenu />
				<For each={ctl.toolbarBtns[0]()}>{(b) => (
					<Button variant="ghost" class={cn(iconBtn, b.active?.() && "bg-accent text-foreground")} title={b.title} onClick={b.onClick}><PluginIcon icon={b.icon} title={b.title} /></Button>
				)}</For>
			</header>

			<Show when={ctl.menu[0]()} keyed>{(m) => (
				<div class="fixed inset-0 z-50" onPointerDown={() => ctl.menu[1](null)} onContextMenu={(e) => { e.preventDefault(); ctl.menu[1](null); }}>
					<div
						class="absolute min-w-44 rounded-md border bg-popover p-1 text-[12.5px] text-popover-foreground shadow-md"
						style={{ left: `${Math.min(m.x, window.innerWidth - 200)}px`, top: `${Math.min(m.y, window.innerHeight - m.items.length * 28 - 12)}px` }}
						onPointerDown={(e) => e.stopPropagation()}
					>
						<For each={m.items}>{(it) => (
							<button class="block w-full rounded-sm px-2 py-1.5 text-left hover:bg-accent" onClick={() => { ctl.menu[1](null); it.onClick(); }}>{it.label}</button>
						)}</For>
					</div>
				</div>
			)}</Show>

			<div class="relative flex min-h-0 flex-1">
				<Show when={sideOpen()}>
					<aside class="flex w-80 shrink-0 flex-col border-r bg-card" data-sidebar>
						<div class="flex shrink-0 border-b">
							{tabBtn("outline", "Outline", <List class="size-4" />)}
							{tabBtn("thumbs", "Thumbnails", <LayoutGrid class="size-4" />)}
							<For each={ctl.sidebarTabs[0]()}>{(t) => tabBtn(t.id, t.title, <PluginIcon icon={t.icon} title={t.title} />)}</For>
						</div>
						<div class="min-h-0 flex-1 overflow-hidden">
							<Show when={sideTab() === "outline"}>
								<div class="h-full overflow-y-auto p-1.5">
									<Show when={props.outline.length} fallback={<p class="p-3 text-xs text-muted-foreground">This document has no outline.</p>}>
										<OutlineTree ctl={ctl} nodes={props.outline} />
									</Show>
								</div>
							</Show>
							<Show when={sideTab() === "thumbs"}><Thumbnails ctl={ctl} /></Show>
							<For each={ctl.sidebarTabs[0]()}>{(t) => (
								<Show when={sideTab() === t.id}><PluginTab render={t.render} /></Show>
							)}</For>
						</div>
					</aside>
				</Show>

				<main class="relative min-w-0 flex-1">
					<FindBar ctl={ctl} />
					<div
						ref={scroller} tabindex="0"
						class="absolute inset-0 overflow-auto bg-muted outline-none"
						style={{ visibility: ctl.alternate[0]() ? "hidden" : "visible", "pointer-events": ctl.alternate[0]() ? "none" : "auto", "--page-gap": `${GAP}px` }}
						data-scroller
					>
						<div class="relative" style={{ height: `${ctl.layout().total}px`, width: `${ctl.layout().innerW}px` }}>
							<For each={visible()}>{(i) => <PageView ctl={ctl} index={i} />}</For>
						</div>
					</div>
					<div ref={altEl} class="absolute inset-0 overflow-auto bg-background" style={{ display: ctl.alternate[0]() ? "block" : "none" }} data-alternate />
				</main>
			</div>
		</div>
	);
}
