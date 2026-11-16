// One library row, re-created from ui/src/cards/Card.tsx with GPUIX primitives.
// Class strings are the web card's; tw()/textStyle() turn them into styles so the theme tokens drive the look.
// color-mix() has no tw() equivalent, so the tinted buttons / selected ring use mix() from logic.ts over resolved tokens.
import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import type { ItemDetail } from "../api";
import type { ItemRow, Mode, Style } from "../contracts";
import { Icon } from "../icons";
import { store } from "../store";
import { textStyle, tokens, tw } from "../theme";
import { readState } from "../readState";
import { DropdownMenu, type MenuItem } from "../ui";
import { childIcon, childLabel, copyCitation, findFullText, getDetail, openChild, peekDetail, openUrl, toggleStar } from "./actions";
import { Twisty } from "./ChildRow";
import { swallow } from "./click";
import { clipText, textWidth } from "../clip";
import { cardLayout, cardListWidth } from "./layout";
import {
	authorsText,
	badgeTags,
	extraAttachments,
	isRegular,
	isStarred,
	metaParts,
	mix,
	needsFullText,
	openLabel,
	plural,
	webpageOf,
} from "./logic";

/** Width the card's text column leaves out of the list: row padding 2 x 10 + card padding 2 x 10 + type icon 22 + gap 12. */
const TEXT_COL_INSET = 74;

/** A resolved colour token ("primary", "card", "foreground" ...) in the given mode. */
export const tok = (name: string, mode: Mode) => tokens[mode][name]!;

const ORANGE = "#D9622B";
const ICON_BY_TYPE: Record<string, string> = {
	journalArticle: "file-text",
	magazineArticle: "newspaper",
	newspaperArticle: "newspaper",
	book: "book",
	bookSection: "book-open",
	webpage: "globe",
	blogPost: "globe",
	conferencePaper: "presentation",
	thesis: "graduation-cap",
	report: "scroll-text",
	preprint: "file-clock",
};
export const typeIcon = (t: string) => ICON_BY_TYPE[t] ?? "file";

const BTN = "inline-flex flex-none items-center gap-1.5 rounded-[7px] border text-[12.5px]";

/** Action button (ActionBtn in Card.tsx): h-7 px-[11px] rounded-[7px] border text-[12.5px] gap-1.5, optional orange / blue tint. */
function ActionBtn(p: {
	mode: Mode;
	compact: boolean;
	hot: boolean;
	icon: string;
	label: string;
	tint?: "orange" | "blue";
	strong?: boolean;
	onClick?: () => void;
}) {
	const look = createMemo(() => {
		const m = p.mode;
		const card = tok("card", m),
			fg = tok("foreground", m),
			primary = tok("primary", m);
		const box = tw(`${BTN} ${p.compact ? "h-6 px-1.5" : "h-7 px-[11px]"} cursor-pointer`, m);
		const text = (color: string): Style => ({
			...textStyle(`select-none text-[12.5px] ${p.strong ? "font-semibold" : "font-medium"}`, m),
			color,
			whiteSpace: "nowrap",
		});
		if (p.tint === "orange") {
			const bg = mix(ORANGE, 11, card),
				c = mix(ORANGE, 72, fg);
			return {
				box: {
					...box,
					backgroundColor: bg,
					borderColor: mix(ORANGE, 32, card),
					...(p.hot ? { hover: { backgroundColor: mix(ORANGE, 17, card) } } : {}),
				},
				text: text(c),
			};
		}
		if (p.tint === "blue") {
			const bg = mix(primary, 9, card),
				c = mix(primary, 85, fg);
			return {
				box: {
					...box,
					backgroundColor: bg,
					borderColor: mix(primary, 28, card),
					...(p.hot ? { hover: { backgroundColor: mix(primary, 15, card) } } : {}),
				},
				text: text(c),
			};
		}
		return {
			box: { ...box, ...tw(p.hot ? "border-border bg-card hover:bg-accent" : "border-border bg-card", m) },
			text: textStyle("select-none text-[12.5px] font-medium text-foreground/85", m),
		};
	});
	return (
		<div
			onClick={() => {
				swallow();
				p.onClick?.();
			}}
			style={look().box}
		>
			<Icon name={p.icon} size={15} color={look().text.color as string} />
			<Show when={!p.compact}>
				<text style={{ ...look().text, whiteSpace: "nowrap" }}>{p.label}</text>
			</Show>
		</div>
	);
}

/** Entries of the notes / attachments dropdown: each opens like a double-click on that child (AttachmentMenu.tsx). */
export function childItems(item: { key: string; title: string }, notes: boolean, d: ItemDetail | null | "error"): MenuItem[] {
	if (d === null) return [{ label: "Loading…", disabled: true }];
	if (d === "error") return [{ label: "Could not load", disabled: true }];
	const atts = d.children.filter((c) => c.itemType === "attachment");
	const nts = notes ? d.children.filter((c) => c.itemType === "note") : [];
	if (!atts.length && !nts.length) return [{ label: "No attachments", disabled: true }];
	const entry = (c: ItemDetail["children"][number]): MenuItem => ({
		label: childLabel(c),
		icon: childIcon(c),
		onSelect: () => void openChild(item, c),
	});
	const out: MenuItem[] = [];
	if (atts.length) out.push({ heading: "Attachments" }, ...atts.map(entry));
	if (nts.length) {
		if (atts.length) out.push({ separator: true });
		out.push({ heading: "Notes" }, ...nts.map(entry));
	}
	return out;
}

/** Items function for a notes / attachments dropdown; the detail is prefetched on hover (CountChip), menus are built synchronously. */
export function childMenu(item: { key: string; title: string }, notes: boolean): () => MenuItem[] {
	return () => {
		const d = peekDetail(item.key);
		if (!d) {
			void getDetail(item.key).catch(() => {});
			return [{ label: "Loading…", disabled: true }];
		}
		return childItems(item, notes, d);
	};
}

/** Notes / attachments count chip (AttachmentMenu triggers): border-border bg-card, hover:bg-accent. */
function CountChip(p: { mode: Mode; compact: boolean; hot: boolean; item: ItemRow; icon: string; label: string; notes?: boolean }) {
	const items = childMenu(p.item, !!p.notes);
	const box = () =>
		tw(
			`${BTN} border-border bg-card ${p.hot ? "hover:bg-accent" : ""} ${p.compact ? "h-6 px-1.5" : p.notes ? "h-7 px-[11px]" : "h-7 px-2.5"} cursor-pointer`,
			p.mode,
		);
	const text = () => textStyle(`select-none text-[12.5px] ${p.notes ? "text-foreground/85" : "text-muted-foreground"}`, p.mode);
	return (
		<DropdownMenu
			items={items}
			trigger={
				<div onClick={() => swallow()} onMouseEnter={() => void getDetail(p.item.key).catch(() => {})} style={box()}>
					<Icon name={p.icon} size={15} color={text().color as string} />
					<text style={{ ...text(), whiteSpace: "nowrap" }}>{p.label}</text>
				</div>
			}
		/>
	);
}

function TagBadge(p: { mode: Mode; name: string; color?: string }) {
	const box = (): Style => {
		const base = tw("inline-flex max-w-48 items-center rounded-full border px-2 cursor-pointer", p.mode);
		if (!p.color) return { ...base, ...tw("border-border bg-muted", p.mode), height: 20 };
		return { ...base, height: 20, backgroundColor: mix(p.color, 16, "transparent"), borderColor: mix(p.color, 38, "transparent") };
	};
	const text = (): Style => {
		const base = textStyle("select-none text-[11px] font-medium leading-[18px]", p.mode);
		return {
			...base,
			color: p.color ? mix(p.color, 62, tok("foreground", p.mode)) : tok("muted-foreground", p.mode),
			whiteSpace: "nowrap",
		};
	};
	// max-w-48 (192) - px-2 (16) - border (2); clipped here, not by textOverflow (see clip.ts)
	const label = () => clipText(p.name, 174, 11, 500);
	// Show items tagged "name"
	return (
		<div
			onClick={() => {
				swallow();
				store.setTagFilter([p.name]);
			}}
			style={box()}
		>
			<text style={text()}>{label()}</text>
		</div>
	);
}

// NOTE on structure: in GPUIX an empty text node (what Solid leaves as a marker after a <Show>/<For> that has siblings after
// it) is a real flex item, so with `gap` it adds a phantom gap. Containers with `gap` therefore hold ONE dynamic child (a
// <For> over descriptors) as their last child, or only static children.

type Action =
	{ k: "open"; label: string } | { k: "fulltext" } | { k: "web" } | { k: "cite" } | { k: "notes"; n: number } | { k: "atts"; n: number };
/** One text of the meta line: consecutive same-colour parts are joined (with their " · " separators) into one <text>. */
type MetaRun = { text: string; accent: boolean };
/** Gap between the meta line's texts. */
const META_GAP = 4;
/** The accent run (publication) keeps its web `max-w-[40%]`. */
const ACCENT_MAX = 0.4;

/** The card's "more actions" (...) button calls this to open the context menu at the button. */
export type MoreHandler = (rect: { x: number; y: number; width: number; height: number }) => void;

export function Card(p: {
	item: ItemRow;
	index: number;
	hovered: boolean;
	onMore: MoreHandler;
	focused?: boolean;
	/** The twisty under the type icon (items with attachments / notes): open state and toggle. */
	tree?: { open: boolean; toggle: () => void };
}): JSX.Element {
	const mode = () => store.mode();
	const it = () => p.item;
	const L = cardLayout.layout;
	const compact = () => L().density === "compact";
	const selected = () => store.selected().has(it().key);
	const hovered = () => p.hovered;
	const [citing, setCiting] = createSignal(false);
	const unread = createMemo(() => readState.isUnread(it()));

	const badges = () => (L().tags ? badgeTags(it()) : []);
	// creators · publication · year · type as FEW texts as possible (a <text> is a host div + selectable wrapper + canvas underlay):
	// GPUIX has no styled runs inside one <text>, so only parts of the same colour merge; the separators ride on the muted runs.
	const runs = createMemo<MetaRun[]>(() => {
		const parts: MetaRun[] = [];
		const a = authorsText(it());
		if (a) parts.push({ text: a, accent: false });
		for (const m of metaParts(it())) parts.push({ text: m.text, accent: m.accent });
		const out: MetaRun[] = [];
		for (const x of parts) {
			const last = out[out.length - 1];
			if (last && !x.accent && !last.accent) last.text += " \u00b7 " + x.text;
			else out.push({ text: x.text, accent: x.accent });
		}
		return out.map((r, i) =>
			r.accent ? r : { ...r, text: (i > 0 ? "\u00b7 " : "") + r.text + (i < out.length - 1 ? " \u00b7" : "") },
		);
	});
	/** The runs clipped to the card's text column (JS pre-clipping instead of textOverflow: ellipsis): the first run (the creators) gives way first. */
	const fitted = createMemo<string[]>(() => {
		const rs = runs(),
			W = cardListWidth();
		if (W <= 0) return rs.map((r) => r.text);
		const size = compact() ? 12 : 13,
			C = (W - TEXT_COL_INSET) * 0.985; // 1.5% shaved (clip.ts): the estimate may be a little low
		const w = rs.map((r) => Math.min(textWidth(r.text, size), r.accent ? C * ACCENT_MAX : Infinity));
		const squeezed = rs.map(() => false);
		let over = w.reduce((n, x) => n + x, 0) + META_GAP * Math.max(0, rs.length - 1) - C;
		for (let i = 0; i < rs.length && over > 0; i++) {
			// squeeze the first run, then the later ones from the end
			const k = i === 0 ? 0 : rs.length - i;
			const cut = Math.min(over, Math.max(0, w[k]! - 12));
			if (cut > 0) {
				w[k]! -= cut;
				over -= cut;
				squeezed[k] = true;
			}
		}
		// a run the accent cap (40%) shortened is clipped too
		return rs.map((r, i) =>
			squeezed[i] || (r.accent && textWidth(r.text, size) > w[i]!) ? clipText(r.text, w[i]!, size, 400, 1) : r.text,
		);
	});
	const actions = createMemo<Action[]>(() => {
		const i = it(),
			out: Action[] = [];
		const prim = i.primaryAttachment;
		if (prim) out.push({ k: "open", label: openLabel(prim.contentType) });
		if (needsFullText(i)) out.push({ k: "fulltext" });
		if (webpageOf(i)) out.push({ k: "web" });
		if (isRegular(i)) out.push({ k: "cite" });
		if (L().icons && (i.noteCount ?? 0) > 0) out.push({ k: "notes", n: i.noteCount! });
		if (L().icons && extraAttachments(i) > 0) out.push({ k: "atts", n: extraAttachments(i) });
		return out;
	});

	// selected: rounded-[10px] bg-primary/[0.07] + 1px ring (primary 32%) + 0 4px 12px glow (primary 14%); otherwise border-b + hover wash
	const rootStyle = (): Style => {
		const m = mode();
		const base = tw(compact() ? "relative flex items-start gap-3 px-2.5 py-1.5" : "relative flex items-start gap-3 px-2.5 py-2.5", m);
		const ring = p.focused ? { outlineWidth: 2, outlineColor: mix(tok("ring", m), 60, "transparent"), outlineOffset: -2 } : {};
		if (selected()) {
			const primary = tok("primary", m);
			// bg-primary/[0.07], flattened onto the list surface: GPUI paints box shadows under translucent fills (CSS does not)
			return {
				...base,
				...tw("rounded-[10px]", m),
				backgroundColor: mix(primary, 7, tok("card", m)),
				boxShadow: [
					{ offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: 1, color: mix(primary, 32, "transparent") },
					{ offsetX: 0, offsetY: 4, blurRadius: 12, spreadRadius: 0, color: mix(primary, 14, "transparent") },
				],
				...ring,
			};
		}
		// Hover is GPUI's own (style.hover, a hit-test on the pointer position), not JS enter/leave: in GPUIX a child that paints (a
		// button, the star, an icon) blocks its ancestors' mouse handlers, so JS hover saw leave/enter pairs across a card and flickered.
		return {
			...base,
			// an open item's rule goes under its last child row instead (ChildRow.tsx)
			...tw(p.tree?.open ? "rounded-none" : "rounded-none border-b border-border/60", m),
			...(p.focused
				? { backgroundColor: mix(tok("accent", m), 50, "transparent") }
				: { hover: { backgroundColor: mix(tok("accent", m), 40, "transparent") } }),
			...ring,
		};
	};

	const muted = () => textStyle(compact() ? "text-xs text-muted-foreground" : "text-[13px] text-muted-foreground", mode());
	// the web title is a <p> whose inline star button makes its line boxes ~22.3px (leading-[1.35] alone is 20.9)
	// The web serif is drawn at a text optical size (wider and sturdier) that GPUIX can't select; 16.2px / weight 500 of the
	// variable face reproduces the web's line widths (so titles wrap at the same words) instead of the nominal 15.5px.
	const titleStyle = (): Style =>
		compact()
			? {
					...textStyle("min-w-0 flex-1 break-words font-title text-foreground text-sm", mode()),
					fontSize: 14.7,
					fontWeight: 500,
					lineHeight: 20,
				}
			: {
					...textStyle("min-w-0 flex-1 break-words font-title text-foreground text-[15.5px]", mode()),
					fontSize: 16.2,
					fontWeight: 500,
					lineHeight: 22.3,
				};
	const metaSize = () => (compact() ? "text-xs" : "text-[13px]");
	return (
		<div style={rootStyle()}>
			{/* item-type icon: w-[22px] pt-[3px] text-muted-foreground/80 */}
			<div style={{ ...tw("flex flex-col w-[22px] flex-none items-center justify-center pt-[3px]", mode()), position: "relative" }}>
				<Show when={unread()}>
					<div
						data-testid="unread-dot"
						style={{
							position: "absolute",
							top: 1,
							right: 0,
							width: 7,
							height: 7,
							borderRadius: 9999,
							backgroundColor: tok("primary", mode()),
						}}
					/>
				</Show>
				<Icon
					name={typeIcon(it().itemType)}
					size={compact() ? 16 : 18}
					color={tw("text-muted-foreground/80", mode()).color as string}
				/>
				<Show when={p.tree}>
					{(t) => (
						<div style={{ marginTop: compact() ? 2 : 6 }}>
							<Twisty open={t().open} onToggle={t().toggle} size={compact() ? 16 : 20} testId="card-twisty" />
						</div>
					)}
				</Show>
			</div>

			<div style={tw("flex flex-col min-w-0 flex-1", mode())}>
				{/* title; right-aligned: more-actions button (shown on hover) and the star (starred, or on hover) */}
				<div style={tw("flex items-start gap-2", mode())}>
					<text style={titleStyle()}>{it().title || "(untitled)"}</text>
					{/* The button box has a FIXED width (24 px, 44 with the star column) and both buttons stay mounted: hover only fades them.
					    Growing the box on hover narrowed the title, which could re-wrap it, change the card's height, move it out from under the
					    pointer (leave), shrink back (enter) — a hover flicker loop. */}
					<div
						style={{
							...tw("flex flex-none items-start", mode()),
							flexDirection: "row-reverse",
							width: 24 + (L().star ? 20 : 0),
							height: 24,
						}}
					>
						<div
							onClick={(e: { x?: number; y?: number }) => {
								swallow();
								p.onMore({ x: (e.x ?? 0) - 12, y: (e.y ?? 0) - 12, width: 24, height: 24 });
							}}
							style={{
								...tw("flex size-6 flex-none items-center justify-center rounded-md cursor-pointer", mode()),
								opacity: 0.45,
								hover: { opacity: 1 },
							}}
						>
							<Icon name="ellipsis" size={16} color={muted().color as string} />
						</div>
						<Show when={L().star}>
							<div
								onClick={() => {
									swallow();
									void toggleStar(it());
								}}
								// always present, faint until hovered itself (GPUIX can't style a child from its card's hover; JS hover flickered)
								style={{
									...tw("flex size-5 flex-none items-center justify-center mt-0.5 rounded cursor-pointer", mode()),
									opacity: isStarred(it()) ? 1 : 0.35,
									hover: { opacity: 1 },
								}}
							>
								<Icon
									name="star"
									size={16}
									color={
										(isStarred(it()) ? tw("text-amber-500", mode()) : tw("text-muted-foreground/60", mode()))
											.color as string
									}
								/>
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

				{/* creators · publication · year · type: the box clips whatever the width estimate got wrong */}
				<div style={tw("mt-[3px] flex min-w-0 items-baseline gap-x-1 overflow-hidden", mode())}>
					<For each={runs()}>
						{(x, i) => (
							<text
								style={textStyle(
									`select-none flex-none whitespace-nowrap ${metaSize()} ${x.accent ? "text-primary/90" : "text-muted-foreground"}`,
									mode(),
								)}
							>
								{fitted()[i()] ?? x.text}
							</text>
						)}
					</For>
				</div>

				{/* actions */}
				<div style={tw(compact() ? "flex flex-wrap gap-1.5 mt-1" : "flex flex-wrap gap-1.5 mt-2", mode())}>
					<For each={actions()}>
						{(a) => {
							const c = compact();
							switch (a.k) {
								case "open":
									return (
										<ActionBtn
											mode={mode()}
											compact={c}
											hot
											icon="file-text"
											label={a.label}
											tint="orange"
											strong
											onClick={() =>
												store.openAttachment(it().primaryAttachment!.key, it().title || "Reader", it().key)
											}
										/>
									);
								case "fulltext":
									return (
										<ActionBtn
											mode={mode()}
											compact={c}
											hot
											icon="download"
											label="Find full text"
											tint="blue"
											strong
											onClick={() => void findFullText([it().key])}
										/>
									);
								case "web":
									return (
										<ActionBtn
											mode={mode()}
											compact={c}
											hot
											icon="external-link"
											label="Open webpage"
											onClick={() => {
												const u = webpageOf(it());
												if (u) void openUrl(u);
											}}
										/>
									);
								case "cite":
									return (
										<ActionBtn
											mode={mode()}
											compact={c}
											hot
											icon="copy"
											label={citing() ? "Copying…" : "Cite"}
											onClick={() => {
												setCiting(true);
												void copyCitation(it().key).finally(() => setCiting(false));
											}}
										/>
									);
								case "notes":
									return (
										<CountChip
											mode={mode()}
											compact={c}
											hot
											item={it()}
											icon="sticky-note"
											label={c ? String(a.n) : plural(a.n, "note")}
											notes
										/>
									);
								case "atts":
									return <CountChip mode={mode()} compact={c} hot item={it()} icon="paperclip" label={String(a.n)} />;
							}
						}}
					</For>
				</div>
			</div>
		</div>
	);
}
