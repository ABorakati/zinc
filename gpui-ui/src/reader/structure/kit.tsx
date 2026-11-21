// Small building blocks shared by the plugin folders (annotations/, academic/, reflow/): themed style helpers that follow the
// reader's mode accessor, an icon button, colour swatches and an inline text field. The shared widgets (Popover, Button, ...)
// live in src/ui; these are the few extras the plugin panels need without pulling in the app store.
import { createEffect, createSignal, For, onCleanup, type Accessor, type JSX } from "solid-js";
import type { Crop } from "./regions";
import type { Mode, Style } from "../../contracts";
import { Icon } from "../../icons";
import { textStyle, tokens, tw } from "../../theme";

export interface Kit {
	/** Tailwind classes -> style */
	t(cls: string): Style;
	/** Tailwind classes -> <text> style (always has a colour) */
	tx(cls: string): Style;
	/** token colour of the current mode */
	tok(name: string): string;
	mode: Accessor<Mode>;
}

export function kit(mode: Accessor<Mode>): Kit {
	return {
		t: (cls) => tw(cls, mode()),
		tx: (cls) => textStyle(cls, mode()),
		tok: (name) => tokens[mode()][name] ?? "#888888",
		mode,
	};
}

/**
 * Text that stays inside its box: `lines` = 1 is one line cut with an ellipsis, more is a wrapped paragraph of at most that many
 * lines whose last one ends in an ellipsis (a bare lineClamp clips at the box edge with no ellipsis, and a nowrap text in a flex
 * row refuses to shrink: both read as "cut off").
 */
export function clampTx(lines: number): Style {
	return lines <= 1
		? { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flexShrink: 1 }
		: { whiteSpace: "normal", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flexShrink: 1, lineClamp: lines };
}

export function IconButton(p: {
	k: Kit;
	icon: string;
	title?: string;
	onClick: () => void;
	on?: boolean;
	disabled?: boolean;
	size?: number;
	box?: number;
	color?: string;
}): JSX.Element {
	const box = () => p.box ?? 28;
	return (
		<div
			onClick={() => {
				if (!p.disabled) p.onClick();
			}}
			style={{
				...p.k.t("flex flex-none items-center justify-center rounded-md"),
				width: box(),
				height: box(),
				cursor: p.disabled ? "default" : "pointer",
				...(p.on ? { backgroundColor: p.k.tok("accent") } : {}),
				hover: p.disabled ? {} : p.k.t("bg-accent"),
			}}
		>
			<Icon
				name={p.icon}
				size={p.size ?? 15}
				color={p.color ?? p.k.tok(p.disabled ? "border" : p.on ? "foreground" : "muted-foreground")}
			/>
		</div>
	);
}

/** Round colour swatches (Zotero's annotation palette). */
export function Swatches(p: {
	k: Kit;
	colors: readonly { name: string; value: string }[];
	value?: string;
	onPick: (c: string) => void;
	size?: number;
	dim?: boolean;
}): JSX.Element {
	const size = () => p.size ?? 20;
	return (
		<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 6 }}>
			<For each={p.colors}>
				{(c) => (
					<div
						onClick={() => p.onPick(c.value)}
						style={{
							width: size(),
							height: size(),
							borderRadius: size() / 2,
							flexShrink: 0,
							backgroundColor: c.value,
							cursor: "pointer",
							borderWidth: p.value === c.value ? 2 : 1,
							borderColor: p.value === c.value ? p.k.tok("foreground") : "rgba(0, 0, 0, 0.2)",
							opacity: p.dim && p.value !== c.value ? 0.45 : 1,
						}}
					/>
				)}
			</For>
		</div>
	);
}

export function inputTheme(k: Kit) {
	return {
		appearance: k.mode(),
		bg: "rgba(0, 0, 0, 0)",
		text: k.tok("foreground"),
		textMuted: k.tok("muted-foreground"),
		textFaint: k.tok("muted-foreground"),
		textDim: k.tok("muted-foreground"),
		accent: k.tok("primary"),
		caret: k.tok("primary"),
		fontSans: "Inter",
	};
}

/** A bordered single-line text field (value reported on every change). */
export function Field(p: {
	k: Kit;
	value: string;
	placeholder?: string;
	onInput: (v: string) => void;
	onSubmit?: (v: string) => void;
	icon?: string;
	style?: Style;
}): JSX.Element {
	const v = (e: unknown) => (e as { value?: string }).value ?? "";
	return (
		<div
			style={{
				...p.k.t("flex h-7 min-w-0 flex-row items-center rounded-md border bg-background px-2"),
				borderColor: p.k.tok("input"),
				...p.style,
			}}
		>
			{p.icon ? <Icon name={p.icon} size={13} color={p.k.tok("muted-foreground")} style={{ marginRight: 6 }} /> : undefined}
			<input
				value={p.value}
				placeholder={p.placeholder}
				onChange={(e) => p.onInput(v(e))}
				onSubmit={(e) => p.onSubmit?.(v(e))}
				style={{ flexGrow: 1, minWidth: 0, height: 24, fontSize: 12, fontFamily: "Inter", color: p.k.tok("foreground") }}
				theme={inputTheme(p.k)}
			/>
		</div>
	);
}

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

// ---------------------------------------------------------------------------------------------------- floating card placement

export interface BoxRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface CardPlacement {
	x: number;
	y: number;
	anchor: "topLeft" | "bottomLeft";
	/** true when placed below the anchor rect, false when flipped above */
	below: boolean;
}

export interface PlaceCardOptions {
	/** Card width in logical px. */
	width: number;
	/** Estimated card height in logical px (decides whether to flip above the anchor). */
	estHeight: number;
	/** Horizontal alignment relative to the anchor rect: "start" aligns left edges, "center" centres over the anchor. Default "start". */
	align?: "start" | "center";
	/** Vertical gap between anchor and card. Default 6. */
	gap?: number;
	/** Minimum inset from viewport edges. Default 8. */
	margin?: number;
	/** Visible reader pane bounds (below toolbar, beside sidebar). Returns null when the anchor has scrolled outside it. */
	pane?: BoxRect | null;
}

/**
 * Window-space placement for a floating reader card (hover card, annotation popup) anchored to a page rect.
 * - Returns null when the anchor has scrolled completely outside `pane` (or the window).
 * - Places below when there is room (`estHeight`) or more room below than above; otherwise flips above (`anchor: "bottomLeft"`).
 * - Clamps `x` inside `pane` (falling back to window bounds when the pane is narrower than the card).
 * Paired with GPUIX `<anchored position={{ x, y }} anchor={anchor} fit="snap" snapMargin={margin}>` so the card paints
 * in GPUI's deferred layer above all pages and never disappears under adjacent pages or clips past window edges.
 */
export function placeFloatingCard(
	anchor: BoxRect,
	window: { width: number; height: number },
	opts: PlaceCardOptions,
): CardPlacement | null {
	const gap = opts.gap ?? 6;
	const margin = opts.margin ?? 8;
	const pane = opts.pane ?? { x: 0, y: 0, width: window.width, height: window.height };

	const vpLeft = Math.max(0, pane.x);
	const vpTop = Math.max(0, pane.y);
	const vpRight = Math.min(window.width, pane.x + pane.width);
	const vpBottom = Math.min(window.height, pane.y + pane.height);
	if (vpRight <= vpLeft || vpBottom <= vpTop) return null;

	// Anchor scrolled completely outside the visible page pane: hide the card instead of stranding it over chrome.
	if (anchor.y + anchor.height < vpTop || anchor.y > vpBottom || anchor.x + anchor.width < vpLeft || anchor.x > vpRight) {
		return null;
	}

	const desiredX = opts.align === "center" ? anchor.x + anchor.width / 2 - opts.width / 2 : anchor.x;
	const usePaneX = vpRight - vpLeft >= opts.width + margin * 2;
	const minX = (usePaneX ? vpLeft : 0) + margin;
	const maxX = Math.max(minX, (usePaneX ? vpRight : window.width) - opts.width - margin);
	const x = Math.round(clamp(desiredX, minX, maxX));

	const belowTop = anchor.y + anchor.height + gap;
	const aboveBottom = anchor.y - gap;
	const spaceBelow = vpBottom - margin - belowTop;
	const spaceAbove = aboveBottom - (vpTop + margin);
	const below = spaceBelow >= opts.estHeight || spaceBelow >= spaceAbove;

	if (below) {
		const y = Math.round(clamp(belowTop, vpTop + margin, Math.max(vpTop + margin, window.height - margin)));
		return { x, y, anchor: "topLeft", below: true };
	}
	const y = Math.round(clamp(aboveBottom, vpTop + margin, Math.max(vpTop + margin, window.height - margin)));
	return { x, y, anchor: "bottomLeft", below: false };
}

// ---------------------------------------------------------------------------------------------------- region image

/** A cropped page region (regions.ts) shown at `width` px; a skeleton box until the pixels are there. */
export function RegionImage(p: {
	k: Kit;
	crop: Accessor<Crop | null | undefined>;
	width: number;
	maxHeight?: number;
	fallbackHeight?: number;
}): JSX.Element {
	let img: { mounted: boolean; setImagePixels(w: number, h: number, b: Uint8Array, o?: { format?: "rgba" | "bgra" }): void } | undefined;
	const [shown, setShown] = createSignal(false);
	const size = () => {
		const c = p.crop();
		if (!c) return { w: p.width, h: p.fallbackHeight ?? Math.round(p.width * 0.6) };
		let w = p.width,
			h = Math.round((p.width * c.height) / c.width);
		if (p.maxHeight && h > p.maxHeight) {
			w = Math.round((w * p.maxHeight) / h);
			h = p.maxHeight;
		}
		return { w, h };
	};
	let alive = true;
	onCleanup(() => {
		alive = false;
		img = undefined;
	});
	createEffect(() => {
		const c = p.crop();
		if (!c) return;
		void (async () => {
			// the element exists in JS first and in the native tree a frame later: retry a few times
			for (let attempt = 0; attempt < 12 && alive; attempt++) {
				if (img && img.mounted) {
					try {
						img.setImagePixels(c.width, c.height, c.pixels, { format: "bgra" });
						setShown(true);
						return;
					} catch {
						/* not in the native tree yet */
					}
				}
				await Bun.sleep(attempt < 3 ? 16 : 60);
			}
		})();
	});
	return (
		<div
			style={{
				width: size().w,
				height: size().h,
				flexShrink: 0,
				backgroundColor: shown() ? "#ffffff" : p.k.tok("muted"),
				borderRadius: 3,
				borderWidth: 1,
				borderColor: p.k.tok("border"),
				overflow: "hidden",
			}}
		>
			<img
				ref={(el) => {
					img = el as never;
				}}
				objectFit="fill"
				style={{ width: size().w, height: size().h, opacity: shown() ? 1 : 0 }}
			/>
		</div>
	);
}
