// One library row, re-created from ui/src/cards/Card.tsx with GPUIX primitives (default "comfortable" layout).
// Class strings are the web card's; tw()/textStyle() turn them into styles so the theme tokens drive the look.
// color-mix() has no tw() equivalent, so the tinted buttons / selected ring use mix() from logic.ts over resolved tokens.
import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import type { ItemRow, Mode, Style } from "../contracts";
import { Icon } from "../icons";
import { store } from "../store";
import { textStyle, tokens, tw } from "../theme";
import {
	authorsText, badgeTags, extraAttachments, isRegular, isStarred, LAYOUT, metaParts, mix, needsFullText, openLabel, plural, webpageOf,
} from "./logic";

/** A resolved colour token ("primary", "card", "foreground" ...) in the given mode. */
export const tok = (name: string, mode: Mode) => tokens[mode][name]!;

const ORANGE = "#D9622B";
const ICON_BY_TYPE: Record<string, string> = {
	journalArticle: "file-text", magazineArticle: "newspaper", newspaperArticle: "newspaper", book: "book", bookSection: "book-open",
	webpage: "globe", blogPost: "globe", conferencePaper: "presentation", thesis: "graduation-cap", report: "scroll-text", preprint: "file-clock",
};
/** Open the item's PDF in a reader tab (double-click on a card, or its "Open PDF" button). Other attachments (EPUB, snapshot) are left as is. */
export function openPdf(item: ItemRow): boolean {
	const prim = item.primaryAttachment;
	if (!prim || openLabel(prim.contentType) !== "Open PDF") return false;
	store.openAttachment(prim.key, item.title || "Reader", item.key);
	return true;
}
export const typeIcon = (t: string) => ICON_BY_TYPE[t] ?? "file";

const BTN = "inline-flex flex-none items-center gap-1.5 rounded-[7px] border text-[12.5px] h-7";

/** Action button (ActionBtn in Card.tsx): h-7 px-[11px] rounded-[7px] border text-[12.5px] gap-1.5, optional orange / blue tint. */
function ActionBtn(p: { mode: Mode; icon: string; label: string; tint?: "orange" | "blue"; strong?: boolean; onClick?: () => void }) {
	const look = createMemo(() => {
		const m = p.mode;
		const card = tok("card", m), fg = tok("foreground", m), primary = tok("primary", m);
		const box = tw(`${BTN} px-[11px] cursor-pointer`, m);
		const text = (color: string): Style => ({ ...textStyle(`text-[12.5px] ${p.strong ? "font-semibold" : "font-medium"}`, m), color, whiteSpace: "nowrap" });
		if (p.tint === "orange") {
			const bg = mix(ORANGE, 11, card), c = mix(ORANGE, 72, fg);
			return { box: { ...box, backgroundColor: bg, borderColor: mix(ORANGE, 32, card), hover: { backgroundColor: mix(ORANGE, 17, card) } }, text: text(c) };
		}
		if (p.tint === "blue") {
			const bg = mix(primary, 9, card), c = mix(primary, 85, fg);
			return { box: { ...box, backgroundColor: bg, borderColor: mix(primary, 28, card), hover: { backgroundColor: mix(primary, 15, card) } }, text: text(c) };
		}
		return { box: { ...box, ...tw("border-border bg-card hover:bg-accent", m) }, text: textStyle("text-[12.5px] font-medium text-foreground/85", m) };
	});
	return (
		<div onClick={() => p.onClick?.()} style={look().box}>
			<Icon name={p.icon} size={15} color={look().text.color as string} />
			<text style={{ ...look().text, whiteSpace: "nowrap" }}>{p.label}</text>
		</div>
	);
}

/** Notes / attachments count chip (AttachmentMenu triggers): border-border bg-card, hover:bg-accent. */
function CountChip(p: { mode: Mode; icon: string; label: string; notes?: boolean }) {
	const box = () => tw(`${BTN} border-border bg-card hover:bg-accent ${p.notes ? "px-[11px]" : "px-2.5"}`, p.mode);
	const text = () => textStyle(`text-[12.5px] ${p.notes ? "text-foreground/85" : "text-muted-foreground"}`, p.mode);
	return (
		<div style={box()}>
			<Icon name={p.icon} size={15} color={text().color as string} />
			<text style={{ ...text(), whiteSpace: "nowrap" }}>{p.label}</text>
		</div>
	);
}

function TagBadge(p: { mode: Mode; name: string; color?: string }) {
	const box = (): Style => {
		const base = tw("inline-flex max-w-48 items-center rounded-full border px-2", p.mode);
		if (!p.color) return { ...base, ...tw("border-border bg-muted", p.mode), height: 20 };
		return { ...base, height: 20, backgroundColor: mix(p.color, 16, "transparent"), borderColor: mix(p.color, 38, "transparent") };
	};
	const text = (): Style => {
		const base = textStyle("text-[11px] font-medium leading-[18px]", p.mode);
		return { ...base, color: p.color ? mix(p.color, 62, tok("foreground", p.mode)) : tok("muted-foreground", p.mode), whiteSpace: "nowrap", textOverflow: "ellipsis" };
	};
	return (
		<div style={box()}>
			<text style={text()}>{p.name}</text>
		</div>
	);
}

// NOTE on structure: in GPUIX an empty text node (what Solid leaves as a marker after a <Show>/<For> that has siblings after
// it) is a real flex item, so with `gap` it adds a phantom gap. Containers with `gap` therefore hold ONE dynamic child (a
// <For> over descriptors) as their last child, or only static children.

type Action = { k: "open"; label: string } | { k: "fulltext" } | { k: "web" } | { k: "cite" } | { k: "notes"; n: number } | { k: "atts"; n: number };
type MetaPart = { k: "authors"; text: string } | { k: "sep" } | { k: "meta"; text: string; accent: boolean };

export function Card(p: { item: ItemRow; index: number }): JSX.Element {
	const mode = () => store.mode();
	const it = () => p.item;
	const selected = () => store.selectedItem() === it().key;
	const [hovered, setHovered] = createSignal(false);

	const badges = () => (LAYOUT.tags ? badgeTags(it()) : []);
	const parts = createMemo<MetaPart[]>(() => {
		const out: MetaPart[] = [];
		const a = authorsText(it());
		if (a) out.push({ k: "authors", text: a });
		metaParts(it()).forEach((m, i) => {
			if (i > 0 || a) out.push({ k: "sep" });
			out.push({ k: "meta", text: m.text, accent: m.accent });
		});
		return out;
	});
	const actions = createMemo<Action[]>(() => {
		const i = it(), out: Action[] = [];
		const prim = i.primaryAttachment;
		if (prim) out.push({ k: "open", label: openLabel(prim.contentType) });
		if (needsFullText(i)) out.push({ k: "fulltext" });
		if (webpageOf(i)) out.push({ k: "web" });
		if (isRegular(i)) out.push({ k: "cite" });
		if (LAYOUT.icons && (i.noteCount ?? 0) > 0) out.push({ k: "notes", n: i.noteCount! });
		if (LAYOUT.icons && extraAttachments(i) > 0) out.push({ k: "atts", n: extraAttachments(i) });
		return out;
	});

	// selected: rounded-[10px] bg-primary/[0.07] + 1px ring (primary 32%) + 0 4px 12px glow (primary 14%); otherwise border-b + hover wash
	const rootStyle = (): Style => {
		const m = mode();
		const base = tw("relative flex items-start gap-3 px-2.5 py-2.5", m);
		if (selected()) {
			const primary = tok("primary", m);
			// bg-primary/[0.07], flattened onto the list surface: GPUI paints box shadows under translucent fills (CSS does not)
			return {
				...base, ...tw("rounded-[10px]", m), backgroundColor: mix(primary, 7, tok("card", m)),
				boxShadow: [
					{ offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: 1, color: mix(primary, 32, "transparent") },
					{ offsetX: 0, offsetY: 4, blurRadius: 12, spreadRadius: 0, color: mix(primary, 14, "transparent") },
				],
			};
		}
		return { ...base, ...tw("rounded-none border-b border-border/60 hover:bg-accent/40", m) };
	};

	const muted = () => textStyle("text-[13px] text-muted-foreground", mode());
	// the web title is a <p> whose inline star button makes its line boxes ~22.3px (leading-[1.35] alone is 20.9)
	// The web serif is drawn at a text optical size (wider and sturdier) that GPUIX can't select; 16.2px / weight 500 of the
	// variable face reproduces the web's line widths (so titles wrap at the same words) instead of the nominal 15.5px.
	const titleStyle = (): Style => ({
		...textStyle("min-w-0 flex-1 break-words font-title text-foreground text-[15.5px]", mode()), fontSize: 16.2, fontWeight: 500, lineHeight: 22.3,
	});
	return (
		<div onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} style={rootStyle()}>
			{/* item-type icon: w-[22px] pt-[3px] text-muted-foreground/80 */}
			<div style={tw("flex w-[22px] flex-none items-center justify-center pt-[3px]", mode())}>
				<Icon name={typeIcon(it().itemType)} size={18} color={tw("text-muted-foreground/80", mode()).color as string} />
			</div>

			<div style={tw("flex flex-col min-w-0 flex-1", mode())}>
				{/* title; right-aligned: more-actions button (shown on hover) and the star (starred, or on hover) */}
				<div style={tw("flex items-start gap-2", mode())}>
					<text style={titleStyle()}>{it().title || "(untitled)"}</text>
					<div style={{ ...tw("flex flex-none items-start", mode()), flexDirection: "row-reverse" }}>
						<div style={{ ...tw("flex size-6 flex-none items-center justify-center", mode()), opacity: hovered() ? 1 : 0 }}>
							<Icon name="ellipsis" size={16} color={muted().color as string} />
						</div>
						<Show when={LAYOUT.star && (isStarred(it()) || hovered())}>
							<div style={tw("flex size-5 flex-none items-center justify-center mt-0.5", mode())}>
								<Icon name="star" size={16} color={(isStarred(it()) ? tw("text-amber-500", mode()) : tw("text-muted-foreground/60", mode())).color as string} />
							</div>
						</Show>
					</div>
				</div>

				{/* tag badges (inline after the title on the web) */}
				<Show when={badges().length}>
					<div style={tw("flex flex-wrap gap-1 mt-1", mode())}>
						<For each={badges()}>{(b) => <TagBadge mode={mode()} name={b.name} color={b.color} />}</For>
					</div>
				</Show>

				{/* creators · publication · year · type */}
				<div style={tw("mt-[3px] flex min-w-0 items-baseline gap-x-1.5 text-muted-foreground", mode())}>
					<For each={parts()}>{(x) => x.k === "authors"
						? <text style={{ ...textStyle("min-w-0 truncate text-[13px] text-muted-foreground", mode()), flexShrink: 1 }}>{x.text}</text>
						: x.k === "sep"
							? <text style={textStyle("flex-none text-[13px] text-muted-foreground/50", mode())}>{"·"}</text>
							: <text style={textStyle(`flex-none max-w-[40%] truncate text-[13px] ${x.accent ? "text-primary/90" : "text-muted-foreground"}`, mode())}>{x.text}</text>
					}</For>
				</div>

				{/* actions */}
				<div style={tw("flex flex-wrap gap-1.5 mt-2", mode())}>
					<For each={actions()}>{(a) => {
						switch (a.k) {
							case "open": return <ActionBtn mode={mode()} icon="file-text" label={a.label} tint="orange" strong onClick={() => openPdf(it())} />;
							case "fulltext": return <ActionBtn mode={mode()} icon="download" label="Find full text" tint="blue" strong />;
							case "web": return <ActionBtn mode={mode()} icon="external-link" label="Open webpage" />;
							case "cite": return <ActionBtn mode={mode()} icon="copy" label="Cite" />;
							case "notes": return <CountChip mode={mode()} icon="sticky-note" label={plural(a.n, "note")} notes />;
							case "atts": return <CountChip mode={mode()} icon="paperclip" label={String(a.n)} />;
						}
					}}</For>
				</div>
			</div>
		</div>
	);
}
