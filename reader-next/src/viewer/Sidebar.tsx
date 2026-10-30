import { ChevronRight } from "lucide-solid";
import { createSignal, For, onCleanup, onMount, Show, createEffect } from "solid-js";
import type { ViewerController } from "./controller";
import type { OutlineNode } from "./pdf";
import { cn } from "./ui/utils";

export function OutlineTree(props: { ctl: ViewerController; nodes: OutlineNode[]; depth?: number }) {
	const depth = props.depth ?? 0;
	return (
		<ul>
			<For each={props.nodes}>{(n) => {
				const [open, setOpen] = createSignal(depth < 1);
				return (
					<li>
						<div class="flex items-start rounded-sm hover:bg-accent" style={{ "padding-left": `${depth * 12}px` }}>
							<button
								class={cn("flex size-5 shrink-0 items-center justify-center text-muted-foreground", !n.children.length && "invisible")}
								onClick={() => setOpen(!open())}
								aria-label="Toggle"
							><ChevronRight class={cn("size-3.5 transition-transform", open() && "rotate-90")} /></button>
							<button
								class="min-w-0 flex-1 py-0.5 pr-2 text-left text-[12.5px] leading-snug"
								onClick={() => {
									if (n.page !== undefined) props.ctl.goToPage(n.page, { top: n.top });
									else if (n.uri) props.ctl.defaultLink({ rect: [0, 0, 0, 0], target: { kind: "external", uri: n.uri } });
								}}
							>{n.title || "(untitled)"}</button>
						</div>
						<Show when={open() && n.children.length}>
							<OutlineTree ctl={props.ctl} nodes={n.children} depth={depth + 1} />
						</Show>
					</li>
				);
			}}</For>
		</ul>
	);
}

const THUMB_W = 116;

function Thumb(props: { ctl: ViewerController; index: number; root: () => HTMLElement | undefined }) {
	const ctl = props.ctl;
	const info = ctl.pages[props.index];
	const rot = () => ctl.rotOf(props.index);
	const swapped = () => rot() % 180 !== 0;
	// rotated size of the page in points; the thumbnail box is THUMB_W wide
	const rw = () => (swapped() ? info.height : info.width);
	const thumbScale = () => THUMB_W / rw();
	const uw = () => info.width * thumbScale(), uh = () => info.height * thumbScale();
	const boxH = () => Math.round(swapped() ? uw() : uh());
	const tf = () => { const r = rot(); return r === 90 ? `translate(${uh()}px,0) rotate(90deg)` : r === 180 ? `translate(${uw()}px,${uh()}px) rotate(180deg)` : r === 270 ? `translate(0,${uw()}px) rotate(270deg)` : "none"; };
	let canvas!: HTMLCanvasElement, box!: HTMLDivElement;
	let cancel: (() => void) | null = null;
	const [shown, setShown] = createSignal(false);
	const drop = () => { cancel?.(); cancel = null; canvas.width = 0; canvas.height = 0; };
	onMount(() => {
		const io = new IntersectionObserver(([e]) => setShown(e.isIntersecting), { root: props.root() ?? null, rootMargin: "300px 0px" });
		io.observe(box);
		onCleanup(() => { io.disconnect(); drop(); });
	});
	createEffect(() => {
		if (!shown() || ctl.firstPaintMs[0]() === null) { if (!shown()) drop(); return; }
		const dpr = window.devicePixelRatio || 1;
		const job = ctl.pdf.renderThumb(props.index, thumbScale() * dpr);
		cancel = job.cancel;
		job.promise.then((img) => {
			canvas.width = img.width; canvas.height = img.height;
			canvas.getContext("2d")!.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
		}).catch(() => {});
		onCleanup(() => { job.cancel(); });
	});
	const current = () => ctl.curPage() === props.index;
	const selected = () => ctl.thumbSel[0]().includes(props.index);
	const onClick = (e: MouseEvent) => {
		const i = props.index;
		if (e.ctrlKey || e.metaKey) {
			ctl.thumbSel[1]((s) => (s.includes(i) ? s.filter((x) => x !== i) : [...s, i]));
			ctl.thumbAnchor = i;
		} else if (e.shiftKey) {
			const a = Math.min(ctl.thumbAnchor, i), b = Math.max(ctl.thumbAnchor, i);
			ctl.thumbSel[1](Array.from({ length: b - a + 1 }, (_, k) => a + k));
		} else {
			ctl.thumbSel[1]([i]);
			ctl.thumbAnchor = i;
			ctl.goToPage(i);
		}
	};
	return (
		<button
			class="flex flex-col items-center gap-1 rounded-md p-1.5 hover:bg-accent" classList={{ "bg-accent": current() || selected() }}
			onClick={onClick} data-thumb={props.index}
			onContextMenu={(e) => {
				let sel = ctl.thumbSel[0]();
				if (!sel.includes(props.index)) { sel = [props.index]; ctl.thumbSel[1](sel); ctl.thumbAnchor = props.index; }
				ctl.showMenu(e, sel);
			}}
		>
			<div ref={box} class={cn("relative bg-white shadow-sm ring-1 ring-black/10", (current() || selected()) && "ring-2 ring-primary")} style={{ width: `${THUMB_W}px`, height: `${boxH()}px` }}>
				<div class="absolute left-0 top-0" style={{ width: `${uw()}px`, height: `${uh()}px`, "transform-origin": "0 0", transform: tf() }}>
					<canvas ref={canvas} class="size-full" />
				</div>
			</div>
			<span class="text-[11px] tabular-nums text-muted-foreground">{props.index + 1}</span>
		</button>
	);
}

export function Thumbnails(props: { ctl: ViewerController }) {
	let el!: HTMLDivElement;
	createEffect(() => {
		const p = props.ctl.curPage();
		const t = el.querySelector(`[data-thumb="${p}"]`) as HTMLElement | null;
		t?.scrollIntoView({ block: "nearest" });
	});
	return (
		<div ref={el} class="flex h-full flex-col items-center overflow-y-auto py-2">
			<For each={props.ctl.pages}>{(p) => <Thumb ctl={props.ctl} index={p.index} root={() => el} />}</For>
		</div>
	);
}

/** Host element for a plugin-provided sidebar tab. */
export function PluginTab(props: { render: (c: HTMLElement) => void | (() => void) }) {
	let el!: HTMLDivElement;
	onMount(() => {
		const cleanup = props.render(el);
		onCleanup(() => { if (typeof cleanup === "function") cleanup(); el.replaceChildren(); });
	});
	return <div ref={el} class="h-full overflow-auto" />;
}
